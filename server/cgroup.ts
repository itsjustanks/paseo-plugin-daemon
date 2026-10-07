import { readFile } from "node:fs/promises";

/**
 * The container's own limits, read from its cgroup. Inside Docker,
 * /proc/meminfo and /proc/stat describe the whole host (a 64 GB machine),
 * while the kernel kills the container at its own memory limit (say 7.3 GB).
 * This module reads that limit and the container's usage so pressure is
 * judged against what actually kills it. Linux only; macOS returns null.
 *
 * cgroup v2 is preferred; v1 is read as a fallback. Everything that can't be
 * read is null, never an error: a host without cgroups simply has no limit.
 */

export interface CgroupSample {
  /** Memory limit in bytes, or null when unlimited (or no lower than the host). */
  memoryLimitBytes: number | null;
  /** Everything the container's memory counter holds, page cache included. */
  memoryUsageBytes: number;
  /** Usage minus inactive file cache: what `docker stats` shows and what the OOM killer weighs. */
  memoryWorkingSetBytes: number;
  /** CPU quota in cores ("200000 100000" → 2), or null when unlimited. */
  cpuLimitCores: number | null;
  /** Cumulative CPU time the cgroup has used, in microseconds; only deltas matter. */
  cpuUsageUsec: number | null;
  psiMemorySome10: number | null;
  /** 0.13.0: "full avg10", the share of time every task waited on memory. */
  psiMemoryFull10?: number | null;
  psiCpuSome10: number | null;
  /** How many times the kernel has OOM-killed a process in this cgroup. */
  oomKills: number | null;
  version: 1 | 2;
}

export interface CgroupFs { readFile(path: string): Promise<string> }
const realFs: CgroupFs = { readFile: (path) => readFile(path, "utf8") };

/** Anything at or above this is "no limit" (v1 reports 2^63 rounded to a page). */
const UNLIMITED = 2 ** 60;

// ------------------------------------------------------------------ parsers

/** `/proc/self/cgroup` → the v2 path ("0::/docker/abc" → "/docker/abc"), or null on a v1-only host. */
export function parseCgroupPath(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^0::(.*)$/.exec(line.trim());
    if (match) return match[1] || "/";
  }
  return null;
}

/** "max" or a byte count; null when unlimited or unparseable. */
export function parseLimit(text: string): number | null {
  const value = text.trim();
  if (value === "max" || value === "") return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 && bytes < UNLIMITED ? bytes : null;
}

/** `cpu.max` ("max 100000" or "200000 100000") → cores, or null when unlimited. */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota), p = Number(period || 100000);
  return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? q / p : null;
}

/** A flat "key value" file (memory.stat, cpu.stat, memory.events). */
export function parseKeyed(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && Number.isFinite(Number(value))) values.set(key, Number(value));
  }
  return values;
}

/** `memory.pressure` / `cpu.pressure` → "some avg10". */
export function parsePsi(text: string): number | null {
  const match = /^some\s+avg10=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `memory.pressure` → "full avg10" (0.13.0). */
export function parsePsiFull(text: string): number | null {
  const match = /^full\s+avg10=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** Working set: usage minus the inactive file cache the kernel can drop for free. */
export function workingSet(usage: number, inactiveFile: number | undefined): number {
  return Math.max(0, usage - (inactiveFile ?? 0));
}

// ------------------------------------------------------------------- reader

async function optional(fs: CgroupFs, path: string): Promise<string | null> {
  try { return await fs.readFile(path); } catch { return null; }
}

async function readV2(fs: CgroupFs, base: string, hostTotalBytes: number): Promise<CgroupSample | null> {
  const current = await optional(fs, `${base}/memory.current`);
  if (current === null) return null;
  const [max, stat, cpuMax, cpuStat, memPsi, cpuPsi, events] = await Promise.all([
    optional(fs, `${base}/memory.max`), optional(fs, `${base}/memory.stat`), optional(fs, `${base}/cpu.max`), optional(fs, `${base}/cpu.stat`),
    optional(fs, `${base}/memory.pressure`), optional(fs, `${base}/cpu.pressure`), optional(fs, `${base}/memory.events`),
  ]);
  const usage = Number(current.trim()) || 0;
  const limit = max === null ? null : parseLimit(max);
  return {
    memoryLimitBytes: limit !== null && (hostTotalBytes <= 0 || limit < hostTotalBytes) ? limit : null,
    memoryUsageBytes: usage,
    memoryWorkingSetBytes: workingSet(usage, stat === null ? undefined : parseKeyed(stat).get("inactive_file")),
    cpuLimitCores: cpuMax === null ? null : parseCpuMax(cpuMax),
    cpuUsageUsec: cpuStat === null ? null : parseKeyed(cpuStat).get("usage_usec") ?? null,
    psiMemorySome10: memPsi === null ? null : parsePsi(memPsi),
    psiMemoryFull10: memPsi === null ? null : parsePsiFull(memPsi),
    psiCpuSome10: cpuPsi === null ? null : parsePsi(cpuPsi),
    oomKills: events === null ? null : parseKeyed(events).get("oom_kill") ?? null,
    version: 2,
  };
}

async function readV1(fs: CgroupFs, hostTotalBytes: number): Promise<CgroupSample | null> {
  const usage = await optional(fs, "/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (usage === null) return null;
  const [limit, stat, quota, period, cpuacct] = await Promise.all([
    optional(fs, "/sys/fs/cgroup/memory/memory.limit_in_bytes"), optional(fs, "/sys/fs/cgroup/memory/memory.stat"),
    optional(fs, "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), optional(fs, "/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    optional(fs, "/sys/fs/cgroup/cpuacct/cpuacct.usage"),
  ]);
  const used = Number(usage.trim()) || 0;
  const bytes = limit === null ? null : parseLimit(limit);
  const q = quota === null ? -1 : Number(quota.trim());
  const p = period === null ? 100000 : Number(period.trim()) || 100000;
  return {
    memoryLimitBytes: bytes !== null && (hostTotalBytes <= 0 || bytes < hostTotalBytes) ? bytes : null,
    memoryUsageBytes: used,
    memoryWorkingSetBytes: workingSet(used, stat === null ? undefined : parseKeyed(stat).get("total_inactive_file")),
    cpuLimitCores: q > 0 ? q / p : null,
    // cpuacct.usage is nanoseconds.
    cpuUsageUsec: cpuacct === null ? null : Math.round((Number(cpuacct.trim()) || 0) / 1000),
    psiMemorySome10: null,
    psiCpuSome10: null,
    oomKills: null,
    version: 1,
  };
}

/**
 * The cgroup this process lives in, or null when there is none to read
 * (macOS, a bare host whose root cgroup has no memory.current, or a
 * filesystem that isn't mounted). A namespaced container sees its own
 * cgroup as "/", so the base is /sys/fs/cgroup itself.
 */
export async function readCgroup(hostTotalBytes: number, fs: CgroupFs = realFs): Promise<CgroupSample | null> {
  const self = await optional(fs, "/proc/self/cgroup");
  if (self === null) return null;
  const path = parseCgroupPath(self);
  if (path !== null) {
    const nested = path === "/" ? null : await readV2(fs, `/sys/fs/cgroup${path}`, hostTotalBytes);
    const sample = nested ?? await readV2(fs, "/sys/fs/cgroup", hostTotalBytes);
    if (sample) return sample;
  }
  return readV1(fs, hostTotalBytes);
}
