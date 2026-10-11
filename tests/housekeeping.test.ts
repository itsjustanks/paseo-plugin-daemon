import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Housekeeper, abortableSleep, CYCLE_BUDGET_MS, TERM_WAIT_MS, type HousekeeperDeps } from "../server/housekeeping";
import { NO_RUNS } from "../server/housekeeping-log";
import { HOUSEKEEPING_DEFAULTS, type HousekeepingEntry, type HousekeepingSettings } from "../shared/housekeeping";
import type { HkProcess, OwnerKind, ProcTable } from "../server/housekeeping-plan";
import { A, PROFILE, proc } from "./housekeeping-fixture";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup(rows: HkProcess[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "hosts-hk-test-")); dirs.push(dir);
  let settings: HousekeepingSettings | null = { ...HOUSEKEEPING_DEFAULTS, dryRun: false };
  let processes = rows, owner: OwnerKind = "closed";
  const logs: HousekeepingEntry[] = [], effects: string[] = [];
  const deps: HousekeeperDeps = {
    platform: "linux", uid: 1000, selfPid: 999,
    readSettings: async () => settings,
    procs: { scan: async () => ({ processes, complete: true }), read: async (pid) => processes.find((p) => p.pid === pid) ?? null },
    owners: { lookup: async (ids) => new Map(ids.map((id) => [id, owner])) },
    lock: async () => ({ outcome: { kind: "held" }, release: async () => { effects.push("release"); } }),
    log: { append: async (entry) => { logs.push(entry); }, recent: async () => logs.slice(-20).reverse(), runs: async () => ({ ...NO_RUNS }), saveRuns: async () => {} },
    workspaces: async () => [], places: { home: join(dir, "home"), paseoHome: join(dir, "paseo"), stateDir: join(dir, "state"), tmpRoots: [] }, helpersDir: dir,
    privateProfile: async () => true,
    removeProfile: async (_path, check) => { const why = await check(); if (!why) effects.push("profile"); return { ok: !why, why }; },
    renice: (pid, nice) => { effects.push(`nice:${pid}:${nice}`); },
    kill: (pid, signal) => { effects.push(`${signal}:${pid}`); },
    sleep: async (ms) => { effects.push(`sleep:${ms}`); return true; },
  };
  // Existing files make the real helper writer passive unless a test explicitly removes one.
  await Promise.all(["gate.sh", "heavy-run.sh"].map((name) => writeFile(join(dir, name), "existing")));
  return { dir, deps, logs, effects, get settings() { return settings; }, set settings(value) { settings = value; }, get processes() { return processes; }, set processes(value) { processes = value; }, set owner(value: OwnerKind) { owner = value; } };
}
const build = (pid: number) => proc({ pid, exe: "/usr/bin/node", argv: ["node", "typescript/bin/tsc"] });

