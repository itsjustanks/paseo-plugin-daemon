import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapter } from "../server/adapter";
import { Collector } from "../server/collector";
import { hashArgv } from "../server/redaction";
import { ProcessGuard } from "../server/safety";

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
  // Signal only disposable sleep processes, never an agent or any existing process.
  const child = trapTerm
    ? spawn("/bin/sh", ["-c", 'trap "" TERM; exec /bin/sleep 60'], { stdio: "ignore" })
    : spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
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
    expect(await waitFor(async () => (await adapter.readIdentity(gentle.pid!))?.argvHash === hashArgv(["/bin/sleep", "60"]) && (await adapter.readIdentity(stubborn.pid!))?.argvHash === hashArgv(["/bin/sleep", "60"]))).toBe(true);

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
