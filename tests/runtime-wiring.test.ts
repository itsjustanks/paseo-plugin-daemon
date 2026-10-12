import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";
import { HOUSEKEEPING_DEFAULTS } from "../shared/housekeeping";
import { clearItem, workspaceUsage } from "./resource-table-fixtures";

// Exercise runtime policy/adapter wiring with inert adapters: these tests never signal,
// reprioritise, remove profiles, run git, or contact a real Paseo daemon.
const f = vi.hoisted(() => ({ c: {} as Record<string, any>, unsupported: false, rows: [] as any[], services: [] as any[], report: {} as any, last: null as any, entries: [] as any[], stat: null as any, resolve: vi.fn(), inspect: vi.fn(), realpath: vi.fn(), lstat: vi.fn(), remove: vi.fn(), kill: vi.fn(), nice: vi.fn(), machine: vi.fn(), descriptors: vi.fn(), refresh: vi.fn(), match: vi.fn(), collect: vi.fn(), canReload: vi.fn(), readIdentity: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: f.lstat, realpath: f.realpath }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), setPriority: f.nice }));
vi.mock("node:child_process", () => ({ execFile: (_file: string, _args: string[], _options: unknown, done: Function) => { done(null, "topic\n"); return { stdin: { on: vi.fn() } }; } }));
vi.mock("../server/scope", () => ({ ProjectScope: class { bind = vi.fn(); refresh = f.refresh; match = f.match; workspaceDescriptors = f.descriptors; } }));
vi.mock("../server/transfers", () => ({ ProjectTransfers: class { close = vi.fn(); } }));
vi.mock("../server/action-log", () => ({ ActionLog: class { append = vi.fn(); recent = vi.fn().mockResolvedValue([]); } }));
vi.mock("../server/handlers", () => ({ createMonitorHandlers: (options: any) => ({
  internals: f.unsupported ? null : { uid: 1000, selfPid: 20, parentPid: 10, adapter: { platform: "linux", readIdentity: f.readIdentity }, collector: { collect: f.collect }, manager: new ProcessManager({ ...options, daemonPid: 10 } as any) },
  snapshot: vi.fn(async () => ({ services: f.services })),
  stop: vi.fn(async () => ({ pid: 42, status: "stopped", signaledCount: 1, message: "Stopped" })),
  forceStop: vi.fn(async () => ({ pid: 42, status: "stopped", signaledCount: 1, message: "Stopped" })),
}) }));
vi.mock("../server/processes", () => ({ ProcessManager: class {
  constructor(options: any) { f.c.manager = options; }
  report = vi.fn(async (_input: unknown, recent: Function) => ({ recentActions: await recent() }));
  preview = vi.fn(async (tokens) => ({ tokens })); stop = vi.fn(async (tokens) => ({ tokens })); close = vi.fn();
  autoStopBiggest = vi.fn(async (min, confirm) => ({ min, confirmed: await confirm(), message: "No process selected" }));
} }));
vi.mock("../server/guard-loop", () => ({ GUARD_INTERVAL_MS: 1000, LinuxQuickSampler: class {}, AdapterQuickSampler: class {}, GuardLoop: class {
  constructor(options: any) { f.c.guard = options; }
  growthOf = vi.fn(() => 12); state = () => ({ memory: { level: "critical" } }); pollLog = vi.fn(); logState = { lastReady: () => 99 };
} }));
vi.mock("../server/plugin-restart", () => ({ PluginRestarter: class { constructor(options: any) { f.c.restart = options; } begin = async (id: string) => ({ pluginId: id, ok: true }); status = (id: string) => ({ pluginId: id, ok: true }); } }));
vi.mock("../server/paseo-cli", () => ({ PaseoCli: class { resolve = f.resolve; canReload = f.canReload; } }));
vi.mock("../server/plugin-procs", () => ({ listPluginHosts: vi.fn(async () => []), startClock: () => (id: string) => Number(id) }));
vi.mock("../server/daemon-log", () => ({ scanLaunches: vi.fn(async () => ({ launches: [] })) }));
vi.mock("../server/lease", () => ({ createServiceLease: (port: number, check: Function) => { f.c.leaseCheck = check; return { port }; } }));
vi.mock("../server/tunnels", () => ({ TunnelManager: class { constructor(lease: Function) { f.c.lease = lease; } } }));
vi.mock("../server/links", () => ({ LinkManager: class { close = vi.fn(); } }));
vi.mock("../server/peers", () => ({ PeerManager: class { constructor(_store: unknown, _lease: unknown, ports: Function) { f.c.ports = ports; } close = vi.fn(); } }));
vi.mock("../server/watch", () => ({ WatchChecker: class {} }));
vi.mock("../server/disk-scan", () => ({
  defaultPlaces: () => ({ home: "/home/example", paseoHome: "/home/example/.paseo", stateDir: "/state", tmpDirs: ["/tmp"] }),
  readWorkspace: (row: any) => row.directory ? row : null,
  disksFor: vi.fn(async () => []), cleanupAskText: (value: unknown) => JSON.stringify(value), folderAskText: (value: unknown) => JSON.stringify(value), leftoverView: (e: any) => ({ where: e.name, message: "May be incomplete", title: "Review leftover", text: e.name }),
  DiskScanner: class {
    isRunning = false; start = vi.fn(); close = vi.fn(); forget = vi.fn(); unlinkedWorktrees = vi.fn(async () => []);
    constructor(options: any) { f.c.scanner = this; f.c.scanOptions = options; }
    report = vi.fn(async (_ws: unknown, _disks: unknown, mint?: Function) => { if (mint) { f.c.tmpToken = mint({ root: "/tmp/work" }); f.c.workspaceToken = mint({ root: "/work/app" }); } return f.report; });
    last = () => f.last;
  },
}));
vi.mock("../server/disk-clear", () => ({ defaultTmpRoots: () => ["/tmp"], DiskTokens: class { mint = () => "verified-token"; }, DiskCleaner: class {
  isRunning = false; constructor(options: any) { f.c.cleaner = this; f.c.cleanOptions = options; }
  preview = vi.fn(async (tokens) => ({ tokens })); start = vi.fn((tokens) => ({ tokens })); status = vi.fn(() => ({ state: "idle" })); close = vi.fn();
} }));
vi.mock("../server/disk-quarantine", () => ({ JOURNAL_PROBLEM: "Journal unreadable", QuarantineInventory: class {
  recover = vi.fn(async () => ({ restored: [] })); status = vi.fn(async () => ({ entries: f.entries, problem: null })); dismiss = vi.fn(async () => true);
  constructor() { f.c.inventory = this; }
} }));
vi.mock("../server/housekeeping", () => ({ readMachine: f.machine, Housekeeper: class { constructor(options: any) { f.c.hk = options; } } }));
vi.mock("../server/housekeeping-procs", () => ({ ProcReader: class {} }));
vi.mock("../server/housekeeping-owners", () => ({ CliOwners: class {}, runInspect: f.inspect }));
vi.mock("../server/housekeeping-lock", () => ({ takeLock: vi.fn(async () => null) }));
vi.mock("../server/housekeeping-log", () => ({ HousekeepingLog: class {} }));
vi.mock("../server/housekeeping-files", () => ({ privateOwnedProfile: vi.fn(async () => true) }));
vi.mock("../server/disk-children", () => ({ ChildGroup: class { killAll = f.kill; } }));
vi.mock("../server/disk-remove", () => ({ quarantineAndRemove: f.remove }));

