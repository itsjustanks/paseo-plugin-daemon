import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildGroup, PIPE_GRACE_MS } from "../server/disk-children";
import { runWorker } from "../server/disk-worker";

/**
 * Review fixes (0.14.0): a child that dies while Hosts is still writing its
 * input is a result, never an unhandled EPIPE that takes the plugin down; and
 * a leader Hosts has seen exit is never signalled again, so PID reuse can't
 * point a kill at something else.
 */

const BIG = "x".repeat(32 * 1024 * 1024);

afterEach(() => { vi.restoreAllMocks(); });

describe("child pipes", () => {
  it("a child that exits without reading 32 MB of input resolves; no EPIPE escapes", async () => {
    const group = new ChildGroup();
    const result = await group.run(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000, input: BIG, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(result.code).toBe(3);
    expect(group.running).toBe(0);
  });

  it("a child killed mid-write by its timeout resolves as timed out", async () => {
    const group = new ChildGroup();
    // Reads slowly so the write is still buffered when the timeout kills it.
    const result = await group.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200, input: BIG, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
    expect(group.running).toBe(0);
  });

  it("the scan worker killed mid-write resolves with what it had", async () => {
    const roots = Array.from({ length: 400_000 }, (_, index) => ({ id: `r${index}`, path: `/nonexistent/${"p".repeat(40)}/${index}`, mode: "whole" as const }));
    const run = await runWorker({ op: "scan", roots, deadline: Date.now() + 60_000, clearable: [], ignoredOnly: [], ignoredMaxDepth: 1, maxItemsPerRoot: 1 }, 1, undefined, new ChildGroup());
    expect(run.timedOut).toBe(true);
    expect(run.error).toBeNull();
  });
});

describe("stale PIDs", () => {
  it("stops signalling a leader once it has exited, even while a descendant holds its pipes", async () => {
    const group = new ChildGroup();
    const kill = vi.spyOn(process, "kill");
    const started = Date.now();
    // The leader exits at once; the background sleep keeps stdout open.
    const result = await group.run("/bin/sh", ["-c", "sleep 3 & exit 0"], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PIPE_GRACE_MS - 50);
    expect(group.running).toBe(0);
    group.killAll();
    expect(kill).not.toHaveBeenCalled();
  });

  it("signals a live leader's process group, and nothing after it exits", async () => {
    const group = new ChildGroup();
    const kill = vi.spyOn(process, "kill");
    const result = await group.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(result.timedOut).toBe(true);
    const calls = kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
    expect(calls.length).toBe(1);
    kill.mockClear();
    group.signal(-calls[0]![0] as number);
    group.killAll();
    expect(kill).not.toHaveBeenCalled();
  });
});
