import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { connectBrowserCdp, readCdpEndpoint } from "../server/browser-cdp";
const servers: Server[] = [];
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler); servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const port = (instance.address() as { port: number }).port;
  return { instance, port };
}
afterEach(async () => { for (const instance of servers.splice(0)) { instance.closeAllConnections(); await new Promise<void>((resolve) => instance.close(() => resolve())); } });
describe("local CDP transport", () => {
  it("does not follow HTTP discovery redirects", async () => {
    let targetRequests = 0;
    const target = await server((_request, response) => { targetRequests++; response.end("private"); });
    const redirect = await server((_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${target.port}/private` }); response.end(); });
    await expect(readCdpEndpoint({ address: "127.0.0.1", family: 4, port: redirect.port })).rejects.toThrow(); expect(targetRequests).toBe(0);
  });
  it("bounds discovery response bytes and rejects foreign WebSocket endpoints", async () => {
    const oversized = await server((_request, response) => response.end("a".repeat(16385)));
    await expect(readCdpEndpoint({ address: "127.0.0.1", family: 4, port: oversized.port })).rejects.toThrow();
    const foreign = await server((_request, response) => response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://private.example:9222/devtools/browser/test" })));
    await expect(readCdpEndpoint({ address: "127.0.0.1", family: 4, port: foreign.port })).rejects.toThrow("usable local");
  });
  it("does not follow CDP WebSocket redirects", async () => {
    let targetRequests = 0;
    const target = await server((_request, response) => { targetRequests++; response.end(); });
    const redirect = await server((_request, response) => { response.writeHead(302, { Location: `ws://127.0.0.1:${target.port}/private` }); response.end(); });
    await expect(connectBrowserCdp(`ws://127.0.0.1:${redirect.port}/devtools/browser/test`)).rejects.toThrow(); expect(targetRequests).toBe(0);
  });
  it("allows fixed observer commands only and releases pending requests on disconnect", async () => {
    const local = await server((_request, response) => response.end());
    const wss = new WebSocketServer({ server: local.instance }); let methods: string[] = [];
    wss.on("connection", (socket) => socket.on("message", (data) => { const command = JSON.parse(data.toString()); methods.push(command.method); if (command.method === "Target.getTargets") socket.send(JSON.stringify({ id: command.id, result: { targetInfos: [] } })); }));
    const connection = await connectBrowserCdp(`ws://127.0.0.1:${local.port}/devtools/browser/test`);
    await expect(connection.send("Browser.close")).rejects.toThrow("capture commands");
    expect(await connection.send("Target.getTargets")).toEqual({ targetInfos: [] });
    const pending = connection.send("Page.captureScreenshot"); const rejected = expect(pending).rejects.toThrow("disconnected"); connection.close(); await rejected;
    expect(methods).not.toContain("Browser.close"); for (const socket of wss.clients) socket.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("transport deadlines and cleanup", () => {
  it("destroys a stalled HTTP discovery socket at its hard deadline", async () => {
    let closed = false;
    const local = await server((request) => { request.socket.once("close", () => { closed = true; }); });
    await expect(readCdpEndpoint({ address: "127.0.0.1", family: 4, port: local.port })).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it("terminates a stalled WebSocket handshake", async () => {
    const local = await server(() => {}); let closed = false;
    local.instance.on("upgrade", (_request, socket) => { socket.on("close", () => { closed = true; }); socket.on("end", () => socket.destroy()); socket.resume(); });
    await expect(connectBrowserCdp(`ws://127.0.0.1:${local.port}/devtools/browser/test`)).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it("terminates a timed-out CDP command and rejects other pending commands", async () => {
    const local = await server((_request, response) => response.end());
    const wss = new WebSocketServer({ server: local.instance }); let closed = false;
    wss.on("connection", socket => socket.on("close", () => { closed = true; }));
    const connection = await connectBrowserCdp(`ws://127.0.0.1:${local.port}/devtools/browser/test`);
    const capture = expect(connection.send("Page.captureScreenshot")).rejects.toThrow("timed out");
    const pending = expect(connection.send("Target.getTargets")).rejects.toThrow("disconnected");
    await Promise.all([capture, pending]);
    await vi.waitFor(() => expect(closed).toBe(true));
    await expect(connection.send("Target.getTargets")).rejects.toThrow("unavailable");
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
  it("uses a verified IPv6 literal for HTTP and WebSocket discovery without touching same-port IPv4", async () => {
    let foreignRequests = 0;
    const ipv6 = createServer((_request, response) => response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/owned` })));
    servers.push(ipv6); await new Promise<void>(resolve => ipv6.listen({ host: "::1", port: 0, ipv6Only: true }, resolve));
    const port = (ipv6.address() as { port: number }).port;
    const ipv4 = createServer((_request, response) => { foreignRequests++; response.end("foreign"); }); servers.push(ipv4);
    await new Promise<void>(resolve => ipv4.listen(port, "127.0.0.1", resolve));
    const wss = new WebSocketServer({ server: ipv6 });
    wss.on("connection", socket => socket.on("message", data => {
      const command = JSON.parse(data.toString()); socket.send(JSON.stringify({ id: command.id, result: { owned: true } }));
    }));
    const endpoint = await readCdpEndpoint({ address: "::1", family: 6, port });
    expect(endpoint).toBe(`ws://[::1]:${port}/devtools/browser/owned`);
    const connection = await connectBrowserCdp(endpoint);
    try { expect(await connection.send("Target.getTargets")).toEqual({ owned: true }); expect(foreignRequests).toBe(0); }
    finally { connection.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); }
  });
});
