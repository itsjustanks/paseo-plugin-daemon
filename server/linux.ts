import { execFile } from "node:child_process";
import { open, readdir, readFile, readlink } from "node:fs/promises";
import { cpus, loadavg, uptime, endianness } from "node:os";
import { promisify } from "node:util";
import { parsePsiFull, readCgroup } from "./cgroup";
import { provenLoopbackEndpoints, type TcpListener } from "./tcp-endpoints";
import { hashArgv } from "./redaction";
import {
  beforeDeadline,
  mapLimit,
  mapState,
  type PlatformAdapter,
  type PortScanResult,
  type ProcessIdentity,
  type RawProcess,
  type RawSystemSample,
  type TreeRow,
} from "./platform";

import { parseLinuxAgentId } from "./process-tags";

const execFileAsync = promisify(execFile);

/** Upper bounds so Monitor never becomes the thing that thrashes the machine. */
export const MAX_PROCESSES = 4096;
export const MAX_FDS_PER_PROCESS = 2048;
export const FD_SCAN_CONCURRENCY = 8;
export const PROC_READ_CONCURRENCY = 16;
export const MAX_ENVIRON_BYTES = 64 * 1024;
export const PROCESS_SAMPLE_MS = 5000;
/** PIDs examined per batch while looking for same-user processes. */
export const PROC_READ_BATCH = 256;

// ------------------------------------------------------------------ parsers
// All parsers are pure. They take file contents and return plain data.

export interface CpuTimes {
  busy: number;
  total: number;
}

/** First line of /proc/stat. */
export function parseProcStat(text: string): CpuTimes {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) throw new Error("/proc/stat: missing aggregate cpu line");
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

export function parseLoadavg(text: string): { load1: number; load5: number; load15: number } {
  const [a, b, c] = text.trim().split(/\s+/);
  return { load1: Number(a) || 0, load5: Number(b) || 0, load15: Number(c) || 0 };
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export function parseMeminfo(text: string): MemInfo {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal") ?? 0;
  const free = values.get("MemFree") ?? 0;
  // Old kernels lack MemAvailable; approximate the kernel's own estimate.
  const available =
    values.get("MemAvailable") ?? free + (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0) + (values.get("Buffers") ?? 0);
  return {
    totalBytes: total,
    availableBytes: Math.min(total, available),
    swapTotalBytes: values.get("SwapTotal") ?? 0,
    swapFreeBytes: values.get("SwapFree") ?? 0,
  };
}

/** `/proc/pressure/{cpu,memory}` → "some avg10" percentage. */
export function parsePressure(text: string): number | null {
  const match = /^some\s+avg10=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

export function parseUptime(text: string): number {
  return Number(text.trim().split(/\s+/)[0]) || 0;
}

export interface ProcStatFields {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utimeTicks: number;
  stimeTicks: number;
  startTicks: number;
  rssPages: number;
}

/**
 * `/proc/<pid>/stat`. The comm field is parenthesised and may itself contain
 * spaces and parentheses ("Paseo Daemon"), so split on the *last* ')'.
 */
export function parseProcPidStat(text: string): ProcStatFields {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("malformed /proc/<pid>/stat");
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state). Field N is rest[N - 3].
  const field = (n: number) => rest[n - 3] ?? "0";
  return {
    pid,
    comm,
    state: field(3),
    ppid: Number(field(4)),
    utimeTicks: Number(field(14)),
    stimeTicks: Number(field(15)),
    startTicks: Number(field(22)),
    rssPages: Number(field(24)),
  };
}

export interface ProcStatus {
  uid: number;
  rssBytes: number | null;
}

/** `/proc/<pid>/status`: real uid and VmRSS. */
export function parseProcStatus(text: string): ProcStatus {
  let uid = -1;
  let rssBytes: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("Uid:")) {
      uid = Number(line.slice(4).trim().split(/\s+/)[0]);
    } else if (line.startsWith("VmRSS:")) {
      rssBytes = Number(line.slice(6).trim().split(/\s+/)[0]) * 1024;
    }
  }
  return { uid, rssBytes };
}

