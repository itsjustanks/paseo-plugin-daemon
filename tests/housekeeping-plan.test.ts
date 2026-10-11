import { describe, expect, it } from "vitest";
import { ancestorsIn, handover, planReap, planRenice, planTurbo, profileInUse, profileOf, qualifiesNow, raisedNice, sameTarget, stillPlanned, type HkProcess, type OwnerKind } from "../server/housekeeping-plan";
import { housekeepingWorkspaces, parseWorkspaceList } from "../server/runtime";
import { CliOwners, parseInspect } from "../server/housekeeping-owners";
import { HOUSEKEEPING_DEFAULTS, HousekeepingSettingsSchema, stateWords } from "../shared/housekeeping";

import { A, B, PROFILE, proc } from "./housekeeping-fixture";
const table = (processes: HkProcess[], complete = true) => ({ processes, complete });
const ctx = { uid: 1000, protectedPids: new Set<number>(), browserMaxAgeHours: 6, stuckQueryMaxHours: 2 };
const owners = (kind: OwnerKind = "closed") => new Map([[A, kind]]);

describe("housekeeping decisions", () => {
  it("defaults new and migrated installs to enabled preview and bounds every numeric policy", () => {
    expect(HOUSEKEEPING_DEFAULTS).toEqual({ enabled: true, dryRun: true, reniceIntervalMinutes: 1, reapIntervalMinutes: 60, turboIntervalHours: 24, browserMaxAgeHours: 6, stuckQueryMaxHours: 2, turboCacheMaxDays: 7, heavyNice: 10, browserNice: 5 });
    expect(HousekeepingSettingsSchema.safeParse({ reapIntervalMinutes: 4 }).success).toBe(false);
    for (const key of ["reniceIntervalMinutes", "reapIntervalMinutes", "turboIntervalHours", "browserMaxAgeHours", "stuckQueryMaxHours", "turboCacheMaxDays", "heavyNice", "browserNice"]) for (const value of [0, -1, 1.5, 10000]) expect(HousekeepingSettingsSchema.safeParse({ [key]: value }).success).toBe(false);
    for (const state of ["unsupported", "off", "starting", "preview", "live", "passive", "blocked"] as const) expect(stateWords({ state, message: "" }).title.length).toBeGreaterThan(0);
  });
  it("retains missing raw SDK and CLI activity metadata as unknown", () => {
    expect(housekeepingWorkspaces([{ id: A, workspaceDirectory: "/site", status: "idle" }])[0]?.devServers).toEqual(["Service state unknown"]);
    expect(parseWorkspaceList(JSON.stringify([{ workspaceId: A, cwd: "/site" }]))?.[0]).toMatchObject({ status: null, devServers: ["Service state unknown"] });
  });
  it("only authorizes closed or validated archived owners; age never authorizes idle/running/unknown", () => {
    for (const kind of ["running", "idle", "unknown"] as const) expect(planReap(table([proc()]), owners(kind), ctx).targets).toEqual([]);
    for (const kind of ["closed", "archived"] as const) expect(planReap(table([proc()]), owners(kind), ctx).targets.map((t) => t.pid)).toEqual([40]);
    expect(planReap(table([proc()], false), owners(), ctx).targets).toEqual([]);
    for (const patch of [{ uid: 1001 }, { agentId: null }, { exe: null }, { exe: "/bin/bash" }]) expect(planReap(table([proc(patch)]), owners(), ctx).targets).toEqual([]);
    expect(planReap(table([proc()]), owners(), { ...ctx, protectedPids: new Set([40]) }).targets).toEqual([]);
  });
  it("authorizes every session member individually and refuses mixed or missing tags", () => {
    const child = proc({ pid: 41, ppid: 40, argv: ["chrome", "--type=renderer"] });
    const plan = planReap(table([proc(), child]), owners(), ctx);
    expect(plan.targets.map((t) => t.pid)).toEqual([40, 41]);
    expect(plan.profiles).toEqual([{ path: PROFILE, agentId: A }]);
    for (const agentId of [B, null]) expect(planReap(table([proc(), { ...child, agentId }]), owners(), ctx).targets).toEqual([]);
    expect(profileOf([`--user-data-dir=${PROFILE}-extra`])).toBe("conflict");
    expect(profileOf([PROFILE, `/tmp/agent-browser-chrome-${B}`])).toBe("conflict");
    expect(profileOf([`--database=${PROFILE}/Crashpad`])).toBe(PROFILE);
    expect(profileInUse(table([], false), PROFILE)).toBe(true);
    expect(profileInUse(table([proc({ argv: [], cwd: PROFILE + "/cache" })]), PROFILE)).toBe(true);
  });
  it("has a narrow browser exception while refusing live agent/plugin/service ancestry", () => {
    for (const [exe, argv] of [["/usr/bin/codex", ["codex"]], ["/usr/bin/node", ["node", "/opt/paseo/plugin-process.js"]], ["/usr/bin/postgres", ["postgres"]]] as const) {
      const parent = proc({ pid: 39, exe, argv: [...argv], comm: exe.split("/").pop()! });
      expect(planReap(table([parent, proc({ ppid: 39 })]), owners(), ctx).targets).toEqual([]);
    }
    expect(planReap(table([proc({ ppid: 39 })]), owners(), ctx).targets).toEqual([]);
    expect(ancestorsIn(proc({ ppid: 40 }), new Map([[40, proc({ ppid: 40 })]]))).toBeNull();
  });
  it("requires finished ownership for daemons, crashpad and old orphan Supabase queries", () => {
    const daemon = proc({ exe: "/opt/agent-browser", argv: ["agent-browser"], browserDaemon: true });
    const crash = proc({ exe: "/opt/chrome_crashpad_handler", argv: ["chrome_crashpad_handler"] });
    const query = proc({ exe: "/opt/supabase", argv: ["supabase", "db", "query"], ageSeconds: 7201 });
    for (const p of [daemon, crash, query]) {
      expect(planReap(table([p]), owners(), ctx).targets).toHaveLength(1);
      expect(planReap(table([p]), owners("idle"), ctx).targets).toEqual([]);
      expect(planReap(table([{ ...p, agentId: null }]), owners(), ctx).targets).toEqual([]);
    }
    for (const patch of [{ ppid: 39 }, { ageSeconds: 7199 }, { argv: ["supabase", "db", "reset"] }]) expect(planReap(table([{ ...query, ...patch }]), owners(), ctx).targets).toEqual([]);
    const target = planReap(table([query]), owners(), ctx).targets[0]!;
    expect(qualifiesNow(query, [], target, { uid: 1000, stuckQueryMaxHours: 10 })).toBe(false);
    expect(sameTarget({ ...query, startId: "reused" }, target, 1000)).toBe(false);
    expect(stillPlanned([target], planReap(table([{ ...query, agentId: B }]), owners(), ctx))).toEqual([]);
  });
  it("renices matching executable families only, same UID, and only toward gentler nice", () => {
    const build = proc({ exe: "/usr/bin/node", argv: ["node", "typescript/bin/tsc"] });
    const p = planRenice(table([build, proc({ pid: 41 })]), { uid: 1000, protectedPids: new Set(), heavyNice: 10, browserNice: 5 });
    expect(p.map((t) => [t.pid, t.target])).toEqual([[40, 10], [41, 5]]);
    for (const patch of [{ uid: 1001 }, { nice: 12 }, { exe: "/usr/bin/codex" }, { exe: "/usr/bin/bash" }, { argv: ["node", "/opt/paseo/plugin-process.js", "bin/tsc"] }]) expect(planRenice(table([{ ...build, ...patch }]), { uid: 1000, protectedPids: new Set(), heavyNice: 10, browserNice: 5 })).toEqual([]);
    expect(raisedNice(15, 10)).toBeNull();
    expect(raisedNice(0, 30)).toBe(19);
  });
  it("selects old owned single-link regular Turbo files only and keeps exact-cutoff entries", () => {
    const now = 20 * 86400_000;
    const entry = { name: "a".repeat(16) + ".tar.zst", isFile: true, isSymlink: false, uid: 1000, nlink: 1, mtimeMs: 0, size: 1 };
    expect(planTurbo([entry], now, 7, 1000).remove).toEqual([entry]);
    for (const patch of [{ name: ".env" }, { name: "index.ts" }, { isSymlink: true }, { isFile: false }, { uid: 1001 }, { nlink: 2 }, { mtimeMs: now - 7 * 86400_000 }]) expect(planTurbo([{ ...entry, ...patch }], now, 7, 1000).remove).toEqual([]);
    expect(handover({ kind: "held" }).run).toBe(true);
    for (const kind of ["busy", "missing-flock", "unsafe", "failed"] as const) expect(handover({ kind, reason: "test" }).run).toBe(false);
  });
});

