import { open, readdir, readFile, readlink } from "node:fs/promises";
import { defaultReadClockTicks, parseCmdline, parseProcPidStat, parseProcStatus, parseUptime } from "./linux";
import { mapLimit } from "./platform";
import { wantsEnvironment, type HkProcess, type ProcTable } from "./housekeeping-plan";

/**
 * Housekeeping's own /proc reader (Linux, 0.18.0). Unlike the monitor's
 * sampler it is never silently partial: a PID that exists but can't be read
 * marks the whole table incomplete, and every close and profile removal then
 * refuses. It also reads what the monitor doesn't keep: each process's nice
 * value and, for the browser family only, two environment tags. Environments
 * are read bounded and dropped at once; nothing else in them is kept.
 */

export const MAX_PIDS = 65_536;
export const READ_CONCURRENCY = 16;
export const MAX_ENVIRON_BYTES = 64 * 1024;

export interface HkFs {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string, maxBytes?: number): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

export const realHkFs: HkFs = {
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

const gone = (error: unknown) => { const code = (error as { code?: unknown }).code; return code === "ENOENT" || code === "ESRCH"; };

/** Field 19 of /proc/<pid>/stat (after the last ')'): the nice value. */
export function parseNice(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const value = Number(stat.slice(close + 2).trim().split(/\s+/)[19 - 3]);
  return Number.isInteger(value) && value >= -20 && value <= 19 ? value : null;
}

/** The two tags Housekeeping reads from an environment. Every other variable is ignored. */
export function parseEnvTags(environ: Buffer | string): { agentId: string | null; browserDaemon: boolean } {
  const text = typeof environ === "string" ? environ : environ.toString("utf8");
  // A cut-off final entry (the read hit its bound) is ignored, never half-parsed.
  const complete = text.endsWith("\0") ? text : text.slice(0, text.lastIndexOf("\0") + 1);
  let agentId: string | null = null, browserDaemon = false, conflicting = false;
  for (const entry of complete.split("\0")) {
    const tag = /^PASEO_AGENT_ID=(.*)$/s.exec(entry);
    if (tag) {
      const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tag[1]!) ? tag[1]! : null;
      if (agentId !== null && agentId !== valid) conflicting = true;
      agentId = valid;
    } else if (/^AGENT_BROWSER_DAEMON=./s.test(entry)) browserDaemon = true;
  }
  return { agentId: conflicting ? null : agentId, browserDaemon };
}

export interface ProcReaderOptions { fs?: HkFs; clockTicks?: () => Promise<number>; now?: () => number }

export class ProcReader {
  private readonly fs: HkFs;
  private ticks: Promise<number> | null = null;
  constructor(private readonly uid: number, private readonly options: ProcReaderOptions = {}) { this.fs = options.fs ?? realHkFs; }

  private clockTicks(): Promise<number> {
    this.ticks ??= (this.options.clockTicks ?? defaultReadClockTicks)().catch(() => 100).then((value) => (value > 0 ? value : 100));
    return this.ticks;
  }

  /**
   * Every process in /proc, bounded. Rows of other users carry only
   * pid/ppid/uid/start (enough for ancestry). `complete` is false when any
   * existing PID couldn't be read, the table was too big, or a read failed.
   */
  async scan(signal?: AbortSignal): Promise<ProcTable> {
    let entries: string[];
    try { entries = await this.fs.readdir("/proc"); } catch { return { processes: [], complete: false }; }
    const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
    if (pids.length > MAX_PIDS) return { processes: [], complete: false };
    const [ticks, uptime] = await Promise.all([this.clockTicks(), this.fs.readFile("/proc/uptime").then(parseUptime).catch(() => null)]);
    if (uptime === null) return { processes: [], complete: false };
    let complete = true;
    const rows = await mapLimit(pids, READ_CONCURRENCY, async (pid) => {
      if (signal?.aborted) { complete = false; return null; }
      try { return await this.readOne(pid, ticks, uptime); }
      catch (error) { if (!gone(error)) complete = false; return null; }
    });
    return { processes: rows.filter((row): row is HkProcess => row !== null), complete: complete && !signal?.aborted };
  }

  /** One process, fresh, or null when it has exited. Rejects when it exists but can't be read. */
  async read(pid: number): Promise<HkProcess | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const [ticks, uptime] = await Promise.all([this.clockTicks(), this.fs.readFile("/proc/uptime").then(parseUptime)]);
    try { return await this.readOne(pid, ticks, uptime); }
    catch (error) { if (gone(error)) return null; throw new Error("process unreadable"); }
  }

  private async readOne(pid: number, ticks: number, uptime: number): Promise<HkProcess | null> {
    const stat = await this.fs.readFile(`/proc/${pid}/stat`);
    const status = parseProcStatus(await this.fs.readFile(`/proc/${pid}/status`));
    const fields = parseProcPidStat(stat);
    if (status.uid < 0) throw new Error("uid unreadable");
    const ageSeconds = Math.max(0, uptime - fields.startTicks / ticks);
    const row: HkProcess = { pid: fields.pid, ppid: fields.ppid, uid: status.uid, startId: String(fields.startTicks), exe: null, comm: fields.comm, argv: [], ageSeconds, nice: parseNice(stat), agentId: null, browserDaemon: false, cwd: null };
    if (status.uid !== this.uid) {
      // Foreign processes supply ancestry IDs only. Their paths remain unknown;
      // profile deletion refuses rather than claiming an unreadable process cannot use it.
      row.pathsKnown = false;
      return row;
    }
    // Kernel threads have no cmdline and no exe; both stay empty and nothing ever matches them.
    row.argv = parseCmdline(await this.fs.readFileBuffer(`/proc/${pid}/cmdline`));
    row.exe = await this.fs.readlink(`/proc/${pid}/exe`).catch((error) => { if (gone(error)) throw error; return null; });
    row.cwd = await this.fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
    if (row.argv.length && (!row.exe || !row.cwd)) throw new Error("process paths unreadable");
    if (wantsEnvironment(row)) {
      const environ = await this.fs.readFileBuffer(`/proc/${pid}/environ`, MAX_ENVIRON_BYTES).catch((error) => { if (gone(error)) throw error; return null; });
      if (environ) Object.assign(row, parseEnvTags(environ));
    }
    // The same incarnation from first read to last: a PID reused mid-read is not this process.
    const finalExe = await this.fs.readlink(`/proc/${pid}/exe`).catch(() => null);
    const finalArgv = parseCmdline(await this.fs.readFileBuffer(`/proc/${pid}/cmdline`));
    const finalUid = parseProcStatus(await this.fs.readFile(`/proc/${pid}/status`)).uid;
    if (finalExe !== row.exe || finalArgv.join("\0") !== row.argv.join("\0") || finalUid !== row.uid) throw new Error("program changed during read");
    const finalStat = await this.fs.readFile(`/proc/${pid}/stat`);
    const again = parseProcPidStat(finalStat);
    if (again.startTicks !== fields.startTicks) throw new Error("process changed during read");
    row.nice = parseNice(finalStat);
    row.ppid = again.ppid;
    return row;
  }

}
