import { Preview, Project } from "../shared/sync";
import type { ProjectSource } from "./transfers";
import { generateKeyPair, exportPublicKey, exportSecretKey, importPublicKey, importSecretKey, type EncryptedChannel } from "@getpaseo/relay/e2ee";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { WebSocket } from "ws";
import { Port } from "../shared/link";
import { ServiceSchema } from "../shared/peers";
import { stateDirectory } from "./binaries";
import { handleMonitorSnapshot } from "./handlers";
import { createServiceLease } from "./lease";
import { bridgeBytes, DEFAULT_RELAY, openRelay, RelayHost, relayUrl } from "./relay";

const Key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const Offer = z.object({ version: z.literal(1), relay: z.string().max(1024), serverId: z.string().uuid(), publicKey: Key, grantId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), label: z.string().max(60) });
type Offer = z.infer<typeof Offer>;
const Store = z.object({
  version: z.literal(1), serverId: z.string().uuid(), publicKey: Key, secretKey: Key, relay: z.string(),
  grants: z.array(z.object({ id: z.string().uuid(), label: z.string(), digest: z.string().length(64), projectIds: z.array(z.string()).max(100).default([]) })).max(16),
  peers: z.array(z.object({ id: z.string().uuid(), offer: Offer })).max(16),
});
type State = z.infer<typeof Store>;
type Forward = { id: string; peerId: string; remotePort: number; localPort: number; server: Server; sockets: Set<Socket> };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function decodeOffer(invitation: string): Offer {
  try {
    if (!invitation.startsWith("daemon-link:")) throw new Error();
    const offer = Offer.parse(JSON.parse(Buffer.from(invitation.slice(12), "base64url").toString("utf8")));
    relayUrl(offer.relay, offer.serverId, "client");
    return offer;
  } catch { throw new Error("This is not a valid Daemon Link pairing code."); }
}

export class PeerManager {
  private data!: State;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private host?: RelayHost;
  private forwards = new Map<string, Forward>();
  private channels = new Set<WebSocket>();
  private grantedChannels = new Map<string, Set<WebSocket>>();
  private stopped = false;

  constructor(private directory = stateDirectory(), private lease = createServiceLease,
    private discover = async () => {
      const snapshot = await handleMonitorSnapshot({ query: "", sort: "name", limit: 200 });
      const ports = new Map<number, z.infer<typeof ServiceSchema>>();
      for (const process of snapshot.services) if (!process.protectedReason) for (const port of process.ports) ports.set(port, { port, label: process.service?.label || process.name, project: process.cwd });
      return [...ports.values()];
    }, private projects?: ProjectSource) {
    this.ready = this.load(); void this.ready.catch(() => {});
  }

