import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapter } from "../adapter.server";
import { Collector } from "../collector.server";
import { ProcessGuard } from "../safety.server";

/**
 * Real-process test. It spawns *its own* child with a unique marker, only
 * ever signals PIDs it received back from the guard for that child, and
 * asserts the guard never touched anything else by using a recording kill.
 */

const platform = process.platform;
const uid = typeof process.getuid === "function" ? process.getuid() : -1;
const supported = (platform === "linux" || platform === "darwin") && uid >= 0;

const children: ChildProcess[] = [];

function spawnChild(trapTerm: boolean): { child: ChildProcess; ready: Promise<void> } {
  const marker = `monitor-test-${process.pid}-${Date.now()}`;
  // No process.title here: on Linux it rewrites /proc/<pid>/cmdline, which the
  // guard would (correctly) treat as an identity change and deny.
  const script = trapTerm
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send?.('ready');"
    : "setInterval(()=>{},1000);process.send?.('ready');";
  const child = spawn(process.execPath, ["-e", script, "--", marker], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", (message) => (message === "ready" ? resolve() : reject(new Error("child sent an unexpected readiness message"))));
    child.once("error", reject);
    child.once("exit", () => reject(new Error("child exited before signalling readiness")));
  });
  children.push(child);
  return { child, ready };
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
}

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

afterEach(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  children.length = 0;
});

describe.runIf(supported)("disposable child (real adapter)", () => {
  it("gracefully stops a real child and gates force stop", async () => {
    const adapter = createAdapter()!;
    const gentleSpawn = spawnChild(false);
    const stubbornSpawn = spawnChild(true);
    const gentle = gentleSpawn.child;
    const stubborn = stubbornSpawn.child;
    await Promise.all([gentleSpawn.ready, stubbornSpawn.ready]);
    expect(await waitFor(async () => (await adapter.readIdentity(gentle.pid!)) !== null && (await adapter.readIdentity(stubborn.pid!)) !== null)).toBe(true);

    const signalled: Array<[number, string]> = [];
    const guard = new ProcessGuard({
      adapter,
      uid,
      selfPid: process.pid,
      alwaysProtected: [process.ppid],
      kill: (pid, signal) => {
        // Belt and braces: the guard must only ever hand us our own children.
        if (pid !== gentle.pid && pid !== stubborn.pid) throw new Error(`guard tried to signal unrelated pid ${pid}`);
        signalled.push([pid, signal]);
        process.kill(pid, signal);
      },
    });
    const collector = new Collector({ adapter, policy: guard, uid, home: process.env.HOME ?? "/", cacheMs: 0, portCacheMs: 0 });

    const snapshot = await collector.snapshot({ query: String(gentle.pid), limit: 5 });
    const gentleRow = snapshot.processes.find((p) => p.pid === gentle.pid)!;
    expect(gentleRow.actionable).toBe(true);
    expect(gentleRow.actionToken).toBeTruthy();
    const self = (await collector.snapshot({ query: String(process.pid), limit: 5 })).processes.find((p) => p.pid === process.pid);
    expect(self?.actionable).toBe(false);

    const stopped = await guard.stop(gentleRow.actionToken!);
    expect(stopped).toMatchObject({ ok: true, status: "signaled", pid: gentle.pid });
    await exited(gentle);
    expect(gentle.signalCode).toBe("SIGTERM");
    expect(await guard.stop(gentleRow.actionToken!)).toMatchObject({ status: "already-exited" });

    const stubbornSnapshot = await collector.snapshot({ query: String(stubborn.pid), limit: 5 });
    const stubbornRow = stubbornSnapshot.processes.find((p) => p.pid === stubborn.pid)!;
    expect(stubbornRow.actionToken).toBeTruthy();
    expect((await guard.forceStop(stubbornRow.actionToken!)).status).toBe("needs-graceful-first");
    expect((await guard.stop(stubbornRow.actionToken!)).status).toBe("signaled");
    expect(await waitFor(async () => stubborn.exitCode !== null || stubborn.signalCode !== null, 300)).toBe(false);
    expect((await guard.forceStop(stubbornRow.actionToken!)).status).toBe("signaled");
    await exited(stubborn);
    expect(stubborn.signalCode).toBe("SIGKILL");

    expect(signalled).toEqual([[gentle.pid, "SIGTERM"], [stubborn.pid, "SIGTERM"], [stubborn.pid, "SIGKILL"]]);
  }, 20_000);
});
