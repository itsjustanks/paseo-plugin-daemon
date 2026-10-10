import type { RawProcess } from "../server/platform";
import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import { DarwinAdapter, PS_FORMAT } from "../server/darwin";
import { LinuxAdapter, type LinuxFs } from "../server/linux";
import { parseLinuxAgentId, parseMacAgentIds, parseMacExecutables } from "../server/process-tags";
import { ProcessManager } from "../server/processes";
import { createMonitorHandlers } from "../server/handlers";
import { ActionLog } from "../server/action-log";
import { ProjectScope, PASSIVE_TTL_MS } from "../server/scope";
import { chatGroups, processGroups, runningIn } from "../shared/processes";
import { SYNTHETIC_ANTHROPIC_KEY } from "./synthetic-secrets";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

const ID = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const PLUGIN = "/opt/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js";
const TERMINAL = "/opt/node_modules/@getpaseo/server/dist/server/terminal/terminal-worker-process.js";

function registry() {
  let now = 1_000_000;
  const workspace = { id: "w1", name: "Feature", projectId: "p1", projectDisplayName: "Website", projectRootPath: "/home/alice/app", workspaceDirectory: "/home/alice/app", scripts: [] };
  const api = {
    projects: { list: vi.fn(async () => ({ projects: [{ projectId: "p1", projectDisplayName: "Website", projectRootPath: "/home/alice/app" }] })) },
    workspaces: { list: vi.fn(async () => ({ entries: [workspace], pageInfo: { hasMore: false } })) },
    agents: { list: vi.fn(async (_input?: unknown) => ({ entries: [{ agent: { id: ID, title: "Build the site", provider: "codex", status: "idle", cwd: "/home/alice/app", workspaceId: "w1" } }], pageInfo: { hasMore: false, nextCursor: null as string | null } })) },
  };
  const scope = new ProjectScope(async (path) => path, "/home/alice", () => now);
  scope.bind(api as unknown as PaseoApi);
  return { scope, api, advance: () => { now += PASSIVE_TTL_MS + 1; } };
}

async function setup(darwin = false) {
  const { scope, api } = registry();
  await scope.refresh();
  const adapter = new FakeAdapter();
  if (darwin) Object.defineProperty(adapter, "platform", { value: "darwin" });
  const clock = new FakeClock();
  const kills = vi.fn();
  const monitor = createMonitorHandlers({ adapter, scope, uid: 1000, selfPid: 200, parentPid: 100, clock });
  const manager = new ProcessManager({ ...monitor.internals!, adapter, scope, daemonPid: 100, clock, kill: kills, log: new ActionLog("/tmp/hosts-attribution-unused.jsonl", () => {}), setTimer: () => undefined });
  return { manager, scope, api, adapter, kills };
}

