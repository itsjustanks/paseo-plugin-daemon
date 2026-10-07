import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLog } from "../server/action-log";
import { DaemonLogTail, type LogFs } from "../server/daemon-log";
import { GuardLoop, GrowthTracker, LinuxQuickSampler, bounded, shouldAutoStop, type ProcFs, type QuickSample } from "../server/guard-loop";
import { createMonitorHandlers } from "../server/handlers";
import { classifyJob, isScriptTestRun } from "../server/jobs";
import { ProcessManager } from "../server/processes";
import {
  GuardStateSchema, growthOver, memoryLevel, parsePsi, pluginName, pressureSentence, runawaySentence, runawayVerdict, type GuardState,
} from "../shared/guard";
import { evaluateHealth, HealthVerdictSchema } from "../shared/health";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";
import { FakeAdapter, FakeClock, GB, MB, proc } from "./fake-adapter";

/** The host from the incident: 62 GB machine, container limit 62981668864 bytes (58.7 GB). */
const LIMIT = 62_981_668_864;
const MINUTE = 60_000;

describe("memory pressure", () => {
  it("parses both PSI lines, as a real container showed them", () => {
    const calm = parsePsi("some avg10=0.00 avg60=2.21 avg300=44.29 total=6456231441\nfull avg10=0.00 avg60=1.87 avg300=37.23 total=5148385536\n");
    expect(calm).toEqual({ some: { avg10: 0, avg60: 2.21, avg300: 44.29 }, full: { avg10: 0, avg60: 1.87, avg300: 37.23 } });
    expect(parsePsi("some avg10=1.50 avg60=0 avg300=0 total=1\n")).toEqual({ some: { avg10: 1.5, avg60: 0, avg300: 0 }, full: null });
    expect(parsePsi("garbage")).toEqual({ some: null, full: null });
  });

  it("calls the incident critical, and calm calm", () => {
    // 04:30 UTC: "full" reached 84%, swap full.
    expect(memoryLevel({ some10: 91, full10: 84, percent: 99, newOomKills: 0 })).toBe("critical");
    expect(memoryLevel({ some10: 0, full10: 0, percent: 41, newOomKills: 0 })).toBe("normal");
    expect(memoryLevel({ some10: 8, full10: 6, percent: 70, newOomKills: 0 })).toBe("high");
    expect(memoryLevel({ some10: 55, full10: 2, percent: 70, newOomKills: 0 })).toBe("critical");
    expect(memoryLevel({ some10: 0, full10: 0, percent: 92, newOomKills: 1 })).toBe("critical");
    expect(memoryLevel({ some10: null, full10: null, percent: 91, newOomKills: 0 })).toBe("high");
    expect(memoryLevel({ some10: null, full10: null, percent: null, newOomKills: 0 })).toBe("normal");
  });

  it("says it in plain words", () => {
    expect(pressureSentence({ some10: 91, full10: 84, percent: 99, newOomKills: 0 }, "critical")).toBe("Memory is nearly full: programs are stalled waiting for memory 84% of the time, and 99% of it is in use.");
    expect(pressureSentence({ some10: 25, full10: 1, percent: 60, newOomKills: 2 }, "high")).toBe("Memory is getting tight: programs are waiting for memory 25% of the time, and the system had to stop 2 programs to free memory.");
    expect(pressureSentence({ some10: 0, full10: 0, percent: 20, newOomKills: 0 }, "normal")).toBeNull();
    // macOS: its own level, said as such, never as an invented percentage.
    const mac = { some10: null, full10: null, percent: 83, newOomKills: 0, osLevel: "warn" as const };
    expect(memoryLevel(mac)).toBe("high");
    expect(pressureSentence(mac, "high")).toBe("Memory is getting tight: macOS reports memory pressure.");
    expect(memoryLevel({ ...mac, osLevel: "critical" })).toBe("critical");
  });
});

