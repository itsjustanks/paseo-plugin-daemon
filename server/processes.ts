import type { ActionResult } from "../shared/contracts";
import {
  MEMORY_HEAVY_PERCENT,
  ReportInputSchema,
  RUNAWAY_CPU_SECONDS,
  STOP_GRACE_SECONDS,
  type ActionLogEntry,
  type OwnerKind,
  type ProcessReport,
  type ProcessRow,
  type ReportInput,
  type ReportSort,
  type Runaway,
  type StopOutcome,
  type StopPlan,
} from "../shared/processes";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";
import type { ActionLog } from "./action-log";
import type { ClassifiedBase, Collector, ProcessDetail } from "./collector";
import { formatBytes } from "./heuristics";
import { classifyJob, isPaseoInternal, isPluginHost, isTerminalWorker, programName, type Job } from "./jobs";
import type { Clock, PlatformAdapter, RawProcess } from "./platform";
import { systemClock } from "./platform";
import { hashArgv } from "./redaction";
import { ProcessGuard, type KillFn } from "./safety";
import { isAgentTool, isInfrastructure, type ProjectScope } from "./scope";

/**
 * The Processes tab's server side.
 *
 * Who may be stopped (every rule must pass, and all are re-checked against a
 * fresh read at the moment of the signal):
 *  1. the guard's own rules: this daemon's OS user only; never PID 1, root,
 *     another user, a zombie, this plugin, or Paseo's daemon and its parents;
 *  2. never part of Paseo: the daemon, supervisor, plugin hosts, terminal
 *     workers and Paseo's bundled tools;
 *  3. never anything a Paseo plugin started (it belongs to that plugin);
 *  4. never an agent CLI (stop it from its chat) and never a terminal's own
 *     shell (close the terminal);
 *  5. never a database or system service (postgres, redis, sshd, …);
 *  6. and only if Paseo started it (a descendant of the daemon: agents'
 *     builds, terminals' dev servers) or it runs inside a registered Paseo
 *     project. Anything else this user runs is shown but view-only.
 *
 * A stop sends SIGTERM to the process and its eligible children, then, after
 * STOP_GRACE_SECONDS, SIGKILL to whichever of them are still the same
 * processes. Every step is logged.
 */

export interface ProcessManagerOptions {
  adapter: PlatformAdapter;
  collector: Collector;
  uid: number;
  scope?: ProjectScope;
  log: ActionLog;
  /** This plugin's process; protected, and its parent is the daemon. */
  selfPid?: number;
  daemonPid?: number;
  clock?: Clock;
  kill?: KillFn;
  graceMs?: number;
  readSettings?: () => Promise<{ maxHeavyJobs: number }>;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

interface Decision { stoppable: boolean; reason: string | null; owner: ProcessRow["owner"] }

const describeOwner = (kind: OwnerKind, label: string, project: string | null = null, workspace: string | null = null): ProcessRow["owner"] => ({ kind, label, project, workspace });

export class ProcessManager {
  readonly guard: ProcessGuard;
  private readonly clock: Clock;
  private readonly selfPid: number;
  private readonly daemonPid: number;
  private readonly graceMs: number;
  private readonly timers = new Set<unknown>();
  private closed = false;
  /** One fresh read shared by the per-process checks of a single action. */
  private fresh: { at: number; base: Promise<ClassifiedBase> } | null = null;

  constructor(private readonly options: ProcessManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.selfPid = options.selfPid ?? process.pid;
    this.daemonPid = options.daemonPid ?? process.ppid;
    this.graceMs = options.graceMs ?? STOP_GRACE_SECONDS * 1000;
    this.guard = new ProcessGuard({
      adapter: options.adapter, uid: options.uid, selfPid: this.selfPid, kill: options.kill, clock: this.clock,
      alwaysProtected: this.daemonPid > 1 ? [this.daemonPid] : [],
      authorizeProcess: (pid) => this.authorize(pid),
    });
  }

  // ------------------------------------------------------------- the rules

  private chain(raw: RawProcess, byPid: ReadonlyMap<number, RawProcess>): RawProcess[] {
    const out: RawProcess[] = [];
    const seen = new Set<number>([raw.pid]);
    let current = byPid.get(raw.ppid);
    for (let hops = 0; current && hops < 64 && !seen.has(current.pid); hops += 1) {
      out.push(current);
      seen.add(current.pid);
      current = byPid.get(current.ppid);
    }
    return out;
  }

