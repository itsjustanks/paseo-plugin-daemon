import { createClientChannel, createDaemonChannel, type EncryptedChannel, type KeyPair, type Transport } from "@getpaseo/relay/e2ee";
import { WebSocket } from "ws";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";

export const DEFAULT_RELAY = "wss://relay.paseo.sh";
export function relayUrl(endpoint: string, serverId: string, role: "server" | "client", connectionId?: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Relay must use wss (or ws on loopback for development).");
  if (url.username || url.password || url.search || (url.pathname !== "/" && url.pathname !== "/ws")) throw new Error("Invalid relay endpoint.");
  url.pathname = "/ws";
  url.searchParams.set("serverId", serverId); url.searchParams.set("role", role); url.searchParams.set("v", "2");
  if (connectionId) url.searchParams.set("connectionId", connectionId);
  return url.href;
}

export function relaySocket(url: string): WebSocket {
  const ws = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false, maxPayload: 128 * 1024 });
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    if (ws.readyState === WebSocket.OPEN) { alive = false; ws.ping(); }
  }, 10_000);
  ws.on("pong", () => { alive = true; });
  ws.on("error", () => {});
  ws.once("close", () => clearInterval(ping));
  return ws;
}

export function relayTransport(ws: WebSocket): Transport {
  const transport: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => new Promise<void>((resolve, reject) => {
      if (ws.bufferedAmount > 512 * 1024) { reject(new Error("Relay buffer limit reached.")); return; }
      ws.send(data, (err) => err ? reject(err) : resolve());
    }),
    close: () => ws.terminate(),
  };
  ws.on("message", (raw, isBinary) => {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    transport.onmessage?.({ data: isBinary ? Uint8Array.from(data).buffer : data.toString("utf8"), isBinary });
  });
  ws.on("close", () => transport.onclose?.(1001, "Relay disconnected"));
  ws.on("error", () => transport.onerror?.(new Error("Relay connection failed.")));
  return transport;
}

/** Bound memory in both directions and preserve byte order; HTTP and WS remain ordinary TCP. */
export function bridgeBytes(socket: Socket, channel: EncryptedChannel, ws: WebSocket) {
  let queue = Promise.resolve();
  let pendingBytes = 0;
  let incomingEnded = false;
  let outgoingEnded = false;
  const close = () => { socket.destroy(); ws.terminate(); };
  socket.on("data", (chunk: Buffer) => {
    socket.pause();
    pendingBytes += chunk.length;
    if (pendingBytes > 512 * 1024) { close(); return; }
    queue = queue.then(async () => {
      for (let offset = 0; offset < chunk.length; offset += 32 * 1024) await channel.send(Uint8Array.from(chunk.subarray(offset, offset + 32 * 1024)).buffer);
      pendingBytes -= chunk.length;
      socket.resume();
    }).catch(close);
  });
  socket.on("end", () => {
    outgoingEnded = true;
    // An empty encrypted binary frame is EOF. Keep the reverse direction alive for a response.
    queue = queue.then(() => channel.send(new ArrayBuffer(0))).then(() => {
      if (incomingEnded) ws.close();
    }).catch(close);
  });
  socket.on("error", close);
  socket.once("close", () => { if (incomingEnded && outgoingEnded) void queue.then(() => ws.close()); else ws.terminate(); });
  ws.once("close", () => { if (incomingEnded) socket.end(); else socket.destroy(); });
  return (data: string | ArrayBuffer) => {
    if (typeof data === "string") { close(); return; }
    if (data.byteLength === 0) {
      incomingEnded = true;
      socket.end();
      if (outgoingEnded) void queue.then(() => ws.close());
      return;
    }
    if (incomingEnded) { close(); return; }
    if (socket.writableLength > 512 * 1024) { close(); return; }
    if (!socket.write(Buffer.from(data))) { ws.pause(); socket.once("drain", () => ws.resume()); }
  };
}