describe("environment tags", () => {
  it("parses Linux NUL entries exactly and keeps only the agent UUID", () => {
    expect(parseLinuxAgentId(Buffer.from(`PATH=/bin\0PASEO_AGENT_ID=${ID}\0TOKEN=private\0`))).toBe(ID);
    for (const text of ["", `X_PASEO_AGENT_ID=${ID}\0`, `value=PASEO_AGENT_ID=${ID}\0`, `PASEO_AGENT_ID=${ID}x\0`, "PASEO_AGENT_ID=bad\0"]) expect(parseLinuxAgentId(text)).toBeNull();
  });
  it("parses one macOS ps table without retaining other environment values", () => {
    expect([...parseMacAgentIds(` 42 /bin/sleep 60 PASEO_AGENT_ID=${ID} TOKEN=private\n43 node X_PASEO_AGENT_ID=${ID}\n44 node PASEO_AGENT_ID=bad\n45 node PASEO_AGENT_ID=${SECOND}\n`)]).toEqual([[42, ID], [45, SECOND]]);
    expect(parseMacExecutables("p42\nn/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nn/usr/lib/dyld\n").get(42)).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
  it("reads Linux environ only once per same-user sample and tolerates denial", async () => {
    const reads: string[] = [];
    let denied = false;
    const fs: LinuxFs = {
      readdir: async () => ["42", "43"], readlink: async () => "/tmp/clone",
      readFile: async (path) => path.endsWith("status") ? `Uid:\t${path.includes("43") ? 0 : 1000}\n` : path.endsWith("stat") ? "42 (sleep) S 1 42 42 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 100 0 5 0" : "1000 0",
      readFileBuffer: async (path) => { reads.push(path); if (path.endsWith("environ") && denied) throw new Error("denied"); return Buffer.from(path.endsWith("environ") ? `PASEO_AGENT_ID=${ID}\0` : "/bin/sleep\0" ); },
    };
    const adapter = new LinuxAdapter({ fs, clockTicks: 100 });
    expect((await adapter.sampleProcesses(1000)).processes[0]?.agentId).toBe(ID);
    expect(reads.filter((path) => path.endsWith("environ"))).toEqual(["/proc/42/environ"]);
    denied = true;
    expect((await adapter.sampleProcesses(1000)).processes[0]?.agentId).toBeNull();
  });
  it("uses one macOS environment read per sample and degrades to unknown", async () => {
    let denied = false;
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (args[0] === "-Eww") { if (denied) throw new Error("denied"); return `42 /bin/sleep 60 PASEO_AGENT_ID=${ID}`; }
      if (file === "lsof" && args.includes("txt")) return "p42\nn/bin/sleep\nn/usr/lib/dyld";
      if (file === "ps" && args[1] === PS_FORMAT) return "42 1 1000 S 100 0:00 0:01 Sat Oct 10 12:00:00 2026 /bin/sleep 60";
      return "";
    });
    const adapter = new DarwinAdapter({ exec });
    const sample = await adapter.sampleProcesses(1000);
    expect(sample.processes[0]).toMatchObject({ agentId: ID, executable: "/bin/sleep", argv: ["/bin/sleep", "60"] });
    expect(exec.mock.calls.filter(([, args]) => args[0] === "-Eww")).toHaveLength(1);
    expect(JSON.stringify(sample)).not.toContain("PASEO_AGENT_ID=");
    denied = true;
    expect((await adapter.sampleProcesses(1000)).processes[0]?.agentId).toBeNull();
  });
});

describe("cached agent mapping", () => {
  it("maps title, workspace and status through the shared TTL without per-poll calls", async () => {
    const { scope, api, advance } = registry();
    await Promise.all([scope.refresh(), scope.refresh(), scope.workspaceDescriptors()]);
    expect(scope.agent(ID)).toMatchObject({ title: "Build the site", workspace: "Feature", status: "idle", where: "~/app", workspacePath: "/home/alice/app" });
    await scope.refresh();
    expect(api.agents.list).toHaveBeenCalledTimes(1);
    advance(); await scope.refresh();
    expect(api.agents.list).toHaveBeenCalledTimes(2);
    expect(scope.agent(SECOND)).toBeNull();
  });
  it("paginates, redacts chat titles and removes stale mapping on failure", async () => {
    const { scope, api } = registry();
    api.agents.list.mockResolvedValueOnce({ entries: [{ agent: { id: ID, title: `Build token=${SYNTHETIC_ANTHROPIC_KEY}`, provider: "codex", status: "idle", cwd: "/tmp/clone", workspaceId: "w1" } }], pageInfo: { hasMore: true, nextCursor: "next" } });
    api.agents.list.mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: false, nextCursor: null } });
    await scope.refresh();
    expect(api.agents.list.mock.calls[1]?.[0]).toMatchObject({ page: { cursor: "next" } });
    expect(scope.agent(ID)?.title).not.toContain(SYNTHETIC_ANTHROPIC_KEY);
    api.agents.list.mockRejectedValueOnce(new Error("private"));
    await scope.refresh(true);
    expect(scope.agent(ID)).toBeNull();
    expect(scope.status().status).toBe("ready");
  });
});