  decide(detail: ProcessDetail, byPid: ReadonlyMap<number, RawProcess>, ports: readonly number[]): Decision {
    const { raw } = detail;
    const ancestors = this.chain(raw, byPid);
    const project = this.options.scope?.match(raw, ports) ?? null;
    const place = project ? describeOwner("project", project.workspace ? `${project.name} · ${project.workspace}` : project.name, project.name, project.workspace) : null;
    const startedByPaseo = raw.ppid === this.daemonPid || ancestors.some((row) => row.pid === this.daemonPid);
    const deny = (owner: ProcessRow["owner"], reason: string): Decision => ({ stoppable: false, reason, owner });

    if (raw.pid === this.selfPid) return deny(describeOwner("paseo", "Daemon Link"), "This is Daemon Link itself.");
    if (isPaseoInternal(raw) || raw.pid === this.daemonPid) {
      const label = isPluginHost(raw) ? "Paseo plugin" : isTerminalWorker(raw) ? "Paseo terminals" : raw.pid === this.daemonPid ? "Paseo daemon" : "Paseo";
      return deny(describeOwner("paseo", label), "Part of Paseo, so it can't be stopped here.");
    }
    if (ancestors.some(isPluginHost)) return deny(describeOwner("plugin", "Started by a Paseo plugin"), "Started by a Paseo plugin. Manage it in that plugin (browser links: the Dev servers tab).");
    if (isAgentTool(raw)) return deny(place ? { ...place, kind: "agent", label: `Agent · ${place.label}` } : describeOwner("agent", "Agent"), "An agent. Stop it from its chat in Paseo.");
    if (isInfrastructure(raw)) return deny(describeOwner("infrastructure", "Database or system service"), "A database or system service. Stop it where it was started.");
    const parent = byPid.get(raw.ppid);
    if (parent && isTerminalWorker(parent)) return deny(place ?? describeOwner("terminal", "Paseo terminal"), "A Paseo terminal's shell. Close the terminal in Paseo instead.");
    const base = this.guard.evaluate(raw, byPid);
    if (!base.actionable) return deny(place ?? describeOwner("other", startedByPaseo ? "Started from Paseo" : "Outside Paseo"), `Can't be stopped here: ${base.reason}.`);
    if (place) return { stoppable: true, reason: null, owner: place };
    if (startedByPaseo) return { stoppable: true, reason: null, owner: describeOwner("paseo-started", "Started from Paseo") };
    return deny(describeOwner("other", "Outside Paseo"), "Started outside Paseo and outside your Paseo projects, so it can only be viewed here.");
  }

  /** The guard's per-process check at action time: a fresh read, then the same rules. */
  private async authorize(pid: number): Promise<boolean> {
    const now = this.clock.now();
    if (!this.fresh || now - this.fresh.at > 1000) {
      this.options.collector.invalidate();
      if (this.options.scope) await this.options.scope.refresh().catch(() => undefined);
      this.fresh = { at: now, base: this.options.collector.collect() };
    }
    const base = await this.fresh.base;
    const byPid = new Map(base.details.map((detail) => [detail.raw.pid, detail.raw]));
    const detail = base.details.find((item) => item.raw.pid === pid);
    return !!detail && this.decide(detail, byPid, detail.view.ports).stoppable;
  }

  // ---------------------------------------------------------------- report

