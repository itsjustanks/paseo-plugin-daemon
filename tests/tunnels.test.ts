import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn as realSpawn } from "node:child_process";
import { TunnelManager } from "../server/tunnels";
import { createServiceLease } from "../server/lease";
import { TUNNEL_MAX_LIFETIME_MS } from "../shared/tunnel-lease";

vi.mock("../server/lease", () => ({ createServiceLease: vi.fn(async () => async () => true) }));
vi.mock("../server/binaries", () => ({ cloudflaredPath: vi.fn(async () => "fixture-cloudflared") }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((name: string, args: string[], options: object) => name === "fixture-cloudflared"
    ? actual.spawn(process.execPath, ["-e", "console.error('https://fixture-tunnel.trycloudflare.com'); console.error('Registered tunnel connection'); setInterval(() => {}, 1000)"], options)
    : actual.spawn(name, args, options)) };
});
const managers: TunnelManager[] = [];
afterEach(async () => { for (const manager of managers) await manager.close(); managers.length = 0; vi.mocked(createServiceLease).mockReset().mockImplementation(async () => async () => true); vi.useRealTimers(); });
async function ready(manager: TunnelManager) {
  for (let i = 0; i < 100; i++) { if (manager.list()[0]?.state !== "starting") return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("Tunnel did not become ready");
}
describe("temporary tunnel lifecycle", () => {
  it("starts once per service, keeps credentials out of status, and disposes its own helper", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    const started = await manager.start({ port: 3000, minutes: 15 });
    expect(started.expiresAt - started.createdAt).toBe(15 * 60_000);
    expect((await manager.start({ port: 3000, minutes: 15 })).id).toBe(started.id);
    expect(() => manager.open(started.id)).toThrow("not ready");
    await ready(manager);
    expect(manager.list()[0]!.state).toBe("connected");
    const url = manager.open(started.id).url;
    expect(new URL(url).hash.length).toBeGreaterThan(30);
    expect(JSON.stringify(manager.list())).not.toContain(new URL(url).hash.slice(1));
    await manager.stop(started.id); expect(manager.list()).toEqual([]);
    await manager.stop(started.id);
    await manager.close(); await expect(manager.start({ port: 3000, minutes: 15 })).rejects.toThrow("stopping");
  });
  it("rejects an unowned service and invalid duration, and handles stop during startup", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    await expect(manager.start({ port: 3000, minutes: 999 })).rejects.toThrow("15 min, 30 min, 1 h, 2 h, 4 h, 8 h");
    await expect(manager.start({ port: 3000, minutes: 45 })).rejects.toThrow("Choose a link");
    vi.mocked(createServiceLease).mockRejectedValueOnce(new Error("Service is not owned"));
    const result = await manager.start({ port: 3000, minutes: 30 }); await ready(manager);
    expect(manager.list()[0]!.message).toBe("Service is not owned");
    await manager.stop(result.id);
    const second = await manager.start({ port: 3000, minutes: 480 });
    expect(second.expiresAt - second.createdAt).toBe(480 * 60_000);
    await manager.stop(second.id); expect(manager.list()).toEqual([]);
  });
  it("revokes a link when the original service stops", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    let valid = true;
    vi.mocked(createServiceLease).mockImplementationOnce(async () => async () => valid);
    const started = await manager.start({ port: 3000, minutes: 15 }); await ready(manager);
    valid = false;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(manager.list()[0]!.state).toBe("error");
    expect(() => manager.open(started.id)).toThrow("not ready");
  });
  it("extends a live link in place without changing its URL or session, and never past the lifetime cap", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    const started = await manager.start({ port: 3000, minutes: 15 }); await ready(manager);
    const before = manager.open(started.id).url;
    const renewed = manager.extend(started.id, 120);
    expect(renewed.id).toBe(started.id);
    expect(renewed.createdAt).toBe(started.createdAt);
    expect(renewed.expiresAt).toBeGreaterThan(started.expiresAt);
    expect(renewed.expiresAt - Date.now()).toBeGreaterThan(119 * 60_000);
    expect(manager.list()[0]!.state).toBe("connected");
    // Same gate, same token: an open browser session keeps working.
    expect(manager.open(started.id).url).toBe(before);
    // A shorter renewal than what is left changes nothing.
    expect(manager.extend(started.id, 15).expiresAt).toBe(renewed.expiresAt);
    expect(() => manager.extend(started.id, 45)).toThrow("Choose a link");
    expect(() => manager.extend("00000000-0000-4000-8000-000000000009", 15)).toThrow("no longer live");
    // Once the link has lived its 24 hours, renewal is refused rather than silently capped to nothing.
    vi.useFakeTimers({ now: started.createdAt + TUNNEL_MAX_LIFETIME_MS, toFake: ["Date"] });
    expect(() => manager.extend(started.id, 480)).toThrow("24-hour lifetime");
    vi.useRealTimers();
    await manager.stop(started.id);
    expect(() => manager.extend(started.id, 15)).toThrow("no longer live");
  });
  it("refuses to extend a failed link", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    vi.mocked(createServiceLease).mockRejectedValueOnce(new Error("Service is not owned"));
    const failed = await manager.start({ port: 3000, minutes: 30 }); await ready(manager);
    expect(manager.list()[0]!.state).toBe("error");
    expect(() => manager.extend(failed.id, 60)).toThrow("no longer live");
  });
});
