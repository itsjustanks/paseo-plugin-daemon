import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RpcInput } from "@getpaseo/plugin";
import { BROWSER_RUNTIME_RESTART_IMPACT, BROWSER_RUNTIME_RESTART_RECOVERY, type BrowserRuntimeUpgradeReply, type browserRuntimeUpgradeRpc } from "../../shared/managed-browser/browser-runtime-upgrade";
import { BrowserUpgradeIdentity, BrowserUpgradeRefusal, sameBoundProcess } from "./browser-upgrade-identity";
import { UpgradeReceiptStore, type UpgradeBinding, type UpgradeReceipt } from "./browser-upgrade-receipt";

export interface BrowserUpgradeDependencies {
  observe(): { binding: UpgradeBinding; activeBrowserProcesses: number } | Promise<{ binding: UpgradeBinding; activeBrowserProcesses: number }>;
  assertFinal(binding: UpgradeBinding): void;
  verifyStopped(binding: UpgradeBinding, deadline?: number, requireOriginalActor?: boolean): boolean;
  readReceipt(): UpgradeReceipt | null;
  writeReceipt(receipt: UpgradeReceipt): void;
  signal(pid: number): void;
  now(): number;
  wait(): Promise<void>;
  shutdownMs: number;
}
function sameApproval(a: UpgradeBinding, b: UpgradeBinding): boolean {
  return sameBoundProcess(a.owner, b.owner) && sameBoundProcess(a.worker, b.worker) && sameBoundProcess(a.plugin, b.plugin)
    && a.runtime === b.runtime && a.homeHash === b.homeHash && a.endpointHash === b.endpointHash
    && JSON.stringify(a.assetHashes) === JSON.stringify(b.assetHashes);
}
const reply = (status: BrowserRuntimeUpgradeReply["status"], message: string): BrowserRuntimeUpgradeReply => ({ status, message });