describe("runaway thresholds", () => {
  it("words the incident the way a person would", () => {
    expect(runawaySentence({ job: "test", name: "node", rssBytes: 36 * GB, percent: (36 * GB / LIMIT) * 100, growthBytes: 7 * GB, level: "critical" }))
      .toBe("A test run is using 36 GB, 61% of this computer's memory. It grew by 7 GB in the last 5 minutes. The computer will slow to a crawl soon.");
    expect(runawaySentence({ job: null, name: "esbuild", rssBytes: 15 * GB, percent: 26, growthBytes: null, level: "normal" }))
      .toBe("esbuild is using 15 GB, 26% of this computer's memory. If it keeps growing, the computer will slow down.");
    expect(runawaySentence({ job: "build", name: "node", rssBytes: 7 * GB, percent: 12, growthBytes: 6 * GB, level: "normal" }))
      .toBe("A build is using 7 GB, 12% of this computer's memory. It grew by 6 GB in the last 5 minutes. It may fill memory soon.");
  });

  it("flags a quarter of memory, or fast growth from a tenth; urgent at half or under pressure", () => {
    expect(runawayVerdict(36 * GB, LIMIT, null, "normal")).toEqual({ flagged: true, severity: "critical", growing: false });
    expect(runawayVerdict(15 * GB, LIMIT, null, "normal")).toEqual({ flagged: true, severity: "warning", growing: false });
    expect(runawayVerdict(15 * GB, LIMIT, null, "high")).toMatchObject({ severity: "critical" });
    expect(runawayVerdict(10 * GB, LIMIT, null, "normal")).toMatchObject({ flagged: false });
    // The incident 10 minutes in: 14 GB (24%) and 7 GB added in 5 minutes. Flagged before the quarter mark.
    expect(runawayVerdict(14 * GB, LIMIT, 7 * GB, "normal")).toEqual({ flagged: true, severity: "warning", growing: true });
    // Growth by a small process, or slow growth, isn't.
    expect(runawayVerdict(3 * GB, LIMIT, 3 * GB, "normal")).toMatchObject({ flagged: false });
    expect(runawayVerdict(10 * GB, LIMIT, 1 * GB, "normal")).toMatchObject({ flagged: false });
    // On an 8 GB laptop a 1.5 GB jump is under the 2 GB floor.
    expect(runawayVerdict(1.5 * GB, 8 * GB, 1.5 * GB, "normal")).toMatchObject({ flagged: false });
    expect(runawayVerdict(1 * GB, 0, 1 * GB, "normal")).toMatchObject({ flagged: false });
  });

  it("measures growth over the last five minutes, needing a minute of history", () => {
    const points = [0, 1, 2, 3, 4, 5, 6].map((minute) => ({ at: minute * MINUTE, rssBytes: minute * 1.4 * GB }));
    expect(growthOver(points, 6 * MINUTE)).toBeCloseTo(5 * 1.4 * GB, -6);
    expect(growthOver(points.slice(0, 1), 0)).toBeNull();
    expect(growthOver([{ at: 0, rssBytes: 0 }, { at: 30_000, rssBytes: GB }], 30_000)).toBeNull();
    const tracker = new GrowthTracker();
    tracker.record(0, [{ pid: 7, startId: "a", rssBytes: GB }]);
    tracker.record(2 * MINUTE, [{ pid: 7, startId: "a", rssBytes: 4 * GB }]);
    expect(tracker.growth(7, "a", 2 * MINUTE)).toBe(3 * GB);
    expect(tracker.growthByPid(7, 2 * MINUTE)).toBe(3 * GB);
    // A reused PID starts afresh, and gone processes are forgotten.
    tracker.record(3 * MINUTE, [{ pid: 7, startId: "b", rssBytes: 4 * GB }]);
    expect(tracker.growth(7, "a", 3 * MINUTE)).toBeNull();
    expect(tracker.growth(7, "b", 3 * MINUTE)).toBeNull();
  });

  it("knows the runaway was a test run", () => {
    expect(classifyJob(["node", "--test", "scripts/app-file-ops.test.mjs"])).toEqual({ kind: "test", label: "Tests" });
    expect(isScriptTestRun(["/usr/local/bin/node", "scripts/app-file-ops.test.mjs"])).toBe(true);
    expect(isScriptTestRun(["bun", "test"])).toBe(true);
    expect(isScriptTestRun(["node", "server.js"])).toBe(false);
    expect(isScriptTestRun(["timeout", "300", "node", "--test"])).toBe(false);
  });

  it("names plugins plainly", () => {
    expect(pluginName("ai-router")).toBe("AI Router");
    expect(pluginName("paseo-mcp")).toBe("Paseo MCP");
    expect(pluginName("activity")).toBe("Activity");
  });
});

