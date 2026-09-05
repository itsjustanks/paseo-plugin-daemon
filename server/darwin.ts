import { execFile } from "node:child_process";
import { cpus, loadavg, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { hashArgv } from "./redaction";
import {
  mapLimit,
  mapState,
  type PlatformAdapter,
  type PortScanResult,
  type ProcessIdentity,
  type RawProcess,
  type RawSystemSample,
  type TreeRow,
} from "./platform";

const execFileAsync = promisify(execFile);

/** Fixed-argv only. No shell, no interpolation, a small deterministic env. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;

const EXEC_ENV = { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

export const defaultExec: Exec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { env: EXEC_ENV, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

export const CWD_LOOKUP_CONCURRENCY = 4;
export const MAX_CWD_LOOKUPS = 64;

/** `ps -axo pid=,ppid=,uid=,lstart=`: three numbers then the five lstart tokens. */
export const PS_TREE_FORMAT = "pid=,ppid=,uid=,lstart=";

export function parsePsTree(text: string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 8) continue;
    const [pid, ppid, uid] = tokens.slice(0, 3).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(uid)) continue;
    rows.push({ pid: pid!, ppid: ppid!, uid: uid!, startId: tokens.slice(3, 8).join(" ") });
  }
  return rows;
}

/** A `ps -p <pid>` that exits 1 with no other failure means "no such process". */
function psSaysGone(error: unknown): boolean {
  const e = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
  return e.code === 1 && !e.killed && !e.signal && !(typeof e.stderr === "string" && e.stderr.trim().length > 0);
}

// ------------------------------------------------------------------ parsers

/** `ps` TIME: `[[DD-]HH:]MM:SS[.ss]`. */
export function parsePsTime(text: string): number {
  let days = 0;
  let rest = text.trim();
  const dash = rest.indexOf("-");
  if (dash > 0) {
    days = Number(rest.slice(0, dash)) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86400 + seconds;
}

export interface PsRow {
  pid: number;
  ppid: number;
  uid: number;
  state: string;
  rssBytes: number;
  cpuSeconds: number;
  ageSeconds: number;
  lstart: string;
  command: string;
}

export const PS_FORMAT = "pid=,ppid=,uid=,state=,rss=,time=,etime=,lstart=,command=";

/**
 * One line of `ps -axo pid=,ppid=,uid=,state=,rss=,time=,etime=,lstart=,command=`.
 * The first seven tokens are fixed; `lstart` is five tokens (weekday, month,
 * day, clock, year); everything after is the command as `ps` joined it.
 */
export function parsePsLine(line: string): PsRow | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 13) return null;
  const [pid, ppid, uid, state, rss, time, etime, ...tail] = tokens;
  const lstart = tail.slice(0, 5).join(" ");
  const command = tail.slice(5).join(" ");
  const row: PsRow = {
    pid: Number(pid),
    ppid: Number(ppid),
    uid: Number(uid),
    state: state ?? "?",
    rssBytes: (Number(rss) || 0) * 1024,
    cpuSeconds: parsePsTime(time ?? "0"),
    ageSeconds: parsePsTime(etime ?? "0"),
    lstart,
    command,
  };
  if (!Number.isFinite(row.pid) || !Number.isFinite(row.uid)) return null;
  return row;
}

export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = parsePsLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

export interface VmStat {
  pageSize: number;
  free: number;
  active: number;
  inactive: number;
  speculative: number;
  wired: number;
  compressed: number;
  purgeable: number;
  fileBacked: number;
}

export function parseVmStat(text: string): VmStat {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };
  return {
    pageSize,
    free: pages("Pages free"),
    active: pages("Pages active"),
    inactive: pages("Pages inactive"),
    speculative: pages("Pages speculative"),
    wired: pages("Pages wired down"),
    compressed: pages("Pages occupied by compressor"),
    purgeable: pages("Pages purgeable"),
    fileBacked: pages("File-backed pages"),
  };
}

/**
 * "Available" on macOS is an estimate. Free + inactive + speculative +
 * purgeable is the honest, conservative reading used by Activity Monitor-like
 * tools; we do not count the compressor.
 */
