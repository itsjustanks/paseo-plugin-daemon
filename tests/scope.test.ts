import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectScope, containsDirectory } from "../server/scope";
import { createMonitorHandlers } from "../server/handlers";
import { ProcessGuard } from "../server/safety";
import { hashArgv } from "../server/redaction";
import { FakeAdapter, proc } from "./fake-adapter";

function setup() {
  const project = { projectId: "website", projectDisplayName: "Website", projectRootPath: "/home/alice/app" };
  const api = {
    projects: { list: vi.fn(async () => ({ projects: [project] })) },
    workspaces: { list: vi.fn(async (_options?: unknown) => ({ entries: [] as any[], pageInfo: { hasMore: false, nextCursor: null as string | null } })) },
  };
  const scope = new ProjectScope(async (path) => path, "/home/alice");
  scope.bind(api as unknown as PaseoApi);
  return { scope, api, project };
}

describe("Paseo project scope", () => {
  it("matches canonical project directories and rejects prefix lookalikes, missing cwd, infrastructure, and outside services", async () => {
    const { scope } = setup(); await scope.refresh();
    const app = proc({ pid: 100, argv: ["node", "next", "dev"] });
    expect(scope.match(app, [3000, 9229])?.shareablePorts).toEqual([3000]);
    expect(scope.match(app, [9229])?.shareable).toBe(false);
    expect(scope.match(app, [3000])).toMatchObject({ id: "website", shareable: true, canStop: true, path: "~/app" });
    for (const cwd of ["/home/alice/app-secret", "/home/alice/elsewhere", "/home/alice", null]) expect(scope.match({ ...app, cwd }, [3000])).toBeNull();
    for (const name of ["postgres", "redis-server", "sshd", "agent-browser", "cloudflared"]) expect(scope.match({ ...app, argv: [name] }, [3000])).toBeNull();
    expect(containsDirectory("/a/b", "/a/b/../other")).toBe(false);
    expect(scope.match({ ...app, argv: ["node", "custom.js"] }, [3000])).toMatchObject({ shareable: false, canStop: false });
    expect(scope.match({ ...app, argv: ["codex"] }, [3000])).toMatchObject({ kind: "agent", shareable: false, canStop: false });
  });

  it("discovers worktrees across pages and accepts custom managed service ports", async () => {
    const { scope, api } = setup();
    api.workspaces.list.mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "next" } });
    api.workspaces.list.mockResolvedValueOnce({ entries: [{ projectId: "website", projectDisplayName: "Website", projectRootPath: "/home/alice/app", workspaceDirectory: "/worktrees/feature", name: "Feature", scripts: [{ type: "service", lifecycle: "running", port: 9000 }] }], pageInfo: { hasMore: false, nextCursor: null } });
    await scope.refresh();
    expect(api.workspaces.list.mock.calls[1]?.[0]).toMatchObject({ page: { cursor: "next" } });
    expect(scope.match(proc({ pid: 101, cwd: "/worktrees/feature/api" }), [9000])).toMatchObject({ workspace: "Feature", shareable: true });
    expect(scope.match(proc({ pid: 101, cwd: "/worktrees/feature/api" }), [9001])).toMatchObject({ shareable: false });
    expect(scope.match(proc({ pid: 101, cwd: "/worktrees/feature/api" }), [9000, 5432])?.shareablePorts).toEqual([9000]);
  });

  it("excludes home/root projects and handles missing or canonicalized paths", async () => {
    const { api, project } = setup();
    api.projects.list.mockResolvedValue({ projects: [project, { ...project, projectId: "home", projectRootPath: "/home/alice" }, { ...project, projectId: "root", projectRootPath: "/" }, { ...project, projectId: "missing", projectRootPath: "/missing" }] });
    const scope = new ProjectScope(async (path) => { if (path === "/missing") throw new Error(); return path === project.projectRootPath ? "/canonical/app" : path; }, "/home/alice");
    scope.bind(api as unknown as PaseoApi); await scope.refresh();
    expect(scope.status().projects).toHaveLength(1);
    expect(scope.status().message).toContain("Broad home/root");
    expect(scope.match(proc({ pid: 101, cwd: "/canonical/app/sub" }), [3000])).not.toBeNull();
    expect(scope.match(proc({ pid: 101 }), [3000])).toBeNull();
  });

  it("fails closed on a registry error or a repeated pagination cursor", async () => {
    const { scope, api } = setup();
    await scope.refresh();
    api.projects.list.mockRejectedValueOnce(new Error("private registry path"));
    await expect(scope.refresh(true)).rejects.toThrow("could not be verified");
    expect(scope.match(proc({ pid: 1 }))).toBeNull();
    expect(scope.status().message).not.toContain("private registry path");
    api.workspaces.list.mockResolvedValue({ entries: [], pageInfo: { hasMore: true, nextCursor: "again" } });
    await expect(scope.refresh(true)).rejects.toThrow("could not be verified");
    expect(scope.status().projects).toEqual([]);
    const unbound = new ProjectScope();
    await expect(unbound.refresh()).rejects.toThrow("Open Daemon Link");
  });

  it("filters before sorting/pagination and keeps agents and unknown tools read-only", async () => {
    const { scope } = setup();
    const adapter = new FakeAdapter();
    adapter.processes = [proc({ pid: 101, argv: ["node", "next", "dev"], rssBytes: 10 }), proc({ pid: 102, argv: ["codex"], rssBytes: 20 }), proc({ pid: 103, argv: ["custom"], rssBytes: 30 }), proc({ pid: 104, cwd: "/elsewhere", rssBytes: 999 }), proc({ pid: 105, argv: ["postgres"], rssBytes: 999 })];
    for (const process of adapter.processes) adapter.ports.set(process.pid, [3000 + process.pid]);
    const handlers = createMonitorHandlers({ scope, adapter, uid: 1000, selfPid: 10000, parentPid: 10001, kill: vi.fn() });
    const page = await handlers.snapshot({ sort: "memory", direction: "desc", limit: 1, offset: 1 });
    expect(page.totalProcesses).toBe(3); expect(page.hiddenProcesses).toBe(2);
    expect(page.processes[0]?.pid).toBe(102); expect(page.processes[0]?.actionToken).toBeNull();
    expect(page.services.map((process) => process.pid)).toEqual([101]);
    expect((await handlers.snapshot({ sort: "memory", direction: "asc", limit: 1 })).processes[0]?.pid).toBe(101);
    expect((await handlers.snapshot({ query: "Website" })).processes).toHaveLength(3);
  });

  it("rechecks project membership before stop and force-stop; removed projects cannot use old tokens", async () => {
    const { scope, api } = setup();
    const adapter = new FakeAdapter(), kill = vi.fn();
    adapter.processes = [proc({ pid: 100, argv: ["node", "next", "dev"] })]; adapter.ports.set(100, [3000]);
    const handlers = createMonitorHandlers({ scope, adapter, uid: 1000, selfPid: 10000, parentPid: 10001, kill });
    const token = (await handlers.snapshot({})).processes[0]!.actionToken!;
    expect((await handlers.stop({ token })).ok).toBe(true); expect(kill).toHaveBeenCalledTimes(1);
    api.projects.list.mockResolvedValue({ projects: [] });
    expect((await handlers.forceStop({ token })).status).toBe("denied");
    expect((await handlers.stop({ token })).status).toBe("denied");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("rechecks scope for descendants and skips an agent child", async () => {
    const adapter = new FakeAdapter(), kill = vi.fn();
    adapter.processes = [proc({ pid: 100 }), proc({ pid: 101, ppid: 100 }), proc({ pid: 102, ppid: 100, argv: ["codex"] }), proc({ pid: 103, ppid: 102 })];
    const guard = new ProcessGuard({ adapter, uid: 1000, selfPid: 10000, kill, authorizeProcess: async (pid) => pid !== 102 });
    const token = guard.mint(adapter.processes[0], hashArgv(adapter.processes[0].argv));
    expect((await guard.stop(token)).signaledCount).toBe(2);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([100, 101]);
  });
});
