import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProcessGuard, descendants, identityOf, protectedSet } from "../safety.server";
import { hashArgv } from "../redaction.server";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

const SELF = 500;
const DAEMON = 400;
const SUPERVISOR = 300;
const LAUNCHER = 200;

function setup() {
  const adapter = new FakeAdapter();
  const clock = new FakeClock();
  const kills: Array<[number, string]> = [];
  const kill = (pid: number, signal: string) => {
    const target = adapter.processes.find((p) => p.pid === pid);
    if (!target) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    kills.push([pid, signal]);
  };
  adapter.processes = [
    proc({ pid: LAUNCHER, ppid: 1, argv: ["node", "paseo", "start"] }),
    proc({ pid: SUPERVISOR, ppid: LAUNCHER, argv: ["Paseo Supervisor"] }),
    proc({ pid: DAEMON, ppid: SUPERVISOR, argv: ["Paseo Daemon"] }),
    proc({ pid: SELF, ppid: DAEMON, argv: ["node", "plugin-process.js"] }),
    proc({ pid: 900, ppid: 1, argv: ["bash"], comm: "bash" }),
    proc({ pid: 901, ppid: 900, argv: ["node", "node_modules/.bin/vite"] }),
    proc({ pid: 902, ppid: 901, argv: ["esbuild", "--service"] }),
    proc({ pid: 903, ppid: 901, argv: ["sudo", "thing"], uid: 0 }),
    proc({ pid: 904, ppid: 903, argv: ["child-of-root"] }),
    proc({ pid: 950, ppid: 1, argv: ["other"], uid: 1001 }),
    proc({ pid: 960, ppid: 900, argv: ["zombie"], state: "zombie" }),
  ];
  const guard = new ProcessGuard({ adapter, uid: 1000, selfPid: SELF, alwaysProtected: [DAEMON], clock, kill, tokenTtlMs: 60_000, gracefulWindowMs: 10_000 });
  const tree = () => new Map(adapter.processes.map((p) => [p.pid, p]));
  const tokenFor = (pid: number) => {
    const target = adapter.processes.find((p) => p.pid === pid)!;
    return guard.mint(target, hashArgv(target.argv));
  };
  return { adapter, clock, kills, guard, tree, tokenFor };
}

describe("protected set and descendants", () => {
  it("protects PID 1, self, every ancestor, and extras", () => {
    const { adapter } = setup();
    const rows = adapter.processes.map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid }));
    const set = protectedSet(rows, SELF, [DAEMON]);
    expect([...set].sort((a, b) => a - b)).toEqual([1, LAUNCHER, SUPERVISOR, DAEMON, SELF]);
  });

  it("walks descendants without crossing other users or protected nodes", () => {
    const { adapter } = setup();
    const rows = adapter.processes.map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid }));
    const set = protectedSet(rows, SELF, [DAEMON]);
    expect(descendants(rows, 900, 1000, set).sort()).toEqual([901, 902, 960]);
    // 903 is root-owned, so 904 (same user but below a root node) is never reached.
    expect(descendants(rows, 901, 1000, set)).toEqual([902]);
    // Cycles do not loop forever.
    expect(descendants([{ pid: 5, ppid: 6, uid: 1 }, { pid: 6, ppid: 5, uid: 1 }], 5, 1, new Set())).toEqual([6]);
  });
});

describe("snapshot-side evaluation", () => {
  it("marks protected and non-actionable processes with reasons", () => {
    const { guard, tree, adapter } = setup();
    const byPid = (pid: number) => adapter.processes.find((p) => p.pid === pid)!;
    expect(guard.evaluate(byPid(901), tree())).toEqual({ actionable: true, reason: null });
    expect(guard.evaluate(byPid(SELF), tree()).reason).toBe("this is Monitor");
    expect(guard.evaluate(byPid(DAEMON), tree()).reason).toMatch(/Paseo/);
    expect(guard.evaluate(byPid(LAUNCHER), tree()).reason).toMatch(/Paseo/);
    expect(guard.evaluate(byPid(903), tree()).reason).toBe("owned by root");
    expect(guard.evaluate(byPid(950), tree()).reason).toBe("owned by another user");
    expect(guard.evaluate(byPid(960), tree()).reason).toMatch(/zombie/);
    expect(guard.evaluate({ pid: 1, uid: 1000, state: "sleeping" }, tree()).reason).toBe("init process");
  });
});

