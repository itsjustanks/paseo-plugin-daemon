import { WebSocket, WebSocketServer } from "ws";

/** Local, protocol-v2 relay fixture; captures the encrypted wire, never decrypts it. */
export async function relayFixture() {
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const controls = new Map<string, WebSocket>();
  const clients = new Map<string, WebSocket>();
  const servers = new Map<string, WebSocket>();
  const pending = new Map<string, { data: Buffer; binary: boolean }[]>();
  const wire: Buffer[] = [];
  const send = (ws: WebSocket | undefined, data: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  relay.on("connection", (ws, req) => {
    const url = new URL(req.url!, "http://localhost");
    const host = url.searchParams.get("serverId")!, id = url.searchParams.get("connectionId");
    const role = url.searchParams.get("role");
    if (!id) {
      controls.get(host)?.terminate(); controls.set(host, ws);
      send(ws, { type: "sync", connectionIds: [...clients.keys()].filter((k) => k.startsWith(`${host}:`)).map((k) => k.slice(host.length + 1)) });
      ws.once("close", () => { if (controls.get(host) === ws) controls.delete(host); });
      return;
    }
    const key = `${host}:${id}`;
    (role === "client" ? clients : servers).set(key, ws);
    if (role === "client") send(controls.get(host), { type: "connected", connectionId: id });
    else for (const msg of pending.get(key) || []) ws.send(msg.data, { binary: msg.binary });
    pending.delete(key);
    ws.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer); wire.push(bytes);
      const other = (role === "client" ? servers : clients).get(key);
      if (other?.readyState === WebSocket.OPEN) other.send(bytes, { binary });
      else if (role === "client") pending.set(key, [...pending.get(key) || [], { data: bytes, binary }]);
    });
    ws.on("error", () => {});
    ws.once("close", () => {
      (role === "client" ? clients : servers).delete(key);
      (role === "client" ? servers : clients).get(key)?.terminate();
      pending.delete(key);
      if (role === "client") send(controls.get(host), { type: "disconnected", connectionId: id });
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${(relay.address() as { port: number }).port}`, wire,
    drop() { for (const ws of relay.clients) ws.terminate(); },
    async close() { for (const ws of relay.clients) ws.terminate(); await new Promise<void>((resolve) => relay.close(() => resolve())); },
  };
}