  private async load() {
    try { this.data = Store.parse(JSON.parse(await readFile(join(this.directory, "peers.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read Daemon Link pairings. Repair peers.json before continuing.");
      const keys = generateKeyPair();
      this.data = { version: 1, serverId: randomUUID(), publicKey: exportPublicKey(keys.publicKey), secretKey: exportSecretKey(keys.secretKey), relay: process.env.PASEO_DAEMON_LINK_RELAY || DEFAULT_RELAY, grants: [], peers: [] };
    }
    if (!this.stopped && this.data.grants.length) this.ensureHost();
  }

  private async persist() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, "peers.json");
    await writeFile(`${file}.tmp`, JSON.stringify(Store.parse(this.data), null, 2) + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => { await this.ready; if (this.stopped) throw new Error("Daemon Link is stopping."); return fn(); });
    this.queue = operation.catch(() => {}); return operation;
  }

  private ensureHost() {
    this.host ??= new RelayHost(this.data.relay, this.data.serverId, { publicKey: importPublicKey(this.data.publicKey), secretKey: importSecretKey(this.data.secretKey) }, (channel, ws, first) => this.accept(channel, ws, first));
  }

  private async accept(channel: EncryptedChannel, ws: WebSocket, first: string) {
    const auth = z.object({ grantId: z.string(), token: z.string().max(128), action: z.enum(["services", "connect", "projects", "project-preview", "project-download"]), port: Port.optional(), projectId: z.string().max(256).optional(), tokenId: z.string().uuid().optional() }).parse(JSON.parse(first));
    const grant = this.data.grants.find((g) => g.id === auth.grantId);
    if (!grant || !timingSafeEqual(Buffer.from(grant.digest), Buffer.from(hash(auth.token)))) throw new Error("Pairing rejected.");
    const connections = this.grantedChannels.get(grant.id) || new Set<WebSocket>();
    connections.add(ws); this.grantedChannels.set(grant.id, connections);
    ws.once("close", () => connections.delete(ws));
    if (["projects", "project-preview", "project-download"].includes(auth.action)) {
      if (!this.projects) throw new Error("Project transfers are not supported by this host.");
      if (auth.action === "projects") {
        const listed = await this.projects.list(grant.projectIds);
        if (!this.data.grants.includes(grant)) throw new Error("Sharing revoked.");
        await channel.send(JSON.stringify({ projects: listed.projects.filter((project) => grant.projectIds.includes(project.id)) }));
      } else if (auth.action === "project-preview") {
        if (!auth.projectId || !grant.projectIds.includes(auth.projectId)) throw new Error("Project sharing is not permitted.");
        const preview = await this.projects.preview(auth.projectId, grant.id);
        if (!this.data.grants.includes(grant) || !grant.projectIds.includes(auth.projectId)) throw new Error("Sharing revoked.");
        await channel.send(JSON.stringify(preview));
      } else {
        if (!auth.tokenId) throw new Error("A project preview is required.");
        const exported = await this.projects.download(auth.tokenId, grant.id);
        if (!this.data.grants.includes(grant) || !grant.projectIds.includes(exported.preview.project.id)) throw new Error("Project sharing was revoked.");
        await channel.send(JSON.stringify(exported.preview));
        void (async () => {
          for (let offset = 0; offset < exported.bytes.length; offset += 32 * 1024) {
            if (!this.data.grants.includes(grant) || !grant.projectIds.includes(exported.preview.project.id) || this.stopped) throw new Error("Sharing revoked.");
            await channel.send(Uint8Array.from(exported.bytes.subarray(offset, offset + 32 * 1024)).buffer);
          }
          await channel.send(new ArrayBuffer(0)); ws.close();
        })().catch(() => ws.terminate());
      }
      return () => ws.terminate();
    }
    if (auth.action === "services") {
      const services = await this.discover();
      if (!this.data.grants.includes(grant)) throw new Error("Pairing revoked.");
      await channel.send(JSON.stringify({ services }));
      return () => ws.terminate();
    }
    const verify = await this.lease(Port.parse(auth.port));
    if (!this.data.grants.includes(grant) || !await verify()) throw new Error("Service unavailable.");
    const socket = createConnection({ host: "127.0.0.1", port: auth.port!, allowHalfOpen: true });
    socket.pause();
    ws.once("close", () => socket.destroy());
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    if (!this.data.grants.includes(grant) || ws.readyState !== 1) { socket.destroy(); throw new Error("Pairing revoked."); }
    const receive = bridgeBytes(socket, channel, ws);
    let checking = false;
    const health = setInterval(() => {
      if (checking) return;
      checking = true;
      void verify().then((ok) => { if (!ok) ws.terminate(); }).catch(() => ws.terminate()).finally(() => { checking = false; });
    }, 2000);
    ws.once("close", () => clearInterval(health));
    await channel.send(JSON.stringify({ ready: true }));
    socket.resume();
    return receive;
  }

  async status() {
    await this.ready;
    return { relayState: this.host?.state || "off", grants: this.data.grants.map(({ id, label }) => ({ id, label })), peers: this.data.peers.map(({ id, offer }) => ({ id, label: offer.label })), forwards: [...this.forwards.values()].map(({ id, peerId, remotePort, localPort }) => ({ id, peerId, remotePort, localPort })) };
  }

  offer({ label, relay }: { label: string; relay?: string }) {
    return this.serialize(async () => {
      if (this.data.grants.length >= 16) throw new Error("Remove an old pairing before creating another (limit: 16).");
      if (relay && relay !== this.data.relay) {
        relayUrl(relay, this.data.serverId, "server");
        if (this.data.grants.length) throw new Error("Revoke existing pairings before changing the relay.");
        this.host?.close(); this.host = undefined; this.data.relay = relay;
      }
      const token = randomBytes(32).toString("base64url"), grantId = randomUUID();
      const offer: Offer = { version: 1, relay: this.data.relay, serverId: this.data.serverId, publicKey: this.data.publicKey, grantId, token, label };
      this.data.grants.push({ id: grantId, label, digest: hash(token), projectIds: [] });
      try { await this.persist(); } catch { this.data.grants.pop(); throw new Error("Could not save pairing."); }
      this.ensureHost();
      return { invitation: `daemon-link:${Buffer.from(JSON.stringify(offer)).toString("base64url")}` };
    });
  }

  pair(invitation: string) {
    return this.serialize(async () => {
      const offer = decodeOffer(invitation);
      if (offer.serverId === this.data.serverId) throw new Error("Select the daemon on your own computer before pairing this remote host.");
      const existing = this.data.peers.find((p) => p.offer.serverId === offer.serverId);
      if (existing) existing.offer = offer;
      else {
        if (this.data.peers.length >= 16) throw new Error("Remove an old paired host first (limit: 16).");
        this.data.peers.push({ id: randomUUID(), offer });
      }
      await this.persist(); return { ok: true as const };
    });
  }

  private peer(id: string) { const peer = this.data.peers.find((p) => p.id === id); if (!peer) throw new Error("Pair this host first."); return peer; }

  async services(id: string) {
    await this.ready;
    const { offer } = this.peer(id);
    let result: { services: z.infer<typeof ServiceSchema>[] } | undefined;
    const { ws } = await openRelay({ ...offer, auth: { grantId: offer.grantId, token: offer.token, action: "services" } }, (data) => {
      result = z.object({ services: z.array(ServiceSchema).max(200) }).parse(JSON.parse(String(data)));
    });
    ws.terminate();
    if (!result) throw new Error("Peer service discovery failed.");
    return result;
  }

  forward(id: string, port: number) {
    return this.serialize(async () => {
      const { offer } = this.peer(id);
      const previous = [...this.forwards.values()].find((f) => f.peerId === id && f.remotePort === port);
      if (previous) return { url: `http://localhost:${previous.localPort}`, localPort: previous.localPort };
      if (this.forwards.size >= 16) throw new Error("Disconnect an existing local port first (limit: 16).");
      if (!(await this.services(id)).services.some((s) => s.port === port)) throw new Error("This service is no longer available.");
      const sockets = new Set<Socket>();
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        if (sockets.size >= 64) { socket.destroy(); return; }
        sockets.add(socket); socket.pause();
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        let receive: ReturnType<typeof bridgeBytes> | undefined;
        void openRelay({ ...offer, auth: { grantId: offer.grantId, token: offer.token, action: "connect", port } }, (data, channel, ws) => {
          if (!receive) {
            this.channels.add(ws); ws.once("close", () => this.channels.delete(ws));
            if (typeof data !== "string" || !JSON.parse(data).ready || socket.destroyed || this.stopped) { ws.terminate(); return; }
            receive = bridgeBytes(socket, channel, ws); socket.resume();
          } else receive(data);
        }).catch(() => socket.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" || error.code === "EACCES") { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }
          else reject(new Error("Could not bind a local port on this daemon."));
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
      });
      server.on("error", () => { for (const socket of sockets) socket.destroy(); });
      const localPort = (server.address() as { port: number }).port;
      const forward: Forward = { id: randomUUID(), peerId: id, remotePort: port, localPort, server, sockets };
      this.forwards.set(forward.id, forward);
      return { url: `http://localhost:${localPort}`, localPort };
    });
  }

