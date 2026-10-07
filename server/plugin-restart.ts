import { PLUGIN_ID, isHostsPlugin, pluginName, type RestartOutcome } from "../shared/guard";
import type { ActionLogEntry } from "../shared/processes";
import type { Launch } from "./daemon-log";
import type { CliResult } from "./paseo-cli";
import type { ProcessIdentity } from "./platform";
import { identify, type PluginHost } from "./plugin-procs";

/**
 * "Restart <plugin>" (0.13.0), after the person has said yes.
 *
 *  1. `paseo plugin reload <id>`, with a timeout. Usually that's it.
 *  2. If the reload hangs (Paseo's plugin manager is wedged on the stuck
 *     plugin), find that plugin's process (plugin-procs.ts), re-read its
 *     identity immediately before each signal, and stop only it: SIGTERM,
 *     then SIGKILL after the grace period if the very same process is still
 *     there. An old copy of the plugin stuck stopping is stopped the same way.
 *  3. Give the queued reload a moment to finish on its own; if it doesn't,
 *     reload again.
 *
 * Never: the daemon, Hosts itself, a process that isn't one of this daemon's
 * plugin processes, or anything when the plugin's process can't be told
 * apart. A reload that fails for another reason (unknown plugin, disabled)
 * stops nothing. Every step is logged.
 */

export interface RestartDeps {
  cli: { canReload(): Promise<boolean>; reload(pluginId: string, timeoutMs: number): Promise<CliResult> };
  /** Launch history read fresh from the daemon's logs. */
  launches(): Promise<ReadonlyMap<string, readonly Launch[]>>;
  /** This daemon's plugin processes, other than Hosts'. */
  hosts(): Promise<PluginHost[]>;
  identity(pid: number): Promise<ProcessIdentity | null>;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  self: { pid: number; startMs(): Promise<number | null> };
  uid: number;
  daemonPid: number;
  log(entry: ActionLogEntry): Promise<void>;
  /** Whether the log shows the plugin ready again after `since` (it re-reads the log). */
  readyAfter(pluginId: string, since: number): Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  reloadTimeoutMs?: number;
  graceMs?: number;
  settleMs?: number;
}

export const RELOAD_TIMEOUT_MS = 45_000;
export const PLUGIN_GRACE_MS = 10_000;
export const SETTLE_MS = 15_000;

const timedOutText = (result: CliResult) => result.timedOut || /timed? ?out/i.test(result.stderr + result.stdout);
/** The CLI's error, without its plumbing: "Error: Request failed: Plugin is not configured: x requestType=… code=…" → "Plugin is not configured: x". */
export const brief = (text: string) => text.replace(/\s+/g, " ").replace(/\b(requestType|code)=\S+/g, "").replace(/^(\s*(Error|Request failed):\s*)+/i, "").trim().slice(0, 160).replace(/\.$/, "");