describe("tokens", () => {
  it("round-trips, rejects tampering, foreign keys, and expiry", () => {
    const { guard, clock, tokenFor } = setup();
    const token = tokenFor(901);
    expect(guard.verify(token)).toMatchObject({ pid: 901, uid: 1000, startId: "start-901" });
    expect(token).not.toContain("vite"); // payload carries a hash, not argv
    const [body, sig] = token.split(".");
    const tampered = Buffer.from(body!, "base64url").toString("utf8").replace('"pid":901', '"pid":900');
    expect(guard.verify(`${Buffer.from(tampered).toString("base64url")}.${sig}`)).toBeNull();
    expect(guard.verify(`${body}.${sig!.slice(0, -2)}AA`)).toBeNull();
    expect(guard.verify("garbage")).toBeNull();
    expect(guard.verify("")).toBeNull();
    const other = new ProcessGuard({ adapter: new FakeAdapter(), uid: 1000, selfPid: SELF, key: randomBytes(32) });
    expect(other.verify(token)).toBeNull();
    clock.advance(60_001);
    expect(guard.verify(token)).toBeNull();
  });
});

describe("stop", () => {
  it("SIGTERMs the verified target and its eligible descendants only", async () => {
    const { guard, kills, tokenFor } = setup();
    const result = await guard.stop(tokenFor(901));
    expect(result).toMatchObject({ ok: true, status: "signaled", pid: 901, signaledCount: 2 });
    expect(kills).toEqual([[901, "SIGTERM"], [902, "SIGTERM"]]);
  });

  it("denies a reused PID, uid mismatch, or changed command", async () => {
    const { guard, adapter, kills, tokenFor } = setup();
    const token = tokenFor(901);
    adapter.processes = adapter.processes.map((p) => (p.pid === 901 ? { ...p, startId: "start-later" } : p));
    expect((await guard.stop(token)).status).toBe("denied");
    adapter.processes = adapter.processes.map((p) => (p.pid === 901 ? { ...p, startId: "start-901", uid: 1001 } : p));
    expect((await guard.stop(token)).status).toBe("denied");
    adapter.processes = adapter.processes.map((p) => (p.pid === 901 ? { ...p, uid: 1000, argv: ["node", "something-else"] } : p));
    expect((await guard.stop(token)).status).toBe("denied");
    expect(kills).toEqual([]);
  });

  it("denies protected ancestors, root, other users, and zombies even with a valid token", async () => {
    const { guard, kills, tokenFor } = setup();
    for (const pid of [DAEMON, SUPERVISOR, LAUNCHER, SELF, 903, 950, 960]) {
      const result = await guard.stop(tokenFor(pid));
      expect(result.ok, `pid ${pid}`).toBe(false);
      expect(result.status).toBe("denied");
    }
    expect(kills).toEqual([]);
  });

  it("reports already-exited when the process is gone", async () => {
    const { guard, adapter, tokenFor } = setup();
    const token = tokenFor(901);
    adapter.processes = adapter.processes.filter((p) => p.pid !== 901);
    expect(await guard.stop(token)).toMatchObject({ ok: true, status: "already-exited", pid: 901 });
  });

  it("re-evaluates protection at action time, not snapshot time", async () => {
    const { guard, adapter, kills, tokenFor } = setup();
    const token = tokenFor(901);
    // Monitor's own process is re-parented under 901 (contrived, but the
    // point is that protection uses the fresh tree).
    adapter.processes = adapter.processes.map((p) => (p.pid === SELF ? { ...p, ppid: 901 } : p));
    const result = await guard.stop(token);
    expect(result.status).toBe("denied");
    expect(kills).toEqual([]);
  });
});

describe("force stop", () => {
  it("requires a recent graceful attempt on the same identity", async () => {
    const { guard, kills, clock, tokenFor } = setup();
    const token = tokenFor(901);
    expect((await guard.forceStop(token)).status).toBe("needs-graceful-first");
    expect(kills).toEqual([]);
    await guard.stop(token);
    clock.advance(5_000);
    const forced = await guard.forceStop(token);
    expect(forced).toMatchObject({ ok: true, status: "signaled", signaledCount: 2 });
    expect(kills.slice(2)).toEqual([[901, "SIGKILL"], [902, "SIGKILL"]]);
    // The record is consumed; a second force needs a new graceful attempt.
    expect((await guard.forceStop(token)).status).toBe("needs-graceful-first");
  });

  it("expires the graceful record and re-verifies identity", async () => {
    const { guard, adapter, clock, tokenFor } = setup();
    const token = tokenFor(901);
    await guard.stop(token);
    clock.advance(10_001);
    expect((await guard.forceStop(token)).status).toBe("needs-graceful-first");
    await guard.stop(token);
    adapter.processes = adapter.processes.map((p) => (p.pid === 901 ? { ...p, startId: "reborn" } : p));
    expect((await guard.forceStop(token)).status).toBe("denied");
  });

  it("identityOf mirrors what the adapter reports", async () => {
    const { adapter } = setup();
    const target = adapter.processes.find((p) => p.pid === 901)!;
    expect(identityOf(target)).toEqual(await adapter.readIdentity(901));
  });
});
