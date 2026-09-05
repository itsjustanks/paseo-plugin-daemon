import type { ProcessView, Snapshot, SnapshotInput } from "../shared/contracts";
import { SnapshotInputSchema } from "../shared/contracts";
import { classifyCpuPressure, classifyMemoryPressure, classifyProcessImpact, detectService } from "./heuristics";
import type { ProjectScope } from "./scope";
import type { Clock, PlatformAdapter, RawProcess, RawSystemSample } from "./platform";
import { systemClock } from "./platform";
import { displayCommand, displayName, hashArgv, homeRelative } from "./redaction";

/**
 * Turns raw adapter samples into one synchronized snapshot. Keeps just enough
 * history to explain pressure (CPU deltas, moving averages, RSS growth) and
 * prunes everything that exits. All bounds are constants below.
 */

export const SNAPSHOT_CACHE_MS = 1000;
export const PORT_CACHE_MS = 5000;
export const HISTORY_WINDOW_MS = 60_000;
export const HISTORY_MAX_POINTS = 40;
export const MAX_SERVICES = 50;
export const MAX_TRACKED_PROCESSES = 4096;
export const CPU_EMA_ALPHA = 0.3;

const SYSTEM_CPU_HIGH = 85;
const PROCESS_CPU_HIGH = 30;

export interface ActionPolicy {
  /** Decide from a same-user sample whether a process may be signalled. */
  evaluate(process: RawProcess, sampleTree: ReadonlyMap<number, RawProcess>): { actionable: boolean; reason: string | null };
  /** Mint an opaque token bound to this exact process incarnation. */
  mint(process: RawProcess, argvHash: string, now: number): string;
}

interface Point {
  at: number;
  value: number;
}

interface TrackedProcess {
  key: string;
  lastCpuSeconds: number;
  lastAt: number;
  cpuPercent: number | null;
  cpuEma: number | null;
  highSince: number | null;
  rss: Point[];
  seen: number;
}

interface SystemHistory {
  last: { at: number; busy: number; total: number } | null;
  cpuPercent: number | null;
  cpuEma: number | null;
  highSince: number | null;
  swap: Point[];
}

export interface CollectorOptions {
  adapter: PlatformAdapter;
  policy: ActionPolicy;
  uid: number;
  home: string;
  clock?: Clock;
  cacheMs?: number;
  portCacheMs?: number;
  scope?: ProjectScope;
}

interface ClassifiedBase {
  at: number;
  sampling: Snapshot["sampling"];
  warnings: string[];
  uptimeSeconds: number;
  cpu: Snapshot["cpu"];
  memory: Snapshot["memory"];
  processes: ProcessView[];
}

function pushPoint(points: Point[], point: Point, now: number): void {
  points.push(point);
  while (points.length > HISTORY_MAX_POINTS || (points.length > 0 && now - points[0]!.at > HISTORY_WINDOW_MS)) points.shift();
}

function growth(points: Point[]): { delta: number | null; seconds: number } {
  if (points.length < 2) return { delta: null, seconds: 0 };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return { delta: last.value - first.value, seconds: (last.at - first.at) / 1000 };
}

export class Collector {
  private readonly scope?: ProjectScope;
  private readonly adapter: PlatformAdapter;
  private readonly policy: ActionPolicy;
  private readonly uid: number;
  private readonly home: string;
  private readonly clock: Clock;
  private readonly cacheMs: number;
  private readonly portCacheMs: number;
  private readonly tracked = new Map<string, TrackedProcess>();
  private readonly system: SystemHistory = { last: null, cpuPercent: null, cpuEma: null, highSince: null, swap: [] };
  private base: ClassifiedBase | null = null;
  private inflight: Promise<ClassifiedBase> | null = null;
  private portCache: { at: number; ports: Map<number, number[]>; warnings: string[] } | null = null;

  constructor(options: CollectorOptions) {
    this.scope = options.scope;
    this.adapter = options.adapter;
    this.policy = options.policy;
    this.uid = options.uid;
    this.home = options.home;
    this.clock = options.clock ?? systemClock;
    this.cacheMs = options.cacheMs ?? SNAPSHOT_CACHE_MS;
    this.portCacheMs = options.portCacheMs ?? PORT_CACHE_MS;
  }

