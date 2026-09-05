import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn as realSpawn } from "node:child_process";
import { TunnelManager } from "../server/tunnels";
import { createServiceLease } from "../server/lease";

vi.mock("../server/lease", () => ({ createServiceLease: vi.fn(async () => async () => true) }));
vi.mock("../server/binaries", () => ({ cloudflaredPath: vi.fn(async () => "fixture-cloudflared") }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((name: string, args: string[], options: object) => name === "fixture-cloudflared"
    ? actual.spawn(process.execPath, ["-e", "console.error('https://fixture-tunnel.trycloudflare.com'); console.error('Registered tunnel connection'); setInterval(() => {}, 1000)"], options)
    : actual.spawn(name, args, options)) };
});
const managers: TunnelManager[] = [];
afterEach(async () => { for (const manager of managers) await manager.close(); managers.length = 0; vi.mocked(createServiceLease).mockReset().mockImplementation(async () => async () => true); });
async function ready(manager: TunnelManager) {
  for (let i = 0; i < 100; i++) { if (manager.list()[0]?.state !== "starting") return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("Tunnel did not become ready");
}
describe("temporary tunnel lifecycle", () => {
  it("starts once per service, keeps credentials out of status, and disposes its own helper", async () => {
    const manager = new TunnelManager(); managers.push(manager);
    const started = await manager.start({ port: 3000, minutes: 15 });
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
    await expect(manager.start({ port: 3000, minutes: 999 })).rejects.toThrow("15, 30, or 60");
    vi.mocked(createServiceLease).mockRejectedValueOnce(new Error("Service is not owned"));
    const result = await manager.start({ port: 3000, minutes: 30 }); await ready(manager);
    expect(manager.list()[0]!.message).toBe("Service is not owned");
    await manager.stop(result.id);
    const second = await manager.start({ port: 3000, minutes: 30 });
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
});
