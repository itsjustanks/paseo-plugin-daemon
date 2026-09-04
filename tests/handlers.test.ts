import { describe, expect, it, vi } from "vitest";
import { ActionResultSchema, SnapshotSchema, monitorForceStop, monitorSnapshot, monitorStop } from "../contracts.shared";
import { createMonitorHandlers } from "../handlers.server";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

describe("handlers", () => {
  it("wires snapshot → token → stop → force-stop with fake adapters", async () => {
    const adapter = new FakeAdapter();
    const clock = new FakeClock();
    const kills: Array<[number, string]> = [];
    adapter.processes = [proc({ pid: 4000, ppid: 1, argv: ["Paseo Daemon"] }), proc({ pid: 4001, ppid: 4000, argv: ["monitor"] }), proc({ pid: 4100, ppid: 1, argv: ["node", "next", "dev"] })];
    adapter.ports.set(4100, [3000]);
    const { ProcessGuard } = await import("../safety.server");
    const guard = new ProcessGuard({ adapter, uid: 1000, selfPid: 4001, alwaysProtected: [4000], clock, kill: (pid, signal) => void kills.push([pid, signal]) });
    const handlers = createMonitorHandlers({ adapter, uid: 1000, home: "/home/alice", selfPid: 4001, parentPid: 4000, clock, guard });

    const snap = await handlers.snapshot(monitorSnapshot.input.parse({}));
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.services.map((s) => s.service!.label)).toEqual(["Next.js"]);
    const daemon = snap.processes.find((p) => p.pid === 4000)!;
    expect(daemon.actionable).toBe(false);
    expect(daemon.actionToken).toBeNull();
    const next = snap.processes.find((p) => p.pid === 4100)!;
    expect(next.actionable).toBe(true);
    const token = next.actionToken!;

    const forcedEarly = await handlers.forceStop(monitorForceStop.input.parse({ token }));
    expect(ActionResultSchema.parse(forcedEarly).status).toBe("needs-graceful-first");
    const stopped = await handlers.stop(monitorStop.input.parse({ token }));
    expect(ActionResultSchema.parse(stopped)).toMatchObject({ ok: true, status: "signaled", pid: 4100 });
    const forced = await handlers.forceStop({ token });
    expect(forced.status).toBe("signaled");
    expect(kills).toEqual([[4100, "SIGTERM"], [4100, "SIGKILL"]]);
    expect(await handlers.stop({ token: "not-a-token" })).toMatchObject({ ok: false, status: "denied" });
  });

  it("returns a typed unsupported snapshot and denies actions off-platform", async () => {
    const handlers = createMonitorHandlers({ adapter: null });
    const snap = await handlers.snapshot({});
    expect(snap.supported).toBe(false);
    expect(snap.platform).toBe("unsupported");
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
    expect((await handlers.stop({ token: "x" })).status).toBe("denied");
  });

  it("hides raw failure details from the client and the log", async () => {
    const adapter = new FakeAdapter();
    adapter.sampleSystem = async () => {
      throw new Error("EACCES /proc/secret --token abc");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = createMonitorHandlers({ adapter, uid: 1000, home: "/h", selfPid: 1, parentPid: 1 });
    await expect(handlers.snapshot({})).rejects.toThrow("Monitor could not read system state.");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("--token");
    spy.mockRestore();
  });

  it("validates snapshot input bounds", () => {
    expect(monitorSnapshot.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(monitorSnapshot.input.safeParse({ limit: 201 }).success).toBe(false);
    expect(monitorSnapshot.input.safeParse({ sort: "score" }).success).toBe(false);
    expect(monitorSnapshot.input.parse({})).toEqual({ query: "", sort: "cpu", limit: 60 });
  });
});
