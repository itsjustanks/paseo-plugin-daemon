import { cpus, loadavg } from "node:os";
import { readFile } from "node:fs/promises";
import {
  HOUSEKEEPING_JOBS, jobIntervalMs, type HousekeepingEntry, type HousekeepingJob, type HousekeepingOutcome, type HousekeepingSettings,
  type HousekeepingState, type HousekeepingStatus, type JobRun, type Machine,
} from "../shared/housekeeping";
import { formatSize, isWithin } from "../shared/disk";
import { protectedSet } from "./safety";
import { readCgroup } from "./cgroup";
import { parseMeminfo } from "./linux";
import {
  handover, isFinished, planRenice, planReap, profileInUse, ancestorsIn, qualifiesNow, sameTarget, stillPlanned,
  wantsEnvironment, type HkProcess, type OwnerKind, type ProcTable, type ReapPlan, type ReapTarget,
} from "./housekeeping-plan";
import type { OwnerLookup } from "./housekeeping-owners";
import type { HeldLock } from "./housekeeping-lock";
import { createHelper, missingHelpers, trimCache, turboCacheDir, type Places } from "./housekeeping-files";
import { NO_RUNS, type HousekeepingLog, type Runs } from "./housekeeping-log";

/**
 * The Housekeeping loop (0.18.0, Linux only). One beat a minute, started when
 * the plugin loads, whether or not anyone opens Hosts. Each beat:
 *  1. reads the settings fresh (unreadable: wait; off: nothing);
 *  2. takes the hand-over lock without waiting and HOLDS it for the whole
 *     beat (busy: stay passive, the standalone script is running);
 *  3. runs whichever jobs are due, one at a time, never overlapping a beat.
 * In preview it decides and logs only. In live mode every effect (a renice,
 * a signal, an unlink, a helper write, a profile removal) is preceded by a
 * fresh read of the settings and of the thing itself, and by a check of the
 * beat's abort signal, which turning Housekeeping off, switching to preview,
 * or unloading the plugin fires at once. The lock is released only after the
 * beat has finished or stopped, so no effect can follow its release.
 */

export const BEAT_MS = 60_000;
export const FIRST_BEAT_MS = 15_000;
export const SETTINGS_READ_MS = 5_000;
export const TERM_WAIT_MS = 3_000;
export const CLOSE_WAIT_MS = 10_000;
export const CYCLE_BUDGET_MS = 45_000;
export const MAX_CACHE_SCAN_PER_CYCLE = 2048;
export const MAX_RENICE_PER_BEAT = 256;
export const MAX_WORKSPACES = 200;
const WORKSPACES_READ_MS = 25_000;

export interface HousekeeperDeps {
  platform: NodeJS.Platform;
  uid: number;
  selfPid: number;
  /** Fresh settings, or null when they can't be read (then nothing happens). */
  readSettings(): Promise<HousekeepingSettings | null>;
  procs: { scan(signal?: AbortSignal): Promise<ProcTable>; read(pid: number): Promise<HkProcess | null> };
  owners: OwnerLookup;
  lock(signal: AbortSignal): Promise<HeldLock>;
  log: Pick<HousekeepingLog, "append" | "recent" | "runs" | "saveRuns">;
  /** Paseo's registered workspaces (name, folder), or null when they can't be read. */
  workspaces(signal: AbortSignal): Promise<Array<{ name: string; directory: string; status: string | null; devServers: string[] }> | null>;
  places: Places;
  /** Where the gate scripts live: /tmp. Tests pass their own folder. */
  helpersDir: string;
  /** Removes one checked browser profile; `finalCheck` runs again right before the delete. */
  privateProfile?(path: string): Promise<boolean>;
  removeProfile(path: string, finalCheck: (currentPath?: string) => Promise<string | null>, signal: AbortSignal): Promise<{ ok: boolean; why: string | null }>;
  renice(tid: number, nice: number): void;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  machine?(): Promise<Machine | null>;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<boolean>;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
type JobResult = { outcome: HousekeepingOutcome; summary: string };

const STATE_MESSAGES: Partial<Record<HousekeepingState, string>> = {
  preview: "Preview: on its configured schedules it decides what it would tidy and logs it. Nothing on this host is changed until you turn on live mode.",
  live: "On its configured schedules, it lowers heavy jobs' priority, closes eligible leftovers from finished chats, and trims old Turborepo caches.",
  off: "Housekeeping is off. Turn it on to keep this host tidy.",
  starting: "Housekeeping starts within a minute of the plugin loading.",
};

export class Housekeeper {
  private timer: unknown = null;
  private closed = false;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private policy: HousekeepingSettings | null = null;
  private state: HousekeepingState;
  private message: string;
  private runs: Runs = { ...NO_RUNS };
  private runsLoaded = false;
  /** The last preview line per job, so a preview repeating every minute is logged once. */
  private lastPreview = new Map<string, string>();
  private lastNotice = "";
  private readonly now: () => number;

