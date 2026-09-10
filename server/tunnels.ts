import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tunnel } from "../shared/link";
import { Port } from "../shared/link";
import { TUNNEL_MINUTES_MESSAGE, isTunnelMinutes, nextExpiry } from "../shared/tunnel-lease";
import { cloudflaredPath } from "./binaries";
import { createGate, type Gate } from "./gate";
import { createServiceLease } from "./lease";
import { stopChild } from "./ssh";

interface Running { view: Tunnel; gate?: Gate; child?: ChildProcess; directory?: string; expiry?: ReturnType<typeof setTimeout>; health?: ReturnType<typeof setInterval>; stopping?: Promise<void>; }
export function tunnelOrigin(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
}
export const cloudflaredArgs = (port: number, config: string) => [
  "tunnel", "--config", config, "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`,
];

export class TunnelManager {
  constructor(private lease = createServiceLease) {}
  private records = new Map<string, Running>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();

  list(): Tunnel[] { return [...this.records.values()].map((record) => ({ ...record.view })); }

  async start({ port, minutes }: { port: number; minutes: number }): Promise<Tunnel> {
    Port.parse(port);
    if (!isTunnelMinutes(minutes)) throw new Error(TUNNEL_MINUTES_MESSAGE);
    if (this.closed) throw new Error("Daemon Link is stopping.");
    const existing = [...this.records.values()].find((r) => r.view.port === port && ["starting", "connected"].includes(r.view.state));
    if (existing) return { ...existing.view };
    if (this.records.size >= 4) throw new Error("Disconnect an existing link before opening another (limit: four).");
    const id = randomUUID();
    const now = Date.now();
    const record: Running = { view: { id, port, createdAt: now, expiresAt: now + minutes * 60_000, state: "starting", message: "Starting a temporary link…", url: null } };
    this.records.set(id, record);
    const pending = this.launch(record).catch(async (error) => {
      if (!record.stopping) await this.fail(record, error instanceof Error ? error.message : "Tunnel could not start.");
    });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
    return { ...record.view };
  }

  private async launch(record: Running) {
    const verify = await this.lease(record.view.port);
    if (record.stopping || this.closed) return;
    const gate = record.gate = await createGate({ port: record.view.port, id: record.view.id, expiresAt: record.view.expiresAt, verify });
    if (record.stopping || this.closed) { await gate.close(); return; }
    record.directory = await mkdtemp(join(tmpdir(), "daemon-link-"));
    const config = join(record.directory, "config.yaml");
    await writeFile(config, "{}\n", { mode: 0o600 });
    const executable = await cloudflaredPath();
    if (record.stopping || this.closed) { await this.dispose(record); return; }
    const child = record.child = spawn(executable, cloudflaredArgs(gate.port, config), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let registered = false;
    const read = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-8192);
      const origin = tunnelOrigin(buffer);
      if (origin && !record.view.url) { gate.setOrigin(origin); record.view.url = origin; }
      registered ||= /Registered tunnel connection/.test(buffer);
      if (registered && record.view.url && !record.stopping) {
        record.view.state = "connected";
        record.view.message = "Ready to open. Access expires automatically.";
      }
    };
    child.stdout?.on("data", read); child.stderr?.on("data", read);
    child.once("error", () => { if (!record.stopping) void this.fail(record, "Tunnel helper is unavailable. Run tunnel setup, then retry."); });
    child.once("close", () => { if (!record.stopping) void this.fail(record, "Tunnel disconnected. Check outbound TCP port 7844 and retry, or use an SSH connection."); });
    this.armExpiry(record);
    const started = Date.now();
    let checking = false;
    record.health = setInterval(() => {
      if (checking || record.stopping) return;
      checking = true;
      void (async () => {
        if (!await verify()) await this.fail(record, "The original service stopped. Start a new link for the restarted service.");
        else if (record.view.state === "starting" && Date.now() - started > 45_000) await this.fail(record, "Tunnel could not connect. Check outbound TCP port 7844, or use an SSH connection.");
      })().finally(() => { checking = false; });
    }, 2000);
  }

  /** (Re)arm the expiry timer from the record's current `expiresAt`. */
  private armExpiry(record: Running) {
    clearTimeout(record.expiry);
    record.expiry = setTimeout(() => { void this.fail(record, "Link expired. Open the service again for a fresh link."); }, Math.max(0, record.view.expiresAt - Date.now()));
  }

  /**
   * Renew a live link in place. The gate, its session cookie, the helper
   * process, and the public URL are untouched; only the expiry moves, and
   * never beyond the lifetime cap measured from `createdAt`. The service
   * lease keeps being re-verified every two seconds as before, so a renewal
   * cannot outlive the dev server it was issued for.
   */
  extend(id: string, minutes: number): Tunnel {
    if (!isTunnelMinutes(minutes)) throw new Error(TUNNEL_MINUTES_MESSAGE);
    const record = this.records.get(id);
    if (!record || record.stopping || !["starting", "connected"].includes(record.view.state)) throw new Error("This link is no longer live. Open the service again for a fresh link.");
    const expiresAt = nextExpiry(Date.now(), record.view.createdAt, minutes);
    if (expiresAt === null) throw new Error("This link has reached its 24-hour lifetime. Close it and open the service again for a fresh link.");
    if (expiresAt > record.view.expiresAt) {
      record.view.expiresAt = expiresAt;
      record.gate?.extend(expiresAt);
      if (record.child) this.armExpiry(record);
    }
    return { ...record.view };
  }

  private async dispose(record: Running) {
    clearTimeout(record.expiry); clearInterval(record.health);
    await record.gate?.close();
    await stopChild(record.child);
    if (record.directory) await rm(record.directory, { recursive: true, force: true });
  }

  private fail(record: Running, message: string): Promise<void> {
    record.view.state = "error"; record.view.message = message; record.view.url = null;
    return record.stopping ??= this.dispose(record);
  }

  open(id: string) {
    const record = this.records.get(id);
    if (!record || record.view.state !== "connected" || !record.gate) throw new Error("This link is not ready. Check its status and retry.");
    return { url: record.gate.openUrl() };
  }

  async stop(id: string) {
    const record = this.records.get(id);
    if (record) {
      record.stopping ??= this.dispose(record);
      await record.stopping;
      this.records.delete(id);
    }
    return { ok: true as const };
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.records.keys()].map((id) => this.stop(id)));
    await Promise.allSettled(this.pending);
  }
}
