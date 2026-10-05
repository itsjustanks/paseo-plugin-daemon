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

export interface RuntimeOptions {
  readSettings?: () => Promise<HostsSettings>;
  log?: ActionLog;
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
  const manager = monitor.internals ? new ProcessManager({
    ...monitor.internals, daemonPid: monitor.internals.parentPid, scope, log, readSettings,
  }) : null;
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
    links, peers, monitor: { ...monitor, stop: monitorStop, forceStop: monitorForceStop }, transfers, scope, processes, log,
    watch: new WatchChecker(),
    withContext<T>(context: PluginHandlerContext, action: () => T): T { scope.bind(context.paseo); return action(); },
  };
}
