import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("node:net", () => ({ createConnection: () => {
  const socket = new EventEmitter() as any; socket.destroy = vi.fn(); network.sockets.push(socket); return socket;
} }));
import { assertPreviousBrowserStopped } from "./supervisor-migration";
import { browserDataRoot, UpgradeReceiptStore, type UpgradeReceipt } from "./browser-upgrade-receipt";
import { resolveSupervisorPaths } from "./supervisor-paths";
import { BrowserUpgradeIdentity } from "./browser-upgrade-identity";
const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hosts-owned-upgrade-admission-")); homes.push(home);
  const old = resolveSupervisorPaths(home, 2); mkdirSync(old.root, { recursive: true, mode: 0o700 });
  writeFileSync(old.endpoint, JSON.stringify({ version: 2, socket: old.socket }), { mode: 0o600 });
  const hash = "a".repeat(64), owner = { pid: 100, uid: process.getuid!(), birth: "before", executable: "/private/node", argvHash: hash };
  const receipt: UpgradeReceipt = { version: 1, operationId: randomUUID(), protocolFrom: 2, protocolTo: 3, status: "in-progress", createdAt: 1,
    binding: { owner, plugin: owner, worker: owner, runtime: "/private/runtime", homeHash: hash, endpointHash: hash, assetHashes: {}, profiles: [], descendants: [] } };
  return { home, old, receipt, store: new UpgradeReceiptStore(home) };
}
afterEach(() => { for (const socket of network.sockets.splice(0)) socket.removeAllListeners(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); vi.useRealTimers(); });
it("pending receipt appearing during async socket probe blocks admission after v2 disappears", async () => {
  const f = fixture(), outcome = assertPreviousBrowserStopped(f.home).then(() => null, error => error as Error);
  await vi.waitFor(() => expect(network.sockets).toHaveLength(1), { timeout: 200, interval: 5 });
  f.store.write(f.receipt); rmSync(f.old.endpoint);
  network.sockets.at(-1).emit("error", Object.assign(Error("gone"), { code: "ECONNREFUSED" }));
  expect((await outcome)?.message).toContain("restart is unresolved"); expect(network.sockets.at(-1).destroy).toHaveBeenCalled();
});
it("pending receipt blocks before any socket probe when v2 removed its metadata", async () => {
  const f = fixture(); f.store.write(f.receipt); rmSync(f.old.endpoint);
  await expect(assertPreviousBrowserStopped(f.home)).rejects.toThrow("restart is unresolved"); expect(network.sockets).toEqual([]);
});
it("durable not-sent never bypasses a still-live v2 listener", async () => {
  const f = fixture(); f.store.write({ ...f.receipt, status: "not-sent" });
  const outcome = assertPreviousBrowserStopped(f.home).then(() => null, error => error as Error);
  await vi.waitFor(() => expect(network.sockets).toHaveLength(1), { timeout: 200, interval: 5 });
  network.sockets.at(-1).emit("connect");
  expect((await outcome)?.message).toContain("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED");
  expect(f.store.read()?.status).toBe("not-sent");
});
it("proven not-sent permits ordinary stopped-listener admission without claiming shutdown", async () => {
  const f = fixture(); f.store.write({ ...f.receipt, status: "not-sent" });
  const outcome = assertPreviousBrowserStopped(f.home);
  await vi.waitFor(() => expect(network.sockets).toHaveLength(1), { timeout: 200, interval: 5 });
  network.sockets.at(-1).emit("error", Object.assign(Error("gone"), { code: "ECONNREFUSED" }));
  await expect(outcome).resolves.toBeUndefined(); expect(f.store.read()?.status).toBe("not-sent");
});
it("liveness probe never sends commands, claims a bridge or reads a token", async () => {
  const f = fixture(), outcome = assertPreviousBrowserStopped(f.home).then(() => null, error => error as Error);
  await vi.waitFor(() => expect(network.sockets).toHaveLength(1), { timeout: 200, interval: 5 });
  expect(network.sockets.at(-1).write).toBeUndefined(); network.sockets.at(-1).emit("connect");
  expect((await outcome)?.message).toContain("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED");
});
it("listener observation timeout refuses, destroys only its own probe socket", async () => {
  vi.useFakeTimers(); const f = fixture(), identity = new BrowserUpgradeIdentity({ home: f.home });
  const probe = identity.assertListenerLive(), refused = expect(probe).rejects.toThrow("listener is unavailable");
  await vi.advanceTimersByTimeAsync(250); await refused; expect(network.sockets.at(-1).destroy).toHaveBeenCalled();
});
it("listener observation succeeds only on connect; refusal remains distinct", async () => {
  const f = fixture(), identity = new BrowserUpgradeIdentity({ home: f.home });
  const ok = identity.assertListenerLive(); network.sockets.at(-1).emit("connect"); await expect(ok).resolves.toBeUndefined();
  const no = identity.assertListenerLive(), refused = expect(no).rejects.toThrow("listener is unavailable");
  network.sockets.at(-1).emit("error", Error("private raw stderr")); await refused;
  expect(browserDataRoot(f.home)).toContain("plugin-data");
});