export function availableBytesFromVmStat(vm: VmStat): number {
  return (vm.free + vm.inactive + vm.speculative + vm.purgeable) * vm.pageSize;
}

/** `sysctl -n vm.swapusage` → "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)". */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } {
  const read = (label: string) => {
    const match = new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT]?)`).exec(text);
    if (!match) return 0;
    const unit = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2] ?? ""] ?? 1;
    return Number(match[1]) * unit;
  };
  return { totalBytes: read("total"), usedBytes: read("used") };
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressureLevel(text: string): "normal" | "warn" | "critical" | null {
  const value = Number(text.trim());
  if (value === 1) return "normal";
  if (value === 2) return "warn";
  if (value === 4) return "critical";
  return null;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pn` field output: `p<pid>` starts a process
 * block, `n<addr>` lines carry `host:port` names.
 */
export function parseLsofListen(text: string): Map<number, number[]> {
  const result = new Map<number, Set<number>>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (!Number.isFinite(pid)) pid = null;
    } else if (line.startsWith("n") && pid !== null) {
      const name = line.slice(1);
      const port = Number(name.slice(name.lastIndexOf(":") + 1));
      if (!Number.isFinite(port) || port <= 0) continue;
      let set = result.get(pid);
      if (!set) result.set(pid, (set = new Set()));
      set.add(port);
    }
  }
  const ports = new Map<number, number[]>();
  for (const [key, set] of result) ports.set(key, [...set].sort((a, b) => a - b));
  return ports;
}

/** `lsof -a -p <pid> -d cwd -F n` → the `n` line. */
export function parseLsofCwd(text: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith("n")) return line.slice(1) || null;
  return null;
}

// ------------------------------------------------------------------ adapter

export interface DarwinAdapterOptions {
  exec?: Exec;
  /** How often `lsof` may run for ports (ms). */
  portCacheMs?: number;
  now?: () => number;
}

export class DarwinAdapter implements PlatformAdapter {
  readonly platform = "darwin" as const;
  private readonly exec: Exec;
  private readonly portCacheMs: number;
  private readonly now: () => number;
  private portCache: { at: number; result: PortScanResult } | null = null;
  private lsofMissing = false;