  async disconnect(id: string) {
    const forward = this.forwards.get(id);
    if (forward) { this.forwards.delete(id); for (const socket of forward.sockets) socket.destroy(); await new Promise<void>((resolve) => forward.server.close(() => resolve())); }
    return { ok: true as const };
  }

  revoke(id: string) {
    return this.serialize(async () => {
      this.data.grants = this.data.grants.filter((g) => g.id !== id);
      for (const ws of this.grantedChannels.get(id) || []) ws.terminate(); this.grantedChannels.delete(id);
      if (!this.data.grants.length) { this.host?.close(); this.host = undefined; }
      await this.persist();
      return { ok: true as const };
    });
  }

  remove(id: string) {
    return this.serialize(async () => {
      this.data.peers = this.data.peers.filter((p) => p.id !== id); await this.persist();
      for (const forward of this.forwards.values()) if (forward.peerId === id) await this.disconnect(forward.id);
      return { ok: true as const };
    });
  }

  async projectGrants() {
    await this.ready;
    return this.data.grants.map(({ id, label, projectIds }) => ({ id, label, projectIds: [...projectIds] }));
  }

  shareProjects(grantId: string, projectIds: string[]) {
    return this.serialize(async () => {
      if (!this.projects) throw new Error("Project transfers unavailable.");
      const grant = this.data.grants.find((entry) => entry.id === grantId);
      if (!grant) throw new Error("Create a pairing on this host first.");
      const ids = [...new Set(projectIds)];
      if ((await this.projects.list(ids)).projects.length !== ids.length) throw new Error("Only registered Paseo projects can be shared.");
      const previous = grant.projectIds; grant.projectIds = ids;
      try { await this.persist(); } catch (error) { grant.projectIds = previous; throw error; }
      return { ok: true as const };
    });
  }

