import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProcessGuard, descendants, identityOf, protectedSet } from "../server/safety";
import { hashArgv } from "../server/redaction";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

const SELF = 500;
const DAEMON = 400;
const SUPERVISOR = 300;
const LAUNCHER = 200;

type KillError = "ESRCH" | "EPERM" | "EINVAL";

function setup() {
  const adapter = new FakeAdapter();
  const clock = new FakeClock();
  const kills: Array<[number, string]> = [];
  /** Per-PID failure injection for the kill seam. */
  const failWith = new Map<number, KillError>();
  const kill = (pid: number, signal: string) => {
    const forced = failWith.get(pid);
    if (forced) throw Object.assign(new Error(forced), { code: forced });
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
  const rows = () => adapter.processes.map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid, startId: p.startId }));
  const tokenFor = (pid: number) => {
    const target = adapter.processes.find((p) => p.pid === pid)!;
    return guard.mint(target, hashArgv(target.argv));
  };
  const mutate = (pid: number, patch: Partial<ReturnType<typeof proc>>) => {
    adapter.processes = adapter.processes.map((p) => (p.pid === pid ? { ...p, ...patch } : p));
  };
  return { adapter, clock, kills, failWith, guard, tree, rows, tokenFor, mutate };
}

describe("protected set and descendants", () => {
  it("protects PID 1, self, every ancestor, and extras", () => {
    const { rows } = setup();
    const set = protectedSet(rows(), SELF, [DAEMON]);
    expect([...set].sort((a, b) => a - b)).toEqual([1, LAUNCHER, SUPERVISOR, DAEMON, SELF]);
  });

  it("walks descendants without crossing other users or protected nodes, carrying start identity", () => {
    const { rows } = setup();
    const set = protectedSet(rows(), SELF, [DAEMON]);
    const kids = descendants(rows(), 900, 1000, set);
    expect(kids.map((r) => r.pid).sort()).toEqual([901, 902, 960]);
    expect(kids.find((r) => r.pid === 902)).toEqual({ pid: 902, ppid: 901, uid: 1000, startId: "start-902" });
    // 903 is root-owned, so 904 (same user but below a root node) is never reached.
    expect(descendants(rows(), 901, 1000, set).map((r) => r.pid)).toEqual([902]);
    // Cycles do not loop forever.
    const cycle = [
      { pid: 5, ppid: 6, uid: 1, startId: "a" },
      { pid: 6, ppid: 5, uid: 1, startId: "b" },
    ];
    expect(descendants(cycle, 5, 1, new Set()).map((r) => r.pid)).toEqual([6]);
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
    expect(token).not.toContain("vite");
    const [body, sig] = token.split(".");
    const tampered = Buffer.from(body!, "base64url").toString("utf8").replace('"pid":901', '"pid":900');
    expect(guard.verify(`${Buffer.from(tampered).toString("base64url")}.${sig}`)).toBeNull();
    expect(guard.verify(`${body}.${sig!.slice(0, -2)}AA`)).toBeNull();
    expect(guard.verify("garbage")).toBeNull();
    expect(guard.verify("")).toBeNull();
    expect(guard.verify(`${body}.`)).toBeNull();
    const other = new ProcessGuard({ adapter: new FakeAdapter(), uid: 1000, selfPid: SELF, key: randomBytes(32) });
    expect(other.verify(token)).toBeNull();
    clock.advance(60_001);
    expect(guard.verify(token)).toBeNull();
  });

  it("rejects a correctly signed body that is not a valid payload", () => {
    const key = randomBytes(32);
    const guard = new ProcessGuard({ adapter: new FakeAdapter(), uid: 1000, selfPid: SELF, key });
    const sign = (body: string) => `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
    expect(guard.verify(sign(Buffer.from("not json").toString("base64url")))).toBeNull();
    expect(guard.verify(sign(Buffer.from(JSON.stringify({ pid: 901, uid: 1000 })).toString("base64url")))).toBeNull();
    expect(guard.verify(sign(Buffer.from(JSON.stringify({ pid: 0, uid: 1000, startId: "s", proof: "p", exp: 1e15 })).toString("base64url")))).toBeNull();
  });

  it("never exposes the argv hash: the payload carries only a keyed proof", () => {
    const { guard, adapter, tokenFor } = setup();
    const target = adapter.processes.find((p) => p.pid === 901)!;
    const argvHash = hashArgv(target.argv);
    const token = tokenFor(901);
    const body = Buffer.from(token.split(".")[0]!, "base64url").toString("utf8");
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(body).not.toContain(argvHash);
    expect(body).not.toContain(argvHash.slice(0, 16));
    expect(token).not.toContain(argvHash.slice(0, 16));
    expect(payload).not.toHaveProperty("argvHash");
    expect(typeof payload.proof).toBe("string");
    expect(payload.proof).not.toBe(argvHash);
    // The proof is keyed: a second guard with its own key derives a different one for the same process.
    const other = new ProcessGuard({ adapter, uid: 1000, selfPid: SELF, key: randomBytes(32) });
    const otherBody = Buffer.from(other.mint(target, argvHash).split(".")[0]!, "base64url").toString("utf8");
    expect((JSON.parse(otherBody) as { proof: string }).proof).not.toBe(payload.proof);
    // An old-format payload with a plain argvHash is rejected even if it were signed.
    expect(guard.verify(token.replace(/^[^.]+/, Buffer.from(JSON.stringify({ ...payload, proof: undefined, argvHash })).toString("base64url")))).toBeNull();
  });

  it("proof still binds the command line: a changed argv is denied", async () => {
    const { guard, kills, tokenFor, mutate } = setup();
    const token = tokenFor(901);
    mutate(901, { argv: ["node", "something-else"] });
    expect((await guard.stop(token)).status).toBe("denied");
    expect(kills).toEqual([]);
  });
});

describe("stop", () => {
  it("SIGTERMs the verified target and its re-verified descendants only", async () => {
    const { guard, kills, adapter, tokenFor } = setup();
    const result = await guard.stop(tokenFor(901));
    expect(result).toMatchObject({ ok: true, status: "signaled", pid: 901, signaledCount: 2 });
    expect(result.message).toBe("Sent SIGTERM to PID 901 and 1 of 1 child process(es).");
    expect(kills).toEqual([[901, "SIGTERM"], [902, "SIGTERM"]]);
    // The descendant was freshly read right before its signal.
    expect(adapter.identityReads).toEqual([901, 902]);
  });

  it("denies a reused PID, uid mismatch, or changed command", async () => {
    const { guard, kills, tokenFor, mutate } = setup();
    const token = tokenFor(901);
    mutate(901, { startId: "start-later" });
    expect((await guard.stop(token)).status).toBe("denied");
    mutate(901, { startId: "start-901", uid: 1001 });
    expect((await guard.stop(token)).status).toBe("denied");
    mutate(901, { uid: 1000, argv: ["node", "something-else"] });
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
    const { guard, kills, tokenFor, mutate } = setup();
    const token = tokenFor(901);
    // Monitor's own process is re-parented under 901 (contrived, but the
    // point is that protection uses the fresh tree).
    mutate(SELF, { ppid: 901 });
    const result = await guard.stop(token);
    expect(result.status).toBe("denied");
    expect(kills).toEqual([]);
  });

  it("fails closed when the identity or process table cannot be read", async () => {
    const { guard, adapter, kills, tokenFor } = setup();
    const token = tokenFor(901);
    adapter.identityReadError = Object.assign(new Error("EACCES /proc/901/status"), { code: "EACCES" });
    const identity = await guard.stop(token);
    expect(identity).toMatchObject({ ok: false, status: "denied", pid: 901 });
    expect(identity.message).not.toContain("/proc");
    adapter.identityReadError = null;
    adapter.treeReadError = new Error("ps exploded");
    const tree = await guard.stop(token);
    expect(tree).toMatchObject({ ok: false, status: "denied", pid: 901 });
    expect(tree.message).not.toContain("ps exploded");
    expect(kills).toEqual([]);
  });
});

describe("descendant safety", () => {
  it("skips a descendant whose PID was reused between the tree read and the signal", async () => {
    const { guard, adapter, kills, tokenFor, mutate } = setup();
    const token = tokenFor(901);
    adapter.beforeIdentityRead = (pid) => {
      if (pid === 902) mutate(902, { startId: "reborn", argv: ["something", "unrelated"] });
    };
    const result = await guard.stop(token);
    expect(result).toMatchObject({ ok: true, status: "signaled", pid: 901, signaledCount: 1 });
    expect(result.message).toContain("0 of 1 child process(es)");
    expect(result.message).toContain("changed identity");
    expect(kills).toEqual([[901, "SIGTERM"]]);
  });

  it("skips a descendant whose owner changed and one that became a zombie", async () => {
    const { guard, adapter, kills, tokenFor, mutate } = setup();
    // Give 901 a second child so both cases run in one action.
    adapter.processes.push(proc({ pid: 905, ppid: 901, argv: ["worker"] }));
    const token = tokenFor(901);
    adapter.beforeIdentityRead = (pid) => {
      if (pid === 902) mutate(902, { uid: 1001 });
      if (pid === 905) mutate(905, { state: "zombie" });
    };
    const result = await guard.stop(token);
    expect(result.signaledCount).toBe(1);
    expect(kills).toEqual([[901, "SIGTERM"]]);
  });

  it("skips a descendant that exited before its signal, without failing the action", async () => {
    const { guard, adapter, kills, tokenFor } = setup();
    const token = tokenFor(901);
    adapter.beforeIdentityRead = (pid) => {
      if (pid === 902) adapter.processes = adapter.processes.filter((p) => p.pid !== 902);
    };
    const result = await guard.stop(token);
    expect(result).toMatchObject({ ok: true, status: "signaled", signaledCount: 1 });
    expect(kills).toEqual([[901, "SIGTERM"]]);
  });

  it("never signals a child that only appeared in an earlier tree snapshot", async () => {
    const { guard, adapter, kills, tokenFor } = setup();
    const token = tokenFor(901);
    // The child from the tree read is gone by signal time and a fresh
    // unrelated process (different start identity) now owns PID 902.
    adapter.beforeIdentityRead = (pid) => {
      if (pid === 902) {
        adapter.processes = adapter.processes.filter((p) => p.pid !== 902);
        adapter.processes.push(proc({ pid: 902, ppid: 1, argv: ["unrelated", "victim"], startId: "new-life" }));
      }
    };
    await guard.stop(token);
    expect(kills).toEqual([[901, "SIGTERM"]]);
  });

  it("stops before touching any descendant when the primary signal is refused (EPERM)", async () => {
    const { guard, adapter, kills, failWith, tokenFor } = setup();
    failWith.set(901, "EPERM");
    const result = await guard.stop(tokenFor(901));
    expect(result).toEqual({ ok: false, status: "failed", message: "Permission denied by the operating system.", pid: 901, signaledCount: 0 });
    expect(kills).toEqual([]);
    expect(adapter.identityReads).toEqual([901]); // no descendant was even looked at
    // No graceful attempt was recorded, so force stop is still gated.
    failWith.delete(901);
    expect((await guard.forceStop(tokenFor(901))).status).toBe("needs-graceful-first");
  });

  it("reports an honest partial outcome when a descendant signal fails", async () => {
    const { guard, kills, failWith, tokenFor } = setup();
    failWith.set(902, "EPERM");
    const result = await guard.stop(tokenFor(901));
    expect(result).toMatchObject({ ok: true, status: "signaled", pid: 901, signaledCount: 1 });
    expect(result.message).toBe("Sent SIGTERM to PID 901 and 0 of 1 child process(es). 1 child process(es) could not be signaled.");
    expect(kills).toEqual([[901, "SIGTERM"]]);
    // The primary was signalled, so the graceful record exists and force stop proceeds.
    failWith.delete(902);
    const forced = await guard.forceStop(tokenFor(901));
    expect(forced).toMatchObject({ ok: true, status: "signaled", signaledCount: 2 });
  });

  it("treats a non-EPERM primary failure as failed with no descendants signalled", async () => {
    const { guard, kills, failWith, tokenFor } = setup();
    failWith.set(901, "EINVAL");
    const result = await guard.stop(tokenFor(901));
    expect(result).toMatchObject({ ok: false, status: "failed", message: "Signal failed.", signaledCount: 0 });
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
    expect(forced.message).toBe("Sent SIGKILL to PID 901 and 1 of 1 child process(es).");
    expect(kills.slice(2)).toEqual([[901, "SIGKILL"], [902, "SIGKILL"]]);
    // The record is consumed; a second force needs a new graceful attempt.
    expect((await guard.forceStop(token)).status).toBe("needs-graceful-first");
  });

  it("expires the graceful record and re-verifies identity", async () => {
    const { guard, clock, tokenFor, mutate } = setup();
    const token = tokenFor(901);
    await guard.stop(token);
    clock.advance(10_001);
    expect((await guard.forceStop(token)).status).toBe("needs-graceful-first");
    await guard.stop(token);
    mutate(901, { startId: "reborn" });
    expect((await guard.forceStop(token)).status).toBe("denied");
  });

  it("re-verifies descendants on force stop and reports EPERM on the primary", async () => {
    const { guard, adapter, kills, failWith, tokenFor } = setup();
    const token = tokenFor(901);
    await guard.stop(token);
    adapter.beforeIdentityRead = (pid) => {
      if (pid === 902) adapter.processes = adapter.processes.filter((p) => p.pid !== 902);
    };
    const forced = await guard.forceStop(token);
    expect(forced).toMatchObject({ ok: true, status: "signaled", signaledCount: 1 });
    expect(kills).toEqual([[901, "SIGTERM"], [902, "SIGTERM"], [901, "SIGKILL"]]);
    adapter.beforeIdentityRead = null;
    await guard.stop(token);
    failWith.set(901, "EPERM");
    expect(await guard.forceStop(token)).toMatchObject({ ok: false, status: "failed", signaledCount: 0 });
    failWith.delete(901);
    adapter.processes = adapter.processes.filter((p) => p.pid !== 901);
    expect((await guard.forceStop(token)).status).toBe("already-exited");
  });

  it("identityOf mirrors what the adapter reports", async () => {
    const { adapter } = setup();
    const target = adapter.processes.find((p) => p.pid === 901)!;
    expect(identityOf(target)).toEqual(await adapter.readIdentity(901));
  });
});
