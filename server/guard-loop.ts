import { readdir, readFile } from "node:fs/promises";
import {
  AUTO_GUARD_COOLDOWN_SECONDS, AUTO_GUARD_MIN_PERCENT, AUTO_GUARD_SECONDS, GROWTH_WINDOW_SECONDS, TIMEOUT_WINDOW_MINUTES,
  growthOver, memoryLevel, pressureSentence, type AutoStop, type GrowthPoint, type GuardState, type MemoryLevel, type MemorySignal,
} from "../shared/guard";
import { readCgroup, type CgroupFs } from "./cgroup";
import { DaemonLogTail, PluginLogState } from "./daemon-log";
import { parseMeminfo, parseProcPidStat, parseProcStatus } from "./linux";
import { mapLimit, type PlatformAdapter } from "./platform";
import { disksFor } from "./disk-scan";
import type { DiskSpace } from "../shared/disk";

/**
 * The daemon-side check loop (0.13.0). It starts when the plugin loads and
 * runs on a fixed beat whether or not anyone has Paseo open, because the
 * moment it matters most is when the daemon is too starved to answer the app.
 * Each pass has a small, fixed cost: a handful of tiny /proc and cgroup
 * files, one short read per process, and at most 1 MB of new daemon log.
 *
 * It keeps:
 *  - memory pressure (PSI some/full, OOM kills, share of the limit), and since
 *    when it has been critical;
 *  - each process's memory over the last few minutes, for "growing fast";
 *  - what the daemon's log says about plugins (timeouts, launches).
 * And, only when the person turned it on, the auto-guard: after memory has
 * been critical for over a minute, stop the biggest process Hosts is already
 * allowed to stop (through the same checked, logged stop as the button).
 */

export interface QuickProcess { pid: number; startId: string; rssBytes: number }
export interface QuickSample {
  at: number;
  signal: MemorySignal;
  /** What shares are measured against: the container's limit when it has one, else the machine. */
  basisBytes: number;
  usedBytes: number;
  processes: QuickProcess[];
}
export interface QuickSampler { sample(): Promise<QuickSample> }

export interface ProcFs extends CgroupFs { readdir(path: string): Promise<string[]> }
const realProcFs: ProcFs = { readFile: (path) => readFile(path, "utf8"), readdir: (path) => readdir(path) };

/**
 * Linux, straight from procfs and the cgroup: no child processes, no
 * listening-port scan. Only processes owned by `uid` are measured.
 */
export class LinuxQuickSampler implements QuickSampler {
  private oomKills: number | null = null;
  constructor(private readonly uid: number, private readonly fs: ProcFs = realProcFs, private readonly now: () => number = Date.now) {}

  async sample(): Promise<QuickSample> {
    const at = this.now();
    const meminfo = parseMeminfo(await this.fs.readFile("/proc/meminfo").catch(() => ""));
    const cgroup = await readCgroup(meminfo.totalBytes, this.fs).catch(() => null);
    let some10: number | null = cgroup?.psiMemorySome10 ?? null;
    let full10: number | null = cgroup?.psiMemoryFull10 ?? null;
    if (some10 === null && full10 === null) {
      const text = await this.fs.readFile("/proc/pressure/memory").catch(() => null);
      if (text) { some10 = matchAvg(text, "some"); full10 = matchAvg(text, "full"); }
    }
    const limit = cgroup?.memoryLimitBytes ?? null;
    const basisBytes = limit ?? meminfo.totalBytes;
    const usedBytes = limit !== null ? cgroup!.memoryWorkingSetBytes : Math.max(0, meminfo.totalBytes - meminfo.availableBytes);
    const kills = cgroup?.oomKills ?? null;
    const newOomKills = kills !== null && this.oomKills !== null ? Math.max(0, kills - this.oomKills) : 0;
    if (kills !== null) this.oomKills = kills;
    const processes = await this.processes();
    return { at, signal: { some10, full10, percent: basisBytes > 0 ? (usedBytes / basisBytes) * 100 : null, newOomKills }, basisBytes, usedBytes, processes };
  }

