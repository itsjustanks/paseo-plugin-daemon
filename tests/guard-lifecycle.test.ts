import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterQuickSampler, GuardLoop, LinuxQuickSampler } from "../server/guard-loop";
import { DaemonLogTail } from "../server/daemon-log";
import { FakeAdapter, proc } from "./fake-adapter";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const tail = () => new DaemonLogTail("/fixture", { stat: async () => ({ size: 0, ino: 1 }), read: async () => Buffer.alloc(0) });
const sample = () => ({ at: Date.now(), signal: { some10: null, full10: null, percent: 30, newOomKills: 0 }, basisBytes: 100, usedBytes: 30, processes: [] });

describe("guard lifecycle and platform fallbacks", () => {
  it("samples adapter memory and process identities without inventing Linux pressure", async () => {
    const adapter = new FakeAdapter(); adapter.processes = [proc({ pid: 42, rssBytes: 100 })]; adapter.sample.pressureSignal = "warn";
    const value = await new AdapterQuickSampler(adapter, 1000, () => 5).sample();
    expect(value).toMatchObject({ at: 5, signal: { osLevel: "warn", some10: null, full10: null }, processes: [{ pid: 42, startId: "start-42", rssBytes: 100 }] });
  });
  it("reads host PSI when cgroup metadata is unavailable and tolerates inaccessible procfs", async () => {
    const sampler = new LinuxQuickSampler(1000, {
      readFile: async (path) => { if (path === "/proc/pressure/memory") return "some avg10=4.00\nfull avg10=2.00\n"; throw new Error("missing"); },
      readdir: async () => { throw new Error("denied"); },
    });
    expect(await sampler.sample()).toMatchObject({ signal: { some10: 4, full10: 2, percent: null }, processes: [] });
    const missing = new LinuxQuickSampler(1000, { readFile: async () => { throw new Error("missing"); }, readdir: async () => [] });
    expect((await missing.sample()).signal.full10).toBeNull();
  });
  it("runs on schedule, tolerates a failed pass, and cancels future ticks on close", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => sample()); const settings = vi.fn(async () => ({ autoStopRunaways: false }));
    const loop = new GuardLoop({ sampler: { sample: read }, tail: tail(), readSettings: settings, intervalMs: 100 });
    loop.start(); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101); expect(read).toHaveBeenCalledTimes(2);
    loop.close(); await vi.advanceTimersByTimeAsync(300); expect(read).toHaveBeenCalledTimes(2); loop.start(); expect(read).toHaveBeenCalledTimes(2);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = new GuardLoop({ sampler: { sample: async () => sample() }, tail: tail(), readSettings: settings, diskPaths: () => { throw new Error("bad registry"); } });
    await expect(bad.tick()).resolves.toBeUndefined(); expect(errors).toHaveBeenCalled(); bad.close();
  });
  it("cancels an in-flight stop's authority when closed and keeps failures out of the latest stop record", async () => {
    vi.useFakeTimers(); let now = 1; const critical = { ...sample(), signal: { ...sample().signal, percent: 99, full10: 80 } }; let confirm: (() => Promise<boolean>) | null = null;
    const stop = vi.fn(async (_min: number, check: () => Promise<boolean>) => { confirm = check; throw new Error("process changed"); });
    const loop = new GuardLoop({ sampler: { sample: async () => critical }, tail: tail(), readSettings: async () => ({ autoStopRunaways: true }), autoStop: stop, now: () => now, intervalMs: 60_000 });
    await loop.tick(); now = 60_002; await loop.tick(); expect(stop).toHaveBeenCalledOnce(); expect(loop.state().autoGuard.last).toBeNull();
    loop.close(); expect(await confirm!()).toBe(false);
  });
});
