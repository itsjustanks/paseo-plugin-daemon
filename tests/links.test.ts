import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProfileSchema } from "../shared/link";
import { sshArgs, sshFailure, portReady, requireFreePort, stopChild } from "../server/ssh";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { LinkManager } from "../server/links";
import { tunnelOrigin, cloudflaredArgs } from "../server/tunnels";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
describe("saved private connections", () => {
  it("bounds profile input and constructs key-based SSH with fixed argv", () => {
    const profile = ProfileSchema.parse({ id: randomUUID(), name: "Example", destination: "me@host.example", remotePort: 3000, localPort: 3001 });
    expect(profile.autoConnect).toBe(false);
    const args = sshArgs(profile);
    expect(args).toContain("127.0.0.1:3001:127.0.0.1:3000");
    expect(args).toContain("BatchMode=yes"); expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    for (const destination of ["-oProxyCommand=bad", "host;echo bad", "$(bad)", "host name"]) expect(ProfileSchema.safeParse({ ...profile, destination }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...profile, localPort: 80 }).success).toBe(false);
    for (const msg of ["Address already in use", "Host key verification failed", "Permission denied", "Could not resolve hostname", "unknown"]) expect(sshFailure(msg)).not.toBe(msg);
  });
  it("detects occupied ports and stops only a child it owns", async () => {
    const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await portReady(port)).toBe(true); await expect(requireFreePort(port)).rejects.toThrow("already in use");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await portReady(port)).toBe(false); await requireFreePort(port);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await stopChild(child); expect(child.signalCode).toBe("SIGTERM"); await stopChild(child); await stopChild(undefined);
  });
  it("persists profiles, rejects duplicates, and preserves unrelated profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "links-test-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "profiles.json");
    const manager = new LinkManager(file); cleanup.push(() => manager.close());
    const input = { name: "Dev", destination: "host.example", remotePort: 3000, localPort: 3001, sshPort: 22, autoConnect: false };
    await manager.save(input); await manager.save({ ...input, name: "Second", localPort: 3002 });
    expect((await manager.status()).profiles).toHaveLength(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(manager.save(input)).rejects.toThrow("already uses");
    const first = (await manager.status()).profiles[0]!;
    await manager.disconnect(first.id); await manager.remove(first.id);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
    await expect(manager.connect(randomUUID())).rejects.toThrow("no longer exists");
    await manager.close(); await expect(manager.save(input)).rejects.toThrow("stopping");
    await writeFile(file, "not json");
    const invalid = new LinkManager(file); cleanup.push(() => invalid.close());
    await expect(invalid.status()).rejects.toThrow("invalid");
  });
  it("accepts only the expected quick-tunnel origin and forces a TCP relay transport", () => {
    expect(tunnelOrigin("https://a-b-c.trycloudflare.com")).toBe("https://a-b-c.trycloudflare.com");
    expect(tunnelOrigin("https://untrusted.example")).toBeUndefined();
    expect(cloudflaredArgs(3100, "/tmp/config.yaml")).toContain("http2");
  });
});
