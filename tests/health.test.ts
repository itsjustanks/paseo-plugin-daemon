import { describe, expect, it, vi } from "vitest";
import { HealthChecker, type HealthRuntime } from "../server/health";
import type { Snapshot } from "../shared/contracts";
import { EMPTY_HEALTH_MEMORY, HealthVerdictSchema, PORT_GONE_TTL_MS, evaluateHealth, pillText, trackPorts, workspaceHealth, type HealthInput, type HealthVerdict } from "../shared/health";
import type { LinkState, Tunnel } from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";

type Row = Snapshot["services"][number];
const row = (pid: number, cwd: string | null, ports: number[], extra: Partial<Row> = {}): Row =>
  ({ pid, name: `proc-${pid}`, cwd, ports, state: "sleeping", project: null, ...extra }) as unknown as Row;
const pressure = (state: "normal" | "critical" = "normal") => ({ pressure: state }) as unknown as Snapshot["cpu"] & Snapshot["memory"];
const snapshot = (services: Row[], processes: Row[] = [], extra: Partial<HealthInput["snapshot"] & object> = {}): NonNullable<HealthInput["snapshot"]> =>
  ({ services, processes, supported: true, scope: { status: "ready", message: "", projects: [] }, cpu: pressure(), memory: pressure(), ...extra });
const tunnel = (port: number, state: Tunnel["state"], message = ""): Tunnel => ({ id: `t-${port}`, port, state, message, createdAt: 0, expiresAt: 0, url: null });
const base = (over: Partial<HealthInput> = {}): HealthInput => ({ now: 1_000_000, snapshot: snapshot([]), tunnels: [], connections: [], profiles: [], background: true, ...over });

