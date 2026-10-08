import { execFile } from "node:child_process";
import { setPriority } from "node:os";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CLEARABLE_NAMES, PROTECTED_NAME, TMP_MIN_AGE_HOURS, TMP_NEVER,
  formatSize, isClearableName, isIgnoredOnlyName, neverDelete, olderVersions, toolCacheName,
  type DiskJob, type DiskPlan,
} from "../shared/disk";
import type { ActionLogEntry } from "../shared/processes";
import { gitVerdicts, runGit, type GitRun } from "./disk-git";
import { openPaths, usedBeneath, type OpenPaths } from "./disk-inuse";
import { busyReason, homeRelative, workspaceState, type DiskPlaces, type WorkspaceInfo } from "./disk-scan";
import { runWorker, type DeleteResult } from "./disk-worker";
import { isAgentTool } from "./scope";
import { classifyJob } from "./jobs";
import type { RawProcess } from "./platform";

/**
 * Clearing (0.14.0), after the person has seen the list and confirmed.
 *
 * Each item is a signed token (HMAC, this process's key, 30 minutes) bound
 * to the folder's path, device, inode and modification time from the scan,
 * plus what it is (a workspace's build folder, a cache, a /tmp leftover).
 * Immediately before each item goes, every rule is checked again against a
 * fresh read; any doubt is a refusal with the reason:
 *  - it is still the same folder (lstat: device, inode, modification time),
 *    not a symlink, its real path is its path, it is on the same device as
 *    the folder it belongs to, and it is owned by this user;
 *  - it is still allow-listed for its kind, and never on the never list
 *    ($PASEO_HOME's data, ~/.claude, ~/.codex, a whole workspace…);
 *  - git still doesn't track anything in it (dist/build/out: still ignored);
 *  - nothing has it open or as its working directory, and no agent is
 *    working, waiting, or running a build, test or dev server in its workspace.
 * Then it is renamed out of the way (atomic, same folder), checked once more
 * to be the very same inode, and deleted by the low-priority worker, which
 * never follows a symlink, never leaves the device and never removes a .env
 * file or a .git folder. pnpm's store is pruned by pnpm itself. Every step is
 * logged as this user; nothing runs with raised privileges.
 */

export const TOKEN_TTL_MS = 30 * 60_000;
export type ItemKind = "workspace" | "npm" | "pnpm" | "versions" | "tool" | "tmp";

/** p path, d device, i inode, m mtime (ms, floored), a action, k kind, o owner label, b bytes the scan measured, n display name, c cost words, x expiry. */
export interface DiskTokenPayload { p: string; d: number; i: number; m: number; a: "delete" | "prune"; k: ItemKind; o: string; b: number; n?: string; c?: string; x: number }

export interface MintInput { path: string; dev: number; ino: number; mtimeMs: number; action: "delete" | "prune"; kind: ItemKind; owner: string; bytes: number; name?: string; cost?: string }

export class DiskTokens {
  constructor(private readonly key: Buffer = randomBytes(32), private readonly now: () => number = Date.now) {}
  mint(item: MintInput): string {
    const payload: DiskTokenPayload = { p: item.path, d: item.dev, i: item.ino, m: Math.floor(item.mtimeMs), a: item.action, k: item.kind, o: item.owner, b: Math.max(0, Math.round(item.bytes)), ...(item.name ? { n: item.name.slice(0, 80) } : {}), ...(item.cost ? { c: item.cost.slice(0, 160) } : {}), x: this.now() + TOKEN_TTL_MS };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  verify(token: string): DiskTokenPayload | null {
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    let given: Buffer;
    try { given = Buffer.from(sig, "base64url"); } catch { return null; }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DiskTokenPayload;
      if (typeof payload.p !== "string" || !payload.p.startsWith("/") || typeof payload.d !== "number" || typeof payload.i !== "number" || payload.x < this.now()) return null;
      return payload;
    } catch { return null; }
  }
}

export interface CleanerDeps {
  places: DiskPlaces;
  uid: number;
  tokens: DiskTokens;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  unlinkedWorktrees(claimed: readonly string[]): Promise<string[]>;
  /** This user's processes now (for agents and jobs working inside a workspace). */
  processes(): Promise<RawProcess[]>;
  openPaths?(): Promise<OpenPaths>;
  pnpmStore(): Promise<string | null>;
  log(entry: ActionLogEntry): Promise<void>;
  /** Told what was freed, so the cached scan drops it. */
  cleared?(path: string, bytes: number): void;
  git?: GitRun;
  remove?(path: string, dev: number): Promise<DeleteResult>;
  prune?(): Promise<{ ok: boolean; message: string }>;
  now?: () => number;
}

