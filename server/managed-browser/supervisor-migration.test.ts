import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertPreviousBrowserStopped } from "./supervisor-migration";
import { resolveSupervisorPaths } from "./supervisor-paths";
import { SupervisorClient } from "./supervisor-client";
const homes: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hosts-owned-protocol-rollover-")); homes.push(home);
  const old = resolveSupervisorPaths(home, 2); const current = resolveSupervisorPaths(home);
  await mkdir(old.root, { recursive: true, mode: 0o700 });
  await writeFile(old.endpoint, JSON.stringify({ version: 2, socket: old.socket }), { mode: 0o600 });
  await writeFile(old.token, "owned-fixture-token", { mode: 0o600 });
  const profile = join(home, "plugin-data/daemon-link/browser/profiles/saved");
  await mkdir(profile, { recursive: true }); await writeFile(join(profile, "saved.txt"), "retained site data");
  return { home, old, current, profile };
}
it("refuses a live previous owner without claiming it or changing saved profile data", async () => {
  const f = await fixture(); let commands = 0; let connections = 0;
  const server = createServer((socket) => { connections++; socket.on("data", () => { commands++; }); }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(f.old.socket, resolve));
  await expect(assertPreviousBrowserStopped(f.home)).rejects.toThrow("previous workspace browser runtime is still running");
  expect(server.listening).toBe(true); expect(connections).toBe(1); expect(commands).toBe(0);
  expect(await readFile(join(f.profile, "saved.txt"), "utf8")).toBe("retained site data");
  expect(f.current.root).toContain("supervisor-v3"); expect(f.current.socket).not.toBe(f.old.socket);
  const client = new SupervisorClient({ bridgeId: "owned-stale-client", paths: f.old });
  await expect(client.connect()).rejects.toThrow("protocol mismatch"); client.disconnect();
  expect(connections).toBe(1);
});
it("permits upgrade after the old socket stopped, retaining metadata and saved profile", async () => {
  const f = await fixture(); await expect(assertPreviousBrowserStopped(f.home)).resolves.toBeUndefined();
  expect(JSON.parse(await readFile(f.old.endpoint, "utf8")).version).toBe(2);
  expect(await readFile(join(f.profile, "saved.txt"), "utf8")).toBe("retained site data");
});
it("never probes an endpoint substituted outside the owned protocol namespace", async () => {
  const f = await fixture(); await writeFile(f.old.endpoint, JSON.stringify({ version: 2, socket: "/tmp/unrelated.sock" }));
  await expect(assertPreviousBrowserStopped(f.home)).rejects.toThrow("does not match");
});