  private async processes(): Promise<QuickProcess[]> {
    let entries: string[];
    try { entries = await this.fs.readdir("/proc"); } catch { return []; }
    const pids = entries.filter((entry) => /^\d+$/.test(entry)).slice(0, 4096);
    const rows = await mapLimit(pids, 16, async (pid): Promise<QuickProcess | null> => {
      try {
        const status = parseProcStatus(await this.fs.readFile(`/proc/${pid}/status`));
        if (status.uid !== this.uid || !status.rssBytes) return null;
        const stat = parseProcPidStat(await this.fs.readFile(`/proc/${pid}/stat`));
        return { pid: stat.pid, startId: String(stat.startTicks), rssBytes: status.rssBytes };
      } catch { return null; }
    });
    return rows.filter((row): row is QuickProcess => row !== null);
  }
}

const matchAvg = (text: string, kind: "some" | "full") => { const match = new RegExp(`^${kind}\\s+avg10=([\\d.]+)`, "m").exec(text); return match ? Number(match[1]) : null; };

/** Elsewhere (macOS): the platform adapter's own readings, which have no PSI. */
export class AdapterQuickSampler implements QuickSampler {
  constructor(private readonly adapter: PlatformAdapter, private readonly uid: number, private readonly now: () => number = Date.now) {}
  async sample(): Promise<QuickSample> {
    const [system, processes] = await Promise.all([this.adapter.sampleSystem(), this.adapter.sampleProcesses(this.uid)]);
    const usedBytes = Math.max(0, system.memoryTotalBytes - system.memoryAvailableBytes);
    const percent = system.memoryTotalBytes > 0 ? (usedBytes / system.memoryTotalBytes) * 100 : null;
    // macOS has no PSI; its own level is carried as it is, never as an invented percentage.
    return {
      at: this.now(), basisBytes: system.memoryTotalBytes, usedBytes,
      signal: { some10: system.psiMemorySome10, full10: system.psiMemoryFull10 ?? null, percent, newOomKills: 0, osLevel: system.pressureSignal },
      processes: processes.processes.map((raw) => ({ pid: raw.pid, startId: raw.startId, rssBytes: raw.rssBytes })),
    };
  }
}

/** Each process's memory over the growth window, keyed by PID and start identity so a reused PID starts afresh. */
export class GrowthTracker {
  private readonly points = new Map<string, GrowthPoint[]>();
  record(at: number, processes: readonly QuickProcess[]): void {
    const live = new Set<string>();
    for (const process of processes) {
      const key = `${process.pid}:${process.startId}`;
      live.add(key);
      const list = this.points.get(key) ?? [];
      list.push({ at, rssBytes: process.rssBytes });
      while (list.length > 2 && at - list[0]!.at > (GROWTH_WINDOW_SECONDS + 60) * 1000) list.shift();
      this.points.set(key, list);
    }
    for (const key of this.points.keys()) if (!live.has(key)) this.points.delete(key);
  }
  growth(pid: number, startId: string, now: number): number | null {
    const list = this.points.get(`${pid}:${startId}`);
    return list ? growthOver(list, now) : null;
  }
  /** Growth by PID alone, for callers that only know the PID (the newest incarnation wins). */
  growthByPid(pid: number, now: number): number | null {
    for (const [key, list] of this.points) if (key.startsWith(`${pid}:`)) return growthOver(list, now);
    return null;
  }
}