  /** Bounded view over the cached base: filter, sort, page. */
  async snapshot(rawInput: SnapshotInput): Promise<Snapshot> {
    const input = SnapshotInputSchema.parse(rawInput);
    const base = await this.collect();
    const query = input.query.trim().toLowerCase();
    const visible = this.scope ? base.processes.filter((p) => p.project) : base.processes;
    const matched = query ? visible.filter((p) => matches(p, query) || p.project?.name.toLowerCase().includes(query)) : visible;
    const sorted = [...matched].sort(comparator(input.sort));
    const defaultDirection = ["name", "pid"].includes(input.sort) ? "asc" : "desc";
    if (input.direction && input.direction !== defaultDirection) sorted.reverse();
    const offset = input.offset || 0;
    const page = sorted.slice(offset, offset + input.limit);
    const services = visible
      .filter((p) => p.service !== null && (!this.scope || p.project?.shareable))
      .sort((a, b) => (a.ports[0] ?? 1 << 20) - (b.ports[0] ?? 1 << 20) || a.pid - b.pid)
      .slice(0, MAX_SERVICES);
    return {
      ...(this.scope ? { scope: this.scope.status(), hiddenProcesses: base.processes.length - visible.length } : {}),
      timestamp: base.at,
      sampling: base.sampling,
      platform: this.adapter.platform,
      supported: true,
      warnings: base.warnings,
      uptimeSeconds: base.uptimeSeconds,
      cpu: base.cpu,
      memory: base.memory,
      services,
      processes: page,
      totalProcesses: visible.length,
      matchedProcesses: matched.length,
      truncated: page.length < matched.length,
    };
  }

  invalidate() { this.base = null; }

