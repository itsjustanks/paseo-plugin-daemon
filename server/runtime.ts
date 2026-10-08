import { execFile } from "node:child_process";
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
import { DiskScanner, defaultPlaces, disksFor, folderAskText, readWorkspace, type WorkspaceInfo } from "./disk-scan";
import { formatSize } from "../shared/disk";
import type { AskContext } from "../shared/ask";
import { DiskCleaner, DiskTokens, cacheToolReady } from "./disk-clear";
import { QuarantineInventory } from "./disk-quarantine";
import { join } from "node:path";
import type { DiskJob, DiskPlan, DiskReport } from "../shared/disk";

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
  // 0.14.0: disk usage. The workspaces come from Paseo's SDK through the bound session.
  /** From the shared registry read; `force` (scan, clear) reads fresh, polling reuses the 60-second cache. */
  const listWorkspaces = async (force = false): Promise<WorkspaceInfo[]> => (await scope.workspaceDescriptors(force)).map(readWorkspace).filter((item): item is WorkspaceInfo => item !== null);
  let knownFolders: string[] = [];
  /** Dev servers the monitor last saw, with absolute folders, for "dev server running here". */
  let lastServices: Array<{ cwd: string | null; label: string; ports: number[] }> | null = null;
  let servicesAt = 0;
  let disk: { scanner: DiskScanner; cleaner: DiskCleaner; tokens: DiskTokens; places: ReturnType<typeof defaultPlaces>; inventory: QuarantineInventory } | null = null;
  if (monitor.internals) {
    const { adapter, uid } = monitor.internals;
    const places = defaultPlaces(adapter.platform);
    const tokens = new DiskTokens();
    const devServersIn = (folder: string) => (lastServices ?? []).filter((service) => service.cwd && (service.cwd === folder || service.cwd.startsWith(`${folder}/`))).map((service) => `${service.label}${service.ports[0] ? ` :${service.ports[0]}` : ""}`);
    // Every quarantine is recorded; on load, an interrupted clear is put back where its place is free.
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    void inventory.recover().then((outcome) => {
      for (const entry of outcome.restored) void log.append({ at: Date.now(), action: "disk-clear", source: "disk", pid: null, name: entry.name, owner: null, status: "done", signaled: 0, message: "Put back after an interrupted clear.", bytes: 0 });
      if (outcome.left.length) console.log(`daemon-link: ${outcome.left.length} folder(s) left from an interrupted clear; listed under Workspaces`);
    }).catch(() => undefined);
    const scanner = new DiskScanner({
      places, uid, listWorkspaces: () => listWorkspaces(true), devServersIn, inventory,
      pnpmStore: async (group) => { const result = await group.run("pnpm", ["store", "path"], { timeoutMs: 10_000, cwd: places.home }); return result.code === 0 ? result.stdout.trim() || null : null; },
      toolReady: (kind, group) => cacheToolReady(kind, group, places.home),
    });
    const cleaner = new DiskCleaner({
      places, uid, tokens, inventory, listWorkspaces: () => listWorkspaces(true),
      unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
      log: (entry) => log.append(entry),
      cleared: (path, bytes) => scanner.forget(path, bytes),
    });
    disk = { scanner, cleaner, tokens, places, inventory };
  }
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
      // statfs only: Paseo's home, the home folder, /tmp and the workspace folders last seen.
      diskPaths: () => [...new Set([disk?.places.paseoHome ?? "", disk?.places.home ?? "", ...(disk?.places.tmpDirs ?? []), ...knownFolders].filter(Boolean))],
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
  const diskApi = {
    async report(scan: boolean): Promise<DiskReport> {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      const workspaces = await listWorkspaces().catch(() => [] as WorkspaceInfo[]);
      if (workspaces.length) knownFolders = workspaces.map((workspace) => workspace.directory).slice(0, 30);
      // The app polls this while a check runs; the process snapshot behind "dev server running here" is reused for 30 s.
      if (Date.now() - servicesAt > 30_000) try {
        servicesAt = Date.now();
        const snap = await monitor.snapshot({ query: "", sort: "pid", limit: 200 });
        const absolute = (cwd: string | null) => (cwd && cwd.startsWith("~/") ? `${disk!.places.home}/${cwd.slice(2)}` : cwd);
        lastServices = snap.services.map((service) => ({ cwd: absolute(service.cwd), label: service.service?.label ?? service.name, ports: service.ports }));
      } catch { /* Dev servers are a courtesy here. */ }
      if (scan && !disk.cleaner.isRunning) disk.scanner.start();
      const disks = await disksFor([disk.places.paseoHome, disk.places.home, ...disk.places.tmpDirs, ...knownFolders]);
      return disk.scanner.report(workspaces, (item) => disk!.tokens.mint(item), disks);
    },
    preview: (tokens: readonly string[]): Promise<DiskPlan> => {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      return disk.cleaner.preview(tokens);
    },
    clear: (tokens: readonly string[]): DiskJob => {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      if (disk.scanner.isRunning) return { state: "idle", freedBytes: 0, results: [], message: "A disk check is still running. Clear once it finishes." };
      return disk.cleaner.start(tokens);
    },
    status: (): DiskJob => disk ? disk.cleaner.status() : { state: "idle", freedBytes: 0, results: [], message: null },
    /** Unloading: stop the scan and the clear job, kill their process groups (walk, find, rm, pnpm), and wait for both. */
    async close(): Promise<void> { if (disk) await Promise.all([disk.scanner.close(), disk.cleaner.close()]); },
    /** "Ask an agent" about a folder Hosts won't remove itself: an unlinked worktree, a /tmp folder, or what an interrupted clear left. Only ids the last check (or the inventory) knows. */
    async folderAsk(id: string): Promise<AskContext | null> {
      if (!disk) return null;
      const home = disk.places.home;
      const ask = (title: string, text: string): AskContext => ({ title, text, workspaceId: null, workspaceName: null, outputFrom: null });
      if (id.startsWith("leftover:")) {
        const entry = (await disk.inventory.list().catch(() => [])).find((item) => `leftover:${item.quarantine}` === id);
        if (!entry) return null;
        return ask(`Left over from an interrupted clear (${formatSize(entry.bytes)})`, folderAskText({ path: entry.quarantine, bytes: entry.bytes, branch: null, changedAt: entry.at, kind: "leftover", original: entry.original }, home));
      }
      if (id.startsWith("tmp:")) {
        const cache = disk.scanner.last()?.caches.find((item) => item.key === id && item.kind === "tmp");
        if (!cache) return null;
        return ask(`A folder in the temporary folder (${formatSize(cache.bytes)})`, folderAskText({ path: cache.path, bytes: cache.bytes, branch: null, changedAt: Math.round(cache.mtimeMs), kind: "tmp" }, home));
      }
      const folder = disk.scanner.last()?.folders.find((item) => item.key === id && item.kind === "worktree");
      if (!folder) return null;
      const branch = await new Promise<string | null>((resolve) => execFile("git", ["-C", folder.path, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null)));
      const changedAt = folder.result?.newestMtimeMs ? Math.round(folder.result.newestMtimeMs) : null;
      return ask(`A worktree no workspace uses (${formatSize(folder.result?.totalBytes ?? 0)})`, folderAskText({ path: folder.path, bytes: folder.result?.totalBytes ?? 0, branch, changedAt }, home));
    },
  };
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

  // Starting a share is a user action (fresh registry read); the lease's later re-checks reuse the passive cache.
  const lease = async (port: number) => {
    await scope.refresh(true).catch(() => undefined);
    return createServiceLease(port, async (owner, servicePort) => {
      await scope.refresh();
      return scope.match(owner, [servicePort])?.shareable === true;
    });
  };
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
    links, peers, monitor: { ...monitor, stop: monitorStop, forceStop: monitorForceStop }, transfers, scope, processes, log, guard, plugins, disk: diskApi,
    watch: new WatchChecker(),
    withContext<T>(context: PluginHandlerContext, action: () => T): T { scope.bind(context.paseo); return action(); },
  };
}