import { ProcessManager } from "../server/processes";
import { bounded, createRuntime, parseWorkspaceList } from "../server/runtime";

beforeEach(() => {
  vi.clearAllMocks(); f.c = {}; f.unsupported = false; f.services = []; f.entries = []; f.last = null;
  f.rows = [{ id: "w1", name: "Alpha", directory: "/work/app", status: "idle", scripts: [] }];
  f.descriptors.mockImplementation(async () => f.rows); f.refresh.mockResolvedValue(undefined); f.match.mockReturnValue({ shareable: true });
  f.resolve.mockResolvedValue("/bin/paseo"); f.canReload.mockResolvedValue(true); f.inspect.mockResolvedValue({ code: 0, stdout: JSON.stringify(f.rows) });
  f.readIdentity.mockResolvedValue({ startId: "123" }); f.collect.mockResolvedValue({ processes: [{ pid: 42, name: "vite", project: { name: "Website", workspace: "Main" } }] });
  f.stat = { dev: 1, ino: 2, uid: 1000, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false };
  f.lstat.mockImplementation(async () => f.stat); f.realpath.mockImplementation(async (path) => path); f.machine.mockResolvedValue({ cores: 4 });
  f.remove.mockImplementation(async (_path, _stat, options) => ({ ok: !(await options.finalCheck("/tmp/quarantine")), error: await options.mutationCheck(_path) }));
  f.report = { scan: { finishedAt: 10 }, workspaces: [workspaceUsage({ id: "w1", names: ["Alpha"], items: [clearItem({ safe: true, where: "node_modules", bytes: 100, sharedBytes: 10 })] })], caches: [{ items: [clearItem({ path: "/home/example/.cache", bytes: 50 })] }] };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("runtime effect and policy boundaries", () => {
  it("retains authoritative running-service metadata and filters unusable workspace rows", () => {
    expect(parseWorkspaceList(JSON.stringify({ workspaces: [null, { directory: "relative" }, { directory: "/archived", archivedAt: "now" }, { directory: "/app", title: "App", status: "idle", scripts: [{ lifecycle: "running" }, { lifecycle: "stopped" }] }] })))
      .toEqual([{ name: "App", directory: "/app", status: "idle", devServers: ["Running service"] }]);
  });
  it("rechecks private profile identity throughout removal and forwards cancellation to child cleanup", async () => {
    createRuntime({ guard: false }); const path = "/tmp/agent-browser-chrome-00000000-0000-0000-0000-000000000000";
    const controller = new AbortController(), check = vi.fn(async () => null);
    expect(await f.c.hk.removeProfile("/tmp/unrelated", check, controller.signal)).toMatchObject({ ok: false }); expect(f.remove).not.toHaveBeenCalled();
    f.realpath.mockRejectedValueOnce(new Error("unavailable")); expect(await f.c.hk.removeProfile(path, check, controller.signal)).toMatchObject({ ok: false });
    f.lstat.mockRejectedValueOnce(new Error("gone")); expect(await f.c.hk.removeProfile(path, check, controller.signal)).toMatchObject({ ok: false });
    f.stat.mode = 0o755; expect(await f.c.hk.removeProfile(path, check, controller.signal)).toMatchObject({ ok: false }); f.stat.mode = 0o700;
    expect(await f.c.hk.removeProfile(path, check, controller.signal)).toEqual({ ok: true, why: null }); expect(check).toHaveBeenCalledWith(path);
    f.remove.mockImplementationOnce(async (_p, _s, options) => {
      f.lstat.mockRejectedValueOnce(new Error("profile disappeared"));
      return { ok: false, error: await options.mutationCheck(path) };
    });
    expect(await f.c.hk.removeProfile(path, check, controller.signal)).toEqual({ ok: false, why: "the private profile changed" });
    f.remove.mockImplementationOnce(async (_p, _s, options) => {
      f.stat = { ...f.stat, ino: 3 }; expect(await options.mutationCheck(path)).toBe("the private profile changed");
      controller.abort(); return { ok: false, error: "cancelled" };
    });
    expect(await f.c.hk.removeProfile(path, check, controller.signal)).toEqual({ ok: false, why: "cancelled" }); expect(f.kill).toHaveBeenCalledOnce();
    await f.c.hk.lock(controller.signal);
  });
  it("bounds failed, successful and stalled registry reads", async () => {
    expect(await bounded(Promise.resolve(7), 10)).toBe(7);
    expect(await bounded(Promise.reject(new Error("offline")), 10)).toBeNull();
    vi.useFakeTimers(); const pending = bounded(new Promise(() => {}), 10); await vi.advanceTimersByTimeAsync(11); expect(await pending).toBeNull();
  });
  it("binds request context and refuses disk, process and restart actions without an adapter", async () => {
    f.unsupported = true; const r = createRuntime({ guard: false, housekeeping: false });
    const session = {} as any; expect(r.withContext({ paseo: session } as any, () => 7)).toBe(7); expect(r.scope.bind).toHaveBeenCalledWith(session);
    expect(await r.plugins.restart("example")).toMatchObject({ ok: false, outcome: "refused" }); expect(r.plugins.status("example").ok).toBe(false);
    await expect(r.disk.report(false)).rejects.toThrow("isn't available"); await expect(r.disk.preview([])).rejects.toThrow("isn't available"); expect(() => r.disk.clear([])).toThrow("isn't available");
    expect(r.disk.status().state).toBe("idle"); expect(await r.disk.dismissLeftover("leftover:x")).toEqual({ ok: false }); expect(await r.disk.cleanupAsk("idle")).toBeNull(); expect(await r.disk.folderAsk("tmp:x")).toBeNull(); await r.disk.close();
    expect(await r.processes.report({} as any)).toMatchObject({ supported: false });
    await expect(r.processes.preview([])).rejects.toThrow(); await expect(r.processes.stop([])).rejects.toThrow(); r.processes.close();
  });
  it("keeps reports passive, defers scans during deletion, and never mints delete tokens for temporary roots", async () => {
    const r = createRuntime({ guard: false });
    f.services = [{ cwd: "~/app", name: "next", ports: [3000], service: { label: "Next" } }];
    await r.disk.report(false); expect(f.c.scanner.start).not.toHaveBeenCalled(); expect(f.c.tmpToken).toBeNull(); expect(f.c.workspaceToken).toBe("verified-token");
    expect(f.c.scanOptions.devServersIn("/home/example/app")).toEqual(["Next :3000"]);
    expect(await f.c.scanOptions.listWorkspaces()).toEqual(f.rows); expect(await f.c.cleanOptions.listWorkspaces()).toEqual(f.rows);
    await f.c.cleanOptions.unlinkedWorktrees([]); f.c.cleanOptions.cleared("/work/app", 1); expect(f.c.scanner.forget).toHaveBeenCalledWith("/work/app", 1);
    await f.c.cleanOptions.log({ action: "clear" }); expect(r.log.append).toHaveBeenCalledWith({ action: "clear" });
    f.c.cleaner.isRunning = true; await r.disk.report(true); expect(f.c.scanner.start).not.toHaveBeenCalled();
    f.c.cleaner.isRunning = false; await r.disk.report(true); expect(f.c.scanner.start).toHaveBeenCalledOnce();
    f.c.scanner.isRunning = true; expect(r.disk.clear(["t"]).message).toContain("disk check"); expect(f.c.cleaner.start).not.toHaveBeenCalled();
    f.c.scanner.isRunning = false; r.disk.clear(["t"]); expect(f.c.cleaner.start).toHaveBeenCalledWith(["t"]); await r.disk.preview(["t"]); expect(f.c.cleaner.preview).toHaveBeenCalledWith(["t"]);
    expect(r.disk.status()).toEqual({ state: "idle" }); await r.disk.close(); expect(f.c.scanner.close).toHaveBeenCalledOnce(); expect(f.c.cleaner.close).toHaveBeenCalledOnce();
  });
  it("reports recoverable leftovers and dismisses only explicit journal IDs", async () => {
    const r = createRuntime({ guard: false }); f.entries = [{ quarantine: "/q", name: "node_modules", bytes: 50, state: "reserved", setAside: false }];
    expect((await r.disk.report(false)).leftovers).toMatchObject([{ id: "leftover:/q", message: "May be incomplete" }]);
    expect(await r.disk.dismissLeftover("/q")).toEqual({ ok: false }); expect(f.c.inventory.dismiss).not.toHaveBeenCalled();
    expect(await r.disk.dismissLeftover("leftover:/q")).toEqual({ ok: true }); expect(f.c.inventory.dismiss).toHaveBeenCalledWith("/q");
    expect(await r.disk.folderAsk("leftover:/q")).toMatchObject({ title: "Review leftover" }); expect(await r.disk.folderAsk("leftover:missing")).toBeNull();
    f.c.inventory.status.mockRejectedValue(new Error("unreadable")); expect((await r.disk.report(false)).journalProblem).toBe("Journal unreadable");
    f.c.inventory.dismiss.mockRejectedValue(new Error("changed")); expect(await r.disk.dismissLeftover("leftover:/q")).toEqual({ ok: false });
  });
  it("builds scoped cleanup messages from the last measured report, with shared bytes excluded", async () => {
    const r = createRuntime({ guard: false });
    const one = await r.disk.cleanupAsk("w1"); expect(one).toMatchObject({ workspaceId: "w1", workspaceName: "Alpha" }); expect(JSON.parse(one!.text).items[0].bytes).toBe(90);
    expect((await r.disk.cleanupAsk("idle"))?.title).toContain("Alpha"); expect((await r.disk.cleanupAsk("caches"))?.title).toContain("50 bytes");
    f.report.workspaces[0].busy = "Build active"; expect(await r.disk.cleanupAsk("idle")).toBeNull();
    f.report.workspaces[0].items = [clearItem({ askOnly: true, bytes: 1 })]; expect((await r.disk.cleanupAsk("w1"))?.text).toContain("made by hand");
    f.report.caches = []; expect(await r.disk.cleanupAsk("caches")).toBeNull(); expect(await r.disk.cleanupAsk("missing")).toBeNull();
    expect(await r.disk.folderAsk("tmp:missing")).toBeNull(); expect(await r.disk.folderAsk("missing")).toBeNull();
    f.last = { caches: [{ key: "tmp:t", kind: "tmp", path: "/tmp/t", bytes: 10, mtimeMs: 5 }], folders: [{ key: "tree:t", kind: "worktree", path: "/work/tree", result: { totalBytes: 20, newestMtimeMs: 5 } }] };
    expect((await r.disk.folderAsk("tmp:t"))?.text).toContain("/tmp/t"); expect((await r.disk.folderAsk("tree:t"))?.text).toContain("topic");
  });
  it("preserves process actions, logs their identity, and applies current guard policy", async () => {
    const settings = vi.fn().mockResolvedValue({ ...HOSTS_SETTINGS_DEFAULTS, autoStopRunaways: true }); const r = createRuntime({ readSettings: settings });
    expect(await r.processes.report({} as any)).toEqual({ recentActions: [] }); expect(await r.processes.preview(["t"])).toEqual({ tokens: ["t"] }); expect(await r.processes.stop(["t"])).toEqual({ tokens: ["t"] }); r.processes.close();
    expect(f.c.manager.growth(42, "123")).toBe(12); expect(f.c.manager.memoryLevel()).toBe("critical");
    await r.monitor.stop({ token: "t" }); await r.monitor.forceStop({ token: "t" }); expect(r.log.append).toHaveBeenLastCalledWith(expect.objectContaining({ action: "force-stop", name: "vite", owner: "Website · Main" }));
    f.collect.mockRejectedValue(new Error("process exited")); await r.monitor.stop({ token: "t" }); expect(r.log.append).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Dev server" }));
    expect(await f.c.guard.readSettings()).toEqual({ autoStopRunaways: true }); settings.mockRejectedValue(new Error("unavailable")); expect(await f.c.guard.readSettings()).toEqual({ autoStopRunaways: false });
    expect(await f.c.guard.autoStop(10, async () => false)).toMatchObject({ min: 10, confirmed: false });
    expect(await f.c.guard.restartCheck()).toEqual({ ok: true, reason: null }); f.canReload.mockResolvedValue(false); expect((await f.c.guard.restartCheck()).ok).toBe(false);
    await r.disk.report(false); expect(f.c.guard.diskPaths()).toContain("/work/app");
    expect(await r.plugins.restart("x")).toMatchObject({ pluginId: "x" }); expect(r.plugins.status("x").ok).toBe(true);
    expect(await f.c.restart.launches()).toEqual([]); expect(await f.c.restart.hosts()).toEqual([]); expect(await f.c.restart.identity(42)).toEqual({ startId: "123" }); expect(await f.c.restart.self.startMs()).toBe(123);
    f.readIdentity.mockRejectedValueOnce(new Error("gone")); expect(await f.c.restart.self.startMs()).toBeNull();
    expect(await f.c.restart.readyAfter("x", 1)).toBe(true); expect(await f.c.restart.readyAfter("x", 100)).toBe(false);
    await f.c.restart.log({ action: "restart" }); expect(r.log.append).toHaveBeenLastCalledWith({ action: "restart" });
  });
  it("offers only shareable unprotected project ports and rechecks leases", async () => {
    createRuntime({ guard: false }); f.services = [
      { ports: [3000], project: { name: "Site", shareable: true }, service: { kind: "dev-server", label: "Next" } },
      { ports: [4000], project: { name: "API", shareable: true } },
      { ports: [5432], project: { name: "DB", shareable: true }, protectedReason: "Database" },
      { ports: [9999], project: null },
    ];
    expect(await f.c.ports()).toEqual([{ port: 3000, label: "Next", project: "Site" }, { port: 4000, label: "Project service", project: "API" }]);
    expect(await f.c.lease(3000)).toEqual({ port: 3000 }); expect(await f.c.leaseCheck({}, 3000)).toBe(true); f.match.mockReturnValue(null); expect(await f.c.leaseCheck({}, 3000)).toBe(false);
    f.refresh.mockRejectedValueOnce(new Error("registry offline")); expect(await f.c.lease(3000)).toEqual({ port: 3000 });
  });
  it("keeps the last display workspace list on a failed read without authorizing automation from it", async () => {
    const r = createRuntime(); expect(await f.c.manager.readSettings()).toEqual(HOSTS_SETTINGS_DEFAULTS);
    await r.disk.report(false); f.descriptors.mockRejectedValue(new Error("offline"));
    await r.disk.report(false); expect(f.c.scanner.report).toHaveBeenLastCalledWith(f.rows, [], expect.any(Function));
    f.c.inventory.status.mockRejectedValueOnce(new Error("corrupt")); expect(await r.disk.folderAsk("leftover:unknown")).toBeNull();
    const print = vi.spyOn(console, "log").mockImplementation(() => {}); f.c.guard.onAutoStop({ message: "Stopped one verified job" }); expect(print).toHaveBeenCalledWith(expect.stringContaining("Stopped one verified job"));
  });
  it("keeps unknown CLI activity non-authoritative and respects cancellation before CLI fallback", async () => {
    const settings = vi.fn().mockResolvedValue(HOSTS_SETTINGS_DEFAULTS); createRuntime({ readSettings: settings }); const signal = new AbortController();
    expect(await f.c.hk.readSettings()).toEqual(HOUSEKEEPING_DEFAULTS); settings.mockRejectedValue(new Error("offline")); expect(await f.c.hk.readSettings()).toBeNull();
    expect(await f.c.hk.workspaces(signal.signal)).toMatchObject([{ status: "idle", devServers: [] }]);
    f.descriptors.mockRejectedValue(new Error("no SDK session")); f.inspect.mockResolvedValue({ code: 0, stdout: JSON.stringify([{ directory: "/work/app" }]) });
    expect(await f.c.hk.workspaces(signal.signal)).toMatchObject([{ status: null, devServers: ["Service state unknown"] }]);
    f.resolve.mockRejectedValueOnce(new Error("CLI unavailable")); expect(await f.c.hk.workspaces(signal.signal)).toBeNull();
    f.inspect.mockClear(); signal.abort(); expect(await f.c.hk.workspaces(signal.signal)).toBeNull(); expect(f.inspect).not.toHaveBeenCalled();
    expect(await f.c.hk.privateProfile("/tmp/profile")).toBe(true); expect(await f.c.hk.machine()).toEqual({ cores: 4 });
    f.c.hk.renice(42, 10); expect(f.nice).toHaveBeenCalledWith(42, 10);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true); f.c.hk.kill(42, "SIGTERM"); f.c.restart.kill(43, "SIGTERM"); expect(kill.mock.calls).toEqual([[42, "SIGTERM"], [43, "SIGTERM"]]);
  });
});