  constructor(private readonly deps: HousekeeperDeps) {
    this.now = deps.now ?? Date.now;
    const supported = deps.platform === "linux";
    this.state = supported ? "starting" : "unsupported";
    this.message = supported ? STATE_MESSAGES.starting! : `Housekeeping works on Linux hosts. This daemon runs on ${deps.platform === "darwin" ? "macOS" : deps.platform}, so it does nothing here.`;
  }

  get supported() { return this.deps.platform === "linux"; }

  start(): void {
    if (!this.supported || this.closed || this.timer) return;
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer; });
    const loop = (ms: number) => { this.timer = set(() => { void this.tick().finally(() => { if (!this.closed) loop(BEAT_MS); }); }, ms); };
    loop(FIRST_BEAT_MS);
  }

  /** Unloading: no new beat, the current one is cancelled, and this waits (bounded) until it has let go of the lock. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.controller?.abort();
    if (this.running) await withDeadline(this.running, CLOSE_WAIT_MS, undefined);
  }

  /** A settings change anywhere: off or preview cancels the beat in progress at once; then a beat runs soon to show the new state. */
  async settingsChanged(): Promise<void> {
    if (!this.supported || this.closed) return;
    this.controller?.abort();
    const settings = await withDeadline(this.deps.readSettings(), SETTINGS_READ_MS, null);
    if (!settings || !settings.enabled || settings.dryRun || (this.policy && JSON.stringify(settings) !== JSON.stringify(this.policy))) this.controller?.abort();
    if (settings && !settings.enabled) this.setState("off", STATE_MESSAGES.off!);
    else if (settings?.dryRun) this.setState("preview", STATE_MESSAGES.preview!);
    if (!this.running) void this.tick();
  }

  /** One beat; overlapping calls share it. Never throws. */
  tick(): Promise<void> {
    if (!this.supported || this.closed) return Promise.resolve();
    this.running ??= this.beat().catch((error) => {
      console.error("daemon-link: housekeeping beat failed", error instanceof Error ? error.name : "unknown");
    }).finally(() => { this.running = null; this.controller = null; this.policy = null; });
    return this.running;
  }

  private setState(state: HousekeepingState, message: string) {
    this.state = state;
    this.message = message;
  }

  /** A state worth a log line (paused, blocked), written once per change. */
  private async notice(outcome: HousekeepingOutcome, what: string, why: string) {
    const key = `${outcome}|${what}|${why}`;
    if (key === this.lastNotice) return;
    this.lastNotice = key;
    await this.deps.log.append({ at: this.now(), job: "cycle", outcome, what, why });
  }

  private async beat(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    if (!this.runsLoaded) { this.runs = await this.deps.log.runs().catch(() => ({ ...NO_RUNS })); this.runsLoaded = true; }
    const settings = await withDeadline(this.deps.readSettings(), SETTINGS_READ_MS, null);
    if (signal.aborted || this.closed) return;
    if (!settings) {
      this.setState("blocked", "Hosts couldn't read its settings, so Housekeeping waits and changes nothing.");
      await this.notice("blocked", "Housekeeping", "Its settings couldn't be read, so nothing was done");
      return;
    }
    if (!settings.enabled) { this.setState("off", STATE_MESSAGES.off!); this.lastNotice = ""; return; }
    this.policy = settings;
    const held = await this.deps.lock(signal);
    const budgetTimer = setTimeout(() => controller.abort("cycle budget"), CYCLE_BUDGET_MS);
    (budgetTimer as { unref?: () => void }).unref?.();
    try {
      const verdict = handover(held.outcome);
      if (!verdict.run) {
        this.setState(verdict.state, verdict.message);
        await this.notice(verdict.state === "passive" ? "skipped" : "blocked", "Housekeeping", verdict.message);
        return;
      }
      if (signal.aborted || this.closed) return;
      const preview = settings.dryRun;
      this.setState(preview ? "preview" : "live", preview ? STATE_MESSAGES.preview! : STATE_MESSAGES.live!);
      this.lastNotice = "";
      for (const job of HOUSEKEEPING_JOBS) {
        if (signal.aborted || this.closed) break;
        if (!this.due(job, preview, settings)) continue;
        let result: JobResult;
        try { result = await this.run(job, settings, preview, signal); }
        catch (error) {
          result = { outcome: "failed", summary: "It stopped on an unexpected error; nothing more was done this time." };
          console.error(`daemon-link: housekeeping ${job} failed`, error instanceof Error ? error.name : "unknown");
        }
        if (signal.aborted) result = { outcome: "skipped", summary: signal.reason === "cycle budget" ? "Stopped: this cycle reached its 45-second action budget; remaining work waits for the next beat." : "Stopped: Housekeeping settings changed or the plugin unloaded." };
        this.runs = { ...this.runs, [job]: { at: this.now(), outcome: result.outcome, summary: result.summary } satisfies JobRun };
        await this.deps.log.saveRuns(this.runs);
      }
    } finally {
      clearTimeout(budgetTimer);
      controller.abort();
      // Only now: every effect of this beat has happened or been cancelled.
      await held.release();
    }
  }

  /** Due on its interval; a job last run in preview is due at once when live mode starts. */
  private due(job: HousekeepingJob, preview: boolean, settings: HousekeepingSettings): boolean {
    const last = this.runs[job];
    if (!last || last.outcome === "skipped" || last.outcome === "blocked" || last.outcome === "failed") return true;
    if (!preview && last.outcome === "preview") return true;
    return this.now() - last.at >= jobIntervalMs(job, settings);
  }

  /** Live mode, confirmed right now, and this beat still wanted. */
  private async mayAct(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed) return false;
    const settings = await withDeadline(this.deps.readSettings(), SETTINGS_READ_MS, null);
    if (signal.aborted || this.closed) return false;
    const allowed = !!settings && settings.enabled && !settings.dryRun && JSON.stringify(settings) === JSON.stringify(this.policy);
    if (!allowed) this.controller?.abort();
    return allowed;
  }

  private async log(entry: Omit<HousekeepingEntry, "at">) { await this.deps.log.append({ at: this.now(), ...entry }); }

  /** A preview line once per distinct content, so a minute-by-minute preview doesn't flood the log. */
  private async previewOnce(job: HousekeepingJob, key: string, entry: Omit<HousekeepingEntry, "at" | "job" | "outcome">) {
    if (this.lastPreview.get(`${job}:${key}`) === `${entry.what}|${entry.why}|${entry.count ?? ""}`) return;
    if (this.lastPreview.size >= 256) this.lastPreview.delete(this.lastPreview.keys().next().value!);
    this.lastPreview.set(`${job}:${key}`, `${entry.what}|${entry.why}|${entry.count ?? ""}`);
    await this.log({ job, outcome: "preview", ...entry });
  }

  private run(job: HousekeepingJob, settings: HousekeepingSettings, preview: boolean, signal: AbortSignal): Promise<JobResult> {
    switch (job) {
      case "helpers": return this.helpers(preview, signal);
      case "renice": return this.renice(settings, preview, signal);
      case "reap": return this.reap(settings, preview, signal);
      default: return this.turbo(settings, preview, signal);
    }
  }

  // -------------------------------------------------------------- gate scripts

  private async helpers(preview: boolean, signal: AbortSignal): Promise<JobResult> {
    const missing = await missingHelpers(this.deps.helpersDir);
    if (!missing.length) return { outcome: "done", summary: "Both gate scripts are in place." };
    const names = missing.map((name) => `${this.deps.helpersDir}/${name}`).join(" and ");
    if (preview) {
      await this.previewOnce("helpers", "missing", { what: names, why: "Missing; live mode would put it back exactly as shipped, never replacing anything" });
      return { outcome: "preview", summary: `Would put back ${names}.` };
    }
    if (!(await this.mayAct(signal))) return { outcome: "skipped", summary: "Paused before putting back the gate scripts." };
    let created = 0;
    for (const name of missing) {
      if (!(await this.mayAct(signal))) break;
      const state = await createHelper(this.deps.helpersDir, name, () => this.mayAct(signal));
      if (state === "created") created++;
      if (state === "created" || state === "failed") await this.log({ job: "helpers", outcome: state === "created" ? "done" : "failed", what: `${this.deps.helpersDir}/${name}`, why: state === "created" ? "It was missing, so it was put back exactly as shipped" : "Creation failed; a partial file may remain and was not replaced" });
    }
    return { outcome: created === missing.length ? "done" : "failed", summary: created ? `Put back ${plural(created, "gate script")}.` : "Couldn't put back the gate scripts." };
  }

  // -------------------------------------------------------------- renice

  private async renice(settings: HousekeepingSettings, preview: boolean, signal: AbortSignal): Promise<JobResult> {
    const table = await this.deps.procs.scan(signal);
    const protectedPids = protectedSet(table.processes, this.deps.selfPid);
    if (!table.complete) return { outcome: "blocked", summary: "The process table was incomplete, so no priorities changed." };
    const plan = planRenice(table, { uid: this.deps.uid, protectedPids, heavyNice: settings.heavyNice, browserNice: settings.browserNice }).slice(0, MAX_RENICE_PER_BEAT);
    const words = (heavy: number, browsers: number) => [heavy ? plural(heavy, "build or test", "builds and tests") : null, browsers ? plural(browsers, "browser process", "browser processes") : null].filter(Boolean).join(" and ");
    const heavy = plan.filter((t) => t.kind === "heavy").length, browsers = plan.length - heavy;
    if (!plan.length) return { outcome: "done", summary: "Nothing needed a lower priority." };
    if (preview) {
      await this.previewOnce("renice", "plan", { what: words(heavy, browsers), why: `Would lower to priority ${settings.heavyNice} (builds) and ${settings.browserNice} (browsers) so Paseo stays responsive`, count: plan.length });
      return { outcome: "preview", summary: `Would lower ${words(heavy, browsers)}.` };
    }
    let lowered = 0, loweredHeavy = 0;
    for (const target of plan) {
      if (!(await this.mayAct(signal))) break;
      const current = await this.deps.procs.scan(signal);
      if (!current.complete) continue;
      const candidate = planRenice(current, { uid: this.deps.uid, protectedPids: protectedSet(current.processes, this.deps.selfPid), heavyNice: settings.heavyNice, browserNice: settings.browserNice }).find((p) => p.pid === target.pid && p.startId === target.startId && p.kind === target.kind);
      if (!candidate || !(await this.mayAct(signal))) continue;
      // Linux priority is per thread. Only the main PID is used: no unbound TID can be reused.
      const fresh = await this.deps.procs.read(target.pid).catch(() => null);
      const expected = current.processes.find((p) => p.pid === target.pid)!;
      if (!fresh || signal.aborted || fresh.ppid !== expected.ppid || fresh.exe !== expected.exe || fresh.argv.join("\0") !== expected.argv.join("\0") || fresh.startId !== target.startId) continue;
      const final = planRenice({ processes: [fresh], complete: true }, { uid: this.deps.uid, protectedPids: protectedSet(current.processes, this.deps.selfPid), heavyNice: settings.heavyNice, browserNice: settings.browserNice })[0];
      if (!final) continue;
      try { this.deps.renice(fresh.pid, final.target); lowered++; if (final.kind === "heavy") loweredHeavy++; } catch { /* Exited or refused. */ }
    }
    if (lowered) await this.log({ job: "renice", outcome: "done", what: words(loweredHeavy, lowered - loweredHeavy), why: "Lowered their priority so Paseo and chats stay responsive (never raised)", count: lowered });
    return { outcome: "done", summary: lowered ? `Lowered ${words(loweredHeavy, lowered - loweredHeavy)}.` : "Nothing needed a lower priority." };
  }

  // -------------------------------------------------------------- reap

  /** A complete table, Paseo's answer for every tagged browser-family process in it, and the plan from both. */
  private async freshPlan(settings: HousekeepingSettings, signal: AbortSignal, onlyOwner?: string): Promise<{ table: ProcTable; owners: Map<string, OwnerKind>; plan: ReapPlan }> {
    const table = await this.deps.procs.scan(signal);
    const ids = table.complete ? table.processes.filter((p) => p.uid === this.deps.uid && wantsEnvironment(p) && p.agentId).map((p) => p.agentId!) : [];
    const owners = await this.deps.owners.lookup(onlyOwner ? [onlyOwner] : ids, signal);
    const plan = planReap(table, owners, { uid: this.deps.uid, protectedPids: protectedSet(table.processes, this.deps.selfPid), stuckQueryMaxHours: settings.stuckQueryMaxHours, browserMaxAgeHours: settings.browserMaxAgeHours });
    return { table, owners, plan };
  }

  private async reap(settings: HousekeepingSettings, preview: boolean, signal: AbortSignal): Promise<JobResult> {
    const first = await this.freshPlan(settings, signal);
    if (!first.table.complete) {
      await this.notice("blocked", "Close finished chats' browsers", "Hosts couldn't read every process, so nothing was closed");
      return { outcome: "blocked", summary: "Couldn't read every process, so nothing was closed." };
    }
    for (const kept of first.plan.kept) await this.log({ job: "reap", outcome: "kept", what: kept.what, why: kept.why });
    const { groups } = first.plan;
    if (!groups.length) return { outcome: "done", summary: first.plan.kept.length ? `Nothing to close; ${plural(first.plan.kept.length, "leftover")} kept (see the log).` : "Nothing left over by finished chats." };
    if (preview) {
      for (const group of groups) await this.log({ job: "reap", outcome: "preview", what: group.what, why: `Would close it: ${group.why}${group.profile ? ", and remove its browser profile" : ""}`, count: group.pids.length });
      return { outcome: "preview", summary: `Would close ${plural(groups.length, "leftover")} from finished chats.` };
    }
    const signalled: ReapTarget[] = [];
    // TERM every independently authorized target before the common grace period.
    for (const target of first.plan.targets.slice(0, 256)) {
      if (await this.signalTarget(target, "SIGTERM", settings, signal)) signalled.push(target);
      if (signal.aborted) break;
    }
    let killed = 0;
    if (signalled.length && await (this.deps.sleep ?? abortableSleep)(TERM_WAIT_MS, signal)) {
      for (const target of signalled) {
        if (await this.signalTarget(target, "SIGKILL", settings, signal)) killed++;
        if (signal.aborted) break;
      }
    }
    let closed = 0, requested = 0;
    for (const group of groups) {
      const sent = signalled.filter((t) => t.group === group.key);
      if (!sent.length) {
        await this.log({ job: "reap", outcome: "kept", what: group.what, why: "The fresh checks didn't authorize a stop, so it was left alone" });
        continue;
      }
      requested++;
      // A delivered signal is a request. Only absence of every original identity proves exit.
      let exited = sent.length === group.pids.length;
      for (const target of sent) {
        try {
          const fresh = await this.deps.procs.read(target.pid);
          if (fresh && fresh.startId === target.startId) exited = false;
        } catch { exited = false; }
      }
      let profile = "";
      if (exited && group.profile) profile = await this.profile(group.profile, group.agentId, signal);
      if (exited) closed++;
      await this.log({ job: "reap", outcome: exited ? "done" : "kept", what: group.what, why: `${exited ? "Verified exit" : "Stop requested; exit not confirmed"}: ${group.why}${profile}`, count: sent.length });
    }
    return { outcome: closed ? "done" : requested ? "kept" : "skipped", summary: `Stop requested for ${requested} leftovers; verified ${closed} exits${killed ? `; sent ${killed} forced-stop requests` : ""}.` };
  }

  /** No authorization cache: fresh owner, full table, ancestors, policy and final identity for EACH signal. */
  private async signalTarget(target: ReapTarget, kind: "SIGTERM" | "SIGKILL", settings: HousekeepingSettings, signal: AbortSignal): Promise<boolean> {
    if (!(await this.mayAct(signal))) return false;
    const current = await this.freshPlan(settings, signal, target.agentId);
    if (!current.table.complete || (kind === "SIGTERM" && !stillPlanned([target], current.plan).length) || protectedSet(current.table.processes, this.deps.selfPid).has(target.pid)) return false;
    const row = current.table.processes.find((p) => p.pid === target.pid);
    if (!row) return false;
    const chain = ancestorsIn(row, new Map(current.table.processes.map((p) => [p.pid, p])));
    if (!chain) return false;
    const owner = await this.deps.owners.lookup([target.agentId], signal);
    if (!isFinished(owner.get(target.agentId)) || !(await this.mayAct(signal))) return false;
    const freshChain: HkProcess[] = [];
    for (const parent of chain) {
      const fresh = await this.deps.procs.read(parent.pid).catch(() => null);
      if (!fresh || fresh.uid !== parent.uid || fresh.startId !== parent.startId || fresh.ppid !== parent.ppid) return false;
      freshChain.push(fresh);
    }
    const fresh = await this.deps.procs.read(target.pid).catch(() => null);
    if (signal.aborted || !sameTarget(fresh, target, this.deps.uid) || fresh!.ppid !== row.ppid || !qualifiesNow(fresh!, freshChain, target, { uid: this.deps.uid, stuckQueryMaxHours: settings.stuckQueryMaxHours, verifiedSession: kind === "SIGKILL" })) return false;
    try { this.deps.kill(target.pid, kind); return true; } catch { return false; }
  }

  /** The profile goes only when a complete, fresh table shows nothing uses it and its chat is still finished. */
  private async profile(path: string, agentId: string, signal: AbortSignal): Promise<string> {
    const check = async (currentPath = path): Promise<string | null> => {
      if (!(await this.mayAct(signal))) return "Housekeeping was paused";
      const owners = await this.deps.owners.lookup([agentId], signal);
      if (!isFinished(owners.get(agentId))) return "its chat is no longer confirmed finished";
      if (!(await this.mayAct(signal))) return "Housekeeping stopped";
      if (!(await this.deps.privateProfile?.(currentPath))) return "the profile is not a private owned folder";
      const table = await this.deps.procs.scan(signal);
      if (!table.complete) return "not every process could be read";
      const boundary = { uid: this.deps.uid, privateOwned: true };
      if (profileInUse(table, path, boundary) || (currentPath !== path && profileInUse(table, currentPath, boundary))) return "a process still uses it";
      return signal.aborted ? "Housekeeping stopped" : null;
    };
    // A moment for the stopped processes to exit, then the checks.
    await (this.deps.sleep ?? abortableSleep)(1_000, signal);
    const before = await check();
    if (before) return `; its browser profile was kept (${before})`;
    const removed = await this.deps.removeProfile(path, check, signal).catch(() => ({ ok: false, why: "it couldn't be removed" }));
    return removed.ok ? "; its browser profile was removed" : `; its browser profile was kept (${(removed.why ?? "it couldn't be removed").replace(/\.$/, "")})`;
  }

  // -------------------------------------------------------------- turbo

  private async turbo(settings: HousekeepingSettings, preview: boolean, signal: AbortSignal): Promise<JobResult> {
    const list = await withDeadline(this.deps.workspaces(signal), WORKSPACES_READ_MS, null);
    if (!list) {
      await this.notice("blocked", "Trim old build caches", "Paseo's workspaces couldn't be read, so no cache was touched");
      return { outcome: "blocked", summary: "Paseo's workspaces couldn't be read, so no cache was touched." };
    }
    const seen = new Set<string>();
    const registered = list.filter((item) => !seen.has(item.directory) && seen.add(item.directory));
    const workspaces = registered.slice(0, Math.min(MAX_WORKSPACES, 16));
    let limited = registered.length > workspaces.length;
    const table = await this.deps.procs.scan(signal);
    if (!table.complete) return { outcome: "blocked", summary: "Couldn't read every process to see which caches are in use, so none was trimmed." };
    const roots = list.map((item) => item.directory);
    let files = 0, bytes = 0, folders = 0, pending = 0, budget = 256, scanBudget = MAX_CACHE_SCAN_PER_CYCLE;
    for (const workspace of workspaces) {
      if (signal.aborted || budget <= 0 || scanBudget <= 0) { limited = true; break; }
      const cache = await turboCacheDir(workspace.directory, this.deps.places, this.deps.uid, roots);
      if ("why" in cache) {
        if (cache.why !== "none") await this.previewOnce("turbo", `why:${workspace.directory}`, { what: `Turborepo cache in ${workspace.name}`, why: `${cache.why}, so it was left alone` });
        continue;
      }
      const available = async () => {
        const current = await withDeadline(this.deps.workspaces(signal), WORKSPACES_READ_MS, null);
        const matches = current?.filter((item) => item.directory === workspace.directory);
        // Do not use workspaceState(): its unknown fallback is intended for display, not delete authority.
        if (!matches?.length || matches.some((item) => item.status !== "idle" || item.devServers.length)) return false;
        const checked = await turboCacheDir(workspace.directory, this.deps.places, this.deps.uid, current!.map((item) => item.directory));
        if ("why" in checked || checked.root !== cache.root || checked.chain.some((link, i) => link.dev !== cache.chain[i]?.dev || link.ino !== cache.chain[i]?.ino)) return false;
        const fresh = await this.deps.procs.scan(signal);
        if (!fresh.complete) return false;
        const active = fresh.processes.some((p) => p.uid === this.deps.uid && p.pid !== this.deps.selfPid && (p.cwd === null ? !!p.exe || p.argv.length > 0 : p.cwd === cache.root || isWithin(p.cwd, cache.root)));
        return !signal.aborted && !active;
      };
      if (workspace.status !== "idle" || workspace.devServers.length || (preview && !(await available()))) { pending++; await this.log({ job: "turbo", outcome: "kept", what: `Turborepo cache in ${workspace.name}`, why: "Its workspace or cache use couldn't be confirmed idle, so it was left for next time" }); continue; }
      const result = await trimCache(cache, this.deps.uid, this.now(), settings.turboCacheMaxDays, { preview, signal, mayAct: () => this.mayAct(signal), batchAvailable: available, budget, scanBudget, now: this.now });
      limited ||= result.truncated;
      scanBudget -= result.scanned;
      if (result.stopped) pending++;
      if (!result.candidates) continue;
      budget -= result.candidates;
      const what = `Turborepo cache in ${workspace.name}`;
      if (preview) {
        await this.log({ job: "turbo", outcome: "preview", what, why: `Would delete ${plural(result.candidates, "entry", "entries")} older than ${settings.turboCacheMaxDays} days (${formatSize(result.bytes)})`, count: result.candidates, bytes: result.bytes });
        files += result.candidates; bytes += result.bytes; folders++;
        continue;
      }
      if (result.removed) { files += result.removed; bytes += result.bytes; folders++; }
      await this.log({ job: "turbo", outcome: result.removed ? "done" : result.stopped ? "skipped" : "kept", what, why: result.removed ? `Deleted ${plural(result.removed, "entry", "entries")} older than ${settings.turboCacheMaxDays} days${result.stopped ? `; then stopped: ${result.stopped}` : ""}` : result.stopped ?? "The entries changed before they could be deleted, so they were left", count: result.removed, bytes: result.bytes });
    }
    const limitNote = limited ? " Scan limit reached; later passes may revisit the same folders or entries. Use Workspaces to inspect the rest." : "";
    if (!files) return { outcome: pending ? "blocked" : preview ? "preview" : "done", summary: (pending ? "Pending: workspace activity must be freshly verified idle before old caches can be trimmed." : "No old cache entries were eligible in this bounded pass.") + limitNote };
    const where = `${formatSize(bytes)} in ${plural(folders, "workspace")}`;
    return preview ? { outcome: "preview", summary: `Would delete ${plural(files, "old cache entry", "old cache entries")} (${where}).${limitNote}` } : { outcome: "done", summary: `Deleted ${plural(files, "old cache entry", "old cache entries")} (${where}).${limitNote}` };
  }

  // -------------------------------------------------------------- status

  async status(): Promise<HousekeepingStatus> {
    const settings = await withDeadline(this.deps.readSettings(), SETTINGS_READ_MS, null);
    const enabled = settings?.enabled ?? false, dryRun = settings?.dryRun ?? true;
    if (!this.runsLoaded && this.supported) { this.runs = await this.deps.log.runs().catch(() => ({ ...NO_RUNS })); this.runsLoaded = true; }
    let state = this.state, message = this.message;
    // Between beats a switch flip shows at once; the next beat confirms it.
    if (this.supported && settings && !settings.enabled) { state = "off"; message = STATE_MESSAGES.off!; }
    if (this.supported && settings?.enabled && settings.dryRun && state === "live") { state = "preview"; message = STATE_MESSAGES.preview!; }
    const [actions, machine] = await Promise.all([
      this.supported ? this.deps.log.recent(20).catch(() => []) : Promise.resolve([]),
      this.supported && this.deps.machine ? this.deps.machine().catch(() => null) : Promise.resolve(null),
    ]);
    return { state, message, enabled, dryRun, lastRuns: this.supported ? this.runs : { ...NO_RUNS }, actions, machine, checkedAt: this.now() };
  }
}

/** Free memory against the container's limit where there is one (cgroup v1 or v2), else the machine; load and cores. */
export async function readMachine(): Promise<Machine | null> {
  const meminfo = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  const cgroup = await readCgroup(meminfo.totalBytes).catch(() => null);
  const cores = Math.max(1, Math.round(cgroup?.cpuLimitCores ?? cpus().length));
  const load1 = Math.max(0, loadavg()[0] ?? 0);
  if (cgroup?.memoryLimitBytes) return { basis: "container", totalBytes: cgroup.memoryLimitBytes, freeBytes: Math.max(0, cgroup.memoryLimitBytes - cgroup.memoryWorkingSetBytes), load1, cores };
  return { basis: "machine", totalBytes: meminfo.totalBytes, freeBytes: meminfo.availableBytes, load1, cores };
}
