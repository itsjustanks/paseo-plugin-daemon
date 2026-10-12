import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import { createMonitorHandlers } from "../server/handlers";
import { hashArgv } from "../server/redaction";
import { programProtection } from "../server/process-protection";
import { ProjectScope } from "../server/scope";
import { StopPlanSchema } from "../shared/processes";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

const PYTHON = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python";

async function setup(cwd = "/elsewhere", argv = ["python3", "-m", "http.server"]) {
  const scope = new ProjectScope(async (path) => path, "/home/alice");
  const api = {
    projects: { list: vi.fn(async () => ({ projects: [{ projectId: "app", projectDisplayName: "App", projectRootPath: "/home/alice/app" }, { projectId: "home", projectDisplayName: "Home", projectRootPath: "/home/alice" }] })) },
    workspaces: { list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false } })) },
    agents: { list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false } })) },
  };
  scope.bind(api as unknown as PaseoApi);
  const adapter = new FakeAdapter();
  adapter.processes = [proc({ pid: 101, cwd, argv, agentId: "archived-chat", state: "sleeping" })];
  adapter.ports.set(101, [8765]);
  const kill = vi.fn(), clock = new FakeClock();
  const monitor = createMonitorHandlers({ adapter, scope, uid: 1000, selfPid: 900, parentPid: 901, kill, clock });
  return { monitor, manager: monitor.internals!.manager, adapter, scope, api, kill, clock };
}

