import { describe, expect, it } from "vitest";
import { Collector, HISTORY_MAX_POINTS, type ActionPolicy } from "../collector.server";
import { SnapshotSchema } from "../contracts.shared";
import { FakeAdapter, FakeClock, GB, MB, proc, system } from "./fake-adapter";

const policy: ActionPolicy = {
  evaluate: (p) => (p.pid === 7 ? { actionable: false, reason: "protected in test" } : { actionable: true, reason: null }),
  mint: (p, hash) => `tok-${p.pid}-${hash.slice(0, 6)}`,
};

function setup() {
  const adapter = new FakeAdapter();
  const clock = new FakeClock();
  const collector = new Collector({ adapter, policy, uid: 1000, home: "/home/alice", clock, cacheMs: 1000, portCacheMs: 5000 });
  return { adapter, clock, collector };
}

describe("Collector", () => {
  it("produces a schema-valid snapshot and reports sampling before the first delta", async () => {
    const { adapter, collector } = setup();
    adapter.processes = [proc({ pid: 100 })];
    const snap = await collector.snapshot({});
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.sampling).toBe("sampling");
    expect(snap.cpu.percent).toBeNull();
    expect(snap.processes[0]!.cpuPercent).toBeNull();
    expect(snap.processes[0]!.cwd).toBe("~/app");
  });

  it("computes CPU deltas for the system and per process, keyed by start identity", async () => {
    const { adapter, clock, collector } = setup();
    adapter.processes = [proc({ pid: 100, cpuSeconds: 10 })];
    await collector.snapshot({});
    clock.advance(2000);
    adapter.sample = system({ cpuBusy: 1000 + 9000 * 0.5, cpuTotal: 19000 });
    adapter.processes = [proc({ pid: 100, cpuSeconds: 11 })];
    const snap = await collector.snapshot({});
    expect(snap.sampling).toBe("live");
    expect(snap.cpu.percent).toBeCloseTo(50, 0);
    expect(snap.processes[0]!.cpuPercent).toBeCloseTo(50, 0);
    // A reused PID with a different start identity starts fresh.
    clock.advance(2000);
    adapter.processes = [proc({ pid: 100, cpuSeconds: 0, startId: "reused" })];
    const reused = await collector.snapshot({});
    expect(reused.processes[0]!.cpuPercent).toBeNull();
    expect(collector.trackedCount()).toBe(1);
  });

  it("caches collections briefly and shares in-flight work", async () => {
    const { adapter, clock, collector } = setup();
    adapter.processes = [proc({ pid: 100 })];
    const [a, b] = await Promise.all([collector.snapshot({}), collector.snapshot({ sort: "pid" })]);
    expect(a.timestamp).toBe(b.timestamp);
    expect(adapter.portScans).toBe(1);
    clock.advance(500);
    await collector.snapshot({});
    expect(adapter.portScans).toBe(1);
    clock.advance(1000);
    await collector.snapshot({});
    expect(adapter.portScans).toBe(1); // port cache (5s) still warm
    clock.advance(5000);
    await collector.snapshot({});
    expect(adapter.portScans).toBe(2);
  });

  it("bounds history and prunes exited processes", async () => {
    const { adapter, clock, collector } = setup();
    adapter.processes = [proc({ pid: 1 + 100 }), proc({ pid: 101 })];
    for (let i = 0; i < HISTORY_MAX_POINTS + 10; i += 1) {
      clock.advance(1500);
      adapter.processes = [proc({ pid: 100, rssBytes: (50 + i) * MB })];
      await collector.snapshot({});
    }
    expect(collector.trackedCount()).toBe(1);
    const snap = await collector.snapshot({});
    expect(snap.totalProcesses).toBe(1);
  });

  it("reports RSS growth and memory pressure drivers with reasons", async () => {
    const { adapter, clock, collector } = setup();
    adapter.processes = [proc({ pid: 100, rssBytes: 100 * MB }), proc({ pid: 101, rssBytes: 10 * MB })];
    await collector.snapshot({});
    clock.advance(30_000);
    adapter.sample = system({ memoryAvailableBytes: 1 * GB });
    adapter.processes = [proc({ pid: 100, rssBytes: 5 * GB }), proc({ pid: 101, rssBytes: 10 * MB })];
    const snap = await collector.snapshot({});
    expect(snap.memory.pressure).toBe("critical");
    const hog = snap.processes.find((p) => p.pid === 100)!;
    expect(hog.impact).toBe("pressure-driver");
    expect(hog.reasons.some((r) => r.startsWith("RSS +"))).toBe(true);
    expect(hog.reasons).toContain("top memory user during memory pressure");
  });

  it("filters, sorts, pages, and surfaces services", async () => {
    const { adapter, collector } = setup();
    adapter.processes = [
      proc({ pid: 100, argv: ["node", "node_modules/.bin/vite"], rssBytes: 10 * MB }),
      proc({ pid: 101, argv: ["python3", "-m", "http.server"], rssBytes: 30 * MB }),
      proc({ pid: 102, argv: ["bash"], comm: "bash", rssBytes: 20 * MB }),
      proc({ pid: 7, argv: ["paseo"], comm: "paseo", rssBytes: 1 * MB }),
    ];
    adapter.ports.set(100, [5173]);
    adapter.ports.set(101, [8000]);
    const byMemory = await collector.snapshot({ sort: "memory", limit: 2 });
    expect(byMemory.processes.map((p) => p.pid)).toEqual([101, 102]);
    expect(byMemory.truncated).toBe(true);
    expect(byMemory.totalProcesses).toBe(4);
    expect(byMemory.services.map((s) => [s.pid, s.service!.label])).toEqual([[100, "Vite"], [101, "Python http.server"]]);
    const search = await collector.snapshot({ query: ":8000" });
    expect(search.processes.map((p) => p.pid)).toEqual([101]);
    const byName = await collector.snapshot({ query: "vite", sort: "name" });
    expect(byName.matchedProcesses).toBe(1);
    const protectedRow = (await collector.snapshot({ sort: "pid" })).processes[0]!;
    expect(protectedRow.pid).toBe(7);
    expect(protectedRow.actionable).toBe(false);
    expect(protectedRow.protectedReason).toBe("protected in test");
    expect(protectedRow.actionToken).toBeNull();
    expect((await collector.snapshot({ query: "100" })).processes[0]!.actionToken).toMatch(/^tok-100-/);
  });

  it("passes adapter warnings through and never leaks raw argv secrets", async () => {
    const { adapter, collector } = setup();
    adapter.portWarnings = ["Listening ports unavailable: test"];
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    adapter.processes = [proc({ pid: 100, argv: ["node", "app.js", "--api-key", secret, "--db", "postgres://u:pw@db/app"] })];
    const snap = await collector.snapshot({});
    const json = JSON.stringify(snap);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("u:pw@");
    expect(snap.warnings).toContain("Listening ports unavailable: test");
    expect(snap.processes[0]!.command).toBe("node app.js --api-key [redacted] --db postgres://[redacted]@db/app");
  });
});