export function parseCmdline(buffer: Buffer | string): string[] {
  const text = typeof buffer === "string" ? buffer : buffer.toString("utf8");
  if (!text) return [];
  const parts = text.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export interface ListeningSocket {
  inode: number;
  port: number;
  uid: number;
}

/** `/proc/net/tcp` and `/proc/net/tcp6`: rows with state 0A (LISTEN). */
export function parseProcNetTcp(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    if (cols[3] !== "0A") continue;
    const local = cols[1]!;
    const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    const uid = Number(cols[7]);
    const inode = Number(cols[9]);
    if (!Number.isFinite(port) || !Number.isFinite(inode) || inode === 0) continue;
    out.push({ inode, port, uid });
  }
  return out;
}

/** Exact addresses from the kernel table; each 32-bit word uses native byte order. */
export function parseProcTcpEndpoints(text: string, family: 4 | 6, byteOrder = endianness()): TcpListener[] {
  return text.split("\n").slice(1).filter((line) => line.trim()).flatMap((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols[3] !== "0A") return [];
    const match = /^([A-Fa-f0-9]+):([A-Fa-f0-9]{4})$/.exec(cols[1] ?? "");
    if (!match || match[1]!.length !== (family === 4 ? 8 : 32) || !/^\d+$/.test(cols[9] ?? "")) throw new Error("Unrecognized kernel TCP listener.");
    const hex = match[1]!.match(/.{8}/g)!.map((word) => byteOrder === "LE" ? word.match(/../g)!.reverse().join("") : word).join("").toLowerCase();
    const address = /^0+$/.test(hex) ? "*" : hex === "7f000001" ? "127.0.0.1" : hex === "00000000000000000000000000000001" ? "::1" : "other";
    const owner = Number(cols[9]); const port = parseInt(match[2]!, 16);
    if (!owner || !port) throw new Error("Invalid kernel TCP listener.");
    return [{ owner, address, family, port }];
  });
}

export function parseSocketInode(link: string): number | null {
  const match = /^socket:\[(\d+)\]$/.exec(link);
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------------ adapter

export interface LinuxFs {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string, maxBytes?: number): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

const realFs: LinuxFs = {
  readFile: (path) => readFile(path, "utf8"),
  readFileBuffer: async (path, maxBytes) => {
    if (maxBytes === undefined) return readFile(path);
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  },
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
};

async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** True when an error means "that process is gone", as opposed to "could not read". */
function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ESRCH";
}

export interface LinuxAdapterOptions {
  fs?: LinuxFs;
  sampleMs?: number;
  clockTicks?: number;
  pageSize?: number;
  /** Injectable for tests; defaults to `getconf CLK_TCK`. */
  readClockTicks?: () => Promise<number>;
}

export class LinuxAdapter implements PlatformAdapter {
  readonly platform = "linux" as const;
  private readonly fs: LinuxFs;
  private readonly sampleMs: number;
  private readonly pageSize: number;
  private clockTicks: number | null;
  private readonly readClockTicks: () => Promise<number>;
  private clockTicksPromise: Promise<number> | null = null;

  constructor(options: LinuxAdapterOptions = {}) {
    this.fs = options.fs ?? realFs;
    this.sampleMs = options.sampleMs ?? PROCESS_SAMPLE_MS;
    this.pageSize = options.pageSize ?? 4096;
    this.clockTicks = options.clockTicks ?? null;
    this.readClockTicks = options.readClockTicks ?? defaultReadClockTicks;
  }

  private ticks(): Promise<number> {
    if (this.clockTicks !== null) return Promise.resolve(this.clockTicks);
    this.clockTicksPromise ??= this.readClockTicks()
      .catch(() => 100)
      .then((value) => {
        this.clockTicks = value > 0 ? value : 100;
        return this.clockTicks;
      });
    return this.clockTicksPromise;
  }

