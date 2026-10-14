import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { assertPreviousBrowserStopped } from "./supervisor-migration";
import { assertUpgradeReceiptVerified, browserDataRoot, readPrivateFile, UpgradeReceiptStore, type UpgradeReceipt } from "./browser-upgrade-receipt";
const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hosts-owned-upgrade-receipt-")); homes.push(home);
  mkdirSync(browserDataRoot(home), { recursive: true, mode: 0o700 });
  const hash = "a".repeat(64), identity = { pid: 42, uid: process.getuid!(), birth: "birth", argvHash: hash, executable: "/private/node" };
  const receipt: UpgradeReceipt = { version: 1, operationId: randomUUID(), protocolFrom: 2, protocolTo: 3, status: "in-progress", createdAt: 1,
    binding: { owner: identity, worker: identity, plugin: identity, runtime: "/private/runtime", homeHash: hash, endpointHash: hash, assetHashes: { node: hash }, profiles: [], descendants: [] } };
  return { home, store: new UpgradeReceiptStore(home), receipt };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it("durable private receipt round-trips; verified and proven not-sent lift only the receipt gate", () => {
  const f = fixture(); expect(f.store.read()).toBeNull(); expect(() => assertUpgradeReceiptVerified(f.home)).not.toThrow();
  f.store.write(f.receipt); expect(f.store.read()).toEqual(f.receipt); expect(lstatSync(f.store.file).mode & 0o777).toBe(0o600);
  expect(() => assertUpgradeReceiptVerified(f.home)).toThrow("unresolved");
  f.store.write({ ...f.receipt, status: "unknown" }); expect(() => assertUpgradeReceiptVerified(f.home)).toThrow("unresolved");
  f.store.write({ ...f.receipt, status: "not-sent" }); expect(f.store.read()?.status).toBe("not-sent");
  expect(() => assertUpgradeReceiptVerified(f.home)).not.toThrow();
  f.store.write({ ...f.receipt, status: "verified" }); expect(() => assertUpgradeReceiptVerified(f.home)).not.toThrow();
});
it("receipt gates startup even after v2 deletes all endpoint/lock/socket metadata", async () => {
  const f = fixture(); f.store.write(f.receipt);
  await expect(assertPreviousBrowserStopped(f.home)).rejects.toThrow("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED");
});
it.each(["verified", "not-sent"] as const)("leftover partial write blocks even when the prior receipt was %s", async status => {
  const f = fixture(); f.store.write({ ...f.receipt, status });
  writeFileSync(f.store.pending, "{partial", { mode: 0o600 });
  expect(() => f.store.read()).toThrow("unresolved");
  await expect(assertPreviousBrowserStopped(f.home)).rejects.toThrow("receipt is unreadable");
  expect(readFileSync(f.store.pending, "utf8")).toBe("{partial");
});
it.each([0o644, 0o666, 0o700])("refuses non-0600 receipt mode %s", mode => {
  const f = fixture(); f.store.write(f.receipt); chmodSync(f.store.file, mode);
  expect(() => f.store.read()).toThrow(); expect(() => assertUpgradeReceiptVerified(f.home)).toThrow("remains blocked");
});
it("refuses receipt symlink and never changes its target", () => {
  const f = fixture(), target = join(f.home, "other"); writeFileSync(target, "untouched", { mode: 0o600 }); symlinkSync(target, f.store.file);
  expect(() => f.store.read()).toThrow(); expect(readFileSync(target, "utf8")).toBe("untouched");
});
it("refuses a symlinked private parent", () => {
  const f = fixture(), root = browserDataRoot(f.home), other = join(f.home, "other");
  rmSync(root, { recursive: true }); mkdirSync(other, { mode: 0o700 }); symlinkSync(other, root);
  expect(() => f.store.write(f.receipt)).toThrow("ownership"); expect(() => lstatSync(f.store.file)).toThrow();
});
it("refuses malformed receipt and unknown fields without deleting evidence", () => {
  const f = fixture(); writeFileSync(f.store.file, JSON.stringify({ ...f.receipt, bypass: true }), { mode: 0o600 });
  expect(() => f.store.read()).toThrow(); expect(readFileSync(f.store.file, "utf8")).toContain("bypass");
});
it("bounded reads refuse oversized private metadata", () => {
  const f = fixture(), file = join(browserDataRoot(f.home), "large"); writeFileSync(file, "12345", { mode: 0o600 });
  expect(() => readPrivateFile(f.home, file, 4)).toThrow("bound");
});
it("exclusive pending write refuses an unresolved writer without overwriting it", () => {
  const f = fixture(); writeFileSync(f.store.pending, "preserved", { mode: 0o600 });
  expect(() => f.store.write(f.receipt)).toThrow(); expect(readFileSync(f.store.pending, "utf8")).toBe("preserved");
});
