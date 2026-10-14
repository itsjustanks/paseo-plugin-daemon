import { expect, it } from "vitest";
import { browserRuntimeUpgradeRpc } from "../../shared/managed-browser/browser-runtime-upgrade";
import { BrowserRuntimeUpgrade, type BrowserUpgradeDependencies } from "./browser-upgrade";
import type { UpgradeBinding, UpgradeReceipt } from "./browser-upgrade-receipt";
import { BrowserUpgradeRefusal } from "./browser-upgrade-identity";
const hash = "a".repeat(64);
function binding(): UpgradeBinding {
  const process = { pid: 100, uid: 501, birth: "birth", argvHash: hash, executable: "/private/node" };
  return { owner: process, worker: { ...process, pid: 20 }, plugin: { ...process, pid: 30 },
    runtime: "/private/runtime", homeHash: hash, endpointHash: hash, assetHashes: { node: hash }, profiles: [], descendants: [] };
}
function fixture() {
  let value = binding(), receipt: UpgradeReceipt | null = null, time = 0, stopped = true;
  const events: string[] = [], signals: number[] = [];
  const deps: BrowserUpgradeDependencies = {
    observe: () => { events.push("observe"); return { binding: structuredClone(value), activeBrowserProcesses: 3 }; },
    assertFinal: () => { events.push("final"); }, verifyStopped: () => { events.push("verify"); return stopped; },
    readReceipt: () => receipt, writeReceipt: next => { events.push(next.status); receipt = structuredClone(next); },
    signal: pid => { events.push("TERM"); signals.push(pid); }, now: () => time,
    wait: async () => { time += 250; }, shutdownMs: 500,
  };
  const service = new BrowserRuntimeUpgrade(deps);
  return { service, deps, events, signals, get receipt() { return receipt; }, set binding(next: UpgradeBinding) { value = next; },
    set time(next: number) { time = next; }, set stopped(next: boolean) { stopped = next; } };
}
async function preview(f: ReturnType<typeof fixture>) {
  const result = await f.service.handle({ action: "preview" });
  expect(result.status).toBe("confirmation-required");
  return result.approvalToken!;
}
async function confirm(f: ReturnType<typeof fixture>, token: string) {
  return f.service.handle({ action: "confirm", approvalToken: token, closeAllManagedSessions: true });
}
it("preview is read-only and explains ALL-session impact without exposing identity", async () => {
  const f = fixture(), token = await preview(f);
  expect(f.events).toEqual(["observe"]); expect(f.signals).toEqual([]); expect(f.receipt).toBeNull();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const result = await f.service.handle({ action: "preview" });
  expect(result.message).toContain("ALL"); expect(result.message).toContain("new configuration");
  expect(JSON.stringify(result)).not.toContain("/private");
});
it("Cancel consumes approval without receipt or signal", async () => {
  const f = fixture(), token = await preview(f);
  expect((await f.service.handle({ action: "cancel" })).status).toBe("cancelled");
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.receipt).toBeNull(); expect(f.signals).toEqual([]);
});
it("durably records before fresh final check and one PID TERM, then independent verification", async () => {
  const f = fixture(), token = await preview(f);
  const result = await confirm(f, token); expect(result.status).toBe("complete"); expect(result.message).toContain("profile folders are kept");
  expect(f.events).toEqual(["observe", "observe", "in-progress", "final", "TERM", "verify", "verified"]);
  expect(f.signals).toEqual([100]); expect(f.receipt?.status).toBe("verified");
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.signals).toEqual([100]);
});
it.each(["owner", "worker", "plugin"] as const)("refuses changed %s birth without signalling", async key => {
  const f = fixture(), token = await preview(f), changed = binding();
  changed[key] = { ...changed[key], birth: "reused-pid" }; f.binding = changed;
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.signals).toEqual([]); expect(f.receipt).toBeNull();
});
it.each(["runtime", "homeHash", "endpointHash"] as const)("refuses changed %s approval binding", async key => {
  const f = fixture(), token = await preview(f), changed = binding(); changed[key] += "changed"; f.binding = changed;
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.signals).toEqual([]);
});
it("refuses changed immutable asset hash", async () => {
  const f = fixture(), token = await preview(f), changed = binding(); changed.assetHashes.node = "b".repeat(64); f.binding = changed;
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.signals).toEqual([]);
});
it("expired approval and previous preview token are refused", async () => {
  const f = fixture(), first = await preview(f), second = await preview(f);
  expect((await confirm(f, first)).status).toBe("blocked");
  expect((await confirm(f, second)).status).toBe("blocked"); // Rejected confirmation consumes the preview.
  const third = await preview(f); f.time = 60000;
  expect((await confirm(f, third)).status).toBe("blocked"); expect(f.signals).toEqual([]);
});
it("final identity refusal durably records not-sent and allows a fresh explicit preview", async () => {
  const f = fixture(), token = await preview(f); f.deps.assertFinal = () => { throw Error("secret raw argv"); };
  const result = await confirm(f, token);
  expect(result.status).toBe("not-sent"); expect(f.receipt?.status).toBe("not-sent"); expect(f.signals).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect((await f.service.handle({ action: "recheck" })).status).toBe("not-sent");
  expect(f.events).not.toContain("verify");
  expect((await confirm(f, token)).status).toBe("blocked");
  f.deps.assertFinal = () => { f.events.push("final"); };
  const freshToken = await preview(f); expect(f.signals).toEqual([]);
  expect((await confirm(f, freshToken)).status).toBe("complete"); expect(f.signals).toEqual([100]);
});
it("failed durable not-sent write keeps in-progress fail-closed, including after reload", async () => {
  const f = fixture(), token = await preview(f), write = f.deps.writeReceipt;
  f.deps.assertFinal = () => { throw Error("identity changed"); };
  f.deps.writeReceipt = next => { if (next.status === "not-sent") throw Error("disk failure"); write(next); };
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.receipt?.status).toBe("in-progress"); expect(f.signals).toEqual([]);
  expect((await f.service.handle({ action: "preview" })).status).toBe("unknown");
  const reloaded = new BrowserRuntimeUpgrade(f.deps);
  expect((await reloaded.handle({ action: "preview" })).status).toBe("unknown"); expect(f.signals).toEqual([]);
});
it("durable not-sent survives handler reload but old approval never does", async () => {
  const f = fixture(), token = await preview(f); f.deps.assertFinal = () => { throw Error("identity changed"); };
  await confirm(f, token); const reloaded = new BrowserRuntimeUpgrade(f.deps);
  expect((await reloaded.handle({ action: "confirm", approvalToken: token, closeAllManagedSessions: true })).status).toBe("blocked");
  expect((await reloaded.handle({ action: "preview" })).status).toBe("confirmation-required"); expect(f.signals).toEqual([]);
});
it("any signal-call exception stays unknown even when it resembles identity refusal", async () => {
  const f = fixture(), token = await preview(f);
  f.deps.signal = pid => { f.signals.push(pid); throw Error("final identity check refused"); };
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.receipt?.status).toBe("unknown");
  expect(f.events).not.toContain("not-sent"); expect((await f.service.handle({ action: "preview" })).status).toBe("unknown");
  expect(f.signals).toEqual([100]);
});
it("failure to record signal uncertainty never falls back to not-sent or allows retry", async () => {
  const f = fixture(), token = await preview(f), write = f.deps.writeReceipt;
  f.deps.signal = pid => { f.signals.push(pid); throw Error("uncertain syscall"); };
  f.deps.writeReceipt = next => { if (next.status !== "in-progress") throw Error("write failed"); write(next); };
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.receipt?.status).toBe("in-progress");
  expect((await f.service.handle({ action: "preview" })).status).toBe("unknown"); expect(f.signals).toEqual([100]);
});
it("receipt persistence failure prevents any signal", async () => {
  const f = fixture(), token = await preview(f); f.deps.writeReceipt = () => { throw Error("disk secret"); };
  expect((await confirm(f, token)).status).toBe("blocked"); expect(f.signals).toEqual([]);
});
it("signal error remains unknown and never retries", async () => {
  const f = fixture(), token = await preview(f); f.deps.signal = pid => { f.signals.push(pid); throw Error("EPERM private path"); };
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.receipt?.status).toBe("unknown");
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.signals).toEqual([100]);
});
it("bounded shutdown timeout persists unknown; recheck sends no signal and can verify later", async () => {
  const f = fixture(), token = await preview(f); f.stopped = false;
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.receipt?.status).toBe("unknown");
  expect((await f.service.handle({ action: "preview" })).status).toBe("unknown");
  expect((await f.service.handle({ action: "recheck" })).status).toBe("unknown");
  f.stopped = true;
  expect((await f.service.handle({ action: "recheck" })).status).toBe("complete"); expect(f.signals).toEqual([100]);
});
it("unknown postflight visibility is not interpreted as absence", async () => {
  const f = fixture(), token = await preview(f); f.deps.verifyStopped = () => { throw Error("private stderr"); };
  const result = await confirm(f, token); expect(result.status).toBe("unknown");
  expect(f.receipt?.status).toBe("unknown"); expect(JSON.stringify(result)).not.toContain("stderr");
});
it("failed receipt update after signal reports uncertain outcome", async () => {
  const f = fixture(), token = await preview(f), write = f.deps.writeReceipt;
  f.deps.writeReceipt = next => { if (next.status !== "in-progress") throw Error("disk full"); write(next); };
  expect((await confirm(f, token)).status).toBe("unknown"); expect(f.signals).toEqual([100]); expect(f.receipt?.status).toBe("in-progress");
});
it("serializes concurrent confirmations even while observation awaits", async () => {
  const f = fixture(), token = await preview(f); let release!: () => void;
  f.deps.observe = async () => { await new Promise<void>(resolve => { release = resolve; }); return { binding: binding(), activeBrowserProcesses: 0 }; };
  const running = confirm(f, token);
  expect((await confirm(f, token)).status).toBe("blocked"); release();
  expect((await running).status).toBe("complete"); expect(f.signals).toEqual([100]);
});
it("recheck without a receipt neither observes nor signals", async () => {
  const f = fixture(); expect((await f.service.handle({ action: "recheck" })).status).toBe("blocked"); expect(f.events).toEqual([]);
});
it("unreadable receipt is an uncertain state, never a fresh restart permission", async () => {
  const f = fixture(); f.deps.readReceipt = () => { throw Error("SECRET filesystem path"); };
  const result = await f.service.handle({ action: "preview" }); expect(result.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("SECRET"); expect(f.events).toEqual([]); expect(f.signals).toEqual([]);
});
it("only explicitly safe refusal messages can reach the public client", async () => {
  const f = fixture(); f.deps.observe = () => { throw new BrowserUpgradeRefusal("overlap"); };
  const result = await f.service.handle({ action: "preview" }); expect(result.status).toBe("blocked"); expect(result.message).toContain("overlap");
  f.deps.observe = () => { throw Error("SECRET argv stderr"); };
  expect(JSON.stringify(await f.service.handle({ action: "preview" }))).not.toContain("SECRET");
});
it("contract refuses unconfirmed closure, unknown fields and malformed tokens", () => {
  for (const input of [{ action: "confirm", approvalToken: hash }, { action: "confirm", approvalToken: hash, closeAllManagedSessions: false },
    { action: "confirm", approvalToken: "bad", closeAllManagedSessions: true }, { action: "preview", pid: 1 }]) expect(browserRuntimeUpgradeRpc.input.safeParse(input).success).toBe(false);
});
