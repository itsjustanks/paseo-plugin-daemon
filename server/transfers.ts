import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Preview, Transfer } from "../shared/sync";
import { stateDirectory } from "./binaries";
import { homeRelative } from "./redaction";
import type { ProjectScope } from "./scope";

const run = promisify(execFile);
const MAX_BYTES = 32 * 1024 * 1024;
type PreviewData = z.infer<typeof Preview>;
type TransferData = z.infer<typeof Transfer>;
type Export = { preview: PreviewData; grantId: string; file: string; directory: string };
export interface ProjectSource {
  list(ids: string[]): Promise<{ projects: { id: string; name: string }[] }>;
  preview(projectId: string, grantId: string): Promise<PreviewData>;
  download(token: string, grantId: string): Promise<{ preview: PreviewData; bytes: Buffer }>;
}
export interface ProjectPeer {
  projectList(peerId: string): Promise<{ projects: { id: string; name: string }[] }>;
  projectPreview(peerId: string, projectId: string): Promise<PreviewData>;
  projectDownload(peerId: string, token: string): Promise<{ preview: PreviewData; bytes: Buffer }>;
}

/** Explicit committed-history exports. No working-tree files, agent state, or daemon secrets are read. */
export class ProjectTransfers implements ProjectSource {
  private exports = new Map<string, Export>();
  private previews = new Map<string, { peerId: string; preview: PreviewData }>();
  private journal: TransferData[] = [];
  private ready: Promise<void>;
  private active = false;
  private building = false;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: Promise<unknown>;
  private exportWork?: Promise<unknown>;
  private abort = new AbortController();
  constructor(private scope: ProjectScope, private directory = join(stateDirectory(), "transfers"), private now = Date.now) {
    this.ready = this.load(); void this.ready.catch(() => {});
  }
  private async load() {
    try { this.journal = z.array(Transfer).max(50).parse(JSON.parse(await readFile(join(this.directory, "history.json"), "utf8"))).map((entry) => entry.state === "receiving" ? { ...entry, state: "interrupted", finishedAt: this.now(), message: "Plugin stopped before this transfer finished. Preview and retry." } : entry); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Transfer history cannot be read. Repair history.json before receiving projects."); }
  }
  async history() { await this.ready; return this.journal.map((entry) => ({ ...entry })); }
  private persist() {
    const data = JSON.stringify(this.journal.slice(0, 50), null, 2) + "\n";
    const write = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `history-${randomUUID()}.tmp`);
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, join(this.directory, "history.json"));
    });
    this.queue = write.catch(() => {}); return write;
  }
  private async git(cwd: string, args: string[]) {
    // Ignore host filters, hooks, templates and credential helpers when handling a received repository.
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
    return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "protocol.file.allow=always", "-C", cwd, ...args], { env, signal: this.abort.signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
  }
  async list(ids: string[]) {
    const projects: { id: string; name: string }[] = [];
    for (const id of ids) { try { const root = await this.scope.root(id); projects.push({ id, name: root.name }); } catch { /* Removed projects stop being offered. */ } }
    return { projects };
  }
  preview(projectId: string, grantId: string): Promise<PreviewData> {
    if (this.stopped || this.building) return Promise.reject(new Error("A project preview is already being prepared. Retry shortly."));
    const operation = this.buildPreview(projectId, grantId); this.exportWork = operation; return operation;
  }
  private async buildPreview(projectId: string, grantId: string): Promise<PreviewData> {
    if (this.stopped || this.building) throw new Error("A project preview is already being prepared. Retry shortly.");
    this.building = true;
    let directory: string | undefined;
    try {
      for (const [token, entry] of this.exports) if (entry.preview.expiresAt <= this.now()) { this.exports.delete(token); await rm(entry.directory, { recursive: true, force: true }); }
      if (this.exports.size >= 4) throw new Error("Four project previews are already reserved. Wait for one to expire.");
      const root = await this.scope.root(projectId);
      const top = (await this.git(root.path, ["rev-parse", "--show-toplevel"])).stdout.trim();
      if (await realpath(top) !== root.path) throw new Error("Register the Git repository root before preparing this project.");
      const head = (await this.git(root.path, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Commit unavailable.");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.directory, "export-"));
      const file = join(directory, "project.bundle");
      // HEAD exports this checkout's committed history, including merge parents, not every unrelated branch.
      await this.git(root.path, ["bundle", "create", file, "HEAD"]);
      const actual = (await this.git(root.path, ["bundle", "list-heads", file])).stdout.trim().split(/\s+/)[0];
      if (actual !== head) throw new Error("Project changed while preparing the preview. Retry.");
      const bytes = (await stat(file)).size;
      if (bytes > MAX_BYTES) throw new Error("Committed history exceeds the 32 MiB transfer limit. Use Git remotes for this repository.");
      const contents = await readFile(file);
      const commits = Number((await this.git(root.path, ["rev-list", "--count", head])).stdout.trim());
      const preview = Preview.parse({ token: randomUUID(), project: { id: root.id, name: root.name }, head, commits, bytes, sha256: createHash("sha256").update(contents).digest("hex"), expiresAt: this.now() + 10 * 60_000 });
      if (this.stopped) throw new Error("Plugin is stopping.");
      this.exports.set(preview.token, { preview, grantId, file, directory });
      return preview;
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (error instanceof Error && /limit|exceeds|preparing|reserved|repository root/.test(error.message)) throw error;
      throw new Error("Cannot prepare committed history. Check that this registered project is a Git checkout with a commit.");
    } finally { this.building = false; }
  }
  async download(token: string, grantId: string) {
    const entry = this.exports.get(token);
    if (!entry || entry.grantId !== grantId || entry.preview.expiresAt <= this.now() || this.stopped) throw new Error("Project preview expired. Build a new preview.");
    await this.scope.root(entry.preview.project.id);
    return { preview: entry.preview, bytes: await readFile(entry.file) };
  }
  async inspect(peer: ProjectPeer, peerId: string, projectId: string) {
    const preview = Preview.parse(await peer.projectPreview(peerId, projectId));
    this.previews.set(preview.token, { peerId, preview });
    for (const [token, entry] of this.previews) if (entry.preview.expiresAt <= this.now()) this.previews.delete(token);
    return preview;
  }
  async receive(peer: ProjectPeer, peerId: string, token: string) {
    await this.ready;
    const inspected = this.previews.get(token);
    if (!inspected || inspected.peerId !== peerId || inspected.preview.expiresAt <= this.now()) throw new Error("Preview this project on this host before receiving it.");
    if (this.active || this.stopped) throw new Error("A transfer is already running or the plugin is stopping.");
    this.active = true;
    const entry: TransferData = { id: randomUUID(), peerId, projectName: inspected.preview.project.name, head: inspected.preview.head, startedAt: this.now(), finishedAt: null, state: "receiving", bytes: 0, directory: null, message: "Receiving the reviewed commit into a new checkout…" };
    this.journal.unshift(entry); this.journal = this.journal.slice(0, 50);
    try { await this.persist(); } catch (error) { this.active = false; this.journal = this.journal.filter((item) => item !== entry); throw error; }
    this.previews.delete(token);
    this.pending = this.execute(peer, inspected.preview, entry).finally(() => { this.active = false; });
    void this.pending.catch(() => {});
    return { ...entry };
  }
  private async execute(peer: ProjectPeer, expected: PreviewData, entry: TransferData) {
    const directory = join(this.directory, "received", entry.id);
    try {
      const received = await peer.projectDownload(entry.peerId, expected.token);
      if (this.stopped) throw new Error("Transfer interrupted.");
      if (received.preview.head !== expected.head || received.bytes.length !== expected.bytes || createHash("sha256").update(received.bytes).digest("hex") !== expected.sha256) throw new Error("Transfer did not match the reviewed preview.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const bundle = join(directory, "project.bundle");
      await writeFile(bundle, received.bytes, { mode: 0o600 });
      await this.git(directory, ["clone", "--no-checkout", "--", bundle, "repository"]);
      if (this.stopped) throw new Error("Transfer interrupted.");
      await this.git(join(directory, "repository"), ["-c", "core.symlinks=false", "checkout", "--detach", expected.head]);
      // Keep the checked-out commit and its history. No active project, existing branch or remote URL is changed.
      entry.bytes = received.bytes.length; entry.directory = homeRelative(join(directory, "repository"), homedir());
      entry.state = "done"; entry.message = "Received into a separate checkout. Add this directory as a Paseo project when you are ready.";
    } catch {
      await rm(directory, { recursive: true, force: true });
      entry.state = this.stopped ? "interrupted" : "failed"; entry.message = "Transfer could not finish. Existing projects were left untouched. Check sharing and connectivity, then preview again.";
    } finally { entry.finishedAt = this.now(); await this.persist(); }
  }
  async close() {
    this.stopped = true; this.abort.abort();
    await this.exportWork?.catch(() => {});
    await this.pending?.catch(() => {}); await this.queue;
    for (const entry of this.exports.values()) await rm(entry.directory, { recursive: true, force: true });
    this.exports.clear(); this.previews.clear();
  }
}