interface Checked { ok: boolean; reason: string | null; payload: DiskTokenPayload | null; name: string; where: string; bytes: number; isFile: boolean }

const safe = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => { try { return await action(); } catch { return fallback; } };
const inside = (path: string, root: string) => path.startsWith(`${root.replace(/\/+$/, "")}/`);

const defaultPrune = () => new Promise<{ ok: boolean; message: string }>((resolve) => {
  const child = execFile("pnpm", ["store", "prune"], { timeout: 15 * 60_000, env: { ...process.env, NO_COLOR: "1" } }, (error) => resolve(error ? { ok: false, message: "pnpm couldn't prune its store." } : { ok: true, message: "pnpm removed the packages no project uses." }));
  try { if (child.pid) setPriority(child.pid, 19); } catch { /* Best effort. */ }
});

export class DiskCleaner {
  private job: DiskJob = { state: "idle", freedBytes: 0, results: [], message: null };
  private running: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: CleanerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  status(): DiskJob { return { ...this.job, results: [...this.job.results] }; }

  /** The ask-first list: light checks only (the full checks run again just before each item goes). */
  async preview(tokens: readonly string[]): Promise<DiskPlan> {
    const items: DiskPlan["items"] = [];
    for (const token of tokens) {
      const payload = this.deps.tokens.verify(token);
      if (!payload) { items.push({ name: "Folder", where: "", owner: "", bytes: 0, action: "delete", cost: "", ok: false, reason: "This list is out of date. Check again and try once more." }); continue; }
      const st = await safe(() => lstat(payload.p), null);
      const same = !!st && st.dev === payload.d && st.ino === payload.i && !st.isSymbolicLink();
      const words = CLEARABLE_NAMES[basename(payload.p)];
      items.push({
        name: payload.n ?? basename(payload.p), where: homeRelative(payload.p, this.deps.places.home), owner: payload.o, bytes: payload.b, action: payload.a,
        cost: payload.c ?? (payload.a === "prune" ? "Removes only packages no project uses." : words?.cost ?? "Made again when it's needed."),
        ok: same && !neverDelete(payload.p, this.deps.places), reason: !st ? "It's already gone." : same ? null : "It changed since it was checked. Check again first.",
      });
    }
    return { items, bytes: items.filter((item) => item.ok).reduce((sum, item) => sum + item.bytes, 0) };
  }

  /** Start clearing in the background; one job at a time. */
  start(tokens: readonly string[]): DiskJob {
    if (this.running) return this.status();
    this.job = { state: "running", freedBytes: 0, results: [], message: `Clearing ${tokens.length} item${tokens.length === 1 ? "" : "s"}… Each one is checked again just before it goes.` };
    this.running = this.run(tokens).catch((error) => {
      console.error("daemon-link: disk clear failed", error instanceof Error ? error.name : "unknown");
      this.job.message = "Clearing stopped early. Nothing was deleted without its checks.";
    }).finally(() => { this.job.state = "done"; this.running = null; });
    return this.status();
  }
  wait(): Promise<void> { return this.running ?? Promise.resolve(); }

  private async run(tokens: readonly string[]): Promise<void> {
    // One picture of what's open and who's working, for the whole job; each item is still re-read just before it goes.
    const [open, workspaces, processes] = await Promise.all([
      (this.deps.openPaths ?? (() => openPaths(this.deps.places.platform, this.deps.uid)))().catch(() => ({ paths: [], complete: false })),
      safe(() => this.deps.listWorkspaces(), null as WorkspaceInfo[] | null),
      safe(() => this.deps.processes(), null as RawProcess[] | null),
    ]);
    for (const token of tokens) {
      const checked = await this.check(token, open, workspaces, processes);
      const owner = checked.payload?.o ?? "";
      if (!checked.ok) {
        this.job.results.push({ name: checked.name, owner, ok: false, bytes: 0, message: checked.reason ?? "Not cleared." });
        if (checked.payload) await this.record(checked.payload.a === "prune" ? "disk-prune" : "disk-clear", checked, "denied", 0, `Not cleared: ${checked.reason}`);
        continue;
      }
      const payload = checked.payload!;
      if (payload.a === "prune") {
        const pruned = await (this.deps.prune ?? defaultPrune)();
        this.job.results.push({ name: checked.name, owner, ok: pruned.ok, bytes: 0, message: pruned.message });
        await this.record("disk-prune", checked, pruned.ok ? "done" : "failed", 0, `${pruned.message} Confirmed in the Paseo app.`);
        continue;
      }
      const outcome = await this.remove(payload, checked.isFile);
      const freed = outcome.removedBytes;
      this.job.freedBytes += freed;
      if (freed > 0 || outcome.ok) this.deps.cleared?.(payload.p, checked.bytes);
      const message = outcome.ok ? `Cleared ${checked.name} (${formatSize(Math.max(freed, 0))}).` : outcome.error ?? `Cleared most of ${checked.name}; ${outcome.leftovers} item${outcome.leftovers === 1 ? " was" : "s were"} left (kept on purpose or in use).`;
      this.job.results.push({ name: checked.name, owner, ok: outcome.ok, bytes: freed, message });
      await this.record("disk-clear", checked, outcome.ok ? "done" : "failed", freed, `${message} Confirmed in the Paseo app.`);
    }
    const ok = this.job.results.filter((result) => result.ok).length;
    this.job.message = `${ok} of ${tokens.length} cleared, ${formatSize(this.job.freedBytes)} freed.${ok < tokens.length ? " The rest were left; each says why." : ""}`;
  }

