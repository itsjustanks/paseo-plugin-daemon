import { describe, expect, it, vi } from "vitest";
import { stopActiveWork } from "../server/shutdown";
describe("integration authority cleanup", () => {
  it("invalidates all authority and detaches capture while cross-daemon teardown is stalled", async () => {
    const calls: string[] = []; let finish!: () => void;
    const stalled = new Promise<void>(resolve => { finish = resolve; });
    const stopped = stopActiveWork({ cross: () => { calls.push("cross"); return stalled; }, recovery: () => { calls.push("recovery"); return Promise.resolve(); }, housekeeping: () => { calls.push("housekeeping"); return Promise.resolve(); }, browsers: () => { calls.push("browsers"); } });
    expect(calls).toEqual(["cross", "recovery", "housekeeping", "browsers"]);
    const settled = vi.fn(); void stopped.then(settled); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    finish(); await stopped; expect(settled).toHaveBeenCalledOnce();
  });
  it("cancels legacy guard, health, process and hooks before waiting for stalled housekeeping", async () => {
    const calls: string[] = []; let finish!: () => void;
    const stalled = new Promise<void>(resolve => { finish = resolve; });
    const stop = (name: string) => () => { calls.push(name); };
    const names = ["hooks", "archived", "subscription", "health", "guard", "processes"];
    const stopped = stopActiveWork({ cross: stop("cross"), recovery: stop("recovery"), housekeeping: () => { calls.push("housekeeping"); return stalled; }, browsers: stop("browser"), cancel: names.map(stop), close: [stop("disk"), stop("links"), stop("peers"), stop("transfers")] });
    expect(calls).toEqual(["cross", "recovery", "housekeeping", "browser", ...names, "disk", "links", "peers", "transfers"]);
    finish(); await stopped;
  });
  it("continues every cancellation and async closure after synchronous failures", async () => {
    const calls: string[] = []; const fail = () => { throw new Error("fake synchronous stop failure"); };
    const result = await stopActiveWork({ cross: fail, recovery: () => { calls.push("recovery"); }, housekeeping: fail, browsers: fail,
      cancel: [fail, () => { calls.push("guard"); }], close: [fail, () => { calls.push("disk"); }] });
    expect(calls).toEqual(["recovery", "guard", "disk"]); expect(result.filter(entry => entry.status === "rejected")).toHaveLength(5);
  });
  it("handles failed teardown without skipping other authorities", async () => {
    const recovery = vi.fn(async () => { throw new Error("fake recovery failure"); }); const housekeeping = vi.fn(async () => {}); const browsers = vi.fn();
    await expect(stopActiveWork({ cross: async () => { throw new Error("fake stalled peer failure"); }, recovery, housekeeping, browsers })).resolves.toHaveLength(4);
    expect(recovery).toHaveBeenCalledOnce(); expect(housekeeping).toHaveBeenCalledOnce(); expect(browsers).toHaveBeenCalledOnce();
  });
});