/** One preview, one approval, one PID signal. Neither timeouts nor rechecks repeat it. */
export class BrowserRuntimeUpgrade {
  private preview: { token: string; expiresAt: number; binding: UpgradeBinding } | null = null;
  private busy = false;
  constructor(private readonly deps: BrowserUpgradeDependencies) {}
  async handle(input: RpcInput<typeof browserRuntimeUpgradeRpc>): Promise<BrowserRuntimeUpgradeReply> {
    if (this.busy) return reply("blocked", "A browser runtime restart is already being checked. Wait for its result, then recheck.");
    if (input.action === "cancel") { this.preview = null; return reply("cancelled", "Browser runtime restart cancelled. No signal was sent."); }
    this.busy = true;
    let signalPossible = false;
    let receiptRecorded = false;
    let checkingReceipt = true;
    try {
      const receipt = this.deps.readReceipt();
      checkingReceipt = false;
      if (input.action === "recheck") {
        this.preview = null;
        if (!receipt) return reply("blocked", "No restart receipt exists. Inspect the previous runtime before confirming a restart.");
        if (receipt.status === "not-sent") return reply("not-sent", "No signal was sent. Inspect the previous runtime again before confirming a new restart.");
        if (receipt.status === "verified") return reply("complete", "The previous Hosts browser runtime was stopped and verified. Saved profile folders are kept. Open browser when ready and create new browser-enabled agents.");
        return this.reconcile(receipt, false);
      }
      if (receipt && receipt.status !== "verified" && receipt.status !== "not-sent") { this.preview = null; return reply("unknown", BROWSER_RUNTIME_RESTART_RECOVERY); }
      if (input.action === "preview") {
        this.preview = null;
        const observed = await this.deps.observe();
        const token = randomBytes(32).toString("hex"), expiresAt = this.deps.now() + 60_000;
        this.preview = { token, expiresAt, binding: observed.binding };
        return { status: "confirmation-required", message: BROWSER_RUNTIME_RESTART_IMPACT, approvalToken: token, expiresAt,
          activeBrowserProcesses: observed.activeBrowserProcesses };
      }
      const preview = this.preview;
      this.preview = null; // Consume even an expired, rejected or failed approval.
      if (!preview || preview.token !== input.approvalToken || preview.expiresAt <= this.deps.now() || input.closeAllManagedSessions !== true) return reply("blocked", "Restart approval expired or was already used. Inspect again before confirming.");
      const fresh = await this.deps.observe();
      if (!sameApproval(preview.binding, fresh.binding)) return reply("blocked", "The previous runtime or daemon identity changed. No signal was sent. Inspect again.");
      const operation: UpgradeReceipt = { version: 1, operationId: randomUUID(), protocolFrom: 2, protocolTo: 3,
        status: "in-progress", createdAt: this.deps.now(), binding: fresh.binding };
      this.deps.writeReceipt(operation); // Durable before the final check and before any signal.
      receiptRecorded = true;
      try {
        this.deps.assertFinal(operation.binding);
      } catch {
        // This synchronous check returned by throwing before the signal call.
        // Persist that known outcome; a failed write retains the in-progress gate.
        this.deps.writeReceipt({ ...operation, status: "not-sent" });
        return reply("not-sent", "No signal was sent because the final identity check refused. Inspect again before confirming a new restart.");
      }
      signalPossible = true; // Crossing this boundary is never classified not-sent.
      try {
        this.deps.signal(operation.binding.owner.pid); // No await, group signal, escalation or retry.
      } catch {
        this.deps.writeReceipt({ ...operation, status: "unknown" });
        return reply("unknown", BROWSER_RUNTIME_RESTART_RECOVERY);
      }
      return await this.reconcile(operation, true);
    } catch (error) {
      this.preview = null;
      if (!signalPossible && error instanceof BrowserUpgradeRefusal) return reply("blocked", error.message);
      // Raw OS stderr, argv, endpoint tokens and filesystem paths never reach the client.
      return reply(signalPossible || receiptRecorded || checkingReceipt ? "unknown" : "blocked", "Browser runtime restart could not be verified safely. No additional signal will be sent. Recheck an existing restart, or restart this host's container or computer and recheck. If its receipt remains unreadable, seek help; no files will be deleted automatically.");
    } finally { this.busy = false; }
  }
  private async reconcile(receipt: UpgradeReceipt, waitForExit: boolean): Promise<BrowserRuntimeUpgradeReply> {
    const deadline = this.deps.now() + (waitForExit ? this.deps.shutdownMs : 0);
    try {
      do {
        if (this.deps.verifyStopped(receipt.binding, waitForExit ? deadline : undefined, waitForExit)) {
          this.deps.writeReceipt({ ...receipt, status: "verified" });
          return reply("complete", "The previous Hosts browser runtime stopped and was verified. Saved profile folders are kept. Open browser when ready and create new browser-enabled agents.");
        }
        if (this.deps.now() >= deadline) break;
        await this.deps.wait();
      } while (this.deps.now() < deadline);
    } catch { /* Unknown process visibility and missing profiles stay blocked. */ }
    this.deps.writeReceipt({ ...receipt, status: "unknown" });
    return reply("unknown", BROWSER_RUNTIME_RESTART_RECOVERY);
  }
}

export function createBrowserRuntimeUpgrade(home: string): BrowserRuntimeUpgrade {
  const identity = new BrowserUpgradeIdentity({ home }), store = new UpgradeReceiptStore(home);
  return new BrowserRuntimeUpgrade({
    observe: async () => { const observed = identity.observe(); await identity.assertListenerLive(); identity.assertFinal(observed.binding); return observed; },
    assertFinal: binding => identity.assertFinal(binding), verifyStopped: (binding, deadline, sameActor) => identity.verifyStopped(binding, deadline, sameActor),
    readReceipt: () => store.read(), writeReceipt: receipt => store.write(receipt),
    signal: pid => { process.kill(pid, "SIGTERM"); }, now: () => Date.now(), wait: () => delay(1000), shutdownMs: 30_000,
  });
}
