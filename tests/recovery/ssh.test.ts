import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { classifySsh, createSshRun } from "../../server/recovery/ssh";
import { outcome } from "./fixtures";
function child() {
  const events = new EventEmitter() as ChildProcess;
  Object.assign(events, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  return events;
}
afterEach(() => vi.useRealTimers());
describe("bounded SSH child and safe results", () => {
  it("handles success with bounded output and no raw passthrough", async () => {
    const c = child(), spawn = vi.fn(() => c), controller = new AbortController(), run = createSshRun(spawn);
    const task = run(["fixed"], controller.signal); c.emit("spawn");
    c.stdout!.emit("data", Buffer.from("x".repeat(10_000))); c.stderr!.emit("data", Buffer.from("fixture-sensitive-value".repeat(1000))); c.emit("close", 0);
    const result = await task; expect(result.stdout).toHaveLength(4096); expect(result.stderr).toHaveLength(4096);
    expect(classifySsh(result, false, 1).message).not.toContain("fixture-sensitive-value");
    controller.abort(); expect(c.kill).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
  });
  it("times out, kills only its child and reports uncertain mutations without retry", async () => {
    vi.useFakeTimers(); const c = child(), spawn = vi.fn(() => c), run = createSshRun(spawn, 100, 10);
    const task = run([], new AbortController().signal); c.emit("spawn"); await vi.advanceTimersByTimeAsync(110);
    const result = await task; expect(c.kill).toHaveBeenNthCalledWith(1, "SIGTERM"); expect(c.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(classifySsh(result, true, 1).code).toBe("uncertain"); expect(spawn).toHaveBeenCalledOnce();
  });
  it("cancels before spawn and active children promptly", async () => {
    vi.useFakeTimers(); const c = child(), spawn = vi.fn(() => c), controller = new AbortController(), run = createSshRun(spawn, 1000, 10);
    controller.abort(); const early = await run([], controller.signal); expect(spawn).not.toHaveBeenCalled(); expect(early.cancelled).toBe(true);
    const activeController = new AbortController(), task = run([], activeController.signal); c.emit("spawn"); activeController.abort(); c.emit("close", null);
    expect((await task).cancelled).toBe(true); await vi.advanceTimersByTimeAsync(20); expect(c.kill).toHaveBeenCalledOnce();
  });
  it("classifies missing SSH and suppresses spawn errors", async () => {
    const thrown = createSshRun(() => { throw new Error("fixture-sensitive-value"); });
    expect(classifySsh(await thrown([], new AbortController().signal), false, 1).code).toBe("unavailable");
    const c = child(), task = createSshRun(() => c)([], new AbortController().signal); c.emit("error", new Error("fixture-sensitive-value"));
    expect(classifySsh(await task, true, 1).message).not.toContain("fixture-sensitive-value");
  });
  it.each([
    ["Host key verification failed", "host_key"], ["REMOTE HOST IDENTIFICATION HAS CHANGED", "host_key"],
    ["Permission denied", "auth"], ["Could not resolve hostname", "unreachable"], ["Connection refused", "unreachable"],
    ["Connection closed", "uncertain"],
  ])("classifies %s without returning diagnostics", (stderr, code) => {
    const r = classifySsh(outcome({ exitCode: 255, stderr: `${stderr}: fixture-sensitive-value` }), true, 1);
    expect(r.code).toBe(code); expect(JSON.stringify(r)).not.toContain("fixture-sensitive-value");
  });
  it("never calls a reboot disconnect recovered and keeps read disconnects honest", () => {
    expect(classifySsh(outcome({ exitCode: 255 }), true, 1, true).message).toContain("not verified");
    expect(classifySsh(outcome({ exitCode: 255 }), false, 1).code).toBe("unreachable");
    expect(classifySsh(outcome({ timedOut: true }), false, 1).code).toBe("unreachable");
    expect(classifySsh(outcome({ cancelled: true }), false, 1).code).toBe("cancelled");
  });
  it.each([["running\n", "running"], ["active\n", "running"], ["container_stopped\n", "stopped"], ["worker_stopped\n", "stopped"], ["worker_unknown\n", "unknown"], ["stopped\n", "unknown"], ["unknown\n", "unknown"], ["fixture-private-configuration", "unknown"]])("allowlists state %s", (stdout, state) => {
    const r = classifySsh(outcome({ stdout }), false, 1); expect(r.state).toBe(state); expect(r.message).not.toContain("fixture-private-configuration");
  });
  it("distinguishes a stopped container from a stopped or unavailable worker", () => {
    const container = classifySsh(outcome({ stdout: "container_stopped\n" }), false, 1);
    const worker = classifySsh(outcome({ stdout: "worker_stopped\n" }), false, 1);
    const unknown = classifySsh(outcome({ stdout: "worker_unknown\n" }), false, 1);
    expect(container.state).toBe("stopped"); expect(container.message).toContain("container is stopped");
    expect(worker.state).toBe("stopped"); expect(worker.message).toContain("container is still running");
    expect(worker.message).toContain("worker is stopped"); expect(worker.message).toContain("Start container cannot restart");
    expect(unknown.state).toBe("unknown"); expect(unknown.message).toContain("container is running");
    for (const result of [worker, unknown]) { expect(result.message).toContain("Restart existing container"); expect(result.message).not.toContain("container is stopped"); }
  });
  it("distinguishes systemd inactive from unknown/missing services and generic failures", () => {
    expect(classifySsh(outcome({ exitCode: 3, stdout: "inactive\n" }), false, 1).state).toBe("stopped");
    expect(classifySsh(outcome({ exitCode: 4, stdout: "unknown\n" }), false, 1).code).toBe("failed");
    expect(classifySsh(outcome({ exitCode: 1, stderr: "password fixture-sensitive-value" }), true, 1).message).not.toContain("fixture-sensitive-value");
    expect(classifySsh(outcome(), true, 1).code).toBe("sent"); expect(classifySsh(outcome(), true, 1, true).message).toContain("not verified");
  });
});