  /** Every rule, against a fresh read. Public so tests can ask about one item. */
  async check(token: string, open: OpenPaths, workspaces: WorkspaceInfo[] | null, processes: RawProcess[] | null): Promise<Checked> {
    const { places, uid } = this.deps;
    const payload = this.deps.tokens.verify(token);
    const no = (reason: string, extra: Partial<Checked> = {}): Checked => ({ ok: false, reason, payload, name: payload ? payload.n ?? basename(payload.p) : "Folder", where: payload ? homeRelative(payload.p, places.home) : "", bytes: 0, isFile: false, ...extra });
    if (!payload) return no("This list is out of date. Check again and try once more.");
    const path = payload.p;
    const st = await safe(() => lstat(path), null);
    if (!st) return no("It's already gone.");
    if (st.isSymbolicLink()) return no("It's a link to somewhere else, and Hosts never follows links.");
    if (st.dev !== payload.d || st.ino !== payload.i) return no("It isn't the same folder that was checked any more. Check again first.");
    if (Math.floor(st.mtimeMs) !== payload.m) return no("It changed since it was checked (something wrote to it). Check again first.");
    if (st.uid !== uid) return no("It belongs to another user, and Hosts only clears this user's files.");
    const real = await safe(() => realpath(path), null);
    if (real !== path) return no("Its real location is somewhere else (a link on the way), so Hosts leaves it.");
    const never = neverDelete(path, places);
    if (never) return no(never);
    const isFile = !st.isDirectory();
    if (isFile && payload.k !== "tmp") return no("It isn't a folder any more.");

    // Allow-listed for its kind, inside the place it belongs, on the same device.
    let root: string | null = null;
    if (payload.k === "workspace") {
      if (!workspaces) return no("Paseo's workspaces couldn't be read, so Hosts can't confirm where this belongs.");
      const folders = await Promise.all(workspaces.map(async (workspace) => ({ workspace, path: await safe(() => realpath(workspace.directory), null) })));
      const claimed = folders.filter((folder) => folder.path).map((folder) => folder.path!);
      const unlinked = await safe(() => this.deps.unlinkedWorktrees(claimed), [] as string[]);
      root = [...claimed, ...unlinked].filter((folder) => inside(path, folder)).sort((a, b) => b.length - a.length)[0] ?? null;
      if (!root) return no("It isn't inside one of your Paseo workspaces any more.");
      const name = basename(path);
      if (!isClearableName(name) && !isIgnoredOnlyName(name)) return no("It isn't on the list of folders Hosts may clear.");
      const owners = folders.filter((folder) => folder.path === root).map((folder) => folder.workspace);
      const busy = owners.map((owner) => busyReason(workspaceState(owner.status), owner.devServers)).find(Boolean);
      if (busy) return no(busy);
      if (!processes) return no("This host's processes couldn't be read, so Hosts can't tell whether the workspace is busy.");
      const worker = processes.find((proc) => proc.cwd && (proc.cwd === root || inside(proc.cwd, root!)) && (isAgentTool(proc) || classifyJob(proc.argv) !== null));
      if (worker) return no(`Something is running in this workspace (${classifyJob(worker.argv)?.label ?? "an agent"}). Clear it once that's finished.`);
      const verdict = (await safe(() => gitVerdicts([path], this.deps.git ?? runGit), new Map())).get(path);
      if (!verdict || verdict.tracked === null) return no("Git couldn't check it, so Hosts leaves it.");
      if (verdict.tracked) return no("Git tracks files in it, so it's part of the project, not build output.");
      if (isIgnoredOnlyName(name) && verdict.ignored !== true) return no("Git doesn't ignore it, so it may be part of the project.");
    } else {
      const name = basename(path);
      if (PROTECTED_NAME.test(name)) return no("Agents' and Paseo's own files are never cleared.");
      const parent = dirname(path);
      if (payload.k === "npm") {
        const npm = join(places.home, ".npm");
        if (path !== join(npm, "_cacache") && path !== join(npm, "_npx")) return no("It isn't npm's cache.");
        root = npm;
      } else if (payload.k === "pnpm") {
        const store = await safe(() => this.deps.pnpmStore(), null);
        const storeReal = store ? await safe(() => realpath(store), null) : null;
        if (!storeReal || storeReal !== path || payload.a !== "prune") return no("It isn't pnpm's store, or pnpm isn't available.");
        root = dirname(path);
      } else if (payload.k === "versions") {
        const siblings = await safe(() => readdir(parent), [] as string[]);
        if (!olderVersions(siblings).includes(name)) return no("It's the newest download of its kind now, so it stays.");
        root = parent;
      } else if (payload.k === "tool") {
        if (!places.cacheBases.includes(parent) || !toolCacheName(name)) return no("It isn't one of the tool caches Hosts knows.");
        root = parent;
      } else if (payload.k === "tmp") {
        if (!places.tmpDirs.includes(parent) || TMP_NEVER.test(name)) return no("It isn't a leftover in the temporary folder.");
        if ((this.now() - st.mtimeMs) / 3_600_000 < TMP_MIN_AGE_HOURS) return no("It changed in the last 6 hours, so it may still be in use.");
        root = parent;
      }
      if (!root) return no("Hosts doesn't know what this is.");
    }
    const rootStat = await safe(() => lstat(root!), null);
    if (!rootStat || rootStat.dev !== st.dev) return no("It's on a different disk from the folder it belongs to, so Hosts leaves it.");
    if (path === root) return no("That's a whole folder Hosts never deletes.");
    if (!open.complete) return no("Hosts couldn't check what's in use right now, so it left this alone.");
    const using = usedBeneath(path, open.paths);
    if (using) return no("Something has a file in it open right now. Try again once it's closed.");
    return { ok: true, reason: null, payload, name: payload.n ?? basename(path), where: homeRelative(path, places.home), bytes: payload.b, isFile };
  }

