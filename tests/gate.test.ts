import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createGate, type Gate } from "../server/gate";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
function call(gate: Gate, path = "/", headers: IncomingHttpHeaders = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: gate.port, path, method, headers: { host: "fixture.example", ...headers } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (data) => chunks.push(data));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function fixture() {
  let seen: IncomingHttpHeaders = {};
  const app = createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/redirect") { res.writeHead(302, { location: `http://localhost:${(app.address() as { port: number }).port}/login` }); res.end(); return; }
    if (req.url === "/relative") { res.writeHead(302, { location: "/login" }); res.end(); return; }
    res.setHeader("set-cookie", ["app=value; Path=/"]);
    res.end(req.url?.startsWith("/_next/") ? "dev-resource" : "app-response");
  });
  const websocket = new WebSocketServer({ server: app });
  websocket.on("connection", (ws) => ws.on("message", (data) => ws.send(data.toString())));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const ws of websocket.clients) ws.terminate(); await new Promise<void>((resolve) => app.close(() => resolve())); });
  let valid = true;
  const port = (app.address() as { port: number }).port;
  const gate = await createGate({ port, id: randomUUID(), expiresAt: Date.now() + 60_000, verify: async () => valid });
  cleanups.push(() => gate.close());
  gate.setOrigin("https://fixture.example");
  const token = new URL(gate.openUrl()).hash.slice(1);
  const session = await call(gate, "/__daemon_link/session", { origin: "https://fixture.example" }, "POST", token);
  const cookie = session.headers["set-cookie"]![0]!.split(";")[0]!;
  return { gate, cookie, session, token, port, seen: () => seen, invalidate: () => { valid = false; } };
}

describe("temporary web gate", () => {
  it("requires a private session and matching host/origin before proxying resources", async () => {
    const { gate, cookie, session, port, seen } = await fixture();
    expect(session.status).toBe(204);
    expect(session.headers["set-cookie"]![0]).toContain("Secure; HttpOnly; SameSite=Lax; Path=/");
    expect((await call(gate)).status).toBe(403);
    expect((await call(gate, "/", { cookie, host: "untrusted.example" })).status).toBe(403);
    expect((await call(gate, "/", { cookie, origin: "https://untrusted.example" })).status).toBe(403);
    expect((await call(gate, "/", { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(gate, "//untrusted.example", { cookie })).status).toBe(400);
    const response = await call(gate, "/_next/fixture", { cookie: `${cookie}; app=value`, origin: "https://fixture.example", referer: "https://fixture.example/page", "x-forwarded-host": "untrusted.example", forwarded: "host=untrusted.example" });
    expect(response.status).toBe(200); expect(response.body).toBe("dev-resource");
    expect(seen().host).toBe(`localhost:${port}`);
    expect(seen().origin).toBe(`http://localhost:${port}`);
    expect(seen().referer).toBe(`http://localhost:${port}/page`);
    expect(seen().cookie?.trim()).toBe("app=value");
    expect(seen().forwarded).toBeUndefined(); expect(seen()["x-forwarded-host"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual(["app=value; Path=/"]);
    expect((await call(gate, "/redirect", { cookie })).headers.location).toBe("https://fixture.example/login");
    expect((await call(gate, "/relative", { cookie })).headers.location).toBe("/login");
  });

  it("keeps the bearer token out of bootstrap HTML and rejects invalid login attempts", async () => {
    const { gate, token } = await fixture();
    const bootstrap = await call(gate, "/__daemon_link");
    expect(bootstrap.status).toBe(200); expect(bootstrap.body).not.toContain(token);
    expect(bootstrap.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await call(gate, "/__daemon_link/session", { origin: "https://wrong.example" }, "POST", token)).status).toBe(403);
    expect((await call(gate, "/__daemon_link/session", { origin: "https://fixture.example" }, "POST", "wrong")).status).toBe(401);
    expect((await call(gate, "/__daemon_link/session", { origin: "https://fixture.example" }, "POST", "é".repeat(43))).status).toBe(401);
    expect(() => gate.setOrigin("http://fixture.example")).toThrow("HTTPS");
  });

  it("forwards authenticated WebSockets and closes them when disconnected", async () => {
    const { gate, cookie } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${gate.port}/_next/webpack-hmr`, { headers: { host: "fixture.example", origin: "https://fixture.example", cookie } });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const message = new Promise((resolve) => ws.once("message", (data) => resolve(data.toString())));
    ws.send("hot-reload"); expect(await message).toBe("hot-reload");
    const closed = new Promise((resolve) => ws.once("close", resolve));
    await gate.close(); await closed;
    await gate.close();
  });

  it("fails closed when a service exits, rejects unauthenticated upgrades, and expires", async () => {
    const { gate, cookie, invalidate } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${gate.port}/hmr`, { headers: { host: "fixture.example" } });
    await new Promise<void>((resolve) => ws.once("error", (err) => { expect(err.message).toContain("403"); resolve(); }));
    invalidate(); expect((await call(gate, "/", { cookie })).status).toBe(403);
    const expired = await createGate({ port: 1, id: randomUUID(), expiresAt: Date.now() - 1, verify: async () => true });
    cleanups.push(() => expired.close());
    expired.setOrigin("https://fixture.example");
    expect((await call(expired)).status).toBe(410);
    expect(() => expired.openUrl()).toThrow("not ready");
  });

  it("extends an expiring gate in place so the existing session keeps working, and never shortens it", async () => {
    const { gate, cookie } = await fixture();
    // Session cookie outlives the first expiry by the lifetime cap, so a renewal needs no new login.
    const session = await call(gate, "/__daemon_link/session", { origin: "https://fixture.example" }, "POST", new URL(gate.openUrl()).hash.slice(1));
    expect(Number(/Max-Age=(\d+)/.exec(session.headers["set-cookie"]![0]!)![1])).toBeGreaterThan(24 * 3600);
    const soon = await createGate({ port: gate.port, id: randomUUID(), expiresAt: Date.now() + 50, verify: async () => true });
    cleanups.push(() => soon.close());
    soon.setOrigin("https://fixture.example");
    const url = soon.openUrl();
    soon.extend(Date.now() + 60_000);
    soon.extend(Date.now() - 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(soon.openUrl()).toBe(url);
    expect((await call(soon, "/__daemon_link")).status).toBe(200);
    expect((await call(gate, "/", { cookie })).status).toBe(200);
  });
});