export class RelayHost {
  state = "connecting";
  private control?: WebSocket;
  private sockets = new Set<WebSocket>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private endpoint: string, private id: string, private key: KeyPair,
    private attach: (channel: EncryptedChannel, ws: WebSocket, first: string) => Promise<(data: string | ArrayBuffer) => void>) { this.connect(); }

  private connect() {
    if (this.stopped) return;
    this.state = "connecting";
    const control = this.control = relaySocket(relayUrl(this.endpoint, this.id, "server"));
    const dataSockets = new Map<string, WebSocket>();
    const readyTimeout = setTimeout(() => control.terminate(), 10_000);
    control.on("message", (raw) => {
      let msg: { type: string; connectionId?: string; connectionIds?: string[] };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!["sync", "connected", "disconnected", "ping", "pong"].includes(msg.type)) return;
      clearTimeout(readyTimeout); this.state = "connected";
      if (msg.type === "ping") control.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "disconnected" && msg.connectionId) { dataSockets.get(msg.connectionId)?.terminate(); dataSockets.delete(msg.connectionId); }
      const ids = msg.type === "sync" ? msg.connectionIds || [] : msg.type === "connected" && msg.connectionId ? [msg.connectionId] : [];
      for (const id of ids.slice(0, 64)) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || dataSockets.has(id) || this.sockets.size >= 64) continue;
        const ws = relaySocket(relayUrl(this.endpoint, this.id, "server", id));
        this.sockets.add(ws); dataSockets.set(id, ws);
        const timeout = setTimeout(() => ws.terminate(), 15_000);
        ws.once("close", () => { clearTimeout(timeout); this.sockets.delete(ws); dataSockets.delete(id); });
        ws.once("open", () => {
          let consume: ((data: string | ArrayBuffer) => void) | undefined;
          let authenticating = false;
          let channel: EncryptedChannel;
          void createDaemonChannel(relayTransport(ws), this.key, {
            onmessage: (data) => {
              if (consume) { consume(data); return; }
              if (authenticating || typeof data !== "string" || data.length > 8192) { ws.terminate(); return; }
              authenticating = true;
              void this.attach(channel, ws, data).then((fn) => { consume = fn; clearTimeout(timeout); })
                .catch(() => ws.terminate());
            },
            onerror: () => ws.terminate(),
          }).then((value) => { channel = value; }).catch(() => ws.terminate());
        });
      }
    });
    control.once("close", () => {
      clearTimeout(readyTimeout);
      for (const ws of dataSockets.values()) ws.terminate();
      this.state = "reconnecting";
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 2000);
    });
  }

  close() { this.stopped = true; clearTimeout(this.retry); this.control?.terminate(); for (const ws of this.sockets) ws.terminate(); this.state = "stopped"; }
}

export async function openRelay(args: { relay: string; serverId: string; publicKey: string; auth: unknown },
  onData: (data: string | ArrayBuffer, channel: EncryptedChannel, ws: WebSocket) => void): Promise<{ channel: EncryptedChannel; ws: WebSocket }> {
  const ws = relaySocket(relayUrl(args.relay, args.serverId, "client", randomUUID()));
  return new Promise((resolve, reject) => {
    let channel: EncryptedChannel;
    let ready = false;
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Peer did not respond. Check that Daemon Link is running on both machines and the relay is reachable.")); }, 15_000);
    ws.once("close", () => { clearTimeout(timeout); if (!ready) reject(new Error("Peer connection failed. Check pairing and relay access.")); });
    ws.once("open", () => {
      void createClientChannel(relayTransport(ws), args.publicKey, {
        onopen: () => { void channel.send(JSON.stringify(args.auth)).catch(() => ws.terminate()); },
        onmessage: (data) => {
          try {
            onData(data, channel, ws);
            if (!ready) { ready = true; clearTimeout(timeout); resolve({ channel, ws }); }
          } catch { ws.terminate(); }
        },
        onerror: () => ws.terminate(),
      }).then((value) => { channel = value; }).catch(() => ws.terminate());
    });
  });
}