describe("the auto-guard rule", () => {
  const base = { enabled: true, level: "critical" as const, criticalSince: 0, lastAttempt: 0, now: 61_000 };
  it("is off by default", () => {
    expect(HOSTS_SETTINGS_DEFAULTS.autoStopRunaways).toBe(false);
    expect(shouldAutoStop({ ...base, enabled: false })).toBe(false);
  });
  it("acts only after more than a minute of critical memory, then waits out its cooldown", () => {
    expect(shouldAutoStop({ ...base, lastAttempt: -1e9 })).toBe(true);
    expect(shouldAutoStop({ ...base, now: 59_000, lastAttempt: -1e9 })).toBe(false);
    expect(shouldAutoStop({ ...base, level: "high", lastAttempt: -1e9 })).toBe(false);
    expect(shouldAutoStop({ ...base, criticalSince: null, lastAttempt: -1e9 })).toBe(false);
    expect(shouldAutoStop({ ...base, now: 120_000, lastAttempt: 61_000 })).toBe(false);
    expect(shouldAutoStop({ ...base, now: 160_000, lastAttempt: 61_000 })).toBe(true);
  });
});

/** procfs and cgroup files for the incident host, as plain text. */
function incidentProcfs(state: { full10: number; some10: number; rss: number; oomKills: number }): ProcFs {
  const files = (): Record<string, string> => ({
    "/proc/meminfo": "MemTotal:       65000000 kB\nMemAvailable:    1000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.current": String(58 * GB),
    "/sys/fs/cgroup/memory.max": String(LIMIT),
    "/sys/fs/cgroup/memory.stat": "inactive_file 104857600\n",
    "/sys/fs/cgroup/memory.pressure": `some avg10=${state.some10.toFixed(2)} avg60=10.00 avg300=5.00 total=1\nfull avg10=${state.full10.toFixed(2)} avg60=8.00 avg300=4.00 total=1\n`,
    "/sys/fs/cgroup/memory.events": `low 0\nhigh 0\nmax 45104301\noom 168\noom_kill ${state.oomKills}\noom_group_kill 0\n`,
    "/proc/77/status": "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t" + Math.round(state.rss / 1024) + " kB\n",
    "/proc/77/stat": "77 (node) R 76 77 77 0 -1 4194304 0 0 0 0 100 10 0 0 20 0 1 0 5000 0 0",
    "/proc/80/status": "Name:\tsshd\nUid:\t0\t0\t0\t0\nVmRSS:\t9000 kB\n",
    "/proc/80/stat": "80 (sshd) S 1 80 80 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 10 0 0",
  });
  return {
    readFile: async (path) => { const text = files()[path]; if (text === undefined) throw new Error(`ENOENT ${path}`); return text; },
    readdir: async () => ["1", "77", "80", "self"],
  };
}

describe("the quick sampler (Linux)", () => {
  it("reads the container's limit, PSI full and OOM kills, and only this user's processes", async () => {
    const state = { full10: 84, some10: 91, rss: 36 * GB, oomKills: 58 };
    const sampler = new LinuxQuickSampler(1000, incidentProcfs(state), () => 1_000);
    const first = await sampler.sample();
    expect(first.basisBytes).toBe(LIMIT);
    expect(first.signal).toMatchObject({ some10: 91, full10: 84, newOomKills: 0 });
    expect(first.processes).toEqual([{ pid: 77, startId: "5000", rssBytes: Math.round(36 * GB / 1024) * 1024 }]);
    state.oomKills = 60;
    expect((await sampler.sample()).signal.newOomKills).toBe(2);
  });
});

/** A sampler that replays the incident: a test run growing ~1.4 GB a minute until memory stalls. */
class IncidentSampler {
  minute = 0;
  async sample(): Promise<QuickSample> {
    const rss = Math.min(36, 1.4 * this.minute) * GB;
    const full10 = this.minute >= 24 ? 84 : this.minute >= 20 ? 12 : 0;
    return { at: this.minute * MINUTE, basisBytes: LIMIT, usedBytes: 20 * GB + rss, signal: { some10: full10, full10, percent: ((20 * GB + rss) / LIMIT) * 100, newOomKills: 0 }, processes: [{ pid: 77, startId: "5000", rssBytes: rss }] };
  }
}