describe("dev-server manual Stop through the monitor", () => {
  it.each([
    ["Python without a chat", "/home/alice/app", ["python3", "-m", "http.server"]],
    ["Vite outside registered projects", "/external/worktree", ["node", "/external/node_modules/vite/bin/vite.js"]],
    ["Next in an archived workspace", "/archived/worktree", ["node", "next", "dev"]],
    ["unrecognised node listener", "/external/worktree", ["node", "server.js"]],
    ["broad home cwd", "/home/alice", ["python3", "-m", "http.server"]],
  ])("previews and stops a sleeping %s without authorising sharing", async (_name, cwd, argv) => {
    const { monitor, manager, adapter, kill } = await setup(cwd, argv);
    adapter.processes[0].agentId = null;
    const snapshot = await monitor.snapshot({});
    const row = snapshot.services.find((item) => item.pid === 101)!;
    expect(row).toMatchObject({ state: "sleeping", actionable: true, ports: [8765] });
    expect(row.actionToken).toBeTruthy();
    if (cwd !== "/home/alice/app") expect(row.project?.shareable).not.toBe(true);
    const plan = StopPlanSchema.parse(await manager.preview([row.actionToken!]));
    expect(plan.targets[0]).toMatchObject({ pid: 101, ok: true, children: [] });
    expect(plan.targets[0].outsidePaseo || plan.targets[0].workspaceWarnings?.length).toBeTruthy();
    expect(kill).not.toHaveBeenCalled();
    expect(await monitor.forceStop({ token: row.actionToken! })).toMatchObject({ status: "needs-graceful-first" });
    expect(await monitor.stop({ token: row.actionToken! })).toMatchObject({ status: "signaled", signaledCount: 1 });
    expect(await monitor.forceStop({ token: row.actionToken! })).toMatchObject({ status: "signaled", signaledCount: 1 });
    expect(kill.mock.calls).toEqual([[101, "SIGTERM"], [101, "SIGKILL"]]);
  });

  it("keeps monitor tokens valid for the Processes confirmation contract after chat archival", async () => {
    const { monitor, manager, adapter, api, scope } = await setup();
    const chat = { id: "archived-chat", title: "Server chat", provider: "codex", status: "idle", cwd: "/elsewhere" };
    api.agents.list.mockResolvedValue({ entries: [{ agent: chat }], pageInfo: { hasMore: false } } as never);
    const token = (await monitor.snapshot({})).services[0].actionToken!;
    expect((await manager.preview([token])).targets[0].tagWarnings).toHaveLength(1);
    api.agents.list.mockResolvedValue({ entries: [], pageInfo: { hasMore: false } });
    await scope.refresh(true);
    expect(scope.agent(adapter.processes[0].agentId)).toBeNull();
    expect((await manager.preview([token])).targets[0]).toMatchObject({ ok: true, outsidePaseo: true });
  });

  it("keeps port sharing independent and excludes debugger ports from share controls", async () => {
    const { monitor, adapter, scope } = await setup("/home/alice/app");
    adapter.ports.set(101, [8765, 9229]);
    const row = (await monitor.snapshot({})).services[0];
    expect(row.ports).toEqual([8765]);
    expect(scope.match(adapter.processes[0], row.ports)?.shareablePorts).toEqual([8765]);
  });

  it.each(["startId", "argv", "executable"] as const)("refuses a stale %s before graceful and force signals", async (field) => {
    const { monitor, manager, adapter, kill } = await setup();
    const token = (await monitor.snapshot({})).services[0].actionToken!;
    expect(await monitor.stop({ token })).toMatchObject({ status: "signaled" });
    if (field === "argv") adapter.processes[0].argv = ["node", "different.js"];
    else adapter.processes[0][field] = "changed";
    expect((await manager.preview([token])).targets[0].ok).toBe(false);
    expect(await monitor.stop({ token })).toMatchObject({ status: "denied" });
    expect(await monitor.forceStop({ token })).toMatchObject({ status: "denied" });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("refuses when fresh ancestry becomes a database child after confirmation", async () => {
    const { monitor, manager, adapter, kill } = await setup();
    const token = (await monitor.snapshot({})).services[0].actionToken!;
    expect((await manager.preview([token])).targets[0].ok).toBe(true);
    adapter.processes.push(proc({ pid: 102, argv: ["postgres"] }));
    adapter.processes[0].ppid = 102;
    expect(await monitor.stop({ token })).toMatchObject({ status: "denied" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not turn workspace or chat tags into automatic Stop authority", async () => {
    const { monitor, manager, adapter, kill } = await setup("/home/alice/app");
    adapter.processes[0].rssBytes = adapter.sample.memoryTotalBytes;
    expect((await monitor.snapshot({})).services[0].actionable).toBe(true);
    expect(await manager.autoStopBiggest(1, async () => true)).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    { pid: 1, uid: 0 }, { pid: 101, uid: 0 }, { pid: 101, uid: 1001 },
    { pid: 900, uid: 1000 }, { pid: 901, uid: 1000 }, { pid: 101, uid: 1000, state: "zombie" as const },
  ])("refuses protected identity $pid/$uid even with a valid token", async (identity) => {
    const { monitor, manager, adapter, kill } = await setup();
    adapter.processes[0] = proc({ ...identity, argv: ["node", "server.js"] });
    const raw = adapter.processes[0];
    const token = manager.guard.mint(raw, hashArgv(raw.argv));
    expect((await manager.preview([token])).targets[0].ok).toBe(false);
    expect(await monitor.stop({ token })).toMatchObject({ status: "denied" });
    expect(await monitor.forceStop({ token })).toMatchObject({ status: "denied" });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(["codex", "postgres", "redis-server", "sshd", "Paseo Daemon"])("protects a listening %s", async (program) => {
    const { monitor, manager, adapter, kill } = await setup("/home/alice/app", [program]);
    const row = (await monitor.snapshot({})).services[0];
    expect(row).toMatchObject({ actionable: false, actionToken: null });
    const forged = manager.guard.mint(adapter.processes[0], hashArgv(adapter.processes[0].argv));
    expect(await monitor.stop({ token: forged })).toMatchObject({ status: "denied" });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("macOS Python framework wrapper", () => {
  it("permits only verified headless http.server and recognises its capitalised program name", async () => {
    const python = proc({ pid: 101, executable: PYTHON, argv: [PYTHON, "-m", "http.server", "8765"] });
    expect(programProtection(python, "darwin")).toBeNull();
    for (const argv of [[PYTHON, "gui.py"], [PYTHON, "-m", "http.server.fake"], ["node", "-m", "http.server"]]) {
      expect(programProtection({ ...python, argv }, "darwin")).toMatch(/desktop app/);
    }
    expect(programProtection({ ...python, executable: "/Applications/Other.app/Contents/MacOS/Python" }, "darwin")).toMatch(/desktop app/);
    expect(programProtection({ ...python, executable: "/Applications/Other.app" + PYTHON }, "darwin")).toMatch(/desktop app/);
    const { monitor, adapter } = await setup();
    adapter.processes[0] = python;
    expect((await monitor.snapshot({})).services[0].service).toMatchObject({ kind: "dev-server", label: "Python http.server" });
  });
});