describe("process decisions and grouping", () => {
  it("attributes detached/reparented work outside roots, warns for external same-user work, and groups by chat", async () => {
    const { manager, adapter, kills } = await setup();
    adapter.processes = [proc({ pid: 42, cwd: "/tmp/clone", agentId: ID }), proc({ pid: 43, cwd: "/tmp/clone" }), proc({ pid: 44, cwd: "/tmp/clone", agentId: SECOND })];
    const report = await manager.report({}, async () => []);
    const tagged = report.processes.find((row) => row.pid === 42)!;
    expect(tagged).toMatchObject({ stoppable: true, outsidePaseo: false, chat: { id: ID, title: "Build the site", workspace: "Feature" } });
    expect(report.processes.find((row) => row.pid === 43)).toMatchObject({ stoppable: true, outsidePaseo: true, chat: null });
    expect(report.processes.find((row) => row.pid === 44)).toMatchObject({ outsidePaseo: true, chat: null });
    expect(processGroups(report.processes)[0]?.title).toBe("Not in a workspace");
    expect(runningIn(report.processes, { path: "/home/alice/app" }).map((row) => row.pid)).toEqual([42]);
    expect(runningIn([{ ...tagged, cwdPath: "/other/workspace" }], { path: "/other/workspace" })).toEqual([]);
    expect(chatGroups([tagged, { ...tagged, pid: 45, chat: { ...tagged.chat!, id: SECOND } }])).toHaveLength(2);
    const plan = await manager.preview([tagged.actionToken!, report.processes.find((row) => row.pid === 43)!.actionToken!]);
    expect(plan.targets.map((target) => target.outsidePaseo)).toEqual([false, true]);
    expect(kills).not.toHaveBeenCalled();
  });

  it.each([
    ["Hosts", { pid: 200 }, /Hosts itself/],
    ["daemon", { pid: 100, argv: ["Paseo Daemon"] }, /Part of Paseo/],
    ["worker", { argv: ["node", TERMINAL] }, /Part of Paseo/],
    ["plugin host", { argv: ["node", PLUGIN] }, /Part of Paseo/],
    ["plugin child", { ppid: 201 }, /Paseo plugin/],
    ...["claude", "codex", "opencode", "aider", "gemini", "copilot", "goose", "cursor-agent"].map((name) => [name, { argv: [name] }, /An agent/]),
    ...["postgres", "redis-server", "mongod", "mysqld", "sshd", "systemd"].map((name) => [name, { argv: [name] }, /database or system service/]),
    ["terminal shell", { ppid: 300, argv: ["bash"] }, /terminal's shell/],
    ["PID 1", { pid: 1 }, /init process/],
    ["init", { argv: ["/bin/init"] }, /startup process/],
    ["tini", { argv: ["/usr/bin/tini"] }, /startup process/],
    ["other user", { uid: 1001 }, /another user/],
    ["root", { uid: 0 }, /root/],
    ["zombie", { state: "zombie" }, /zombie/],
  ] as Array<[string, Partial<RawProcess>, RegExp]>)("protects %s even with a known chat tag", async (_name, overrides, reason) => {
    const { manager, adapter } = await setup();
    const raw = proc({ pid: 42, agentId: ID, ...overrides } as Parameters<typeof proc>[0]);
    const byPid = new Map([raw, proc({ pid: 201, argv: ["node", PLUGIN] }), proc({ pid: 300, argv: ["node", TERMINAL] })].map((row) => [row.pid, row]));
    expect(manager.decide({ raw } as never, byPid, [])).toMatchObject({ stoppable: false, reason: expect.stringMatching(reason) });
  });

  it.each(["/Library/Apple/System/Library/PrivateFrameworks/RemotePairing.framework/tool", "/System/Library/tool", "/usr/libexec/tool", "/usr/sbin/tool", "/sbin/tool", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"])("protects Mac executable %s", async (executable) => {
    const { manager } = await setup(true);
    const raw = proc({ pid: 42, argv: [executable], executable, agentId: ID });
    expect(manager.decide({ raw } as never, new Map([[42, raw]]), [])).toMatchObject({ stoppable: false });
  });

  it("allows a verified Mac CLI, fails closed for an unreadable path and rechecks before signalling", async () => {
    const { manager, adapter, kills } = await setup(true);
    adapter.processes = [proc({ pid: 42, argv: ["/bin/sleep", "60"], executable: "/bin/sleep", agentId: ID })];
    const row = (await manager.report({}, async () => [])).processes[0]!;
    expect(row.stoppable).toBe(true);
    adapter.processes[0]!.executable = "/System/Library/tool";
    expect((await manager.stop([row.actionToken!])).results[0]?.ok).toBe(false);
    expect(kills).not.toHaveBeenCalled();
    const raw = proc({ pid: 43, executable: null, argv: ["tool"] });
    expect(manager.decide({ raw } as never, new Map([[43, raw]]), [])).toMatchObject({ stoppable: false, reason: expect.stringMatching(/couldn't be verified/) });
  });

  it("never automatically stops outside-Paseo work", async () => {
    const { manager, adapter, kills } = await setup();
    adapter.processes = [proc({ pid: 42, cwd: "/tmp/clone", rssBytes: 30 * 1024 ** 3 })];
    expect(await manager.autoStopBiggest(25, async () => true)).toBeNull();
    expect(kills).not.toHaveBeenCalled();
  });
});