const emptyLog: LogFs = { stat: async () => ({ size: 0, ino: 1 }), read: async () => Buffer.alloc(0) };

describe("the check loop", () => {
  it("flags the incident well before the daemon stalls, and never stops anything with the guard off", async () => {
    const sampler = new IncidentSampler();
    let stops = 0;
    const loop = new GuardLoop({ sampler, tail: new DaemonLogTail("/x", emptyLog), readSettings: async () => ({ autoStopRunaways: false }), autoStop: async () => { stops += 1; return null; }, now: () => sampler.minute * MINUTE });
    for (sampler.minute = 0; sampler.minute <= 30; sampler.minute += 1) await loop.tick();
    expect(stops).toBe(0);
    const state = GuardStateSchema.parse(loop.state());
    expect(state.memory).toMatchObject({ level: "critical", full10: 84, criticalSince: 24 * MINUTE });
    expect(state.memory.sentence).toMatch(/^Memory is nearly full: programs are stalled waiting for memory 84% of the time/);
    expect(state.autoGuard).toEqual({ enabled: false, last: null });
    // Ten minutes in (14 GB, memory still calm), it was already growing fast enough to flag.
    const early = new IncidentSampler();
    const watch = new GuardLoop({ sampler: early, tail: new DaemonLogTail("/x", emptyLog), readSettings: async () => ({ autoStopRunaways: false }), now: () => early.minute * MINUTE });
    for (early.minute = 0; early.minute <= 10; early.minute += 1) await watch.tick();
    early.minute = 10;
    expect(watch.state().memory.level).toBe("normal");
    expect(runawayVerdict(14 * GB, LIMIT, watch.growthOf(77, "5000"), "normal")).toEqual({ flagged: true, severity: "warning", growing: true });
  });

  it("keeps going when the daemon can't answer: a hung settings read keeps the last choice", async () => {
    expect(await bounded(new Promise<number>(() => undefined), 5, 7)).toBe(7);
    expect(await bounded(Promise.reject(new Error("x")), 50, 7)).toBe(7);
    expect(await bounded(Promise.resolve(1), 50, 7)).toBe(1);
    const sampler = new IncidentSampler();
    let hang = false;
    const loop = new GuardLoop({ sampler, tail: new DaemonLogTail("/x", emptyLog), now: () => sampler.minute * MINUTE, readSettings: () => (hang ? new Promise(() => undefined) : Promise.resolve({ autoStopRunaways: true })) });
    await loop.tick();
    expect(loop.state().autoGuard.enabled).toBe(true);
    hang = true;
    sampler.minute = 1;
    const started = Date.now();
    await loop.tick();
    expect(Date.now() - started).toBeLessThan(6000);
    expect(loop.state().autoGuard.enabled).toBe(true);
  }, 10_000);

  it("with the guard on: one stop after a minute of critical memory, then a cooldown", async () => {
    const sampler = new IncidentSampler();
    const stopped: number[] = [];
    let seen: string | null = null;
    const loop = new GuardLoop({
      sampler, tail: new DaemonLogTail("/x", emptyLog), now: () => sampler.minute * MINUTE,
      readSettings: async () => ({ autoStopRunaways: true }),
      autoStop: async (minPercent) => { stopped.push(sampler.minute); expect(minPercent).toBe(10); return { at: sampler.minute * MINUTE, pid: 77, name: "app-file-ops.test", rssBytes: 36 * GB, message: "Hosts stopped a test run (app-file-ops.test, 36 GB) because memory was nearly full." }; },
      onAutoStop: (stop) => { seen = stop.message; },
    });
    for (sampler.minute = 0; sampler.minute <= 27; sampler.minute += 1) await loop.tick();
    // Critical from minute 24; more than 60 s later is minute 25; the cooldown (90 s) skips 26 and allows 27.
    expect(stopped).toEqual([25, 27]);
    expect(seen).toContain("because memory was nearly full");
    expect(loop.state().autoGuard.last?.pid).toBe(77);
    expect(loop.growthOf(77, "5000")).toBeGreaterThan(3 * GB);
  });
});

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

const PLUGIN = "/opt/npm-global/lib/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js";

