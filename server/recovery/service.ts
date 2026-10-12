import { randomUUID } from "node:crypto";
import type { RecoveryAction, RecoveryPreview, RecoveryProfile, RecoveryResult, RecoverySave } from "../../shared/recovery";
import { RecoveryStore } from "./store";
import { remoteCommand, sshArgs } from "./commands";
import { classifySsh, createSshRun, type SshRun } from "./ssh";

/** A small bounded queue; closing rejects queued work before any child is spawned. */
class Slots {
  private active = 0;
  private closed = false;
  private queue: Array<{ resolve: (release: () => void) => void; reject: () => void }> = [];
  constructor(private readonly max = 2) {}
  take(): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error("Recovery is stopping."));
    if (this.active < this.max) { this.active++; return Promise.resolve(() => this.release()); }
    if (this.queue.length >= 20) return Promise.reject(new Error("Recovery is busy. Wait for another operation to finish."));
    return new Promise((resolve, reject) => this.queue.push({ resolve, reject: () => reject(new Error("Recovery is stopping.")) }));
  }
  private release(): void {
    const next = this.queue.shift();
    if (next && !this.closed) next.resolve(() => this.release()); else this.active--;
  }
  close(): void { this.closed = true; for (const item of this.queue.splice(0)) item.reject(); }
}
const result = (code: RecoveryResult["code"], message: string, now: number): RecoveryResult => ({ code, message, checkedAt: now, state: "unknown" });
export class RecoveryService {
  private readonly previews = new Map<string, RecoveryPreview>();
  private readonly checks = new Map<string, RecoveryResult>();
  private readonly busy = new Set<string>();
  private readonly slots = new Slots();
  private readonly abort = new AbortController();
  private readonly work = new Set<Promise<RecoveryResult>>();
  constructor(readonly store: RecoveryStore, private readonly run: SshRun = createSshRun(), private readonly now: () => number = Date.now) {}
  private available(): void { if (this.abort.signal.aborted) throw new Error("Recovery is stopping."); }
  list() { this.available(); const profiles = this.store.list(); return { profiles, checks: Object.fromEntries(profiles.flatMap(p => { const check = this.checks.get(p.id); return check ? [[p.id, check]] : []; })) }; }
  save(input: RecoverySave): RecoveryProfile {
    this.available();
    if (input.id && this.busy.has(input.id)) throw new Error("Wait for this connection's current operation before editing it.");
    const profile = this.store.save(input);
    for (const [token, preview] of this.previews) if (preview.profile.id === profile.id) this.previews.delete(token);
    this.checks.delete(profile.id); return profile;
  }
  preview(id: string, revision: number, action: RecoveryAction): RecoveryPreview {
    this.available(); const profile = this.store.get(id, revision);
    if (action === "container_restart" && profile.preset !== "docker") throw new Error("Container restart requires the Docker preset.");
    for (const [token, p] of this.previews) if (p.expiresAt <= this.now()) this.previews.delete(token);
    if (this.previews.size >= 100) throw new Error("Too many pending confirmations. Cancel one or wait a minute.");
    const preview = { token: randomUUID(), profile, action, expiresAt: this.now() + 60_000 };
    this.previews.set(preview.token, preview); return preview;
  }
  cancel(token: string) { this.previews.delete(token); return { ok: true as const }; }
  confirm(token: string, targetName?: string): Promise<RecoveryResult> {
    this.available(); const preview = this.previews.get(token);
    // Consume synchronously before validation, queueing, or effects. Duplicate requests cannot replay it.
    this.previews.delete(token);
    if (!preview || preview.expiresAt <= this.now()) throw new Error("This confirmation expired or was already used. Review the action again.");
    const profile = this.store.get(preview.profile.id, preview.profile.revision);
    if (preview.action === "reboot" && targetName !== profile.name) throw new Error("The target name did not match. Review the reboot again.");
    if (preview.action === "remove") {
      if (this.busy.has(profile.id)) throw new Error("Wait for this connection's operation before removing it.");
      this.store.remove(profile.id, profile.revision); this.checks.delete(profile.id);
      for (const [key, other] of this.previews) if (other.profile.id === profile.id) this.previews.delete(key);
      return Promise.resolve(result("removed", "Saved connection removed. No target command was run.", this.now()));
    }
    return this.operate(profile, preview.action, preview.expiresAt);
  }
  test(id: string, revision: number): Promise<RecoveryResult> { this.available(); return this.operate(this.store.get(id, revision), "test"); }
  private operate(profile: RecoveryProfile, action: "test" | Exclude<RecoveryAction, "remove">, expiresAt = Infinity): Promise<RecoveryResult> {
    if (this.busy.has(profile.id)) return Promise.resolve(result("busy", "Another operation is already pending for this connection.", this.now()));
    this.busy.add(profile.id);
    const task = (async () => {
      let release: (() => void) | undefined;
      try {
        release = await this.slots.take();
        this.available(); this.store.get(profile.id, profile.revision);
        if (expiresAt <= this.now()) return result("cancelled", "Confirmation expired while waiting. Review the action again.", this.now());
        const outcome = await this.run(sshArgs(profile, remoteCommand(profile, action)), this.abort.signal);
        const checked = classifySsh(outcome, action !== "test", this.now(), action === "reboot");
        this.checks.set(profile.id, checked); return checked;
      } catch { return result(this.abort.signal.aborted ? "cancelled" : "failed", this.abort.signal.aborted ? "Recovery stopped. Queued work was cancelled." : "Recovery could not complete. Refresh the connection and review it again.", this.now()); }
      finally { release?.(); this.busy.delete(profile.id); }
    })();
    this.work.add(task); void task.finally(() => this.work.delete(task)); return task;
  }
  async close(): Promise<void> {
    this.abort.abort(); this.slots.close(); this.previews.clear(); this.checks.clear();
    // The production SSH runner terminates its exact child within 500 ms. Never hold plugin teardown indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.work]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
  }
}