describe("evaluateHealth", () => {
  it("is ok for a quiet host and critical for an unreadable one", () => {
    const ok = evaluateHealth(base({ snapshot: snapshot([row(1, "~/app", [3000], { name: "next" })]) }));
    expect(ok.verdict).toMatchObject({ status: "ok", checkedAt: 1_000_000, background: true, issues: [] });
    expect(ok.verdict.services).toEqual([{ name: "next", cwd: "~/app", ports: [3000], project: null }]);
    expect(HealthVerdictSchema.safeParse(ok.verdict).success).toBe(true);
    const down = evaluateHealth(base({ snapshot: null, snapshotError: "Monitor could not read system state." }));
    expect(down.verdict.status).toBe("critical");
    expect(down.verdict.issues).toEqual([{ code: "host-unreachable", severity: "critical", scope: "host", message: "Monitor could not read system state.", ports: [], cwd: null }]);
    expect(down.memory).toBe(EMPTY_HEALTH_MEMORY);
  });
  it("reports unsupported platforms, unverified projects, critical pressure, and zombies as warnings", () => {
    const { verdict } = evaluateHealth(base({
      snapshot: snapshot([], [row(9, "~/app", [], { state: "zombie", name: "dead" })], { supported: false, scope: { status: "unavailable", message: "Refresh this host.", projects: [] }, cpu: pressure("critical"), memory: pressure("critical") }),
    }));
    expect(verdict.status).toBe("warning");
    expect(verdict.issues.map((issue) => issue.code)).toEqual(["host-unsupported", "projects-unavailable", "cpu-pressure", "memory-pressure", "process-zombie"]);
    expect(verdict.issues[4]).toMatchObject({ scope: "process", cwd: "~/app", message: "dead (PID 9) is a zombie process." });
  });
  it("attributes pressure to a workspace only through the collector's pressure-driver impact, once per process", () => {
    const driver = row(3, "~/app/web", [3000], { name: "vite", impact: "pressure-driver", reasons: ["CPU 92%", "top CPU user during CPU pressure"] });
    const hog = row(4, "~/app/api", [], { name: "worker", impact: "pressure-driver", reasons: ["34% of memory", "top memory user during memory pressure"] });
    const busy = row(5, "~/app/web", [], { name: "tsc", impact: "high", reasons: ["CPU 80%"] });
    const { verdict } = evaluateHealth(base({ snapshot: snapshot([driver], [driver, hog, busy], { cpu: pressure("critical") }) }));
    expect(verdict.issues).toEqual([
      expect.objectContaining({ code: "cpu-pressure", scope: "host" }),
      { code: "pressure-driver", severity: "warning", scope: "process", message: "vite (PID 3) is a top CPU user while the host is under CPU pressure.", ports: [3000], cwd: "~/app/web" },
      { code: "pressure-driver", severity: "warning", scope: "process", message: "worker (PID 4) is a top memory user while the host is under memory pressure.", ports: [], cwd: "~/app/api" },
    ]);
    // A merely busy process on a busy host is not blamed, and a quiet host never produces the code.
    expect(evaluateHealth(base({ snapshot: snapshot([], [busy], { cpu: pressure("critical") }) })).verdict.issues.map((issue) => issue.code)).toEqual(["cpu-pressure"]);
    expect(evaluateHealth(base({ snapshot: snapshot([], [busy]) })).verdict.issues).toEqual([]);
  });
  it("remembers served dev-server ports and reports one that stops serving until the TTL passes", () => {
    const first = evaluateHealth(base({ snapshot: snapshot([row(1, "~/app/web", [3000], { name: "vite" })]) }));
    expect(first.memory.serving).toEqual({ 3000: { cwd: "~/app/web", name: "vite", seenAt: 1_000_000 } });
    const second = evaluateHealth(base({ now: 1_020_000 }), first.memory);
    expect(second.verdict.issues).toEqual([{ code: "port-gone", severity: "warning", scope: "process", message: "vite on port 3000 stopped serving.", ports: [3000], cwd: "~/app/web" }]);
    // Still gone: same issue, original lostAt preserved.
    const third = evaluateHealth(base({ now: 1_040_000 }), second.memory);
    expect(third.memory.lost[3000]!.lostAt).toBe(1_020_000);
    expect(third.verdict.status).toBe("warning");
    // Served again by any process: forgotten.
    const back = evaluateHealth(base({ now: 1_060_000, snapshot: snapshot([], [row(7, "~/elsewhere", [3000])]) }), third.memory);
    expect(back.verdict.issues).toEqual([]);
    expect(back.memory.lost).toEqual({});
    // Or expired.
    const expired = evaluateHealth(base({ now: 1_020_000 + PORT_GONE_TTL_MS }), second.memory);
    expect(expired.verdict.issues).toEqual([]);
  });
  it("does not move ports to lost while project verification is unavailable, and keeps old memory", () => {
    const memory = { serving: { 3000: { cwd: "~/app", name: "next", seenAt: 1 } }, lost: {} };
    const { verdict, memory: next } = evaluateHealth(base({ snapshot: snapshot([], [], { scope: { status: "unavailable", message: "x", projects: [] } }) }), memory);
    expect(verdict.issues.map((issue) => issue.code)).toEqual(["projects-unavailable"]);
    expect(next).toBe(memory);
    expect(trackPorts({ services: [], processes: [] }, memory, 5).lost).toEqual({ 3000: { cwd: "~/app", name: "next", seenAt: 1, lostAt: 5 } });
  });
  it("flags failed browser links, retrying SSH forwards, and auto-connect forwards that are not running", () => {
    const connections: LinkState[] = [{ id: "a", state: "retrying", message: "SSH connection failed." }, { id: "b", state: "connected", message: "" }];
    const profiles = [
      { id: "a", name: "api", localPort: 8080, autoConnect: false },
      { id: "b", name: "db", localPort: 5432, autoConnect: true },
      { id: "c", name: "web", localPort: 9000, autoConnect: true },
      { id: "d", name: "manual", localPort: 9001, autoConnect: false },
    ];
    const { verdict } = evaluateHealth(base({ tunnels: [tunnel(3000, "error", "Tunnel disconnected."), tunnel(3001, "connected")], connections, profiles }));
    expect(verdict.issues).toEqual([
      expect.objectContaining({ code: "tunnel-failed", ports: [3000], message: "Browser link for port 3000 failed: Tunnel disconnected." }),
      expect.objectContaining({ code: "link-retrying", ports: [8080] }),
      expect.objectContaining({ code: "link-down", ports: [9000], message: 'SSH forward "web" should auto-connect but is not running.' }),
    ]);
    expect(JSON.stringify(verdict)).not.toContain("trycloudflare");
  });
});