export class PluginRestarter {
  private busy = false;
  /** The restart in progress, or the last one, for "running" answers and polling. */
  private job: { pluginId: string; steps: RestartOutcome["steps"]; result: Promise<RestartOutcome>; outcome: RestartOutcome | null } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RestartDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); }));
  }

  /**
   * Start (or join) a restart and wait at most `waitMs` for it. A restart
   * that takes longer keeps going in the background and this answers
   * "running"; `status` reports it until it finishes.
   */
  async begin(pluginId: string, waitMs: number): Promise<RestartOutcome> {
    if (!this.job || this.job.outcome || this.job.pluginId !== pluginId) {
      if (this.busy) return { ok: false, outcome: "refused", message: "A plugin restart is already running. Wait for it to finish.", steps: [], pluginId };
      const steps: RestartOutcome["steps"] = [];
      const job = { pluginId, steps, outcome: null as RestartOutcome | null, result: this.restart(pluginId, steps) };
      void job.result.then((outcome) => { job.outcome = outcome; });
      this.job = job;
    }
    const job = this.job;
    const timeout = new Promise<null>((resolve) => { const timer = setTimeout(() => resolve(null), waitMs); (timer as { unref?: () => void }).unref?.(); });
    const finished = await Promise.race([job.result, timeout]);
    return finished ?? this.running(job.pluginId, job.steps);
  }

  status(pluginId: string): RestartOutcome {
    const job = this.job;
    if (!job || job.pluginId !== pluginId) return { ok: false, outcome: "failed", message: "No restart of that plugin is running here.", steps: [], pluginId };
    return job.outcome ?? this.running(pluginId, job.steps);
  }

  private running(pluginId: string, steps: RestartOutcome["steps"]): RestartOutcome {
    return { ok: false, outcome: "running", message: `Restarting ${pluginName(pluginId)}… This can take up to two minutes when Paseo is stuck.`, steps: [...steps], pluginId };
  }

  async restart(pluginId: string, steps: RestartOutcome["steps"] = []): Promise<RestartOutcome> {
    const step = (text: string) => { steps.push({ at: this.now(), text }); };
    const name = PLUGIN_ID.test(pluginId) ? pluginName(pluginId) : "That plugin";
    const done = (ok: boolean, outcome: RestartOutcome["outcome"], message: string): RestartOutcome => ({ ok, outcome, message, steps: [...steps], pluginId });
    if (!PLUGIN_ID.test(pluginId)) return done(false, "refused", "That isn't a plugin id Hosts recognises.");
    if (isHostsPlugin(pluginId)) return done(false, "refused", "Hosts never restarts itself.");
    if (this.busy) return done(false, "refused", "A plugin restart is already running. Wait for it to finish.");
    this.busy = true;
    try {
      if (!await this.deps.cli.canReload()) return done(false, "refused", "Restart needs Paseo's paseo command, and Hosts can't find one here that can reload plugins.");
      const timeout = this.deps.reloadTimeoutMs ?? RELOAD_TIMEOUT_MS;
      step(`Asked Paseo to reload ${name}.`);
      const first = await this.deps.cli.reload(pluginId, timeout);
      await this.record("plugin-reload", pluginId, name, null, first.code === 0 ? "done" : timedOutText(first) ? "timed-out" : "failed", 0, first.code === 0 ? `${name} reloaded.` : `Reload ${timedOutText(first) ? "timed out" : "failed"}.`);
      if (first.code === 0) { step(`${name} reloaded.`); return done(true, "reloaded", `${name} restarted. It should answer again within a few seconds.`); }
      if (!timedOutText(first)) {
        step(`The reload failed: ${brief(first.stderr || first.stdout) || "no reason given"}.`);
        return done(false, "failed", `Paseo couldn't reload ${name}: ${brief(first.stderr || first.stdout) || "no reason given"}. Nothing was stopped.`);
      }
      step(`The reload didn't finish in ${Math.round(timeout / 1000)} seconds, so Paseo's plugin manager looks stuck on ${name}.`);

      const stopped = await this.stopPluginProcesses(pluginId, name, step);
      if (!stopped.ok) return done(false, "failed", `Hosts stopped nothing: ${stopped.reason}`);

      if (await this.settled(pluginId, stopped.at)) { step(`Paseo finished reloading ${name} on its own.`); return done(true, "stopped-and-reloaded", `${name} was stuck, so Hosts stopped its process and Paseo started it again.`); }
      step(`Asked Paseo to reload ${name} again.`);
      const second = await this.deps.cli.reload(pluginId, timeout);
      await this.record("plugin-reload", pluginId, name, null, second.code === 0 ? "done" : timedOutText(second) ? "timed-out" : "failed", 0, second.code === 0 ? `${name} reloaded after its process was stopped.` : "Second reload did not finish.");
      if (second.code === 0) { step(`${name} reloaded.`); return done(true, "stopped-and-reloaded", `${name} was stuck, so Hosts stopped its process and reloaded it.`); }
      step("The second reload didn't finish either.");
      return done(false, "failed", `${name}'s process was stopped, but Paseo still didn't reload it. Try "paseo plugin reload ${pluginId}" in a terminal, or restart Paseo once no agent is working.`);
    } finally { this.busy = false; }
  }

  /** Find the plugin's process(es) and stop exactly those, re-checking each one immediately before its signal. */
  private async stopPluginProcesses(pluginId: string, name: string, step: (text: string) => void): Promise<{ ok: true; at: number } | { ok: false; reason: string }> {
    let found;
    try {
      const [launches, hosts, selfStart] = await Promise.all([this.deps.launches(), this.deps.hosts(), this.deps.self.startMs()]);
      found = identify(pluginId, launches, hosts, { pid: this.deps.self.pid, startMs: selfStart }, this.deps.daemonPid);
    } catch { return { ok: false, reason: "this host's processes couldn't be read." }; }
    if (!found.ok) { step(found.reason); return { ok: false, reason: found.reason }; }
    let signalled = 0;
    // A "Plugin ready" logged after this moment is the plugin coming back, not its old start.
    const startedAt = this.now();
    for (const target of found.targets) {
      const label = target.current ? `${name}'s process (PID ${target.pid})` : `an old copy of ${name} that never finished stopping (PID ${target.pid})`;
      if (!await this.same(target)) { step(`Skipped PID ${target.pid}: it changed or ended before it could be stopped.`); continue; }
      // Known limit (accepted in the 0.13.0 safety review): between this fresh identity read and kill(2) the
      // process could exit and its PID be reused, a window of microseconds. Closing it needs pidfd_send_signal,
      // which Node doesn't expose. The same limit applies to every stop (see server/safety.ts).
      try { this.deps.kill(target.pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { step(`PID ${target.pid} had already exited.`); continue; }
        await this.record("plugin-stop", pluginId, name, target.pid, "failed", 0, "The stop signal failed.");
        step(`Couldn't signal PID ${target.pid}.`); continue;
      }
      signalled += 1;
      await this.record("plugin-stop", pluginId, name, target.pid, "signaled", 1, `Asked ${label} to stop.`);
      step(`Asked ${label} to stop.`);
      if (await this.exited(target)) { step(`PID ${target.pid} stopped.`); continue; }
      if (!await this.same(target)) { step(`PID ${target.pid} stopped.`); continue; }
      try { this.deps.kill(target.pid, "SIGKILL"); } catch { step(`PID ${target.pid} stopped.`); continue; }
      await this.record("plugin-force-stop", pluginId, name, target.pid, "signaled", 1, `${label} ignored the request for ${Math.round((this.deps.graceMs ?? PLUGIN_GRACE_MS) / 1000)} seconds, so it was stopped forcefully.`);
      step(`PID ${target.pid} was still running after ${Math.round((this.deps.graceMs ?? PLUGIN_GRACE_MS) / 1000)} seconds, so it was stopped forcefully.`);
    }
    if (signalled === 0) return { ok: false, reason: `${name}'s process changed or ended before it could be stopped. Try Restart again.` };
    return { ok: true, at: startedAt };
  }

  /** A fresh read says this is still the same plugin process: same start, same command, this daemon's child, this user's, not Hosts. */
  private async same(target: PluginHost): Promise<boolean> {
    if (target.pid === this.deps.self.pid || target.pid === this.deps.daemonPid || target.pid <= 1) return false;
    let identity: ProcessIdentity | null;
    try { identity = await this.deps.identity(target.pid); } catch { return false; }
    return !!identity && identity.startId === target.startId && identity.argvHash === target.argvHash && identity.ppid === this.deps.daemonPid && identity.uid === this.deps.uid && identity.state !== "zombie";
  }

  private async exited(target: PluginHost): Promise<boolean> {
    const grace = this.deps.graceMs ?? PLUGIN_GRACE_MS;
    const until = this.now() + grace;
    while (this.now() < until) {
      await this.sleep(Math.min(500, grace));
      try {
        const identity = await this.deps.identity(target.pid);
        if (!identity || identity.startId !== target.startId || identity.state === "zombie") return true;
      } catch { /* Unreadable: keep waiting; the SIGKILL path re-checks before acting. */ }
    }
    return false;
  }

  private async settled(pluginId: string, since: number): Promise<boolean> {
    const settle = this.deps.settleMs ?? SETTLE_MS;
    const until = this.now() + settle;
    while (this.now() < until) {
      await this.sleep(Math.min(1000, settle));
      if (await this.deps.readyAfter(pluginId, since).catch(() => false)) return true;
    }
    return false;
  }

  private record(action: ActionLogEntry["action"], pluginId: string, name: string, pid: number | null, status: ActionLogEntry["status"], signaled: number, message: string) {
    return this.deps.log({ at: this.now(), action, source: "plugins", pid, name, owner: `Paseo plugin · ${pluginId}`, status, signaled, message }).catch(() => undefined);
  }
}
