import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryService } from "../../server/recovery/service";
import { details, fixture, outcome } from "./fixtures";
import type { SshOutcome } from "../../server/recovery/ssh";
const fixtures: ReturnType<typeof fixture>[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const flush = () => new Promise(resolve => setImmediate(resolve));

describe("reviewed recovery effects", () => {
  it("saves/lists/removes offline and previews without executing", async () => {
    const f = make(), run = vi.fn(async () => { throw new Error("target offline"); }), service = new RecoveryService(f.store, run);
    const p = service.save({ schemaVersion: 1, expectedRevision: 0, details: details() });
    expect(service.list().profiles).toEqual([p]);
    const preview = service.preview(p.id, p.revision, "remove"); expect(run).not.toHaveBeenCalled();
    expect((await service.confirm(preview.token)).code).toBe("removed"); expect(service.list().profiles).toEqual([]); expect(run).not.toHaveBeenCalled();
    await service.close();
  });
  it("consumes confirmation once before any effect, including simultaneous duplicates", async () => {
    const f = make(), p = f.save(), run = vi.fn(async (_args: string[]) => outcome()), service = new RecoveryService(f.store, run);
    const preview = service.preview(p.id, 1, "container_restart");
    expect(run).not.toHaveBeenCalled(); const task = service.confirm(preview.token);
    expect(() => service.confirm(preview.token)).toThrow("already used"); expect((await task).code).toBe("sent");
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][0].at(-1)).toContain("'docker' 'restart'"); await service.close();
  });
  it("profile edits invalidate previews and stale revisions", () => {
    const f = make(), p = f.save(), run = vi.fn(), service = new RecoveryService(f.store, run);
    const preview = service.preview(p.id, 1, "start"); service.save({ schemaVersion: 1, id: p.id, expectedRevision: 1, details: details({ hostname: "edited.example.test" }) });
    expect(() => service.confirm(preview.token)).toThrow("already used"); expect(() => service.test(p.id, 1)).toThrow("changed"); expect(run).not.toHaveBeenCalled();
  });
  it("cancellation and expiry never execute", () => {
    const f = make(), p = f.save(), run = vi.fn(), clock = { now: 1000 }, service = new RecoveryService(f.store, run, () => clock.now);
    const cancelled = service.preview(p.id, 1, "restart"); service.cancel(cancelled.token); service.cancel(cancelled.token);
    expect(() => service.confirm(cancelled.token)).toThrow(); const expired = service.preview(p.id, 1, "reboot"); clock.now += 60_000;
    expect(() => service.confirm(expired.token, p.name)).toThrow("expired"); expect(run).not.toHaveBeenCalled();
  });
  it("requires exact target name for reboot and disallows container action on systemd", async () => {
    const f = make(), p = f.save(), run = vi.fn(async (_args: string[]) => outcome()), service = new RecoveryService(f.store, run);
    const bad = service.preview(p.id, 1, "reboot"); expect(() => service.confirm(bad.token, "wrong")).toThrow("did not match"); expect(run).not.toHaveBeenCalled();
    const good = service.preview(p.id, 1, "reboot"); expect((await service.confirm(good.token, p.name)).message).toMatch(/not verified/);
    const systemd = f.save({ preset: "systemd" }); expect(() => service.preview(systemd.id, 1, "container_restart")).toThrow("Docker"); await service.close();
  });
  it("serialises each profile, bounds global concurrency and blocks edits/removal while pending", async () => {
    const f = make(), profiles = [f.save(), f.save(), f.save()];
    const releases: Array<(value: SshOutcome) => void> = [];
    const run = vi.fn(() => new Promise<SshOutcome>(resolve => releases.push(resolve))), service = new RecoveryService(f.store, run);
    const first = service.test(profiles[0].id, 1); const second = service.test(profiles[1].id, 1); const queued = service.test(profiles[2].id, 1); await flush();
    expect(run).toHaveBeenCalledTimes(2); expect((await service.test(profiles[0].id, 1)).code).toBe("busy");
    expect(() => service.save({ schemaVersion: 1, id: profiles[0].id, expectedRevision: 1, details: details() })).toThrow("Wait");
    const remove = service.preview(profiles[0].id, 1, "remove"); expect(() => service.confirm(remove.token)).toThrow("Wait");
    releases.shift()!(outcome()); await first; await flush(); expect(run).toHaveBeenCalledTimes(3);
    releases.shift()!(outcome()); releases.shift()!(outcome()); await Promise.all([second, queued]); await service.close();
  });
  it("rechecks expiry after queue admission", async () => {
    const f = make(), p = [f.save(), f.save(), f.save()], clock = { now: 1000 }, releases: Array<(value: SshOutcome) => void> = [];
    const run = vi.fn(() => new Promise<SshOutcome>(resolve => releases.push(resolve))), service = new RecoveryService(f.store, run, () => clock.now);
    const active = [service.test(p[0].id, 1), service.test(p[1].id, 1)]; await flush();
    const preview = service.preview(p[2].id, 1, "container_restart"), queued = service.confirm(preview.token); clock.now += 60_001;
    releases.shift()!(outcome()); await flush(); expect((await queued).code).toBe("cancelled"); expect(run).toHaveBeenCalledTimes(2);
    releases.shift()!(outcome()); await Promise.all(active); await service.close();
  });
  it("cleanup cancels active and queued work, without spawning the queued child", async () => {
    const f = make(), p = [f.save(), f.save(), f.save()];
    const run = vi.fn((_args: string[], signal: AbortSignal) => new Promise<SshOutcome>(resolve => signal.addEventListener("abort", () => resolve(outcome({ cancelled: true })), { once: true })));
    const service = new RecoveryService(f.store, run), active = [service.test(p[0].id, 1), service.test(p[1].id, 1)], queued = service.test(p[2].id, 1); await flush();
    await service.close(); expect((await queued).code).toBe("cancelled"); await Promise.all(active); expect(run).toHaveBeenCalledTimes(2);
    expect(() => service.list()).toThrow("stopping"); expect(() => service.preview(p[0].id, 1, "start")).toThrow("stopping"); await service.close();
  });
  it("never retries uncertain container restart or reboot and never claims recovered", async () => {
    const f = make(), p = f.save(), run = vi.fn(async () => outcome({ timedOut: true, exitCode: null })), service = new RecoveryService(f.store, run);
    for (const action of ["container_restart", "reboot"] as const) {
      const preview = service.preview(p.id, 1, action); const result = await service.confirm(preview.token, p.name);
      expect(result.code).toBe("uncertain"); expect(result.message).not.toContain("recovered");
    }
    expect(run).toHaveBeenCalledTimes(2); await service.close();
  });
  it("bounds pending previews and prunes expired ones", () => {
    const f = make(), p = f.save(), clock = { now: 0 }, service = new RecoveryService(f.store, vi.fn(), () => clock.now);
    for (let i = 0; i < 100; i++) service.preview(p.id, 1, "start"); expect(() => service.preview(p.id, 1, "start")).toThrow("Too many");
    clock.now += 60_000; expect(service.preview(p.id, 1, "start").expiresAt).toBe(120_000);
  });
  it("converts unexpected runner errors to generic messages", async () => {
    const f = make(), p = f.save(), service = new RecoveryService(f.store, async () => { throw new Error("fixture-sensitive-value"); });
    const result = await service.test(p.id, 1); expect(result.code).toBe("failed"); expect(JSON.stringify(service.list())).not.toContain("fixture-sensitive-value"); await service.close();
  });
});
