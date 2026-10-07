import { ProjectTransfers } from "./transfers";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ActionResult } from "../shared/contracts";
import type { ProcessReport, ReportInput, StopOutcome, StopPlan } from "../shared/processes";
import { HOSTS_SETTINGS_DEFAULTS, type HostsSettings } from "../shared/settings";
import { ActionLog } from "./action-log";
import { createMonitorHandlers } from "./handlers";
import { createServiceLease } from "./lease";
import { LinkManager } from "./links";
import { PeerManager } from "./peers";
import { ProcessManager } from "./processes";
import { ProjectScope } from "./scope";
import { TunnelManager } from "./tunnels";
import { WatchChecker } from "./watch";
import { AdapterQuickSampler, GUARD_INTERVAL_MS, GuardLoop, LinuxQuickSampler } from "./guard-loop";
import { scanLaunches } from "./daemon-log";
import { PaseoCli } from "./paseo-cli";
import { listPluginHosts, startClock } from "./plugin-procs";
import { PluginRestarter } from "./plugin-restart";
import { RESTART_WAIT_MS, type RestartOutcome } from "../shared/guard";

export interface RuntimeOptions {
  readSettings?: () => Promise<HostsSettings>;
  log?: ActionLog;
  /** Tests pass false to keep the check loop and the paseo command out of the way. */
  guard?: boolean;
}

/** The Processes tab on a platform the monitor can't read: an honest, empty report. */
export function unsupportedProcesses() {
  const refuse = (): never => { throw new Error("Process management supports Linux and macOS only."); };
  return {
    report: async (): Promise<ProcessReport> => ({
      checkedAt: Date.now(), platform: "unsupported", supported: false, sampling: false,
      host: { cores: 1, cpuPercent: null, load1: 0, memoryTotalBytes: 0, memoryUsedBytes: 0, cpuPressure: "normal", memoryPressure: "normal" },
      container: null, memoryBasis: "machine", memoryBasisBytes: 0, heavyJobs: { count: 0, limit: HOSTS_SETTINGS_DEFAULTS.maxHeavyJobs, pids: [] },
      runaways: [], processes: [], total: 0, matched: 0, paseoBytes: 0, projectsVerified: false, warnings: [`Process management supports Linux and macOS. This daemon runs on ${process.platform}.`], recentActions: [],
    }),
    preview: async (): Promise<StopPlan> => refuse(),
    stop: async (): Promise<StopOutcome> => refuse(),
    close() {},
  };
}

