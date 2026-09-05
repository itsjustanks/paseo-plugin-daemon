import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ProfileSchema, type Profile } from "../shared/link";
import { SshLink } from "./ssh";
import { TunnelManager } from "./tunnels";
import { executableAvailable } from "./binaries";

const Profiles = z.array(ProfileSchema).max(16);

export class LinkManager {
  readonly tunnels = new TunnelManager();
  private profiles: Profile[] = [];
  private links = new Map<string, SshLink>();
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private capabilities?: Promise<{ ssh: boolean; cloudflared: boolean }>;

  constructor(private readonly file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "daemon-link", "profiles.json")) {
    this.ready = this.load();
    // A malformed store should be visible via RPC, without an unhandled rejection on startup.
    void this.ready.catch(() => {});
  }

  private async load() {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Could not read Daemon Link profiles."); }
    try { this.profiles = Profiles.parse(JSON.parse(text)); }
    catch { throw new Error("Daemon Link profiles are invalid. Repair profiles.json before saving changes."); }
    if (!this.closing) for (const profile of this.profiles) if (profile.autoConnect) this.start(profile);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready;
      if (this.closing) throw new Error("Daemon Link is stopping.");
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async persist(next: Profile[]) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
    this.profiles = next;
  }

  async status() {
    await this.ready;
    this.capabilities ??= Promise.all([executableAvailable("ssh"), executableAvailable("cloudflared")])
      .then(([ssh, cloudflared]) => ({ ssh, cloudflared }));
    // Re-check after installation of a missing optional executable.
    const capabilities = await this.capabilities;
    if (!capabilities.ssh || !capabilities.cloudflared) this.capabilities = undefined;
    return { ...capabilities, profiles: this.profiles, connections: [...this.links.values()].map((link) => link.status), tunnels: this.tunnels.list() };
  }

  save(raw: Omit<Profile, "id"> & { id?: string }) {
    return this.serialize(async () => {
      const profile = ProfileSchema.parse({ ...raw, id: raw.id || randomUUID() });
      const next = Profiles.parse([...this.profiles.filter((p) => p.id !== profile.id), profile]);
      if (next.some((p) => p.id !== profile.id && p.localPort === profile.localPort)) throw new Error("Another profile already uses this local port.");
      await this.persist(next);
      await this.links.get(profile.id)?.close();
      this.links.delete(profile.id);
      if (profile.autoConnect) this.start(profile);
      return { ok: true as const };
    });
  }

  remove(id: string) {
    return this.serialize(async () => {
      await this.persist(this.profiles.filter((p) => p.id !== id));
      await this.links.get(id)?.close();
      this.links.delete(id);
      return { ok: true as const };
    });
  }

  private start(profile: Profile) {
    const link = new SshLink(profile);
    this.links.set(profile.id, link);
    link.start();
  }

  connect(id: string) {
    return this.serialize(async () => {
      const profile = this.profiles.find((p) => p.id === id);
      if (!profile) throw new Error("Connection profile no longer exists.");
      if (!this.links.has(id)) this.start(profile);
      return { ok: true as const };
    });
  }

  disconnect(id: string) {
    return this.serialize(async () => {
      // Explicit disconnect also disables reconnect on the next plugin start.
      await this.persist(this.profiles.map((p) => p.id === id ? { ...p, autoConnect: false } : p));
      await this.links.get(id)?.close();
      this.links.delete(id);
      return { ok: true as const };
    });
  }

  async close() {
    this.closing = true;
    await this.ready.catch(() => {});
    await this.queue;
    await Promise.all([...this.links.values()].map((link) => link.close()));
    await this.tunnels.close();
  }
}
