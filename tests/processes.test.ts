import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionLog } from "../server/action-log";
import { createMonitorHandlers } from "../server/handlers";
import { classifyJob, isPaseoInternal } from "../server/jobs";
import { ProcessManager, friendly } from "../server/processes";
import { ProcessGuard } from "../server/safety";
import { ProjectScope } from "../server/scope";
import { ProcessReportSchema, StopOutcomeSchema, StopPlanSchema } from "../shared/processes";
import { FakeAdapter, FakeClock, GB, MB, proc } from "./fake-adapter";

const PLUGIN = "/opt/npm-global/lib/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js";
const TERMINALS = "/opt/npm-global/lib/node_modules/@getpaseo/server/dist/server/terminal/terminal-worker-process.js";

/** A fleet container as `ps` showed it on 2026-10-05, plus an agent's build and a dev server. */
function fleet() {
  const adapter = new FakeAdapter();
  adapter.processes = [
    proc({ pid: 1, ppid: 0, uid: 0, argv: ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint-devstack.sh"] }),
    proc({ pid: 7, ppid: 1, argv: ["Paseo Supervisor"], comm: "Paseo Supervisor" }),
    proc({ pid: 100, ppid: 7, argv: ["Paseo Daemon"], comm: "Paseo Daemon", rssBytes: 300 * MB }),
    proc({ pid: 200, ppid: 100, argv: ["/usr/local/bin/node", PLUGIN], rssBytes: 200 * MB }),
    proc({ pid: 201, ppid: 100, argv: ["/usr/local/bin/node", PLUGIN], rssBytes: 150 * MB }),
    proc({ pid: 202, ppid: 200, argv: ["/home/alice/.paseo/daemon-link/bin/cloudflared", "tunnel"] }),
    proc({ pid: 203, ppid: 201, argv: ["node", "helper.js"] }),
    proc({ pid: 300, ppid: 100, argv: ["/usr/local/bin/node", TERMINALS] }),
    proc({ pid: 301, ppid: 300, argv: ["bash"], comm: "bash", cwd: "/home/alice/app" }),
    proc({ pid: 302, ppid: 301, argv: ["npm", "run", "dev"], cwd: "/home/alice/app" }),
    proc({ pid: 303, ppid: 302, argv: ["node", "/home/alice/app/node_modules/.bin/next", "dev"], cwd: "/home/alice/app", rssBytes: 900 * MB }),
    proc({ pid: 400, ppid: 100, argv: ["claude"], comm: "claude", cwd: "/home/alice/app" }),
    proc({ pid: 401, ppid: 400, argv: ["sh", "-c", "npx tsc --noEmit && npx vitest run"], comm: "sh", cwd: "/home/alice/app" }),
    proc({ pid: 402, ppid: 401, argv: ["node", "/home/alice/app/node_modules/.bin/tsc", "--noEmit"], cwd: "/home/alice/app", rssBytes: 1200 * MB }),
    proc({ pid: 403, ppid: 401, argv: ["node", "/home/alice/app/node_modules/.bin/vitest", "run"], cwd: "/home/alice/app" }),
    proc({ pid: 404, ppid: 403, argv: ["node", "/home/alice/app/node_modules/vitest/dist/workers/forks.js"], cwd: "/home/alice/app" }),
    proc({ pid: 500, ppid: 1, argv: ["postgres", "-D", "/var/lib/postgres"], comm: "postgres" }),
    proc({ pid: 501, ppid: 1, argv: ["python3", "/usr/local/bin/stream-bridge.py"] }),
    proc({ pid: 600, ppid: 1, argv: ["node", "build.js"], cwd: "/tmp/scratch" }),
  ];
  adapter.ports.set(303, [3000]);
  return adapter;
}

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

async function setup(options: { adapter?: FakeAdapter; scope?: ProjectScope; maxHeavyJobs?: number } = {}) {
  const adapter = options.adapter ?? fleet();
  const clock = new FakeClock();
  const kills: Array<[number, string]> = [];
  const kill = (pid: number, signal: "SIGTERM" | "SIGKILL") => { kills.push([pid, signal]); };
  const monitor = createMonitorHandlers({ adapter, uid: 1000, home: "/home/alice", selfPid: 200, parentPid: 100, clock, scope: options.scope });
  dir = await mkdtemp(join(tmpdir(), "daemon-link-actions-"));
  const lines: string[] = [];
  const log = new ActionLog(join(dir, "actions.jsonl"), (line) => lines.push(line));
  const timers: Array<() => void> = [];
  const manager = new ProcessManager({
    ...monitor.internals!, daemonPid: 100, scope: options.scope, log, kill, clock,
    readSettings: async () => ({ maxHeavyJobs: options.maxHeavyJobs ?? 4 }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
  });
  const report = async (input = {}) => {
    clock.advance(1500);
    return ProcessReportSchema.parse(await manager.report({ limit: 200, ...input }, () => log.recent(5)));
  };
  return { adapter, clock, kills, manager, log, lines, timers, report };
}

describe("what a process is", () => {
  it("names heavy jobs, tests builds before dev servers, and never counts Paseo's own tools", () => {
    expect(classifyJob(["npm", "run", "build"])).toEqual({ kind: "build", label: "Build" });
    expect(classifyJob(["node", "/x/node_modules/.bin/next", "build"])).toEqual({ kind: "build", label: "Next.js build" });
    expect(classifyJob(["node", "/x/node_modules/.bin/next", "dev"], [3000])).toMatchObject({ kind: "dev-server", label: "Next.js" });
    expect(classifyJob(["pnpm", "test"])).toMatchObject({ kind: "test" });
    expect(classifyJob(["node", "/x/.bin/vitest", "run"])).toMatchObject({ kind: "test", label: "Vitest" });
    expect(classifyJob(["node", "/x/.bin/tsc", "--noEmit"])).toMatchObject({ kind: "typecheck" });
    expect(classifyJob(["npm", "ci", "--ignore-scripts"])).toMatchObject({ kind: "install" });
    expect(classifyJob(["cargo", "build", "--release"])).toMatchObject({ kind: "build" });
    expect(classifyJob(["/opt/npm-global/lib/node_modules/@getpaseo/server/node_modules/@esbuild/linux-x64/bin/esbuild", "--service=0.25.12", "--ping"])).toBeNull();
    expect(classifyJob(["node", "server.js"])).toBeNull();
    expect(classifyJob([])).toBeNull();
    expect(isPaseoInternal({ argv: ["Paseo Daemon"], comm: "" })).toBe(true);
    expect(isPaseoInternal({ argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo"], comm: "Paseo" })).toBe(true);
    expect(isPaseoInternal({ argv: ["node", "app.js"], comm: "node" })).toBe(false);
  });
});

describe("process report", () => {
  it("lists every process this user owns and says plainly which can be stopped and why not", async () => {
    const { report } = await setup();
    const result = await report();
    const row = (pid: number) => result.processes.find((item) => item.pid === pid)!;
    expect(result.total).toBe(18);
    expect(result.processes.some((item) => item.pid === 1)).toBe(false);
    const stoppable = result.processes.filter((item) => item.stoppable).map((item) => item.pid).sort((a, b) => a - b);
    expect(stoppable).toEqual([302, 303, 401, 402, 403, 404]);
    expect(row(100)).toMatchObject({ owner: { kind: "paseo", label: "Paseo · daemon" }, protectedReason: "Part of Paseo, so it can't be stopped here.", actionToken: null });
    expect(row(200).protectedReason).toBe("This is Hosts itself.");
    expect(row(201).owner.label).toBe("Paseo · plugin host");
    expect(row(202).protectedReason).toMatch(/Started by a Paseo plugin/);
    expect(row(203).protectedReason).toMatch(/Started by a Paseo plugin/);
    expect(row(301).protectedReason).toMatch(/terminal's shell/);
    expect(row(400).protectedReason).toMatch(/An agent/);
    expect(row(500).protectedReason).toMatch(/database or system service/);
    expect(row(501).protectedReason).toMatch(/Started outside Paseo/);
    expect(row(600).protectedReason).toMatch(/Started outside Paseo/);
    expect(row(402)).toMatchObject({ owner: { kind: "paseo-started", label: "Started from Paseo" }, job: { kind: "typecheck" }, jobRoot: true });
    expect(row(402).actionToken).toEqual(expect.any(String));
    expect(row(404).jobRoot).toBe(false);
    expect(row(403).tree).toMatchObject({ count: 2, rssBytes: 100 * MB });
    expect(result.paseoBytes).toBe(row(7).rssBytes + 300 * MB + 200 * MB + 150 * MB + row(300).rssBytes);
    expect(result.memoryBasis).toBe("machine");
    expect(result.projectsVerified).toBe(false);
  });

  it("counts heavy jobs once per tree and flags more than the limit, without stopping anything", async () => {
    const { report, kills } = await setup({ maxHeavyJobs: 2 });
    const result = await report();
    expect(result.heavyJobs).toEqual({ count: 3, limit: 2, pids: expect.arrayContaining([302, 402, 403]) });
    expect(result.runaways).toEqual([expect.objectContaining({ code: "too-many-jobs", title: expect.stringMatching(/^3 heavy jobs are running at once; your limit is 2\./) })]);
    expect((await report({ filter: "jobs" })).processes.map((row) => row.pid).sort()).toEqual([302, 402, 403]);
    expect(kills).toEqual([]);
  });

  it("judges memory against the container's own limit, not the 64 GB host", async () => {
    const { adapter, report } = await setup();
    adapter.sample = { ...adapter.sample, memoryTotalBytes: 64 * GB, memoryAvailableBytes: 50 * GB, container: { memoryLimitBytes: 8 * GB, memoryUsageBytes: 7.8 * GB, memoryWorkingSetBytes: 7.4 * GB, cpuLimitCores: null, cpuUsageUsec: 0, psiMemorySome10: 0, psiCpuSome10: 0, oomKills: 0, version: 2 } };
    const result = await report();
    expect(result.memoryBasis).toBe("container");
    expect(result.container).toMatchObject({ memoryLimitBytes: 8 * GB, memoryPercent: 92.5, pressure: "critical" });
    expect(result.processes.find((row) => row.pid === 402)!.memoryPercent).toBeCloseTo((1200 * MB) / (8 * GB) * 100, 0);
    expect(result.runaways[0]).toMatchObject({ code: "memory-near-limit", severity: "critical" });
    expect(result.runaways[0]!.title).toBe("This container's memory is nearly full: 7.4 GB of its 8.0 GB limit.");
  });

  it("marks a runaway once the smoothed CPU has held a core for RUNAWAY_CPU_SECONDS", async () => {
    const { adapter, clock, manager, log } = await setup();
    const tsc = adapter.processes.find((p) => p.pid === 402)!;
    let result = null as Awaited<ReturnType<typeof manager.report>> | null;
    for (let i = 0; i < 8; i += 1) {
      tsc.cpuSeconds += 30;
      clock.advance(30_000);
      result = await manager.report({ limit: 200 }, () => log.recent(5));
    }
    const row = result!.processes.find((item) => item.pid === 402)!;
    expect(row.hotSeconds).toBeGreaterThanOrEqual(120);
    expect(row.flags.map((flag) => flag.code)).toContain("cpu-runaway");
    expect(result!.runaways).toContainEqual(expect.objectContaining({ code: "cpu-runaway", pids: [402], cwd: "~/app", title: expect.stringMatching(/^tsc \(PID 402\) has used a full CPU core for \d+ min\.$/) }));
  });

  it("lets a manually started dev server inside a registered project be stopped (macOS: no Paseo parent)", async () => {
    const adapter = new FakeAdapter();
    adapter.processes = [
      proc({ pid: 50, ppid: 1, argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo"], comm: "Paseo" }),
      proc({ pid: 51, ppid: 50, argv: ["/Applications/Paseo.app/Contents/Resources/node", PLUGIN] }),
      proc({ pid: 60, ppid: 1, argv: ["node", "/Users/alice/app/node_modules/.bin/vite"], cwd: "/home/alice/app" }),
      proc({ pid: 61, ppid: 1, argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], cwd: "/" }),
    ];
    const scope = new ProjectScope(async (path) => path, "/home/alice");
    scope.bind({ projects: { list: async () => ({ projects: [{ projectId: "app", projectDisplayName: "App", projectRootPath: "/home/alice/app" }] }) }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) } } as unknown as PaseoApi);
    const monitor = createMonitorHandlers({ adapter, uid: 1000, home: "/home/alice", selfPid: 51, parentPid: 50, scope });
    const manager = new ProcessManager({ ...monitor.internals!, daemonPid: 50, scope, log: new ActionLog(join(tmpdir(), "unused.jsonl"), () => {}), readSettings: async () => ({ maxHeavyJobs: 4 }) });
    const result = await manager.report({ limit: 50 }, async () => []);
    const vite = result.processes.find((row) => row.pid === 60)!;
    expect(vite).toMatchObject({ stoppable: true, owner: { kind: "project", label: "App" } });
    expect(result.processes.find((row) => row.pid === 61)).toMatchObject({ stoppable: false, owner: { kind: "other" } });
    expect(result.processes.find((row) => row.pid === 50)).toMatchObject({ stoppable: false, owner: { kind: "paseo" } });
    expect(result.projectsVerified).toBe(true);
  });
});

describe("ask first, then stop", () => {
  it("lists what will be stopped, children included, and refuses what it may not stop", async () => {
    const { report, manager } = await setup();
    const rows = (await report()).processes;
    const token = (pid: number) => rows.find((row) => row.pid === pid)!.actionToken!;
    const foreign = new ProcessGuard({ adapter: new FakeAdapter(), uid: 1000 }).mint(proc({ pid: 403 }), "x", Date.now());
    const plan = StopPlanSchema.parse(await manager.preview([token(403), token(302), foreign]));
    expect(plan.graceSeconds).toBe(10);
    expect(plan.targets[0]).toMatchObject({ pid: 403, name: "vitest", ok: true, children: [{ pid: 404, name: "forks" }] });
    expect(plan.targets[1]).toMatchObject({ pid: 302, ok: true, children: [{ pid: 303 }] });
    expect(plan.targets[2]).toMatchObject({ ok: false, reason: "This list is out of date. Refresh and try again." });
  });

  it("asks a job tree to stop, force-stops survivors after the grace period, and logs both steps", async () => {
    const { report, manager, kills, timers, log, lines } = await setup();
    const rows = (await report()).processes;
    const outcome = StopOutcomeSchema.parse(await manager.stop([rows.find((row) => row.pid === 403)!.actionToken!]));
    expect(outcome).toMatchObject({ escalateAfterSeconds: 10, results: [{ pid: 403, name: "vitest", ok: true, status: "signaled", signaled: 2 }] });
    expect(outcome.results[0]!.message).toBe("Asked vitest and 1 child process to stop. Anything still running in 10 seconds is stopped forcefully.");
    expect(kills).toEqual([[403, "SIGTERM"], [404, "SIGTERM"]]);
    expect(timers).toHaveLength(1);
    timers[0]!();
    await vi.waitFor(async () => expect((await log.recent(10)).length).toBe(2));
    expect(kills).toEqual([[403, "SIGTERM"], [404, "SIGTERM"], [403, "SIGKILL"], [404, "SIGKILL"]]);
    const entries = await log.recent(10);
    expect(entries.map((entry) => entry.action)).toEqual(["auto-force-stop", "stop"]);
    expect(entries[0]).toMatchObject({ source: "processes", pid: 403, name: "vitest", owner: "Started from Paseo", status: "signaled" });
    expect(lines[0]).toMatch(/^daemon-link: stop vitest \(PID 403\) · Started from Paseo: signaled, 2 signaled$/);
    const file = await readFile(join(dir!, "actions.jsonl"), "utf8");
    expect(file).not.toMatch(/vitest\/dist|--noEmit|token/);
  });

  it("does nothing more when everything exits within the grace period", async () => {
    const { adapter, report, manager, kills, timers, log } = await setup();
    const rows = (await report()).processes;
    await manager.stop([rows.find((row) => row.pid === 402)!.actionToken!]);
    adapter.processes = adapter.processes.filter((p) => p.pid !== 402);
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kills).toEqual([[402, "SIGTERM"]]);
    expect((await log.recent(10)).map((entry) => entry.action)).toEqual(["stop"]);
  });

  it("re-checks at the moment of the stop: a process that became protected is refused", async () => {
    const { adapter, report, manager, kills } = await setup();
    const rows = (await report()).processes;
    const token = rows.find((row) => row.pid === 402)!.actionToken!;
    // Reparented under a plugin host since the list was drawn.
    adapter.processes.find((p) => p.pid === 402)!.ppid = 201;
    const outcome = await manager.stop([token]);
    expect(outcome.results[0]).toMatchObject({ ok: false, status: "denied" });
    expect(kills).toEqual([]);
  });

  it("never signals Paseo, its plugins or other users, even with a forged list", async () => {
    const { manager, kills } = await setup();
    const forged = manager.guard.mint(proc({ pid: 100, argv: ["Paseo Daemon"], startId: "start-100" }), "irrelevant", Date.now());
    const outcome = await manager.stop([forged]);
    expect(outcome.results[0]!.ok).toBe(false);
    expect(kills).toEqual([]);
  });

  it("says the guard's refusals in plain words", () => {
    expect(friendly({ ok: true, status: "already-exited", message: "", pid: 1, signaledCount: 0 })).toBe("It has already stopped.");
    expect(friendly({ ok: false, status: "denied", message: "Refusing to signal: owned by another user.", pid: 1, signaledCount: 0 })).toBe("Hosts won't stop it: owned by another user.");
    expect(friendly({ ok: false, status: "denied", message: "Process identity changed since the snapshot (PID may have been reused).", pid: 1, signaledCount: 0 })).toMatch(/reused/);
  });
});

describe("action log", () => {
  it("keeps the newest entries, survives torn lines, and returns newest first", async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-link-log-"));
    const file = join(dir, "actions.jsonl");
    const log = new ActionLog(file, () => {});
    for (let i = 0; i < 620; i += 1) await log.append({ at: i, action: "stop", source: "monitor", pid: 1000 + i, name: "node", owner: null, status: "signaled", signaled: 1, message: "ok" });
    const recent = await log.recent(3);
    expect(recent.map((entry) => entry.at)).toEqual([619, 618, 617]);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines.length).toBeGreaterThanOrEqual(500);
    await (await import("node:fs/promises")).appendFile(file, "{torn\n");
    expect((await new ActionLog(file, () => {}).recent(1))[0]!.at).toBe(619);
  });
});