describe("fresh CLI owner answers", () => {
  const inspect = (patch: Record<string, unknown>) => JSON.stringify({ Id: A, Status: "idle", Archived: false, ArchivedAt: null, ...patch });
  it("accepts the actual Paseo 0.11.1 archive shape, while refusing contradictions and live idle", () => {
    expect(parseInspect(A, inspect({ Archived: true, ArchivedAt: "2026-10-11T01:00:00Z" }))).toBe("archived");
    expect(parseInspect(A, inspect({ Status: "closed" }))).toBe("closed");
    expect(parseInspect(A, inspect({}))).toBe("idle");
    expect(parseInspect(A, inspect({ Status: "initializing" }))).toBe("running");
    for (const patch of [{ Id: B }, { Archived: true }, { Archived: true, ArchivedAt: "bad" }, { ArchivedAt: "2026-10-11" }, { Archived: true, ArchivedAt: "2026-10-11", Status: "running" }]) expect(parseInspect(A, inspect(patch))).toBe("unknown");
    expect(parseInspect(A, "bad")).toBe("unknown");
  });
  it("uses no shell, keeps failed lookups unknown, deduplicates and cancels answers", async () => {
    const calls: unknown[] = [];
    const control = new AbortController();
    const lookup = new CliOwners({ resolve: async () => "/opt/paseo" }, async (file, args) => { calls.push([file, args]); return { code: 0, stdout: inspect({ Status: "closed" }) }; });
    expect((await lookup.lookup([A, A], control.signal)).get(A)).toBe("closed");
    expect(calls).toEqual([["/opt/paseo", ["inspect", A, "--json"]]]);
    const failed = new CliOwners({ resolve: async () => "/opt/paseo" }, async () => { throw new Error("timeout"); });
    expect((await failed.lookup([A], control.signal)).get(A)).toBe("unknown");
    control.abort();
    expect((await lookup.lookup([A], control.signal)).get(A)).toBe("unknown");
    expect(calls).toHaveLength(1);
  });
});
