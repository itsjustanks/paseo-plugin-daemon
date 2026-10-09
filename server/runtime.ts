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
import { safeGitArgs, safeGitEnv } from "./disk-git";
import { DiskScanner, cleanupAskText, defaultPlaces, disksFor, folderAskText, readWorkspace, type WorkspaceInfo } from "./disk-scan";
import { formatSize } from "../shared/disk";
import { friendlyPath } from "../shared/paths";
import { homeRelative } from "../shared/redaction";
import type { AskContext } from "../shared/ask";
import { join } from "node:path";
import { isWithin, type DiskJob, type DiskPlan, type DiskReport } from "../shared/disk";
import { DiskCleaner, DiskTokens, defaultTmpRoots } from "./disk-clear";
import { JOURNAL_PROBLEM, QuarantineInventory } from "./disk-quarantine";
import { measure } from "./disk-remove";
import { ChildGroup } from "./disk-children";

/** A disk report or ask waits this long for the registry or a process snapshot, then uses what it has. */
export const REPORT_READ_MS = 5000;

/** The value, or null after `ms`. The slow read isn't awaited further (the registry bounds its own reads). */
export function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

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
  let disk: { scanner: DiskScanner; places: ReturnType<typeof defaultPlaces>; cleaner: DiskCleaner; tokens: DiskTokens; inventory: QuarantineInventory; tmpRoots: string[] } | null = null;
  if (monitor.internals) {
    const { adapter, uid } = monitor.internals;
    const places = defaultPlaces(adapter.platform);
    const devServersIn = (folder: string) => (lastServices ?? []).filter((service) => service.cwd && (service.cwd === folder || service.cwd.startsWith(`${folder}/`))).map((service) => `${service.label}${service.ports[0] ? ` :${service.ports[0]}` : ""}`);
    const scanner = new DiskScanner({
      places, uid, listWorkspaces: () => listWorkspaces(true), devServersIn,
    });
    // 0.16.0: one-press Clear, for build folders inside a workspace or worktree only (disk-clear.ts).
    const tokens = new DiskTokens();
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    const recoveryGroup = new ChildGroup();
    void inventory.recover((path) => measure(path, recoveryGroup, Date.now() + 5 * 60_000)).then((outcome) => {
      if (outcome.restored.length) console.log(`daemon-link: put back ${outcome.restored.length} folder(s) an interrupted clear had set aside`);
    }).catch(() => undefined);
    const tmpRoots = defaultTmpRoots();
    const cleaner = new DiskCleaner({
      places, uid, tokens, inventory, tmpRoots, listWorkspaces: () => listWorkspaces(true),
      unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
      log: (entry) => log.append(entry), cleared: (path, bytes) => scanner.forget(path, bytes),
    });
    disk = { scanner, places, cleaner, tokens, inventory, tmpRoots };
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
  /** The registry for a disk report or ask: at most REPORT_READ_MS, else the last list it gave. */
  let lastWorkspaces: WorkspaceInfo[] = [];
  const currentWorkspaces = async (): Promise<WorkspaceInfo[]> => {
    const read = await bounded(listWorkspaces().catch(() => null), REPORT_READ_MS);
    if (read) lastWorkspaces = read;
    return read ?? lastWorkspaces;
  };
  const diskApi = {
    async report(scan: boolean): Promise<DiskReport> {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      // First, so nothing below can hold it up: the scan reads the registry itself, inside its own deadline.
      // A check never starts while a clear is deleting (it would measure half-deleted folders).
      if (scan && !disk.cleaner.isRunning) disk.scanner.start();
      const workspaces = await currentWorkspaces();
      if (workspaces.length) knownFolders = workspaces.map((workspace) => workspace.directory).slice(0, 30);
      // The app polls this while a check runs; the process snapshot behind "dev server running here" is reused for 30 s.
      if (Date.now() - servicesAt > 30_000) try {
        servicesAt = Date.now();
        const snap = await bounded(monitor.snapshot({ query: "", sort: "pid", limit: 200 }), REPORT_READ_MS);
        if (!snap) throw new Error("slow");
        const absolute = (cwd: string | null) => (cwd && cwd.startsWith("~/") ? `${disk!.places.home}/${cwd.slice(2)}` : cwd);
        lastServices = snap.services.map((service) => ({ cwd: absolute(service.cwd), label: service.service?.label ?? service.name, ports: service.ports }));
      } catch { /* Dev servers are a courtesy here. */ }
      const disks = await disksFor([disk.places.paseoHome, disk.places.home, ...disk.places.tmpDirs, ...knownFolders]);
      const { tokens, tmpRoots } = disk;
      const report = await disk.scanner.report(workspaces, disks, (item) => (tmpRoots.some((tmp) => item.root === tmp || isWithin(item.root, tmp)) ? null : tokens.mint(item)));
      const journal = await disk.inventory.status().catch(() => ({ problem: JOURNAL_PROBLEM, entries: [] }));
      const leftovers = disk.cleaner.isRunning ? [] : journal.entries.map((entry) => {
        const where = friendlyPath(entry.original, { home: disk!.places.home, paseoHome: disk!.places.paseoHome }).label;
        // Only what's known (second review).
        const message = entry.state === "partial" ? `An interrupted delete removed part of ${where}. Run the project's install to rebuild it. What's left of it is set aside in a hidden folder beside it; ask an agent to remove it.`
          : entry.state === "unchecked" ? `Couldn't check a leftover from an interrupted delete (${where}). Nothing is deleted until Hosts can look at it.`
          : entry.state === "unconfirmed" ? `An interrupted delete set ${where} aside, and Hosts can't confirm how complete it is. If the project needs it, run its install to rebuild it. It's set aside in a hidden folder beside it; ask an agent to check it.`
          : `Left over from an interrupted delete: ${where} is set aside, whole and untouched, because it couldn't be put back without replacing something.`;
        return { id: `leftover:${entry.quarantine}`, name: entry.name, where, bytes: entry.bytes, at: entry.at, state: entry.state, message };
      });
      return { ...report, leftovers, journalProblem: journal.problem };
    },
    /** The warning dialog's list: every check, fresh. Deletes nothing. */
    async preview(tokenList: readonly string[]): Promise<DiskPlan> {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      return disk.cleaner.preview(tokenList);
    },
    /** Start deleting what the person confirmed; each item is checked again just before it goes. */
    clear(tokenList: readonly string[]): DiskJob {
      if (!disk) throw new Error("Disk usage isn't available on this host.");
      if (disk.scanner.isRunning) return { state: "done", freedBytes: 0, results: [], message: "A disk check is running. Try again once it's finished.", finishedAt: Date.now() };
      return disk.cleaner.start(tokenList);
    },
    status(): DiskJob { return disk ? disk.cleaner.status() : { state: "idle", freedBytes: 0, results: [], message: null, finishedAt: null }; },
    /** Drops a "removed part of…" record the person dismissed; nothing on disk changes. */
    async dismissLeftover(id: string): Promise<{ ok: boolean }> {
      if (!disk || !id.startsWith("leftover:")) return { ok: false };
      return { ok: await disk.inventory.dismiss(id.slice("leftover:".length)).catch(() => false) };
    },
    /** Unloading: stop the scan and the clear job, kill their process groups (walk, find, rm, pnpm), and wait for both. */
    async close(): Promise<void> { if (disk) await Promise.all([disk.scanner.close(), disk.cleaner.close()]); },
    /** "Ask an agent" about a folder Hosts never removes itself: an unlinked worktree or a /tmp folder. Only ids the last check knows. */
    async folderAsk(id: string): Promise<AskContext | null> {
      if (!disk) return null;
      const home = disk.places.home;
      const ask = (title: string, text: string): AskContext => ({ title, text, workspaceId: null, workspaceName: null, outputFrom: null });
      if (id.startsWith("leftover:")) {
        const entry = (await disk.inventory.inspect().catch(() => ({ entries: [] as Array<{ quarantine: string; name: string; original: string; bytes: number; at: number }> }))).entries.find((item) => `leftover:${item.quarantine}` === id);
        if (!entry) return null;
        return ask(`A folder an interrupted clear set aside (${formatSize(entry.bytes)})`, folderAskText({ path: join(entry.quarantine, entry.name), bytes: entry.bytes, branch: null, changedAt: entry.at, kind: "leftover", original: entry.original, partial: (entry as { stage?: string }).stage !== "moved" }, home));
      }
      if (id.startsWith("tmp:")) {
        const cache = disk.scanner.last()?.caches.find((item) => item.key === id && item.kind === "tmp");
        if (!cache) return null;
        return ask(`A folder in the temporary folder (${formatSize(cache.bytes)})`, folderAskText({ path: cache.path, bytes: cache.bytes, branch: null, changedAt: Math.round(cache.mtimeMs), kind: "tmp" }, home));
      }
      const folder = disk.scanner.last()?.folders.find((item) => item.key === id && item.kind === "worktree");
      if (!folder) return null;
      const branch = await new Promise<string | null>((resolve) => execFile("git", safeGitArgs(folder.path, ["rev-parse", "--abbrev-ref", "HEAD"]), { timeout: 5000, env: safeGitEnv() }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null)).stdin?.on("error", () => undefined));
      const changedAt = folder.result?.newestMtimeMs ? Math.round(folder.result.newestMtimeMs) : null;
      return ask(`A worktree no workspace uses (${formatSize(folder.result?.totalBytes ?? 0)})`, folderAskText({ path: folder.path, bytes: folder.result?.totalBytes ?? 0, branch, changedAt }, home));
    },
    /**
     * "Ask an agent to clean this up": one workspace (its folder id), every
     * idle workspace ("idle"), or the shared caches and temporary files
     * ("caches"). The message lists the exact items that look safe to clear,
     * with paths and sizes, and the checks to do before deleting each one.
     */
    async cleanupAsk(id: string): Promise<AskContext | null> {
      if (!disk) return null;
      const workspaces = await currentWorkspaces();
      const report = await disk.scanner.report(workspaces, []);
      const checkedAt = report.scan.finishedAt;
      const ask = (title: string, text: string, workspaceId: string | null = null, workspaceName: string | null = null): AskContext => ({ title, text, workspaceId, workspaceName, outputFrom: null });
      const join = (folder: string, where: string) => `${folder.replace(/\/$/, "")}/${where}`;
      if (id === "caches") {
        const items = report.caches.flatMap((group) => group.items).filter((item) => item.bytes > 0).map((item) => ({ label: item.where, where: item.path ? homeRelative(item.path, disk!.places.home) : item.where, bytes: item.bytes, what: item.name, how: item.cost, partial: item.partial }));
        if (!items.length) return null;
        return ask(`Clean up shared caches (${formatSize(items.reduce((sum, item) => sum + item.bytes, 0))})`, cleanupAskText({ kind: "caches", checkedAt, items }));
      }
      const chosen = id === "idle" ? report.workspaces.filter((workspace) => !workspace.busy && workspace.clearableBytes > 0) : report.workspaces.filter((workspace) => workspace.id === id && workspace.clearableBytes > 0);
      const items = chosen.flatMap((workspace) => workspace.items.filter((item) => item.safe).map((item) => ({ label: `${workspace.names[0] ?? friendlyPath(workspace.folder, { paseoHome: homeRelative(disk!.places.paseoHome, disk!.places.home) }).label} · ${item.where}`, where: join(workspace.folder, item.where), bytes: item.bytes - item.sharedBytes, what: item.what, cost: item.cost, partial: item.partial })));
      if (!items.length) return null;
      const single = chosen.length === 1 ? chosen[0]! : null;
      const title = single ? (single.names[0] ?? single.folder) : `${chosen.length} idle workspaces`;
      // One workspace: offer its own chats first. Several: let the person pick where to send it.
      const owner = single && single.names.length ? workspaces.find((workspace) => workspace.name === single.names[0]) ?? null : null;
      return ask(`Clean up ${title} (${formatSize(items.reduce((sum, item) => sum + item.bytes, 0))})`, cleanupAskText({ kind: "workspaces", title, checkedAt, items }), owner?.id ?? null, owner?.name ?? null);
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