  async report(rawInput: ReportInput, recent: () => Promise<ActionLogEntry[]>): Promise<ProcessReport> {
    const input = ReportInputSchema.parse(rawInput);
    if (this.options.scope) await this.options.scope.refresh().catch(() => undefined);
    const [base, settings, actions] = await Promise.all([
      this.options.collector.collect(),
      (this.options.readSettings?.() ?? Promise.resolve(HOSTS_SETTINGS_DEFAULTS)).catch(() => HOSTS_SETTINGS_DEFAULTS),
      recent().catch(() => []),
    ]);
    const byPid = new Map(base.details.map((detail) => [detail.raw.pid, detail.raw]));
    const jobs = new Map<number, Job>();
    for (const detail of base.details) {
      const job = classifyJob(detail.raw.argv, detail.view.ports);
      if (job) jobs.set(detail.raw.pid, job);
    }
    const children = new Map<number, ProcessDetail[]>();
    for (const detail of base.details) {
      const list = children.get(detail.raw.ppid);
      if (list) list.push(detail); else children.set(detail.raw.ppid, [detail]);
    }
    const trees = new Map<number, ProcessRow["tree"]>();
    const tree = (detail: ProcessDetail, depth = 0): ProcessRow["tree"] => {
      const known = trees.get(detail.raw.pid);
      if (known) return known;
      let count = 1, rss = detail.raw.rssBytes, cpu = detail.view.cpuPercent;
      if (depth < 32) for (const child of children.get(detail.raw.pid) ?? []) {
        const sub = tree(child, depth + 1);
        count += sub.count; rss += sub.rssBytes;
        cpu = cpu === null && sub.cpuPercent === null ? null : (cpu ?? 0) + (sub.cpuPercent ?? 0);
      }
      const result = { count, rssBytes: rss, cpuPercent: cpu === null ? null : Math.round(cpu * 10) / 10 };
      trees.set(detail.raw.pid, result);
      return result;
    };
    const isJobRoot = (detail: ProcessDetail) => jobs.has(detail.raw.pid) && !this.chain(detail.raw, byPid).some((row) => jobs.has(row.pid));

    const limit = settings.maxHeavyJobs;
    const basis = base.memoryBasisBytes;
    const rows: ProcessRow[] = base.details.map((detail) => {
      const decision = this.decide(detail, byPid, detail.view.ports);
      const job = jobs.get(detail.raw.pid) ?? null;
      const flags: ProcessRow["flags"] = [];
      if (detail.hotSeconds >= RUNAWAY_CPU_SECONDS) flags.push({ code: "cpu-runaway", text: `Has used a full CPU core for ${minutes(detail.hotSeconds)}` });
      if (detail.view.memoryPercent >= MEMORY_HEAVY_PERCENT) flags.push({ code: "memory-heavy", text: `Uses ${Math.round(detail.view.memoryPercent)}% of ${base.container?.memoryLimitBytes ? "this container's memory limit" : "the machine's memory"}` });
      if (detail.view.impact === "pressure-driver") flags.push({ code: "pressure-driver", text: "One of the biggest users while the host is under pressure" });
      return {
        pid: detail.raw.pid, ppid: detail.raw.ppid, name: programName(detail.raw.argv, detail.view.name), command: detail.view.command, cwd: detail.view.cwd, state: detail.view.state,
        cpuPercent: detail.view.cpuPercent, cpuSustained: detail.cpuSustained, hotSeconds: Math.round(detail.hotSeconds),
        rssBytes: detail.raw.rssBytes, memoryPercent: detail.view.memoryPercent, ageSeconds: detail.view.ageSeconds, ports: detail.view.ports,
        job, jobRoot: isJobRoot(detail), tree: tree(detail), owner: decision.owner, flags,
        stoppable: decision.stoppable, protectedReason: decision.reason, actionToken: null,
      };
    });

    const roots = rows.filter((row) => row.jobRoot);
    const runaways = this.runaways(base, rows, roots, limit);
    const query = input.query.trim().toLowerCase();
    const matched = rows.filter((row) => {
      if (input.filter === "jobs" && !row.jobRoot) return false;
      if (input.filter === "stoppable" && !row.stoppable) return false;
      if (!query) return true;
      return [row.name, row.command, row.cwd ?? "", row.owner.label, row.job?.label ?? "", String(row.pid)].some((text) => text.toLowerCase().includes(query));
    });
    matched.sort(order(input.sort, input.filter === "jobs"));
    const page = matched.slice(input.offset, input.offset + input.limit).map((row) => {
      if (!row.stoppable) return row;
      const raw = byPid.get(row.pid)!;
      return { ...row, actionToken: this.guard.mint(raw, hashArgv(raw.argv), base.at) };
    });
    const paseoBytes = rows.filter((row) => row.owner.kind === "paseo").reduce((sum, row) => sum + row.rssBytes, 0);
    return {
      checkedAt: base.at,
      platform: this.options.adapter.platform,
      supported: true,
      sampling: base.sampling === "sampling",
      host: {
        cores: base.cpu.cores, cpuPercent: base.cpu.percent, load1: base.cpu.load1,
        memoryTotalBytes: base.memory.totalBytes, memoryUsedBytes: base.memory.usedBytes,
        cpuPressure: base.cpu.pressure, memoryPressure: base.memory.pressure,
      },
      container: base.container,
      memoryBasis: base.container?.memoryLimitBytes ? "container" : "machine",
      memoryBasisBytes: basis,
      heavyJobs: { count: roots.length, limit, pids: roots.map((row) => row.pid) },
      runaways,
      processes: page,
      total: rows.length,
      matched: matched.length,
      paseoBytes,
      projectsVerified: this.options.scope ? this.options.scope.status().status === "ready" : false,
      warnings: base.warnings,
      recentActions: actions.slice(0, 5),
    };
  }