describe("housekeeping cycle authority", () => {
  it("reports that a bounded workspace pass can leave later folders unexamined", async () => {
    const f = await setup(); f.settings = { ...HOUSEKEEPING_DEFAULTS };
    f.deps.workspaces = async () => Array.from({ length: 17 }, (_, i) => ({ name: `project-${i}`, directory: join(f.dir, `project-${i}`), status: "idle", devServers: [] }));
    const hk = new Housekeeper(f.deps); await hk.tick();
    expect((await hk.status()).lastRuns.turbo?.summary).toContain("Scan limit reached; later passes may revisit");
    expect(f.effects).toEqual(["release"]);
  });
  it("preview records decisions and never renices, signals, deletes or creates helpers", async () => {
    const f = await setup([proc(), build(41)]); f.settings = { ...HOUSEKEEPING_DEFAULTS };
    await rm(join(f.dir, "gate.sh"));
    const hk = new Housekeeper(f.deps); await hk.tick();
    expect(f.effects).toEqual(["release"]);
    expect(f.logs.some((line) => line.job === "renice" && line.outcome === "preview")).toBe(true);
    expect(f.logs.some((line) => line.job === "reap" && line.outcome === "preview")).toBe(true);
    await expect(readFile(join(f.dir, "gate.sh"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await hk.status()).state).toBe("preview");
  });
  it("uses configured elapsed schedules and re-evaluates a changed interval", async () => {
    const f = await setup([build(41)]);
    f.settings = { ...HOUSEKEEPING_DEFAULTS, reniceIntervalMinutes: 5, reapIntervalMinutes: 15, turboIntervalHours: 2 };
    let now = 1_000_000; f.deps.now = () => now;
    const hk = new Housekeeper(f.deps); await hk.tick();
    const first = (await hk.status()).lastRuns;
    now += 60_000; await hk.tick();
    expect((await hk.status()).lastRuns.renice?.at).toBe(first.renice?.at);
    expect((await hk.status()).lastRuns.helpers?.at).toBe(now);
    now += 4 * 60_000; await hk.tick();
    expect((await hk.status()).lastRuns.renice?.at).toBe(now);
    expect((await hk.status()).lastRuns.reap?.at).toBe(first.reap?.at);
    now += 10 * 60_000; await hk.tick();
    expect((await hk.status()).lastRuns.reap?.at).toBe(now);
    expect((await hk.status()).lastRuns.turbo?.at).toBe(first.turbo?.at);
    now += 105 * 60_000; await hk.tick();
    expect((await hk.status()).lastRuns.turbo?.at).toBe(now);
    f.settings = { ...f.settings, reniceIntervalMinutes: 1 };
    now += 60_000; await hk.settingsChanged(); await hk.tick();
    expect((await hk.status()).lastRuns.renice?.at).toBe(now);
  });
  it("is passive with a busy handover lock and unsupported on macOS", async () => {
    const f = await setup([proc()]); f.deps.lock = async () => ({ outcome: { kind: "busy" }, release: async () => { f.effects.push("release"); } });
    const hk = new Housekeeper(f.deps); await hk.tick();
    expect(f.effects).toEqual(["release"]); expect((await hk.status()).state).toBe("passive");
    f.deps.platform = "darwin"; f.deps.readSettings = vi.fn(async () => f.settings);
    const mac = new Housekeeper(f.deps); mac.start(); await mac.tick(); await mac.close();
    expect(f.deps.readSettings).not.toHaveBeenCalled();
    expect((await mac.status()).state).toBe("unsupported");
  });
  it.each(["off", "preview", "threshold", "schedule", "unreadable"])("checks fresh settings between main-PID renices: %s", async (change) => {
    const f = await setup([build(40), build(41)]);
    f.deps.renice = (pid, nice) => {
      f.effects.push(`nice:${pid}:${nice}`);
      f.settings = change === "unreadable" ? null : { ...f.settings!, ...(change === "off" ? { enabled: false } : change === "preview" ? { dryRun: true } : change === "schedule" ? { reniceIntervalMinutes: 5 } : { heavyNice: 19 }) };
    };
    const hk = new Housekeeper(f.deps); await hk.tick();
    expect(f.effects.filter((s) => s.startsWith("nice:"))).toEqual(["nice:40:10"]);
    expect(f.effects.at(-1)).toBe("release");
  });
  it.each(["nice", "pid", "program"])("re-reads current nice, start identity and program after async policy work: %s", async (change) => {
    const f = await setup([build(40)]);
    f.deps.procs.read = async () => ({ ...build(40), ...(change === "nice" ? { nice: 19 } : change === "pid" ? { startId: "new" } : { exe: "/usr/bin/codex", argv: ["codex"] }) });
    await new Housekeeper(f.deps).tick();
    expect(f.effects.some((s) => s.startsWith("nice:"))).toBe(false);
  });
  it("rechecks ownership before each TERM and only KILLs verified survivors after one common grace period", async () => {
    const f = await setup([proc(), proc({ pid: 41, ppid: 40, argv: ["chrome", "--type=renderer"] })]);
    f.deps.kill = (pid, signal) => { f.effects.push(`${signal}:${pid}`); if (signal === "SIGTERM" && pid === 40) f.owner = "running"; };
    await new Housekeeper(f.deps).tick();
    expect(f.effects.filter((s) => s.startsWith("SIG"))).toEqual(["SIGTERM:40"]);
    expect(f.effects).toContain(`sleep:${TERM_WAIT_MS}`);
    expect(f.logs.some((l) => l.why.startsWith("Stop requested; exit not confirmed"))).toBe(true);
    expect(f.logs.some((l) => l.why.startsWith("Verified exit"))).toBe(false);
  });
  it("TERMs all targets, waits three seconds once, and verifies every forced survivor", async () => {
    const f = await setup([proc({ nice: 5 }), proc({ pid: 41, nice: 5 })]);
    f.deps.kill = (pid, signal) => { f.effects.push(`${signal}:${pid}`); if (signal === "SIGKILL") f.processes = f.processes.filter((p) => p.pid !== pid); };
    await new Housekeeper(f.deps).tick();
    expect(f.effects.filter((s) => /^(SIG|sleep:3000)/.test(s))).toEqual(["SIGTERM:40", "SIGTERM:41", "sleep:3000", "SIGKILL:40", "SIGKILL:41"]);
    expect(f.logs.some((l) => l.why.startsWith("Verified exit"))).toBe(true);
    expect(f.effects).toContain("profile");
  });
  it("refuses a newly protected ancestor between targets even if the leaf identity stays the same", async () => {
    const f = await setup([proc({ nice: 5 }), proc({ pid: 41, ppid: 39, nice: 5 }), proc({ pid: 39, exe: "/bin/bash", comm: "bash", argv: ["bash"], agentId: null })]);
    f.deps.kill = (pid, signal) => { f.effects.push(`${signal}:${pid}`); if (signal === "SIGTERM") f.processes = f.processes.map((p) => p.pid === 39 ? { ...p, exe: "/usr/bin/codex", comm: "codex", argv: ["codex"] } : p); };
    await new Housekeeper(f.deps).tick();
    expect(f.effects.some((s) => s.endsWith(":41") && s.startsWith("SIG"))).toBe(false);
  });
  it("refuses PID reuse and incomplete scans on the final signal path", async () => {
    const f = await setup([proc({ nice: 5 })]);
    f.deps.procs.read = async () => proc({ startId: "reused", nice: 5 });
    await new Housekeeper(f.deps).tick();
    expect(f.effects.some((s) => s.startsWith("SIG"))).toBe(false);
    f.deps.procs.scan = async () => ({ complete: false, processes: [proc()] });
    await new Housekeeper(f.deps).tick();
    expect(f.effects.some((s) => s.startsWith("SIG"))).toBe(false);
  });
  it("cancellation invalidates authority during the grace wait and holds the lock until work settles", async () => {
    const f = await setup([proc({ nice: 5 })]);
    let entered!: () => void, releaseWait!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    f.deps.sleep = async (_ms, signal) => { entered(); await new Promise<void>((resolve) => { releaseWait = resolve; }); return !signal.aborted; };
    const hk = new Housekeeper(f.deps); const tick = hk.tick(); await waiting;
    f.settings = { ...f.settings!, enabled: false }; await hk.settingsChanged();
    expect(f.effects).not.toContain("release");
    releaseWait(); await tick; await hk.close();
    expect(f.effects.filter((s) => s.startsWith("SIG"))).toEqual(["SIGTERM:40"]);
    expect(f.effects.at(-1)).toBe("release");
  });
  it("unload is bounded even with an unresponsive read; a late answer cannot act", async () => {
    vi.useFakeTimers();
    const f = await setup([proc()]); let resolve!: (table: ProcTable) => void;
    f.deps.procs.scan = () => new Promise((done) => { resolve = done; });
    const hk = new Housekeeper(f.deps); const tick = hk.tick();
    for (let i = 0; i < 20 && !resolve; i++) await Promise.resolve();
    const close = hk.close(); await vi.advanceTimersByTimeAsync(10_000); await close;
    expect(f.effects).not.toContain("release");
    resolve({ processes: [proc()], complete: true }); await tick;
    expect(f.effects.filter((s) => /^(SIG|nice:)/.test(s))).toEqual([]);
    expect(f.effects.at(-1)).toBe("release");
  });
  it("requires a fresh complete profile-unused scan and fresh finished ownership before removal", async () => {
    const f = await setup([proc({ nice: 5 })]);
    f.deps.kill = (pid) => { f.processes = f.processes.filter((p) => p.pid !== pid); };
    f.deps.removeProfile = async (_path, check) => { f.processes = [proc({ pid: 60, agentId: null, argv: ["tool", PROFILE + "/cache"], exe: "/bin/tool" })]; const why = await check(); expect(why).toContain("still uses"); return { ok: false, why }; };
    await new Housekeeper(f.deps).tick();
    expect(f.logs.some((l) => l.why.includes("profile was kept"))).toBe(true);
  });
  it.each([null, "running", "attention"])("unknown and active workspace state is never idle delete authority: %s", async (status) => {
    const f = await setup(); f.deps.workspaces = async () => [{ name: "site", directory: join(f.dir, "site"), status, devServers: [] }];
    await mkdir(join(f.dir, "site", ".turbo", "cache"), { recursive: true });
    const entry = join(f.dir, "site", ".turbo", "cache", "a".repeat(16) + ".tar"); await writeFile(entry, "cache"); await utimes(entry, 0, 0);
    // Match the fixture files' actual UID without ever operating on any live processes.
    f.deps.uid = process.getuid!();
    await new Housekeeper(f.deps).tick();
    expect(await readFile(entry, "utf8")).toBe("cache");
  });
  it("revalidates broad custom-build activity before each bounded cache batch", async () => {
    const f = await setup(); f.deps.uid = process.getuid!();
    const root = join(f.dir, "site"), cache = join(root, ".turbo", "cache"); await mkdir(cache, { recursive: true });
    for (let i = 0; i < 20; i++) { const path = join(cache, i.toString(16).padStart(16, "0") + ".tar"); await writeFile(path, "cache"); await utimes(path, 0, 0); }
    let reads = 0;
    f.deps.workspaces = async () => {
      if (++reads === 3) f.processes = [proc({ uid: f.deps.uid, exe: "/usr/bin/node", argv: ["node", "scripts/build.js"], cwd: await realpath(root) })];
      return [{ name: "site", directory: root, status: "idle", devServers: [] }];
    };
    await new Housekeeper(f.deps).tick();
    expect(reads).toBe(3);
    expect(f.logs.find((l) => l.job === "turbo" && l.bytes)?.count).toBe(16);
    expect(f.logs.some((l) => l.job === "turbo" && l.why.includes("next batch"))).toBe(true);
  });
  it("invalidates action authority at the whole-cycle time budget before releasing the lock", async () => {
    vi.useFakeTimers(); const f = await setup([proc({ nice: 5 })]);
    f.deps.sleep = (ms, signal) => abortableSleep(ms === TERM_WAIT_MS ? 60_000 : ms, signal);
    const hk = new Housekeeper(f.deps), tick = hk.tick();
    await vi.advanceTimersByTimeAsync(CYCLE_BUDGET_MS); await tick;
    expect(f.effects.filter((s) => s.startsWith("SIG"))).toEqual(["SIGTERM:40"]);
    expect(f.effects.at(-1)).toBe("release");
    expect((await hk.status()).lastRuns.reap?.summary).toContain("45-second");
  });
  it("checks an ancestor that execs an agent CLI during a slow owner lookup before TERM", async () => {
    const f = await setup([proc({ ppid: 39, nice: 5 }), proc({ pid: 39, exe: "/bin/bash", argv: ["bash"], agentId: null })]);
    let calls = 0;
    f.deps.owners.lookup = async (ids) => {
      if (++calls === 3) f.processes = f.processes.map((p) => p.pid === 39 ? { ...p, exe: "/usr/bin/codex", argv: ["codex"] } : p);
      return new Map(ids.map((id) => [id, "closed" as const]));
    };
    await new Housekeeper(f.deps).tick();
    expect(f.effects.some((s) => s.startsWith("SIG"))).toBe(false);
  });
  it("KILLs only successfully TERM-bound renderers after their named parent exits", async () => {
    const f = await setup([proc({ nice: 5 }), proc({ pid: 41, ppid: 40, nice: 5, argv: ["chrome", "--type=renderer"] })]);
    f.deps.sleep = async () => { f.processes = f.processes.filter((p) => p.pid !== 40).map((p) => ({ ...p, ppid: 1 })); return true; };
    await new Housekeeper(f.deps).tick();
    expect(f.effects.filter((s) => s.startsWith("SIG"))).toEqual(["SIGTERM:40", "SIGTERM:41", "SIGKILL:41"]);
  });
  it("abortable sleep resolves promptly on cancellation", async () => {
    const control = new AbortController(); const sleep = abortableSleep(60_000, control.signal); control.abort(); expect(await sleep).toBe(false);
    expect(await abortableSleep(60_000, control.signal)).toBe(false);
  });
});