describe("workspaceHealth and pillText", () => {
  const target = { directory: "/home/alice/app/.worktrees/feature", projectRootPath: "/home/alice/app", name: "feature" };
  const verdict = (issues: HealthVerdict["issues"], services: HealthVerdict["services"] = []): HealthVerdict => ({ status: issues.length ? "warning" : "ok", checkedAt: 42, background: true, issues, services });
  const issue = (code: HealthVerdict["issues"][number]["code"], ports: number[], cwd: string | null, scope: "host" | "process" = "process", severity: "warning" | "critical" = "warning"): HealthVerdict["issues"][number] =>
    ({ code, severity, scope, message: `${code} message`, ports, cwd });
  it("keeps host issues and only the process issues under the workspace or on its ports", () => {
    const services = [
      { name: "next", cwd: "~/app/.worktrees/feature", ports: [3000], project: null },
      { name: "other", cwd: "~/app/.worktrees/other", ports: [3001], project: null },
    ];
    const health = workspaceHealth(verdict([
      issue("projects-unavailable", [], null, "host"),
      issue("port-gone", [4000], "~/app/.worktrees/feature/api"),
      issue("port-gone", [4001], "~/app/.worktrees/other"),
      issue("tunnel-failed", [3000], null),
      issue("tunnel-failed", [3001], null),
    ], services), target);
    expect(health.services.map((service) => service.name)).toEqual(["next"]);
    // Service ports plus the port of the vanished dev server under this workspace.
    expect(health.ports).toEqual([3000, 4000]);
    expect(health.issues.map((entry) => `${entry.code}:${entry.ports[0] ?? "-"}`)).toEqual(["projects-unavailable:-", "port-gone:4000", "tunnel-failed:3000"]);
    expect(health).toMatchObject({ status: "warning", checkedAt: 42 });
    expect(workspaceHealth({ ...verdict([]), status: "unknown" }, target).status).toBe("unknown");
  });
  it("returns null when there is nothing to report and short copy otherwise", () => {
    expect(pillText(workspaceHealth(verdict([]), target))).toBeNull();
    expect(pillText(workspaceHealth(verdict([], [{ name: "next", cwd: "~/app/.worktrees/feature", ports: [3000], project: null }]), target))).toBe("1 dev server :3000");
    expect(pillText(workspaceHealth(verdict([], [
      { name: "a", cwd: "~/app/.worktrees/feature", ports: [3000, 3001], project: null },
      { name: "b", cwd: "~/app/.worktrees/feature/api", ports: [4000, 4001], project: null },
    ]), target))).toBe("2 dev servers :3000 :3001 :4000…");
    expect(pillText(workspaceHealth(verdict([issue("port-gone", [3000], "~/app/.worktrees/feature"), issue("tunnel-failed", [3000], null)]), target))).toBe("Dev server :3000 stopped +1");
    expect(pillText(workspaceHealth(verdict([issue("link-down", [9000], null, "process")]), target))).toBeNull();
    expect(pillText(workspaceHealth(verdict([issue("host-unreachable", [], null, "host", "critical")]), target))).toBe("Host unreachable");
    expect(pillText(workspaceHealth(verdict([issue("cpu-pressure", [], null, "host")]), target))).toBe("CPU busy");
    // The workspace's own driver outranks the host-wide code in the chip; both stay counted.
    expect(pillText(workspaceHealth(verdict([issue("cpu-pressure", [], null, "host"), issue("pressure-driver", [3000], "~/app/.worktrees/feature")]), target))).toBe("Driving host pressure +1");
    expect(pillText(workspaceHealth(verdict([issue("pressure-driver", [3001], "~/app/.worktrees/other")]), target))).toBeNull();
  });
});