  private runaways(base: ClassifiedBase, rows: readonly ProcessRow[], roots: readonly ProcessRow[], limit: number): Runaway[] {
    const out: Runaway[] = [];
    const container = base.container;
    if (container && container.pressure !== "normal") {
      const used = container.memoryLimitBytes ? `${formatBytes(container.memoryUsedBytes)} of its ${formatBytes(container.memoryLimitBytes)} limit` : formatBytes(container.memoryUsedBytes);
      out.push({ code: "memory-near-limit", severity: container.pressure === "critical" ? "critical" : "warning", title: `This container's memory is ${container.pressure === "critical" ? "nearly full" : "getting full"}: ${used}. ${capitalise(container.reasons.find((reason) => !reason.startsWith("using ")) ?? "")}`.trim(), pids: [], cwd: null });
    } else if (!container && base.memory.pressure === "critical") {
      out.push({ code: "memory-near-limit", severity: "critical", title: `This machine is short of memory: ${base.memory.reasons[0] ?? "little is left"}.`, pids: [], cwd: null });
    }
    if (base.cpu.pressure === "critical") out.push({ code: "cpu-busy", severity: "warning", title: `The CPU is almost fully busy (${base.cpu.reasons[0] ?? "high load"}).`, pids: [], cwd: null });
    if (roots.length > limit) {
      out.push({ code: "too-many-jobs", severity: "warning", title: `${roots.length} heavy jobs are running at once; your limit is ${limit}. Builds, tests and dev servers compete for the same CPU.`, pids: roots.map((row) => row.pid), cwd: null });
    }
    for (const row of rows) {
      const hot = row.flags.find((flag) => flag.code === "cpu-runaway");
      if (hot) out.push({ code: "cpu-runaway", severity: "warning", title: `${row.name} (PID ${row.pid}) has used a full CPU core for ${minutes(row.hotSeconds)}.`, pids: [row.pid], cwd: row.cwd });
      const heavy = row.flags.find((flag) => flag.code === "memory-heavy");
      if (heavy) out.push({ code: "memory-heavy", severity: row.memoryPercent >= 70 ? "critical" : "warning", title: `${row.name} (PID ${row.pid}) uses ${formatBytes(row.rssBytes)}, ${Math.round(row.memoryPercent)}% of ${container?.memoryLimitBytes ? "this container's limit" : "the machine's memory"}.`, pids: [row.pid], cwd: row.cwd });
    }
    return out.slice(0, 12);
  }

  // --------------------------------------------------------------- actions

  private async names(): Promise<Map<number, { name: string; rssBytes: number; cpuPercent: number | null; owner: string | null }>> {
    this.options.collector.invalidate();
    const base = await this.options.collector.collect();
    const byPid = new Map(base.details.map((detail) => [detail.raw.pid, detail.raw]));
    return new Map(base.details.map((detail) => [detail.raw.pid, {
      name: programName(detail.raw.argv, detail.view.name), rssBytes: detail.raw.rssBytes, cpuPercent: detail.view.cpuPercent,
      owner: this.decide(detail, byPid, detail.view.ports).owner.label,
    }]));
  }

  /** The ask-first list: what each token would stop, children included, or why it would be refused. */
  async preview(tokens: readonly string[]): Promise<StopPlan> {
    this.fresh = null;
    const names = await this.names();
    const targets: StopPlan["targets"] = [];
    for (const token of tokens) {
      const pid = this.guard.verify(token)?.pid ?? null;
      const known = pid === null ? undefined : names.get(pid);
      const plan = await this.guard.plan(token);
      if (!plan.ok) {
        targets.push({ pid, name: known?.name ?? "Process", ok: false, reason: friendly(plan.result), rssBytes: known?.rssBytes ?? 0, cpuPercent: known?.cpuPercent ?? null, children: [] });
        continue;
      }
      targets.push({
        pid: plan.pid, name: known?.name ?? "Process", ok: true, reason: null, rssBytes: known?.rssBytes ?? 0, cpuPercent: known?.cpuPercent ?? null,
        children: plan.children.map((child) => ({ pid: child, name: names.get(child)?.name ?? "process" })),
      });
    }
    return { targets, graceSeconds: Math.round(this.graceMs / 1000) };
  }