describe("the auto-guard only stops what a person could stop", () => {
  async function manager(processes: ReturnType<typeof proc>[]) {
    const adapter = new FakeAdapter();
    adapter.sample = { ...adapter.sample, memoryTotalBytes: 64 * GB, memoryAvailableBytes: 2 * GB };
    adapter.processes = [
      proc({ pid: 1, ppid: 0, uid: 0, argv: ["/sbin/init"] }),
      proc({ pid: 100, ppid: 1, argv: ["Paseo Daemon"], comm: "Paseo Daemon", rssBytes: 300 * MB }),
      proc({ pid: 200, ppid: 100, argv: ["/usr/local/bin/node", PLUGIN] }),
      ...processes,
    ];
    const clock = new FakeClock();
    const kills: Array<[number, string]> = [];
    const monitor = createMonitorHandlers({ adapter, uid: 1000, home: "/home/alice", selfPid: 200, parentPid: 100, clock });
    dir = await mkdtemp(join(tmpdir(), "daemon-link-guard-"));
    const log = new ActionLog(join(dir, "actions.jsonl"), () => undefined);
    const timers: Array<() => void> = [];
    const pm = new ProcessManager({ ...monitor.internals!, daemonPid: 100, log, clock, kill: (pid, signal) => { kills.push([pid, signal]); }, setTimer: (fn) => { timers.push(fn); return timers.length; } });
    return { pm, kills, log, adapter };
  }

  it("skips agents, plugin children and databases, and stops the biggest stoppable job", async () => {
    const { pm, kills, log } = await manager([
      proc({ pid: 300, ppid: 100, argv: ["claude"], comm: "claude", rssBytes: 30 * GB }),
      proc({ pid: 301, ppid: 200, argv: ["node", "plugin-helper.js"], rssBytes: 25 * GB }),
      proc({ pid: 302, ppid: 1, argv: ["postgres", "-D", "/var/lib/postgres"], comm: "postgres", rssBytes: 20 * GB }),
      proc({ pid: 303, ppid: 100, argv: ["node", "--test", "scripts/app-file-ops.test.mjs"], cwd: "/tmp/scratch", rssBytes: 18 * GB }),
      proc({ pid: 304, ppid: 100, argv: ["node", "build.js"], cwd: "/tmp/scratch", rssBytes: 8 * GB }),
    ]);
    const stop = await pm.autoStopBiggest(10);
    expect(stop).toMatchObject({ pid: 303, message: "Hosts stopped a test run (app-file-ops.test, 18 GB) because memory was nearly full." });
    expect(kills).toEqual([[303, "SIGTERM"]]);
    const entries = await log.recent(5);
    expect(entries[0]).toMatchObject({ action: "auto-stop", source: "guard", pid: 303, status: "signaled" });
  });

  it("words the Processes report's runaway the same way, with Stop when it may be stopped", async () => {
    const { pm } = await manager([proc({ pid: 303, ppid: 100, argv: ["node", "--test", "scripts/app-file-ops.test.mjs"], cwd: "/tmp/scratch", rssBytes: 36 * GB })]);
    const report = await pm.report({ limit: 50 }, async () => []);
    const runaway = report.runaways.find((item) => item.code === "memory-heavy");
    expect(runaway).toMatchObject({ severity: "critical", pids: [303], stoppable: true, title: "A test run is using 36 GB, 56% of this computer's memory. The computer will slow to a crawl soon." });
    expect(report.processes.find((row) => row.pid === 303)?.flags).toContainEqual({ code: "memory-heavy", text: "Uses 36 GB, 56% of this computer's memory" });
  });

  it("stops nothing when only protected processes, or only small ones, hold the memory", async () => {
    const protectedOnly = await manager([
      proc({ pid: 300, ppid: 100, argv: ["claude"], comm: "claude", rssBytes: 30 * GB }),
      proc({ pid: 305, ppid: 1, argv: ["node", "outside.js"], cwd: "/tmp/elsewhere", rssBytes: 30 * GB }),
      proc({ pid: 304, ppid: 100, argv: ["node", "build.js"], cwd: "/tmp/scratch", rssBytes: 2 * GB }),
    ]);
    expect(await protectedOnly.pm.autoStopBiggest(10)).toBeNull();
    expect(protectedOnly.kills).toEqual([]);
  });
});