export interface GuardLoopOptions {
  sampler: QuickSampler;
  tail?: DaemonLogTail;
  logState?: PluginLogState;
  readSettings: () => Promise<{ autoStopRunaways: boolean }>;
  /**
   * Stops the biggest process Hosts may stop that holds at least `minPercent`
   * of memory; null when there is none. It must call `confirm` immediately
   * before each signal it sends (the SIGKILL follow-up included) and send
   * nothing when it answers false.
   */
  autoStop?: (minPercent: number, confirm: () => Promise<boolean>) => Promise<AutoStop | null>;
  /** Whether "Restart" can be offered on this host at all (the paseo command can reload plugins). */
  restartCheck?: () => Promise<{ ok: boolean; reason: string | null }>;
  /** Told about every automatic stop (the status dot reads the state). */
  onAutoStop?: (stop: AutoStop) => void;
  now?: () => number;
  intervalMs?: number;
  /** How long a pass waits for an automatic stop before moving on (tests shorten it). */
  autoStopLimitMs?: number;
  /**
   * 0.14.0: folders whose disks to watch (Paseo's home, workspaces). Each pass
   * calls stat and statfs on them and nothing else: never a directory walk.
   */
  diskPaths?: () => readonly string[];
  /** statfs, swappable in tests. */
  disks?: (paths: readonly string[]) => Promise<DiskSpace[]>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const GUARD_INTERVAL_MS = 10_000;
/** No step of a pass may wait longer than this: anything that goes through the daemon can hang when the machine is starved. */
export const STEP_LIMIT_MS = 5_000;
/** The automatic stop reads every process and the project list; it gets longer, but not forever. */
export const AUTO_STOP_LIMIT_MS = 30_000;

/** The promise's value, or `fallback` once `ms` pass. The slow work isn't cancelled; the loop just stops waiting for it. */
export function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

export class GuardLoop {
  readonly logState: PluginLogState;
  readonly growth = new GrowthTracker();
  private readonly tail: DaemonLogTail;
  private readonly now: () => number;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private last: QuickSample | null = null;
  private level: MemoryLevel = "normal";
  private criticalSince: number | null = null;
  private lastAuto: AutoStop | null = null;
  private lastAutoAttempt = -Infinity;
  private autoEnabled = false;
  /** The automatic stop in progress, if any: only one at a time, however long it takes. */
  private autoInFlight: Promise<unknown> | null = null;
  /** When the last good sample was taken; a gap breaks the critical streak. */
  private lastSampleAt: number | null = null;
  /** Offered until the check says otherwise: a restart re-checks the paseo command itself and says why if it can't. */
  private restart: { ok: boolean; reason: string | null; at: number } = { ok: true, reason: null, at: 0 };
  private checkedAt = 0;
  private diskReadings: DiskSpace[] = [];

  constructor(private readonly options: GuardLoopOptions) {
    this.now = options.now ?? Date.now;
    this.tail = options.tail ?? new DaemonLogTail();
    this.logState = options.logState ?? new PluginLogState();
  }