  async sampleSystem(): Promise<RawSystemSample> {
    const [stat, load, mem, psiCpu, psiMem, up] = await Promise.all([
      this.fs.readFile("/proc/stat"),
      optional(this.fs.readFile("/proc/loadavg")),
      this.fs.readFile("/proc/meminfo"),
      optional(this.fs.readFile("/proc/pressure/cpu")),
      optional(this.fs.readFile("/proc/pressure/memory")),
      optional(this.fs.readFile("/proc/uptime")),
    ]);
    const cpu = parseProcStat(stat);
    const loads = load ? parseLoadavg(load) : { load1: loadavg()[0] ?? 0, load5: loadavg()[1] ?? 0, load15: loadavg()[2] ?? 0 };
    const memory = parseMeminfo(mem);
    const container = await readCgroup(memory.totalBytes, this.fs).catch(() => null);
    return {
      cpuBusy: cpu.busy,
      cpuTotal: cpu.total,
      cores: Math.max(1, cpus().length),
      ...loads,
      psiCpuSome10: psiCpu ? parsePressure(psiCpu) : null,
      psiMemorySome10: psiMem ? parsePressure(psiMem) : null,
      psiMemoryFull10: psiMem ? parsePsiFull(psiMem) : null,
      memoryTotalBytes: memory.totalBytes,
      memoryAvailableBytes: memory.availableBytes,
      swapTotalBytes: memory.swapTotalBytes,
      swapUsedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes),
      pressureSignal: null,
      uptimeSeconds: up ? parseUptime(up) : uptime(),
      container,
    };
  }

  /**
   * Every numeric entry in /proc. Deliberately uncapped: it is a list of
   * integers, and truncating it here would hide same-user processes (and
   * ancestors) behind whatever other users happen to run.
   */
  private async listPids(): Promise<number[]> {
    const entries = await this.fs.readdir("/proc");
    const pids: number[] = [];
    for (const entry of entries) if (/^\d+$/.test(entry)) pids.push(Number(entry));
    return pids;
  }

  private async readOne(pid: number, uid: number, clockTicks: number, uptimeSeconds: number): Promise<RawProcess | null> {
    const status = await optional(this.fs.readFile(`/proc/${pid}/status`));
    if (!status) return null;
    const parsedStatus = parseProcStatus(status);
    if (parsedStatus.uid !== uid) return null;
    const stat = await optional(this.fs.readFile(`/proc/${pid}/stat`));
    if (!stat) return null;
    const fields = parseProcPidStat(stat);
    const cmdline = await optional(this.fs.readFileBuffer(`/proc/${pid}/cmdline`));
    const argv = cmdline ? parseCmdline(cmdline) : [];
    const [cwd, environ, executable] = await Promise.all([
      optional(this.fs.readlink(`/proc/${pid}/cwd`)),
      optional(this.fs.readFileBuffer(`/proc/${pid}/environ`, MAX_ENVIRON_BYTES)),
      optional(this.fs.readlink(`/proc/${pid}/exe`)),
    ]);
    const startSeconds = fields.startTicks / clockTicks;
    return {
      pid: fields.pid,
      ppid: fields.ppid,
      uid: parsedStatus.uid,
      comm: fields.comm,
      argv,
      state: mapState(fields.state),
      cpuSeconds: (fields.utimeTicks + fields.stimeTicks) / clockTicks,
      startId: String(fields.startTicks),
      rssBytes: parsedStatus.rssBytes ?? fields.rssPages * this.pageSize,
      ageSeconds: Math.max(0, uptimeSeconds - startSeconds),
      cwd,
      executable,
      agentId: environ === null ? null : parseLinuxAgentId(environ.subarray(0, MAX_ENVIRON_BYTES)),
    };
  }

  /**
   * Same-user processes. The whole PID list is walked in bounded batches so
   * other users' processes never crowd ours out; only the *same-user* result
   * is capped, and a capped result says so. Raw procfs contents are parsed
   * per batch and dropped immediately.
   */
  async sampleProcesses(uid: number): Promise<{ processes: RawProcess[]; warnings: string[] }> {
    const deadline = Date.now() + this.sampleMs;
    let inputs: [number, string | null, number[]];
    try { inputs = await beforeDeadline(Promise.all([this.ticks(), optional(this.fs.readFile("/proc/uptime")), this.listPids()]), deadline); }
    catch { return { processes: [], warnings: ["Process sample deadline exceeded; attribution may be missing."] }; }
    const [clockTicks, upText, pids] = inputs;
    const uptimeSeconds = upText ? parseUptime(upText) : uptime();
    const processes: RawProcess[] = [];
    const warnings: string[] = [];
    let truncated = false;
    for (let offset = 0; offset < pids.length && !truncated && Date.now() < deadline; offset += PROC_READ_BATCH) {
      const batch = pids.slice(offset, offset + PROC_READ_BATCH);
      const rows = await mapLimit(batch, PROC_READ_CONCURRENCY, (pid) => Date.now() >= deadline ? Promise.resolve(null)
        : beforeDeadline(this.readOne(pid, uid, clockTicks, uptimeSeconds), deadline).catch(() => null));
      for (const row of rows) {
        if (row === null) continue;
        if (processes.length >= MAX_PROCESSES) {
          truncated = true;
          break;
        }
        processes.push(row);
      }
    }
    if (Date.now() >= deadline) warnings.push("Process sample deadline exceeded; attribution may be missing.");
    if (truncated) warnings.push(`You have more than ${MAX_PROCESSES} processes; only the first ${MAX_PROCESSES} are tracked.`);
    return { processes, warnings };
  }

  async listeningPorts(pids: readonly number[]): Promise<PortScanResult> {
    const [tcp4, tcp6] = await Promise.all([optional(this.fs.readFile("/proc/net/tcp")), optional(this.fs.readFile("/proc/net/tcp6"))]);
    const warnings: string[] = [];
    if (tcp4 === null && tcp6 === null) {
      warnings.push("Listening ports unavailable: /proc/net/tcp is unreadable.");
      return { ports: new Map(), warnings };
    }
    const sockets = [...(tcp4 ? parseProcNetTcp(tcp4) : []), ...(tcp6 ? parseProcNetTcp(tcp6) : [])];
    const byInode = new Map<number, number>();
    for (const socket of sockets) byInode.set(socket.inode, socket.port);
    const ports = new Map<number, number[]>();
    if (byInode.size === 0) return { ports, warnings };
    let denied = 0;
    let fdTruncated = 0;
    await mapLimit(pids, FD_SCAN_CONCURRENCY, async (pid) => {
      const fds = await optional(this.fs.readdir(`/proc/${pid}/fd`));
      if (!fds) {
        denied += 1;
        return;
      }
      if (fds.length > MAX_FDS_PER_PROCESS) fdTruncated += 1;
      const found = new Set<number>();
      const matchedInodes = new Set<number>();
      for (const fd of fds.slice(0, MAX_FDS_PER_PROCESS)) {
        // Every listening socket has been attributed to this process already;
        // the remaining descriptors cannot add a port.
        if (matchedInodes.size === byInode.size) break;
        const link = await optional(this.fs.readlink(`/proc/${pid}/fd/${fd}`));
        if (!link) continue;
        const inode = parseSocketInode(link);
        if (inode === null || matchedInodes.has(inode)) continue;
        const port = byInode.get(inode);
        if (port === undefined) continue;
        matchedInodes.add(inode);
        found.add(port);
      }
      if (found.size > 0) ports.set(pid, [...found].sort((a, b) => a - b));
    });
    if (denied > 0 && denied === pids.length) warnings.push("Listening ports unavailable: file descriptor tables are not readable.");
    if (fdTruncated > 0) {
      warnings.push(
        `${fdTruncated} process(es) have more than ${MAX_FDS_PER_PROCESS} open files; only the first ${MAX_FDS_PER_PROCESS} were checked, so some listening ports may be missing.`,
      );
    }
    return { ports, warnings };
  }

  async freshListeningEndpoints(pid: number) {
    // Both families must be readable so an unknown competing socket cannot be ignored.
    const [tcp4, tcp6, fds] = await Promise.all([this.fs.readFile("/proc/net/tcp"), this.fs.readFile("/proc/net/tcp6"), this.fs.readdir(`/proc/${pid}/fd`)]);
    if (fds.length > MAX_FDS_PER_PROCESS) throw new Error("Browser descriptor ownership is truncated.");
    const rows = [...parseProcTcpEndpoints(tcp4, 4), ...parseProcTcpEndpoints(tcp6, 6)];
    const held = new Set<number>();
    for (const fd of fds) {
      const inode = parseSocketInode(await this.fs.readlink(`/proc/${pid}/fd/${fd}`));
      if (inode !== null) held.add(inode);
    }
    // Keep distinct kernel socket inodes distinct to reject SO_REUSEPORT ambiguity.
    return [...held].flatMap((inode) => provenLoopbackEndpoints(rows, inode));
  }

  /**
   * Null means the process is gone (ENOENT/ESRCH). Any other failure
   * rejects so the guard can refuse rather than treat "unreadable" as
   * "exited".
   */
  async readIdentity(pid: number): Promise<ProcessIdentity | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let status: string;
    let stat: string;
    try {
      [status, stat] = await Promise.all([this.fs.readFile(`/proc/${pid}/status`), this.fs.readFile(`/proc/${pid}/stat`)]);
    } catch (error) {
      if (isGone(error)) return null;
      throw new Error("process identity unreadable");
    }
    const parsedStatus = parseProcStatus(status);
    const fields = parseProcPidStat(stat);
    let cmdline: Buffer;
    try {
      cmdline = await this.fs.readFileBuffer(`/proc/${pid}/cmdline`);
    } catch (error) {
      if (isGone(error)) return null;
      throw new Error("process identity unreadable");
    }
    const executable = await this.fs.readlink(`/proc/${pid}/exe`);
    const cwd = await optional(this.fs.readlink(`/proc/${pid}/cwd`));
    const finalStat = parseProcPidStat(await this.fs.readFile(`/proc/${pid}/stat`));
    const finalStatus = parseProcStatus(await this.fs.readFile(`/proc/${pid}/status`));
    if (finalStat.startTicks !== fields.startTicks || finalStatus.uid !== parsedStatus.uid) throw new Error("process identity changed during read");
    return {
      cwd, executable, comm: finalStat.comm, argv: parseCmdline(cmdline),
      pid: fields.pid,
      ppid: finalStat.ppid,
      uid: parsedStatus.uid,
      startId: String(fields.startTicks),
      argvHash: hashArgv(parseCmdline(cmdline)),
      state: mapState(fields.state),
    };
  }

  /** Whole table, every user, uncapped: ancestor protection depends on it. */
  async readTree(): Promise<TreeRow[]> {
    const pids = await this.listPids();
    const rows = await mapLimit(pids, PROC_READ_CONCURRENCY, async (pid) => {
      const [status, stat] = await Promise.all([optional(this.fs.readFile(`/proc/${pid}/status`)), optional(this.fs.readFile(`/proc/${pid}/stat`))]);
      if (!status || !stat) return null;
      const fields = parseProcPidStat(stat);
      return { pid, ppid: fields.ppid, uid: parseProcStatus(status).uid, startId: String(fields.startTicks) };
    });
    return rows.filter((row): row is TreeRow => row !== null);
  }
}

export async function defaultReadClockTicks(): Promise<number> {
  const { stdout } = await execFileAsync("getconf", ["CLK_TCK"], { timeout: 2000, env: { LC_ALL: "C", PATH: process.env.PATH ?? "" } });
  const value = Number(stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 100;
}
