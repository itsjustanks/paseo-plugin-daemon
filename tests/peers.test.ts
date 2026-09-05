import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer } from "node:http";
import { createConnection } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { PeerManager, decodeOffer } from "../server/peers";
import { relayUrl } from "../server/relay";
import { relayFixture } from "./relay-fixture";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "peer-test-")); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }
async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error("Condition timed out");
}

describe("daemon-to-daemon relay", () => {
  it("pairs once, discovers services, forwards HTTP and WebSockets, survives a relay reconnect, and revokes live access", async () => {
    const relay = await relayFixture(); cleanups.push(() => relay.close());
    const marker = `fixture-${Date.now()}-private-payload`;
    const large = Buffer.alloc(2 * 1024 * 1024, "streamed-fixture");
    const http = httpServer((req, res) => { res.setHeader("content-type", "text/plain"); res.end(req.url === "/large" ? large : `${marker}:${req.url}`); });
    const websocket = new WebSocketServer({ server: http });
    websocket.on("connection", (ws) => ws.on("message", (data) => ws.send(data.toString())));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as { port: number }).port;
    cleanups.push(async () => { for (const ws of websocket.clients) ws.terminate(); await new Promise<void>((resolve) => http.close(() => resolve())); });
    let valid = true;
    const hostDir = await directory(), clientDir = await directory();
    const host = new PeerManager(hostDir, async (p) => { if (p !== port) throw new Error(); return async () => valid; }, async () => [{ port, label: "Fixture app", project: null }]);
    const client = new PeerManager(clientDir);
    cleanups.push(() => host.close(), () => client.close());
    const { invitation } = await host.offer({ label: "Remote host", relay: relay.endpoint });
    expect(decodeOffer(invitation).label).toBe("Remote host");
    await expect(host.pair(invitation)).rejects.toThrow("your own computer");
    await client.pair(invitation);
    await client.pair(invitation); // Updating the same host is idempotent.
    const id = (await client.status()).peers[0]!.id;
    await waitFor(async () => (await host.status()).relayState === "connected");
    expect((await client.services(id)).services[0]!.port).toBe(port);
    const forwarded = await client.forward(id, port);
    expect(forwarded.localPort).not.toBe(port); // The fixture occupies that port on this machine.
    expect(await client.forward(id, port)).toEqual(forwarded);
    const response = await fetch(`${forwarded.url}/hello?value=1`);
    expect(await response.text()).toBe(`${marker}:/hello?value=1`);
    const streamed = await fetch(`${forwarded.url}/large`, { headers: { connection: "close" } });
    expect(Buffer.from(await streamed.arrayBuffer()).equals(large)).toBe(true);
    // A client may finish its request with TCP EOF and still expect the complete response.
    const halfClosed = await new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: forwarded.localPort });
      const chunks: Buffer[] = [];
      socket.on("data", (data) => chunks.push(data)); socket.on("error", reject);
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("connect", () => socket.end("GET /large HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    });
    expect(halfClosed.subarray(-large.length).equals(large)).toBe(true);
    const ws = new WebSocket(forwarded.url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const echo = new Promise((resolve) => ws.once("message", (msg) => resolve(msg.toString())));
    ws.send(marker); expect(await echo).toBe(marker);
    expect(Buffer.concat(relay.wire).toString()).not.toContain(marker);
    expect(Buffer.concat(relay.wire).toString()).not.toContain(decodeOffer(invitation).token);
    ws.terminate();
    relay.drop();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await waitFor(async () => (await host.status()).relayState === "connected");
    expect(await (await fetch(`${forwarded.url}/again`)).text()).toContain(marker);
    const persisted = await readFile(join(hostDir, "peers.json"), "utf8");
    expect(persisted).not.toContain(decodeOffer(invitation).token); // Remote stores a digest.
    expect(JSON.stringify(await client.status())).not.toContain(decodeOffer(invitation).token);
    // Keep the host online with a second grant so revocation itself rejects the old token.
    await host.offer({ label: "Second device" });
    const live = new WebSocket(forwarded.url.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => { live.once("open", resolve); live.once("error", reject); });
    const closed = new Promise<void>((resolve) => live.once("close", () => resolve()));
    await host.revoke((await host.status()).grants[0]!.id);
    await closed;
    await expect(client.services(id)).rejects.toThrow("Peer connection failed");
    await client.disconnect((await client.status()).forwards[0]!.id);
    expect((await client.status()).forwards).toEqual([]);
    await client.remove(id);
    expect((await client.status()).peers).toEqual([]);
    valid = false;
  }, 25_000);

  it("keeps pairings across plugin restarts and rejects malformed or insecure invitations", async () => {
    const dir = await directory();
    const host = new PeerManager(await directory());
    cleanups.push(() => host.close());
    await expect(host.pair("wrong")).rejects.toThrow("pairing code");
    expect(() => relayUrl("ws://untrusted.example", "a", "client")).toThrow("wss");
    expect(() => relayUrl("wss://relay.example/other", "a", "client")).toThrow("endpoint");
    expect(() => relayUrl("wss://user:pass@relay.example", "a", "client")).toThrow();
    const relay = await relayFixture(); cleanups.push(() => relay.close());
    const invitation = (await host.offer({ label: "Server", relay: relay.endpoint })).invitation;
    const first = new PeerManager(dir); await first.pair(invitation); await first.close();
    const second = new PeerManager(dir); cleanups.push(() => second.close());
    expect((await second.status()).peers).toHaveLength(1);
    await expect(second.forward("absent", 3000)).rejects.toThrow("Pair this host");
    await second.disconnect("absent");
  });
});