  /** One collection at a time; concurrent callers share it. */
  collect(): Promise<ClassifiedBase> {
    const now = this.clock.now();
    if (this.base && now - this.base.at < this.cacheMs) return Promise.resolve(this.base);
    if (this.inflight) return this.inflight;
    this.inflight = this.collectUncached()
      .then((base) => {
        this.base = base;
        return base;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async ports(pids: number[]): Promise<{ ports: Map<number, number[]>; warnings: string[] }> {
    const now = this.clock.now();
    if (this.portCache && now - this.portCache.at < this.portCacheMs) return this.portCache;
    const result = await this.adapter.listeningPorts(pids);
    this.portCache = { at: now, ports: result.ports, warnings: result.warnings };
    return this.portCache;
  }

  private async collectUncached(): Promise<ClassifiedBase> {
    const [system, sampled] = await Promise.all([this.adapter.sampleSystem(), this.adapter.sampleProcesses(this.uid)]);
    const at = this.clock.now();
    const warnings = [...sampled.warnings];
    // Adapters already return only same-user rows, so this cap never lets
    // other users' processes crowd ours out.
    const processes = sampled.processes.slice(0, MAX_TRACKED_PROCESSES);
    if (sampled.processes.length > MAX_TRACKED_PROCESSES) warnings.push(`You have more than ${MAX_TRACKED_PROCESSES} processes; only the first ${MAX_TRACKED_PROCESSES} are tracked.`);
    const portScan = await this.ports(processes.map((p) => p.pid));
    warnings.push(...portScan.warnings);

    const cpu = this.updateSystem(system, at);
    const memory = this.memoryView(system, at);
    const sampling: Snapshot["sampling"] = cpu.percent === null ? "sampling" : "live";

    const byPid = new Map<number, RawProcess>();
    for (const p of processes) byPid.set(p.pid, p);

    const live = new Set<string>();
    const measured = processes.map((raw) => {
      const track = this.updateProcess(raw, at, system.cores);
      live.add(track.key);
      const rssGrowth = growth(track.rss);
      return { raw, track, rssGrowth };
    });
    for (const key of this.tracked.keys()) if (!live.has(key)) this.tracked.delete(key);

    const cpuOrder = [...measured].sort((a, b) => (b.track.cpuEma ?? b.track.cpuPercent ?? 0) - (a.track.cpuEma ?? a.track.cpuPercent ?? 0));
    const memoryOrder = [...measured].sort((a, b) => b.raw.rssBytes - a.raw.rssBytes);
    const cpuRank = new Map(cpuOrder.map((m, i) => [m.track.key, i]));
    const memoryRank = new Map(memoryOrder.map((m, i) => [m.track.key, i]));

    const views: ProcessView[] = measured.map(({ raw, track, rssGrowth }) => {
      const memoryPercent = system.memoryTotalBytes > 0 ? Math.min(100, (raw.rssBytes / system.memoryTotalBytes) * 100) : 0;
      const impact = classifyProcessImpact({
        cpuPercent: track.cpuPercent,
        cpuSustainedPercent: track.cpuEma,
        cpuSustainedSeconds: track.highSince === null ? 0 : (at - track.highSince) / 1000,
        memoryPercent,
        rssGrowthBytes: rssGrowth.delta,
        rssWindowSeconds: rssGrowth.seconds,
        cpuRank: cpuRank.get(track.key) ?? Number.MAX_SAFE_INTEGER,
        memoryRank: memoryRank.get(track.key) ?? Number.MAX_SAFE_INTEGER,
        systemCpuPressure: cpu.pressure,
        systemMemoryPressure: memory.pressure,
      });
      const ports = portScan.ports.get(raw.pid) ?? [];
      const service = detectService(raw.argv, ports);
      const project = this.scope?.match(raw, ports) ?? null;
      const baseDecision = this.policy.evaluate(raw, byPid);
      const decision = this.scope && baseDecision.actionable && !project?.canStop
        ? { actionable: false, reason: project?.kind === "agent" ? "Manage this agent in its Paseo agent tab." : "Only verified project dev servers can be stopped here." }
        : baseDecision;
      const argvHash = hashArgv(raw.argv);
      return {
        ...(this.scope ? { project } : {}),
        pid: raw.pid,
        ppid: raw.ppid,
        name: displayName(raw.argv, raw.comm),
        command: displayCommand(raw.argv, this.home, { lossy: raw.argvLossy === true }),
        cwd: raw.cwd === null ? null : homeRelative(raw.cwd, this.home),
        state: raw.state,
        cpuPercent: track.cpuPercent === null ? null : round1(track.cpuPercent),
        rssBytes: raw.rssBytes,
        memoryPercent: round1(memoryPercent),
        ageSeconds: Math.round(raw.ageSeconds),
        ports: project?.shareable ? project.shareablePorts : ports,
        impact: impact.impact,
        reasons: impact.reasons,
        service,
        actionable: decision.actionable,
        protectedReason: decision.reason,
        actionToken: decision.actionable ? this.policy.mint(raw, argvHash, at) : null,
      };
    });

    return { at, sampling, warnings: dedupe(warnings), uptimeSeconds: system.uptimeSeconds, cpu, memory, processes: views };
  }

  private updateSystem(sample: RawSystemSample, at: number): Snapshot["cpu"] {
    const history = this.system;
    let percent: number | null = null;
    if (history.last) {
      const total = sample.cpuTotal - history.last.total;
      const busy = sample.cpuBusy - history.last.busy;
      if (total > 0 && busy >= 0) percent = Math.min(100, Math.max(0, (busy / total) * 100));
    }
    history.last = { at, busy: sample.cpuBusy, total: sample.cpuTotal };
    if (percent !== null) {
      history.cpuPercent = percent;
      history.cpuEma = history.cpuEma === null ? percent : history.cpuEma + CPU_EMA_ALPHA * (percent - history.cpuEma);
      if (history.cpuEma >= SYSTEM_CPU_HIGH) history.highSince ??= at;
      else history.highSince = null;
    }
    const classified = classifyCpuPressure({
      percent: history.cpuPercent,
      sustainedPercent: history.cpuEma,
      sustainedSeconds: history.highSince === null ? 0 : (at - history.highSince) / 1000,
      load1: sample.load1,
      cores: sample.cores,
      psiSome10: sample.psiCpuSome10,
    });
    return {
      percent: percent === null ? null : round1(percent),
      cores: sample.cores,
      load1: sample.load1,
      load5: sample.load5,
      load15: sample.load15,
      psiSome10: sample.psiCpuSome10,
      pressure: classified.pressure,
      reasons: classified.reasons,
    };
  }

  private memoryView(sample: RawSystemSample, at: number): Snapshot["memory"] {
    pushPoint(this.system.swap, { at, value: sample.swapUsedBytes }, at);
    const swapGrowth = growth(this.system.swap);
    const classified = classifyMemoryPressure({
      totalBytes: sample.memoryTotalBytes,
      availableBytes: sample.memoryAvailableBytes,
      swapTotalBytes: sample.swapTotalBytes,
      swapUsedBytes: sample.swapUsedBytes,
      swapGrowthBytes: swapGrowth.delta,
      psiSome10: sample.psiMemorySome10,
      pressureSignal: sample.pressureSignal,
    });
    return {
      totalBytes: sample.memoryTotalBytes,
      usedBytes: Math.max(0, sample.memoryTotalBytes - sample.memoryAvailableBytes),
      availableBytes: sample.memoryAvailableBytes,
      swapTotalBytes: sample.swapTotalBytes,
      swapUsedBytes: sample.swapUsedBytes,
      psiSome10: sample.psiMemorySome10,
      pressureSignal: sample.pressureSignal,
      pressure: classified.pressure,
      reasons: classified.reasons,
    };
  }

  private updateProcess(raw: RawProcess, at: number, cores: number): TrackedProcess {
    const key = `${raw.pid}:${raw.startId}`;
    let track = this.tracked.get(key);
    if (!track) {
      track = { key, lastCpuSeconds: raw.cpuSeconds, lastAt: at, cpuPercent: null, cpuEma: null, highSince: null, rss: [], seen: 0 };
      this.tracked.set(key, track);
    } else {
      const wall = (at - track.lastAt) / 1000;
      const cpuDelta = raw.cpuSeconds - track.lastCpuSeconds;
      if (wall > 0 && cpuDelta >= 0) {
        const percent = Math.min(cores * 100, (cpuDelta / wall) * 100);
        track.cpuPercent = percent;
        track.cpuEma = track.cpuEma === null ? percent : track.cpuEma + CPU_EMA_ALPHA * (percent - track.cpuEma);
        if (track.cpuEma >= PROCESS_CPU_HIGH) track.highSince ??= at;
        else track.highSince = null;
      }
      track.lastCpuSeconds = raw.cpuSeconds;
      track.lastAt = at;
    }
    track.seen += 1;
    pushPoint(track.rss, { at, value: raw.rssBytes }, at);
    return track;
  }

  /** Test seam: how many process histories are retained. */
  trackedCount(): number {
    return this.tracked.size;
  }
}

function matches(process: ProcessView, query: string): boolean {
  if (process.name.toLowerCase().includes(query)) return true;
  if (process.command.toLowerCase().includes(query)) return true;
  if (process.cwd?.toLowerCase().includes(query)) return true;
  if (String(process.pid) === query) return true;
  if (process.service?.label.toLowerCase().includes(query)) return true;
  const port = query.startsWith(":") ? query.slice(1) : query;
  return /^\d+$/.test(port) && process.ports.includes(Number(port));
}

function comparator(sort: SnapshotInput["sort"]): (a: ProcessView, b: ProcessView) => number {
  switch (sort) {
    case "memory":
      return (a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid;
    case "name":
      return (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid;
    case "pid":
      return (a, b) => a.pid - b.pid;
    case "cpu":
    default:
      return (a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.rssBytes - a.rssBytes || a.pid - b.pid;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Read-only snapshot for platforms Monitor does not support. */
export function unsupportedSnapshot(now: number): Snapshot {
  return {
    timestamp: now,
    sampling: "live",
    platform: "unsupported",
    supported: false,
    warnings: [`Monitor supports Linux and macOS. This daemon runs on ${process.platform}.`],
    uptimeSeconds: 0,
    cpu: { percent: null, cores: 1, load1: 0, load5: 0, load15: 0, psiSome10: null, pressure: "normal", reasons: [] },
    memory: {
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      psiSome10: null,
      pressureSignal: null,
      pressure: "normal",
      reasons: [],
    },
    services: [],
    processes: [],
    totalProcesses: 0,
    matchedProcesses: 0,
    truncated: false,
  };
}
