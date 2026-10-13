import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeDaemons } from "../../client/cross-daemon/readings.client";
import { daemonRequest, DAEMON_REQUEST_MS } from "../../client/cross-daemon/requests.client";
import { buildDaemonRows } from "../../client/cross-daemon/daemon-rows.client";
import { syncPeers, type DaemonPort } from "../../client/cross-daemon/peer-sync.client";
import { peersToStore } from "../../server/cross-daemon/switch-policy.server";

function port(id: string): DaemonPort {
  return { status: vi.fn(async () => ({ serverId: id, available: true, switchedOn: false })),
    describe: vi.fn(async () => ({ serverId: id, switchedOn: false, member: null })),
    listPeers: vi.fn(async () => []), setPeers: vi.fn(async () => {}), setSwitch: vi.fn(async () => {}) };
}
const never = () => new Promise<never>(() => {});
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("shows an answering computer even when another never answers, and later checks recover", async () => {
  const mac = port("mac"), vm = port("vm"); vm.status = vi.fn(never);
  const result = describeDaemons([mac, vm]);
  await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS);
  const readings = await result;
  expect(readings.failedCount).toBe(1);
  const hosts = ["mac", "vm"].map(serverId => ({ serverId, label: serverId, status: "online" as const }));
  expect(buildDaemonRows(hosts, readings).map(row => row.state)).toEqual(["off", "unavailable"]);
  expect(mac.describe).not.toHaveBeenCalled(); expect(mac.listPeers).not.toHaveBeenCalled();
  const next = await describeDaemons([mac, vm]);
  expect(next.daemons[0].serverId).toBe("mac");
  expect(mac.status).toHaveBeenCalledTimes(2); expect(vm.status).toHaveBeenCalledTimes(1);
});

it("does not turn a failed peer inventory into a successful enabled reading", async () => {
  const p = port("enabled"); p.status = async () => ({ serverId: "enabled", available: true, switchedOn: true }); p.listPeers = never;
  const result = describeDaemons([p]); await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS);
  expect(await result).toEqual({ daemons: [], failedCount: 1 });
});

it("does not overlap or replay an uncertain write, but permits a new update after settlement", async () => {
  const p = port("host"); let finish!: () => void;
  const first = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const result = daemonRequest(p, "setPeers", first);
  const failure = expect(result).rejects.toThrow("did not reply");
  await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS); await failure;
  const replacement = vi.fn(async () => {});
  await expect(daemonRequest(p, "setPeers", replacement)).rejects.toThrow("still pending");
  expect(replacement).not.toHaveBeenCalled();
  finish(); await vi.advanceTimersByTimeAsync(0);
  await daemonRequest(p, "setPeers", replacement); expect(replacement).toHaveBeenCalledTimes(1);
});

it("never reuses a pending status for a newer authority check", async () => {
  const p = port("host"); const old = daemonRequest(p, "status", never);
  const failure = expect(old).rejects.toThrow(); await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS); await failure;
  const fresh = vi.fn(async () => ({ serverId: "host", available: true, switchedOn: true }));
  await expect(daemonRequest(p, "status", fresh)).rejects.toThrow("still pending"); expect(fresh).not.toHaveBeenCalled();
});

it("lets subsequent sync rounds progress despite a stuck member", async () => {
  const a = port("a"), b = port("b"); b.describe = vi.fn(never);
  const first = syncPeers([a, b]); await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS); await first;
  await syncPeers([a, b]);
  expect(a.setPeers).toHaveBeenCalledTimes(2); expect(b.describe).toHaveBeenCalledTimes(1);
  expect(b.setPeers).not.toHaveBeenCalled();
  expect(a.setPeers).toHaveBeenLastCalledWith({ peers: [], answeredServerIds: ["a"] });
});

it("cleans deadlines after successful, rejected and synchronously failing requests", async () => {
  const p = port("host");
  await daemonRequest(p, "status", async () => 1);
  await expect(daemonRequest(p, "status", async () => { throw Error("failed"); })).rejects.toThrow("failed");
  await expect(daemonRequest(p, "status", () => { throw Error("sync failed"); })).rejects.toThrow("sync failed");
  expect(await daemonRequest(p, "status", async () => 2)).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
});

function enabled(id: string): DaemonPort {
  const p = port(id);
  p.describe = vi.fn(async () => ({ serverId: id, switchedOn: true, member: { serverId: id, name: id, link: `https://example.test/${id}` } }));
  p.status = vi.fn(async () => ({ serverId: id, available: true, switchedOn: true }));
  return p;
}

it("does not confuse a concurrent screen refresh with a failed authority recheck", async () => {
  const a = enabled("a"), b = enabled("b");
  a.status = vi.fn(() => new Promise<Awaited<ReturnType<DaemonPort["status"]>>>(resolve => setTimeout(() => resolve({ serverId: "a", available: true, switchedOn: true }), 300)));
  const readings = describeDaemons([a, b]);
  const sync = syncPeers([a, b]);
  await vi.advanceTimersByTimeAsync(300); await sync;
  expect((await readings).failedCount).toBe(0);
  expect(a.setPeers).toHaveBeenCalledWith({ peers: [{ serverId: "b", name: "b", link: "https://example.test/b" }], answeredServerIds: ["a", "b"] });
  expect(b.setPeers).toHaveBeenCalledWith({ peers: [{ serverId: "a", name: "a", link: "https://example.test/a" }], answeredServerIds: ["a", "b"] });
});

it("retains prior links when authority times out instead of treating a silent computer as off", async () => {
  const a = enabled("a"), b = enabled("b"); a.status = vi.fn(never);
  const sync = syncPeers([a, b]); await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS); await sync;
  expect(a.setPeers).not.toHaveBeenCalled();
  expect(b.setPeers).toHaveBeenCalledWith({ peers: [], answeredServerIds: ["b"] });
  const stored = [{ serverId: "a", name: "a", link: "https://example.test/a" }];
  expect(peersToStore({ switchedOn: true, ownServerId: "b", stored, peers: [], answeredServerIds: ["b"] })).toEqual(stored);
});

it("shares uncertain-write slots between separately evaluated host bundles", async () => {
  const p = enabled("a");
  const first = daemonRequest(p, "setPeers", never);
  const failure = expect(first).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(DAEMON_REQUEST_MS); await failure;
  vi.resetModules();
  const otherBundle = await import("../../client/cross-daemon/requests.client");
  const write = vi.fn(async () => {});
  await expect(otherBundle.daemonRequest(p, "setPeers", write)).rejects.toThrow("still pending");
  expect(write).not.toHaveBeenCalled();
});