  /** SIGTERM now; SIGKILL survivors after the grace period. Returns at once. */
  async stop(tokens: readonly string[]): Promise<StopOutcome> {
    this.fresh = null;
    const names = await this.names();
    const results: StopOutcome["results"] = [];
    for (const token of tokens) {
      const payload = this.guard.verify(token);
      const known = payload ? names.get(payload.pid) : undefined;
      const name = known?.name ?? "Process";
      const { result, children } = await this.guard.stopTree(token);
      await this.record("stop", result, name, known?.owner ?? null);
      results.push({ pid: result.pid, name, ok: result.ok, status: result.status, message: plain(result, name, this.graceMs), signaled: result.signaledCount });
      if (result.status === "signaled") this.escalate(token, payload?.startId ?? null, result.pid!, children, name, known?.owner ?? null);
    }
    return { results, escalateAfterSeconds: Math.round(this.graceMs / 1000) };
  }

  private escalate(token: string, startId: string | null, pid: number, children: Parameters<ProcessGuard["forceSurvivors"]>[0], name: string, owner: string | null) {
    const set = this.options.setTimer ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer; });
    const timer = set(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      void (async () => {
        let alive = false;
        try { const identity = await this.options.adapter.readIdentity(pid); alive = !!identity && identity.startId === startId; } catch { alive = false; }
        this.fresh = null;
        let signaled = 0;
        let status: ActionResult["status"] = "already-exited";
        let message = `${name} stopped within ${Math.round(this.graceMs / 1000)} seconds.`;
        if (alive) {
          const forced = await this.guard.forceStop(token);
          status = forced.status;
          signaled = forced.signaledCount;
          message = forced.ok ? `${name} was still running after ${Math.round(this.graceMs / 1000)} seconds, so it was stopped forcefully.` : friendly(forced);
        }
        const survivors = await this.guard.forceSurvivors(children);
        if (survivors > 0) {
          signaled += survivors;
          status = "signaled";
          message = `${message} ${survivors} child process${survivors === 1 ? "" : "es"} still running ${survivors === 1 ? "was" : "were"} stopped forcefully.`;
        }
        if (alive || survivors > 0) await this.record("auto-force-stop", { ok: status === "signaled", status, message, pid, signaledCount: signaled }, name, owner);
      })().catch((error) => console.error("daemon-link: automatic force stop failed", error instanceof Error ? error.name : "unknown"));
    }, this.graceMs);
    this.timers.add(timer);
  }

  private record(action: ActionLogEntry["action"], result: ActionResult, name: string, owner: string | null) {
    return this.options.log.append({ at: this.clock.now(), action, source: "processes", pid: result.pid, name, owner, status: result.status, signaled: result.signaledCount, message: result.message });
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer as ReturnType<typeof setTimeout>);
    this.timers.clear();
  }
}

// ---------------------------------------------------------------- helpers

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 1 ? `${Math.round(seconds)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function capitalise(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : "";
}

function order(sort: ReportSort, byTree: boolean): (a: ProcessRow, b: ProcessRow) => number {
  const cpu = (row: ProcessRow) => (byTree ? row.tree.cpuPercent : row.cpuPercent) ?? -1;
  const rss = (row: ProcessRow) => (byTree ? row.tree.rssBytes : row.rssBytes);
  switch (sort) {
    case "memory": return (a, b) => rss(b) - rss(a) || a.pid - b.pid;
    case "age": return (a, b) => b.ageSeconds - a.ageSeconds || a.pid - b.pid;
    case "name": return (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid;
    default: return (a, b) => cpu(b) - cpu(a) || rss(b) - rss(a) || a.pid - b.pid;
  }
}

/** The guard's words, said plainly. */
export function friendly(result: ActionResult): string {
  if (result.status === "already-exited") return "It has already stopped.";
  if (result.message.startsWith("Action token")) return "This list is out of date. Refresh and try again.";
  if (result.message.includes("identity changed")) return "That process ended and its number was reused. Refresh and try again.";
  if (result.message.startsWith("Only a verified")) return "It is no longer something Daemon Link may stop (it changed, or projects can't be verified right now).";
  if (result.status === "needs-graceful-first") return "It has to be asked to stop first.";
  if (result.message.startsWith("Refusing to signal: ")) return `Daemon Link won't stop it: ${result.message.slice(20).replace(/\.$/, "")}.`;
  return result.message;
}

function plain(result: ActionResult, name: string, graceMs: number): string {
  if (result.status !== "signaled") return friendly(result);
  const children = result.signaledCount - 1;
  return `Asked ${name}${children > 0 ? ` and ${children} child process${children === 1 ? "" : "es"}` : ""} to stop. Anything still running in ${Math.round(graceMs / 1000)} seconds is stopped forcefully.`;
}