  constructor(options: DarwinAdapterOptions = {}) {
    this.exec = options.exec ?? defaultExec;
    this.portCacheMs = options.portCacheMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  async sampleSystem(): Promise<RawSystemSample> {
    const [vm, swap, level] = await Promise.all([
      this.exec("vm_stat", []).catch(() => ""),
      this.exec("sysctl", ["-n", "vm.swapusage"]).catch(() => ""),
      this.exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(() => ""),
    ]);
    let busy = 0;
    let total = 0;
    for (const cpu of cpus()) {
      const t = cpu.times;
      busy += t.user + t.nice + t.sys + t.irq;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
    const memoryTotalBytes = totalmem();
    const available = vm ? availableBytesFromVmStat(parseVmStat(vm)) : 0;
    const swapUsage = parseSwapUsage(swap);
    return {
      cpuBusy: busy,
      cpuTotal: total,
      cores: Math.max(1, cpus().length),
      load1,
      load5,
      load15,
      psiCpuSome10: null,
      psiMemorySome10: null,
      memoryTotalBytes,
      memoryAvailableBytes: Math.min(memoryTotalBytes, available),
      swapTotalBytes: swapUsage.totalBytes,
      swapUsedBytes: swapUsage.usedBytes,
      pressureSignal: parsePressureLevel(level),
      uptimeSeconds: uptime(),
    };
  }

  /** Null when `ps` failed, timed out, or overflowed its buffer. */
  private async psRows(): Promise<PsRow[] | null> {
    try {
      return parsePsOutput(await this.exec("ps", ["-axo", PS_FORMAT]));
    } catch {
      return null;
    }
  }

  private toRaw(row: PsRow, cwd: string | null): RawProcess {
    // `ps` joins argv with spaces; the split below is best-effort for display
    // and identity hashing. Quoted arguments cannot be recovered exactly.
    const argv = row.command ? row.command.split(" ") : [];
    return {
      pid: row.pid,
      ppid: row.ppid,
      uid: row.uid,
      comm: argv[0]?.split("/").pop() ?? "",
      argv,
      argvLossy: true,
      state: mapState(row.state),
      cpuSeconds: row.cpuSeconds,
      startId: row.lstart,
      rssBytes: row.rssBytes,
      ageSeconds: row.ageSeconds,
      cwd,
    };
  }

  /**
   * Same-user processes. `ps` lists every user (macOS `ps -U` cannot be
   * combined with `-x` portably, and the fixed-argv all-user read is what the
   * tree walk needs anyway); the filter happens here. A failed `ps` degrades
   * to an empty list with a warning rather than failing the snapshot.
   */
  async sampleProcesses(uid: number): Promise<{ processes: RawProcess[]; warnings: string[] }> {
    const all = await this.psRows();
    if (all === null) return { processes: [], warnings: ["Process list unavailable: `ps` failed or timed out."] };
    const rows = all.filter((row) => row.uid === uid);
    const warnings: string[] = [];
    // cwd is only resolved for listening candidates (see listeningPorts) to
    // keep `lsof` invocations bounded; everything else reports null.
    const ports = await this.listeningPorts(rows.map((row) => row.pid));
    warnings.push(...ports.warnings);
    const candidates = rows.filter((row) => ports.ports.has(row.pid)).slice(0, MAX_CWD_LOOKUPS);
    const cwds = new Map<number, string | null>();
    if (!this.lsofMissing) {
      await mapLimit(candidates, CWD_LOOKUP_CONCURRENCY, async (row) => {
        const out = await this.exec("lsof", ["-a", "-p", String(row.pid), "-d", "cwd", "-F", "n"]).catch(() => "");
        cwds.set(row.pid, parseLsofCwd(out));
      });
    }
    return { processes: rows.map((row) => this.toRaw(row, cwds.get(row.pid) ?? null)), warnings };
  }

  async listeningPorts(pids: readonly number[]): Promise<PortScanResult> {
    const now = this.now();
    if (this.portCache && now - this.portCache.at < this.portCacheMs) return this.portCache.result;
    const wanted = new Set(pids);
    let result: PortScanResult;
    try {
      const all = parseLsofListen(await this.exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]));
      const ports = new Map<number, number[]>();
      for (const [pid, list] of all) if (wanted.has(pid)) ports.set(pid, list);
      result = { ports, warnings: [] };
      this.lsofMissing = false;
    } catch (error) {
      // lsof exits 1 when nothing matches; treat that as "no listeners" only
      // when it produced no stderr. Anything else degrades with a warning.
      const code = (error as { code?: unknown }).code;
      const missing = code === "ENOENT";
      this.lsofMissing = missing;
      result = {
        ports: new Map(),
        warnings: [missing ? "Listening ports unavailable: `lsof` is not installed." : "Listening ports unavailable: `lsof` failed or was denied."],
      };
    }
    this.portCache = { at: now, result };
    return result;
  }

  /**
   * Null only when `ps` reports no such process; any other failure rejects
   * so the guard refuses instead of mistaking a broken read for an exit.
   */
  async readIdentity(pid: number): Promise<ProcessIdentity | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let out: string;
    try {
      out = await this.exec("ps", ["-o", PS_FORMAT, "-p", String(pid)]);
    } catch (error) {
      if (psSaysGone(error)) return null;
      throw new Error("process identity unreadable");
    }
    const row = parsePsOutput(out).find((r) => r.pid === pid);
    if (!row) return null;
    return {
      pid: row.pid,
      ppid: row.ppid,
      uid: row.uid,
      startId: row.lstart,
      argvHash: hashArgv(row.command ? row.command.split(" ") : []),
      state: mapState(row.state),
    };
  }

  /** Whole table, every user, with lstart so descendants can be re-verified. Rejects on failure. */
  async readTree(): Promise<TreeRow[]> {
    let out: string;
    try {
      out = await this.exec("ps", ["-axo", PS_TREE_FORMAT]);
    } catch {
      throw new Error("process table unreadable");
    }
    return parsePsTree(out);
  }
}