  /** Rename out of the way (atomic), confirm it's the same inode, then delete at low priority. */
  private async remove(payload: DiskTokenPayload, isFile: boolean): Promise<DeleteResult> {
    if (isFile) {
      const st = await safe(() => lstat(payload.p), null);
      if (!st || st.ino !== payload.i || st.dev !== payload.d) return { ok: false, removedBytes: 0, leftovers: 0, partial: false, error: "It changed just before it was cleared, so it was left." };
      try { await unlink(payload.p); return { ok: true, removedBytes: st.nlink <= 1 ? st.blocks * 512 : 0, leftovers: 0, partial: false }; }
      catch { return { ok: false, removedBytes: 0, leftovers: 1, partial: false, error: "It couldn't be removed." }; }
    }
    const aside = join(dirname(payload.p), `.hosts-clearing-${basename(payload.p)}-${randomBytes(4).toString("hex")}`);
    try { await rename(payload.p, aside); } catch { return { ok: false, removedBytes: 0, leftovers: 0, partial: false, error: "It couldn't be moved aside to clear, so it was left." }; }
    const moved = await safe(() => lstat(aside), null);
    if (!moved || moved.ino !== payload.i || moved.dev !== payload.d || moved.isSymbolicLink()) {
      await safe(() => rename(aside, payload.p), undefined);
      return { ok: false, removedBytes: 0, leftovers: 0, partial: false, error: "It changed just before it was cleared, so it was put back." };
    }
    const remove = this.deps.remove ?? (async (path: string, dev: number) => {
      const run = await runWorker<DeleteResult>({ op: "delete", path, dev, deadline: Date.now() + 20 * 60_000 }, 21 * 60_000);
      return run.results[0] ?? { ok: false, removedBytes: 0, leftovers: 0, partial: true, error: "Clearing took too long and stopped; what's left is set aside and can be cleared again." };
    });
    return remove(aside, payload.d);
  }

  private record(action: ActionLogEntry["action"], checked: Checked, status: ActionLogEntry["status"], bytes: number, message: string) {
    return this.deps.log({ at: this.now(), action, source: "disk", pid: null, name: checked.name, owner: `${checked.payload?.o ?? ""}${checked.where ? ` · ${checked.where}` : ""}`.replace(/^ · /, "") || null, status, signaled: 0, message, bytes }).catch(() => undefined);
  }
}