describe("HealthChecker", () => {
  function harness(settings = HOSTS_SETTINGS_DEFAULTS) {
    let now = 0;
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const snapshotFn = vi.fn(async () => snapshot([row(1, "~/app", [3000], { name: "next" })]) as Snapshot);
    const runtime: HealthRuntime = { monitor: { snapshot: snapshotFn }, links: { status: vi.fn(async () => ({ profiles: [], connections: [], tunnels: [] })) } };
    const readSettings = vi.fn(async () => settings);
    const checker = new HealthChecker({
      runtime, readSettings, now: () => now,
      setTimer: ((fn: () => void, ms: number) => { const id = nextId++; timers.push({ fn, ms, id }); return id as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
      clearTimer: ((id: unknown) => { const index = timers.findIndex((timer) => timer.id === id); if (index >= 0) timers.splice(index, 1); }) as typeof clearTimeout,
    });
    const tick = async () => { const timer = timers.shift(); if (!timer) throw new Error("no timer"); now += timer.ms; timer.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
    return { checker, snapshotFn, readSettings, timers, tick, advance: (ms: number) => { now += ms; } };
  }
  it("serves the cache within the interval, re-checks after it, and coalesces concurrent checks", async () => {
    const { checker, snapshotFn, advance } = harness();
    expect(checker.current()).toBeNull();
    const [a, b] = await Promise.all([checker.read(), checker.read()]);
    expect(a).toBe(b);
    expect(snapshotFn).toHaveBeenCalledTimes(1);
    expect(a.status).toBe("ok");
    advance(5_000);
    expect(await checker.read()).toBe(a);
    advance(30_000);
    const c = await checker.read();
    expect(c).not.toBe(a);
    expect(snapshotFn).toHaveBeenCalledTimes(2);
    expect(checker.current()).toBe(c);
  });
  it("arms the background timer only once a client context exists, skips ticks when disabled, and clears on close", async () => {
    const settings = { ...HOSTS_SETTINGS_DEFAULTS };
    const { checker, snapshotFn, readSettings, timers, tick } = harness(settings);
    await checker.read();
    expect(timers).toHaveLength(0);
    await checker.read({ paseo: {} as never });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(30_000);
    await tick();
    expect(snapshotFn).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    settings.backgroundHealthChecks = false;
    readSettings.mockResolvedValue(settings);
    await tick();
    expect(snapshotFn).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    checker.close();
    expect(timers).toHaveLength(0);
  });
  it("turns a failing snapshot into a critical verdict without throwing", async () => {
    const { checker, snapshotFn } = harness();
    snapshotFn.mockRejectedValueOnce(new Error("Monitor could not read system state."));
    const verdict = await checker.read();
    expect(verdict.status).toBe("critical");
    expect(verdict.issues[0]).toMatchObject({ code: "host-unreachable", message: "Monitor could not read system state." });
  });
});

describe("runaways, watched services and the summary", () => {
  const runaway = (code: string, severity: "warning" | "critical", title: string, cwd: string | null = null) => ({ code, severity, title, pids: [1], cwd }) as never;
  const report = (runaways: never[]) => ({
    runaways, container: { memoryLimitBytes: 8e9, memoryUsedBytes: 7.4e9 } as never, memoryBasis: "container" as const, memoryBasisBytes: 8e9,
    host: { cores: 8, cpuPercent: 40, load1: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 20e9, cpuPressure: "normal", memoryPressure: "critical" } as never,
    heavyJobs: { count: 5, limit: 4, pids: [] },
  });
  it("puts the report's plain sentences on the verdict, scoped to the process where there is one", () => {
    const { verdict } = evaluateHealth(base({
      snapshot: snapshot([], [], { memory: pressure("critical") }),
      report: report([
        runaway("memory-near-limit", "critical", "This container's memory is nearly full: 7.4 GB of its 8.0 GB limit."),
        runaway("too-many-jobs", "warning", "5 heavy jobs are running at once; your limit is 4."),
        runaway("cpu-runaway", "warning", "tsc (PID 402) has used a full CPU core for 4 min.", "~/app"),
      ]),
      watched: [{ id: "o", name: "OmniRoute", target: "h/x", state: "slow", latencyMs: 4200, usualMs: 100, status: 200, checkedAt: 1, message: "OmniRoute is slow: 4.2 s, usually 100 ms.", history: [] }],
    }));
    expect(HealthVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(verdict.status).toBe("critical");
    expect(verdict.issues.map((issue) => [issue.code, issue.scope])).toEqual([["memory-pressure", "host"], ["too-many-jobs", "host"], ["runaway", "process"], ["service-slow", "host"]]);
    expect(verdict.issues[0]!.message).toBe("This container's memory is nearly full: 7.4 GB of its 8.0 GB limit.");
    expect(verdict.issues[2]).toMatchObject({ cwd: "~/app", subject: "tsc" });
    expect(verdict.load).toEqual({ memoryUsedBytes: 7.4e9, memoryLimitBytes: 8e9, memoryBasis: "container", cpuPercent: 40, heavyJobs: 5, heavyJobLimit: 4 });
    const target = { directory: "/home/alice/app", projectRootPath: "/home/alice/app", name: "App" };
    expect(pillText(workspaceHealth(verdict, target))).toBe("This container's memory is nearly full: 7.4 GB of its 8.0 GB limit.");
    expect(pillText(workspaceHealth({ ...verdict, status: "warning", issues: verdict.issues.slice(1) }, target))).toBe("Runaway: tsc +2");
    const quiet = evaluateHealth(base({ report: report([]), watched: [{ id: "o", name: "OmniRoute", target: "h/x", state: "down", latencyMs: null, usualMs: null, status: null, checkedAt: 1, message: "OmniRoute is down: it can't be reached.", history: [] }] })).verdict;
    expect(pillText(workspaceHealth(quiet, { directory: "/elsewhere" }))).toBe("OmniRoute down");
  });
  it("summarises a verdict for other plugins without paths or commands, and writes it atomically", async () => {
    const { summarize, HostSummarySchema } = await import("../shared/summary");
    const { verdict } = evaluateHealth(base({ report: report([runaway("cpu-runaway", "warning", "tsc (PID 402) has used a full CPU core for 4 min.", "~/secret-project")]),
      watched: [{ id: "o", name: "OmniRoute", target: "10.0.0.9:20128/api/health/ping", state: "up", latencyMs: 90, usualMs: 100, status: 200, checkedAt: 1, message: "OmniRoute answered in 90 ms.", history: [] }] }));
    const summary = HostSummarySchema.parse(summarize(verdict));
    expect(summary.watched).toEqual([{ name: "OmniRoute", state: "up", latencyMs: 90, usualMs: 100, message: "OmniRoute answered in 90 ms." }]);
    expect(JSON.stringify(summary)).not.toContain("10.0.0.9");
    expect(summary).toMatchObject({ version: 1, plugin: "daemon-link", status: "warning", load: { heavyJobs: 5 } });
    expect(JSON.stringify(summary)).not.toContain("secret-project");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { summaryWriter } = await import("../server/summary-file");
    const dir = await mkdtemp(join(tmpdir(), "daemon-link-summary-"));
    await summaryWriter(dir)(verdict);
    expect(HostSummarySchema.parse(JSON.parse(await readFile(join(dir, "host-summary.json"), "utf8"))).status).toBe("warning");
    await rm(dir, { recursive: true, force: true });
  });
  it("checks watched services and reads the process report on each health check", async () => {
    const check = vi.fn(async () => []);
    const reportFn = vi.fn(async () => report([]) as never);
    const runtime: HealthRuntime = { monitor: { snapshot: async () => snapshot([]) as Snapshot }, links: { status: async () => ({ profiles: [], connections: [], tunnels: [] }) }, processes: { report: reportFn }, watch: { check } };
    const seen: HealthVerdict[] = [];
    const checker = new HealthChecker({ runtime, readSettings: async () => ({ ...HOSTS_SETTINGS_DEFAULTS, watchedServices: [{ id: "o", name: "OmniRoute", url: "http://h/x", expectedStatus: null }] }), onVerdict: (v) => seen.push(v) });
    await checker.read(undefined, true);
    expect(check).toHaveBeenCalledWith([expect.objectContaining({ id: "o" })], true);
    expect(reportFn).toHaveBeenCalledWith({ limit: 1 });
    expect(seen).toHaveLength(1);
  });
});