  private async projectRequest(id: string, action: string, input: object) {
    await this.ready;
    if (this.stopped) throw new Error("Host plugin is stopping.");
    const { offer } = this.peer(id);
    let result: unknown;
    const { ws } = await openRelay({ ...offer, auth: { grantId: offer.grantId, token: offer.token, action, ...input } }, (data) => { result = JSON.parse(String(data)); });
    ws.terminate(); return result;
  }

  async projectList(id: string) {
    return z.object({ projects: z.array(Project).max(100) }).parse(await this.projectRequest(id, "projects", {}));
  }
  async projectPreview(id: string, projectId: string) {
    return Preview.parse(await this.projectRequest(id, "project-preview", { projectId }));
  }
  async projectDownload(id: string, tokenId: string): Promise<{ preview: z.infer<typeof Preview>; bytes: Buffer }> {
    await this.ready;
    if (this.stopped) throw new Error("Host plugin is stopping.");
    const { offer } = this.peer(id);
    return new Promise((resolve, reject) => {
      let preview: z.infer<typeof Preview> | undefined, received = 0, finished = false;
      const chunks: Buffer[] = [];
      let socket: WebSocket | undefined;
      const fail = () => { if (!finished) { finished = true; clearTimeout(timer); socket?.terminate(); reject(new Error("Project transfer interrupted. Preview and retry.")); } };
      const timer = setTimeout(fail, 120_000);
      void openRelay({ ...offer, auth: { grantId: offer.grantId, token: offer.token, action: "project-download", tokenId } }, (data, _channel, ws) => {
        socket = ws;
        if (finished) { ws.terminate(); return; }
        if (!preview) {
          preview = Preview.parse(JSON.parse(String(data)));
          if (preview.token !== tokenId) { fail(); return; }
          this.channels.add(ws); ws.once("close", () => { this.channels.delete(ws); fail(); });
          return;
        }
        if (typeof data === "string") { fail(); return; }
        if (!data.byteLength) {
          if (received !== preview.bytes) { fail(); return; }
          finished = true; clearTimeout(timer); ws.close(); resolve({ preview, bytes: Buffer.concat(chunks, received) }); return;
        }
        received += data.byteLength;
        if (received > preview.bytes || received > 32 * 1024 * 1024) { fail(); return; }
        chunks.push(Buffer.from(data));
      }).catch(fail);
    });
  }

  async close() {
    this.stopped = true; await this.ready.catch(() => {}); await this.queue;
    this.host?.close(); for (const ws of this.channels) ws.terminate();
    await Promise.all([...this.forwards.keys()].map((id) => this.disconnect(id)));
  }
}