  start(): void {
    if (this.timer || this.closed) return;
    const set = this.options.setTimer ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer; });
    const loop = () => {
      this.timer = set(() => { void this.tick().finally(() => { if (!this.closed) loop(); }); }, this.options.intervalMs ?? GUARD_INTERVAL_MS);
    };
    void this.tick().finally(() => { if (!this.closed) loop(); });
  }

  /** Stops the loop and disarms any automatic stop still in progress: its confirm() answers false from now on. */
  close(): void {
    this.closed = true;
    if (this.timer) (this.options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** One pass; overlapping calls share it. Never throws. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch((error) => { console.error("daemon-link: guard pass failed", error instanceof Error ? error.name : "unknown"); }).finally(() => { this.running = null; });
    return this.running;
  }

  /** Read the log again now (a restart waiting for "Plugin ready"). */
  async pollLog(): Promise<void> { await this.tail.poll((event) => this.logState.feed(event)); }

  private async pass(): Promise<void> {
    const sample = await bounded(this.options.sampler.sample(), STEP_LIMIT_MS, null);
    const now = this.now();
    if (sample) {
      // 0.13.0 safety review: "critical for over a minute" has to be measured. A gap with no
      // readings (a stalled loop) starts the streak again rather than counting as critical.
      const gap = this.lastSampleAt !== null && now - this.lastSampleAt > maxSampleGap(this.options.intervalMs ?? GUARD_INTERVAL_MS);
      this.lastSampleAt = now;
      this.last = sample;
      this.growth.record(sample.at, sample.processes);
      this.level = memoryLevel(sample.signal);
      this.criticalSince = this.level === "critical" ? (gap ? now : this.criticalSince ?? now) : null;
    } else {
      // A failed or timed-out reading breaks the streak: memory may have recovered meanwhile.
      this.criticalSince = null;
      this.lastSampleAt = null;
    }
    await bounded(this.pollLog(), STEP_LIMIT_MS, undefined);
    if (this.options.diskPaths) {
      const read = await bounded((this.options.disks ?? disksFor)(this.options.diskPaths().slice(0, 32)), STEP_LIMIT_MS, null);
      if (read) this.diskReadings = read;
    }
    if (now - this.restart.at > 5 * 60_000 && this.options.restartCheck) {
      this.restart = { ...(await bounded(this.options.restartCheck(), 20_000, { ok: false, reason: "Hosts couldn't check whether plugins can be restarted here." })), at: now };
    }
    this.checkedAt = now;
    // A settings read that can't answer keeps the last known choice (off until one has been read).
    const settings = await bounded(this.options.readSettings(), STEP_LIMIT_MS, { autoStopRunaways: this.autoEnabled });
    this.autoEnabled = settings.autoStopRunaways === true;
    if (!this.closed && !this.autoInFlight && this.options.autoStop && shouldAutoStop({ enabled: this.autoEnabled, level: this.level, criticalSince: this.criticalSince, lastAttempt: this.lastAutoAttempt, now })) {
      this.lastAutoAttempt = now;
      const run = this.options.autoStop(AUTO_GUARD_MIN_PERCENT, () => this.confirmAutoStop()).catch(() => null);
      // A stop that finishes after the loop stopped waiting still counts (and is still reported); a new one waits for it.
      this.autoInFlight = run.then((stopped) => { if (stopped) { this.lastAuto = stopped; this.options.onAutoStop?.(stopped); } }).finally(() => { this.autoInFlight = null; });
      await bounded(this.autoInFlight, this.options.autoStopLimitMs ?? AUTO_STOP_LIMIT_MS, undefined);
    }
  }

  /**
   * Asked immediately before every automatic signal: is the guard still on,
   * is memory critical in a reading taken right now, and is the loop still
   * running? A settings read or a reading that fails or times out is a no.
   */
  async confirmAutoStop(): Promise<boolean> {
    if (this.closed) return false;
    const settings = await bounded(this.options.readSettings(), STEP_LIMIT_MS, null);
    if (this.closed || settings?.autoStopRunaways !== true) return false;
    const sample = await bounded(this.options.sampler.sample(), STEP_LIMIT_MS, null);
    if (this.closed || !sample) return false;
    return memoryLevel(sample.signal) === "critical";
  }

  /** The latest reading, for the health verdict and the screens. Cheap: no I/O. */
  state(): GuardState {
    const now = this.now();
    const signal = this.last?.signal ?? { some10: null, full10: null, percent: null, newOomKills: 0 };
    return {
      checkedAt: this.checkedAt || now,
      logReadable: this.tail.readable && this.logState.events > 0,
      plugins: this.logState.stuck(now).map((plugin) => ({
        id: plugin.id, name: plugin.name, timeouts: plugin.timeouts, windowMinutes: TIMEOUT_WINDOW_MINUTES, lastAt: plugin.lastAt, stopping: plugin.stopping, severity: plugin.severity,
        restartable: this.restart.ok, reason: this.restart.ok ? null : this.restart.reason,
      })),
      slowPluginRequests: this.logState.slowRequests(now),
      memory: { level: this.level, some10: signal.some10, full10: signal.full10, percent: signal.percent === null ? null : Math.round(signal.percent * 10) / 10, criticalSince: this.criticalSince, sentence: pressureSentence(signal, this.level) },
      autoGuard: { enabled: this.autoEnabled, last: this.lastAuto },
      disks: this.diskReadings,
    };
  }

  /** Bytes a process added over the growth window, or null with too little history. */
  growthOf(pid: number, startId?: string): number | null {
    return startId ? this.growth.growth(pid, startId, this.now()) : this.growth.growthByPid(pid, this.now());
  }
}

/** The longest gap between readings that still counts as one unbroken streak. */
export function maxSampleGap(intervalMs: number): number { return Math.max(30_000, intervalMs * 3); }

/**
 * The auto-guard's rule, pure: only when switched on, only after memory has
 * been critical for AUTO_GUARD_SECONDS, and at most once per cooldown so the
 * last stop has time to free its memory.
 */
export function shouldAutoStop(input: { enabled: boolean; level: MemoryLevel; criticalSince: number | null; lastAttempt: number; now: number }): boolean {
  if (!input.enabled || input.level !== "critical" || input.criticalSince === null) return false;
  if (input.now - input.criticalSince < AUTO_GUARD_SECONDS * 1000) return false;
  return input.now - input.lastAttempt >= AUTO_GUARD_COOLDOWN_SECONDS * 1000;
}