describe("the verdict carries plugin health, pressure and automatic stops", () => {
  const guard = (overrides: Partial<GuardState> = {}): GuardState => ({
    checkedAt: 1000, logReadable: true, slowPluginRequests: 12,
    plugins: [{ id: "activity", name: "Activity", timeouts: 30, windowMinutes: 10, lastAt: 900, stopping: false, severity: "critical", restartable: true, reason: null }],
    memory: { level: "critical", some10: 91, full10: 84, percent: 99, criticalSince: 500, sentence: "Memory is nearly full: programs are stalled waiting for memory 84% of the time." },
    autoGuard: { enabled: true, last: { at: 900, pid: 77, name: "app-file-ops.test", rssBytes: 36 * GB, message: "Hosts stopped a test run (app-file-ops.test, 36 GB) because memory was nearly full." } },
    ...overrides,
  });
  const snapshot = { services: [], processes: [], scope: { status: "ready" as const, message: "", projects: [] }, supported: true, cpu: { pressure: "normal" as const }, memory: { pressure: "normal" as const } };

  it("says which plugin isn't answering, offers Restart, and tells the dot about an automatic stop", () => {
    const { verdict } = evaluateHealth({ now: 1000, snapshot: snapshot as never, tunnels: [], connections: [], profiles: [], background: true, guard: guard() });
    HealthVerdictSchema.parse(verdict);
    expect(verdict.status).toBe("critical");
    expect(verdict.issues.find((issue) => issue.code === "plugin-stuck")).toMatchObject({ message: "Activity isn't answering (30 timeouts in 10 min).", plugin: "activity", restartable: true, severity: "critical", scope: "host" });
    expect(verdict.issues.find((issue) => issue.code === "memory-pressure")).toMatchObject({ severity: "critical", message: expect.stringContaining("84% of the time") });
    expect(verdict.issues.find((issue) => issue.code === "auto-stopped")).toMatchObject({ message: expect.stringContaining("because memory was nearly full"), pid: 77 });
    // The automatic-stop notice fades after half an hour.
    const later = evaluateHealth({ now: 900 + 31 * MINUTE, snapshot: snapshot as never, tunnels: [], connections: [], profiles: [], background: true, guard: guard({ memory: { ...guard().memory, level: "normal", sentence: null } }) }).verdict;
    expect(later.issues.some((issue) => issue.code === "auto-stopped")).toBe(false);
  });

  it("words a plugin stuck stopping, and an unrestartable host", () => {
    const plugins = [{ id: "paseo-mcp", name: "Paseo MCP", timeouts: 0, windowMinutes: 10, lastAt: 1, stopping: true, severity: "critical" as const, restartable: false, reason: "Restart needs the paseo command." }];
    const { verdict } = evaluateHealth({ now: 1000, snapshot: snapshot as never, tunnels: [], connections: [], profiles: [], background: true, guard: guard({ plugins, autoGuard: { enabled: false, last: null }, memory: { ...guard().memory, level: "normal", sentence: null } }) });
    expect(verdict.issues).toEqual([expect.objectContaining({ code: "plugin-stuck", message: expect.stringContaining("began stopping and never finished"), restartable: false, restartReason: "Restart needs the paseo command." })]);
  });

  it("passes a runaway's stoppable flag through for the Stop button", () => {
    const report = { runaways: [{ code: "memory-heavy" as const, severity: "critical" as const, title: "A test run is using 36 GB, 61% of this computer's memory. The computer will slow to a crawl soon.", pids: [77], cwd: "/tmp/x", stoppable: true }], container: null, host: { cores: 8, cpuPercent: 10, load1: 1, memoryTotalBytes: 64 * GB, memoryUsedBytes: 60 * GB, cpuPressure: "normal" as const, memoryPressure: "critical" as const }, memoryBasis: "machine" as const, memoryBasisBytes: 64 * GB, heavyJobs: { count: 1, limit: 4, pids: [77] } };
    const { verdict } = evaluateHealth({ now: 1000, snapshot: snapshot as never, tunnels: [], connections: [], profiles: [], background: true, report });
    expect(verdict.issues.find((issue) => issue.code === "runaway")).toMatchObject({ pid: 77, stoppable: true, subject: "A test run", severity: "critical" });
  });
});
