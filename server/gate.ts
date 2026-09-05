import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

const BOOTSTRAP = "/__daemon_link";
const SCRIPT = `const token=location.hash.slice(1);history.replaceState(null,'','${BOOTSTRAP}');fetch('${BOOTSTRAP}/session',{method:'POST',headers:{'Content-Type':'text/plain'},body:token}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('status').textContent='This link is unavailable or expired. Open a fresh link from Paseo.'});`;
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Daemon Link</title><p id="status">Connecting to your service…</p><script>${SCRIPT}</script>`;
const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function safeHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const result = { ...headers };
  const connection = String(headers.connection || "").split(",").map((s) => s.trim().toLowerCase());
  for (const key of [...HOP, ...connection]) delete result[key];
  return result;
}

export interface Gate {
  port: number;
  setOrigin(origin: string): void;
  openUrl(): string;
  close(): Promise<void>;
}

/** A single-service HTTP/WS gate. The upstream address cannot come from a request. */
export async function createGate(options: {
  port: number; id: string; expiresAt: number; verify: () => Promise<boolean>;
}): Promise<Gate> {
  const token = randomBytes(32).toString("base64url");
  const cookieName = `__Host-daemon-link-${options.id}`;
  let origin: string | undefined;
  let closed = false;
  const sockets = new Set<Socket>();
  const upstreamOrigin = `http://localhost:${options.port}`;
  const secretMatches = (value: string) => Buffer.byteLength(value) === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const hostAllowed = (req: IncomingMessage) => !!origin && req.headers.host === new URL(origin).host;
  const originAllowed = (req: IncomingMessage) => (!req.headers.origin || req.headers.origin === origin) && req.headers["sec-fetch-site"] !== "cross-site";
  const authenticated = (req: IncomingMessage) => (req.headers.cookie || "").split(";").some((item) => {
    const [name, ...value] = item.trim().split("=");
    return name === cookieName && secretMatches(value.join("="));
  });
  const active = () => !closed && Date.now() < options.expiresAt;
  const allowed = async (req: IncomingMessage) => active() && hostAllowed(req) && originAllowed(req) && authenticated(req) && await options.verify();

  function headers(req: IncomingMessage, upgrade = false): OutgoingHttpHeaders {
    const result = safeHeaders(req.headers);
    for (const key of Object.keys(result)) if (/^(forwarded$|x-forwarded-|cf-)/i.test(key)) delete result[key];
    result.host = `localhost:${options.port}`;
    // Only after verifying the external origin and session. Next/Vite see a same-origin local request.
    if (req.headers.origin) result.origin = upstreamOrigin;
    if (req.headers.referer?.startsWith(`${origin}/`)) result.referer = upstreamOrigin + req.headers.referer.slice(origin!.length);
    result.cookie = (req.headers.cookie || "").split(";").filter((c) => !c.trim().startsWith(`${cookieName}=`)).join(";");
    if (upgrade) { result.connection = "Upgrade"; result.upgrade = "websocket"; }
    return result;
  }

  function responseHeaders(raw: OutgoingHttpHeaders): OutgoingHttpHeaders {
    const result = safeHeaders(raw);
    // The gate session is never delegated to the application.
    if (result["set-cookie"]) result["set-cookie"] = (Array.isArray(result["set-cookie"]) ? result["set-cookie"] : [String(result["set-cookie"])])
      .filter((c) => !c.startsWith(`${cookieName}=`));
    if (typeof result.location === "string") {
      try {
        const url = new URL(result.location);
        if (["localhost", "127.0.0.1"].includes(url.hostname) && (Number(url.port) || 80) === options.port) result.location = origin + url.pathname + url.search + url.hash;
      } catch { /* A relative redirect already resolves against the tunnel. */ }
    }
    result["cache-control"] = "no-store";
    result["referrer-policy"] = "no-referrer";
    return result;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const reject = (status: number, message: string) => { res.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain" }); res.end(message); };
    if (!active()) return reject(410, "Daemon Link expired.");
    if (!hostAllowed(req)) return reject(403, "Host rejected.");
    if (req.url === BOOTSTRAP && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
      res.end(PAGE); return;
    }
    if (req.url === `${BOOTSTRAP}/session` && req.method === "POST") {
      if (req.headers.origin !== origin || !originAllowed(req)) return reject(403, "Origin rejected.");
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 128) { reject(413, "Request too large."); req.destroy(); return; }
      }
      if (!secretMatches(body)) return reject(401, "Invalid link.");
      res.writeHead(204, {
        "cache-control": "no-store", "referrer-policy": "no-referrer",
        "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor((options.expiresAt - Date.now()) / 1000))}`,
      });
      res.end(); return;
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return reject(400, "Invalid path.");
    if (!await allowed(req)) return reject(403, "Open this service through Daemon Link in Paseo.");
    const upstream = request({ hostname: "127.0.0.1", port: options.port, method: req.method, path: req.url, headers: headers(req) }, (response) => {
      res.writeHead(response.statusCode || 502, responseHeaders(response.headers));
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("socket", track);
    upstream.on("error", () => { if (!res.headersSent) reject(502, "Local service unavailable."); else res.destroy(); });
    upstream.setTimeout(120_000, () => upstream.destroy());
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end("Service unavailable."); }); });
  server.on("connection", track);
  server.on("upgrade", (req, rawSocket, head) => {
    const socket = rawSocket as Socket;
    void (async () => {
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.headers.upgrade?.toLowerCase() !== "websocket" || !await allowed(req)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      const upstream = request({ hostname: "127.0.0.1", port: options.port, path: req.url, headers: headers(req, true) });
      upstream.on("socket", track);
      upstream.on("error", () => socket.destroy());
      upstream.setTimeout(120_000, () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("response", () => { upstream.destroy(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
      upstream.once("upgrade", (response, peer, upstreamHead) => {
        track(peer);
        const filtered = responseHeaders(response.headers);
        filtered.connection = "Upgrade"; filtered.upgrade = "websocket";
        socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(filtered).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}\r\n`)).join("") + "\r\n");
        if (head.length) peer.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
        peer.once("close", () => socket.destroy()); socket.once("close", () => peer.destroy());
        socket.pipe(peer).pipe(socket);
      });
      upstream.end();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as { port: number }).port,
    setOrigin(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("Tunnel origin must be HTTPS.");
      origin = value;
    },
    openUrl() { if (!active() || !origin) throw new Error("Tunnel is not ready."); return `${origin}${BOOTSTRAP}#${token}`; },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