export function createRuntime(options: RuntimeOptions = {}) {
  const scope = new ProjectScope();
  const transfers = new ProjectTransfers(scope);
  const log = options.log ?? new ActionLog();
  const monitor = createMonitorHandlers({ scope });
  const readSettings = options.readSettings ?? (async () => HOSTS_SETTINGS_DEFAULTS);
  // 0.13.0: the always-on check loop (memory pressure, growth, plugin health) and plugin restarts.
  let guard: GuardLoop | null = null;
  const manager = monitor.internals ? new ProcessManager({
    ...monitor.internals, daemonPid: monitor.internals.parentPid, scope, log, readSettings,
    growth: (pid, startId) => guard?.growthOf(pid, startId) ?? null,
    memoryLevel: () => guard?.state().memory.level ?? "normal",
  }) : null;
  let restarter: PluginRestarter | null = null;
  if (manager && monitor.internals && options.guard !== false) {
    const { adapter, uid, selfPid, parentPid } = monitor.internals;
    const cli = new PaseoCli();
    const startMs = startClock(adapter.platform);
    guard = new GuardLoop({
      sampler: adapter.platform === "linux" ? new LinuxQuickSampler(uid) : new AdapterQuickSampler(adapter, uid),
      intervalMs: adapter.platform === "linux" ? GUARD_INTERVAL_MS : GUARD_INTERVAL_MS * 3,
      readSettings: async () => ({ autoStopRunaways: (await readSettings().catch(() => HOSTS_SETTINGS_DEFAULTS)).autoStopRunaways === true }),
      autoStop: (minPercent, confirm) => manager.autoStopBiggest(minPercent, confirm),
      onAutoStop: (stop) => console.log(`daemon-link: memory guard: ${stop.message}`),
      restartCheck: async () => (await cli.canReload()) ? { ok: true, reason: null } : { ok: false, reason: "Restart needs Paseo's paseo command, and Hosts can't find one here that can reload plugins." },
    });
    const loop = guard;
    restarter = new PluginRestarter({
      cli,
      launches: async () => (await scanLaunches()).launches,
      hosts: () => listPluginHosts({ adapter, uid, daemonPid: parentPid, selfPid, startMs }),
      identity: (pid) => adapter.readIdentity(pid),
      kill: (pid, signal) => { process.kill(pid, signal); },
      self: { pid: selfPid, startMs: async () => { const identity = await adapter.readIdentity(selfPid).catch(() => null); return identity ? startMs(identity.startId) : null; } },
      uid, daemonPid: parentPid,
      log: (entry) => log.append(entry),
      readyAfter: async (pluginId, since) => { await loop.pollLog(); return (loop.logState.lastReady(pluginId) ?? 0) > since; },
    });
  }
  const unavailable = (pluginId: string): RestartOutcome => ({ ok: false, outcome: "refused", message: "Plugin restarts aren't available on this host.", steps: [], pluginId });
  const plugins = {
    restart: async (pluginId: string): Promise<RestartOutcome> => restarter ? restarter.begin(pluginId, RESTART_WAIT_MS) : unavailable(pluginId),
    status: (pluginId: string): RestartOutcome => restarter ? restarter.status(pluginId) : unavailable(pluginId),
  };
  const processes = manager ? {
    report: (input: ReportInput) => manager.report(input, () => log.recent(5)),
    preview: (tokens: readonly string[]) => manager.preview(tokens),
    stop: (tokens: readonly string[]) => manager.stop(tokens),
    close: () => manager.close(),
  } : unsupportedProcesses();

  /** The monitor's own stop controls (workspace tab, dev-server cards) are logged too. */
  const logged = (action: "stop" | "force-stop", run: (input: { token: string }) => Promise<ActionResult>) => async (input: { token: string }) => {
    const result = await run(input);
    let name = "Dev server", owner: string | null = null;
    try {
      const base = await monitor.internals?.collector.collect();
      const view = base?.processes.find((item) => item.pid === result.pid);
      if (view) { name = view.name; owner = view.project ? `${view.project.name}${view.project.workspace ? ` · ${view.project.workspace}` : ""}` : null; }
    } catch { /* The name is a courtesy; the entry is written regardless. */ }
    await log.append({ at: Date.now(), action, source: "monitor", pid: result.pid, name, owner, status: result.status, signaled: result.signaledCount, message: result.message });
    return result;
  };
  const monitorStop = logged("stop", monitor.stop);
  const monitorForceStop = logged("force-stop", monitor.forceStop);

  const lease = (port: number) => createServiceLease(port, async (owner, servicePort) => {
    await scope.refresh();
    return scope.match(owner, [servicePort])?.shareable === true;
  });
  const links = new LinkManager(undefined, new TunnelManager(lease));
  const peers = new PeerManager(undefined, lease, async () => {
    await scope.refresh();
    const snapshot = await monitor.snapshot({});
    const ports = new Map<number, { port: number; label: string; project: string | null }>();
    for (const process of snapshot.services) {
      if (!process.project?.shareable || process.protectedReason) continue;
      for (const port of process.ports) ports.set(port, {
        port, label: process.service?.kind === "dev-server" ? process.service.label : "Project service",
        project: process.project.name,
      });
    }
    return [...ports.values()];
  }, transfers);
  return {
    links, peers, monitor: { ...monitor, stop: monitorStop, forceStop: monitorForceStop }, transfers, scope, processes, log, guard, plugins,
    watch: new WatchChecker(),
    withContext<T>(context: PluginHandlerContext, action: () => T): T { scope.bind(context.paseo); return action(); },
  };
}
