// Adapted from Omer Cohen's MIT-licensed paseo-shared-browser at
// daed6eb12f4156ca392f71c48e7a9ccca231ae8c. See browser-LICENSE.txt.
import WebSocket from "ws";
import { get } from "node:http";
import type { TcpEndpoint } from "./platform";
import { BROWSER_MAX_BASE64 } from "../shared/browser";

export const CDP_TIMEOUT_MS = 3_000;
/** Only a browser endpoint on the OS-verified local listener is admitted. No redirects or DNS. */
export function localCdpEndpoint(raw: unknown, endpoint: TcpEndpoint): string {
  if (typeof raw !== "string" || raw.length > 300) throw new Error("No usable local Chrome endpoint.");
  const url = new URL(raw);
  const host = endpoint.family === 6 ? `[${endpoint.address}]` : endpoint.address;
  if (url.protocol !== "ws:" || ![host, "localhost"].includes(url.hostname) ||
      Number(url.port) !== endpoint.port || url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error("The browser endpoint is not a verified local Chrome endpoint.");
  // localhost is replaced only with this exact OS-verified literal/family, never DNS.
  return `ws://${host}:${endpoint.port}${url.pathname}`;
}

export function readCdpEndpoint(endpoint: TcpEndpoint): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: endpoint.address, family: endpoint.family, port: endpoint.port, path: "/json/version", timeout: CDP_TIMEOUT_MS, agent: false }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error("Chrome discovery did not answer.")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) { response.destroy(new Error("Chrome discovery response is too large.")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(localCdpEndpoint(JSON.parse(Buffer.concat(chunks).toString("utf8")).webSocketDebuggerUrl, endpoint)); }
        catch { reject(new Error("Chrome did not expose a usable local CDP endpoint.")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Chrome discovery timed out.")), CDP_TIMEOUT_MS);
    request.on("timeout", () => request.destroy(new Error("Chrome discovery timed out.")));
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
  });
}

export interface BrowserCdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  close(): void;
}
const METHODS = new Set(["Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget", "Page.getLayoutMetrics", "Page.captureScreenshot"]);
/** Separate viewer connection: never enables domains, activates tabs, evaluates code, or owns the browser. */
export async function connectBrowserCdp(endpoint: string): Promise<BrowserCdp> {
  const socket = new WebSocket(endpoint, { handshakeTimeout: CDP_TIMEOUT_MS, maxPayload: BROWSER_MAX_BASE64 + 32_768, followRedirects: false, perMessageDeflate: false });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0; let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(new Error("Browser capture disconnected.")); }
    pending.clear(); socket.terminate();
  };
  socket.on("error", close); socket.on("close", close);
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id); clearTimeout(command.timer);
      // Do not forward browser-controlled error strings, which can contain page data.
      if (message.error) command.reject(new Error("Chrome could not capture this tab. It may have closed or be showing a dialog."));
      else command.resolve(message.result);
    } catch { close(); }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { close(); reject(new Error("Browser capture connection timed out.")); }, CDP_TIMEOUT_MS);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", () => { clearTimeout(timer); reject(new Error("Browser capture connection failed.")); });
    socket.once("close", () => { clearTimeout(timer); reject(new Error("Browser capture connection closed.")); });
  });
  return {
    close,
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      if (!METHODS.has(method)) return Promise.reject(new Error("This viewer only supports capture commands."));
      if (closed || socket.readyState !== WebSocket.OPEN || pending.size >= 8) return Promise.reject(new Error("Browser capture is unavailable."));
      return new Promise<T>((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser capture timed out.")); close(); }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { close(); }
      });
    },
  };
}
