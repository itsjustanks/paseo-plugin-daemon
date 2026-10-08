import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CLEARABLE_NAMES, PROTECTED_NAME, TMP_MIN_AGE_HOURS, TMP_NEVER,
  formatSize, isClearableName, isIgnoredOnlyName, isWithin, olderVersions, protectedReason, protectedSet, toolCacheName,
  type DiskJob, type DiskPlan, type ProtectedSet,
} from "../shared/disk";
import type { ActionLogEntry } from "../shared/processes";
import { gitAllows, gitVerdicts, runGit, type GitRun } from "./disk-git";
import { darwinCwds, openPaths, usedBeneath, type OpenPaths } from "./disk-inuse";
import { ChildGroup, quarantineAndRemove, type DeleteResult, type RmFlavour } from "./disk-remove";
import { busyReason, homeRelative, realRoot, workspaceState, type DiskPlaces, type WorkspaceInfo } from "./disk-scan";
import { classifyJob, isPackageDownload } from "./jobs";
import type { RawProcess } from "./platform";
import { isAgentTool } from "./scope";

/**
 * Clearing (0.14.0, reviewed after a deletion-safety audit), after the person
 * has seen the list and confirmed. Designed to fail closed: any doubt is a
 * refusal with the reason.
 *
 * Each item is a signed token (HMAC, this process's key, 30 minutes) bound to
 * the folder's path, device, inode and modification time from the scan.
 * Immediately before EACH item, with a fresh read of Paseo's workspaces, this
 * user's processes and what they have open:
 *  - it is the same real folder (lstat: device, inode, mtime; not a symlink),
 *    owned by this user, and outside the protected set (never equal to,
 *    inside, or an ancestor of home, Paseo's data, agents' history, Hosts'
 *    folder or any workspace/worktree root);
 *  - workspace items: the path is its own real path, inside a workspace or
 *    worktree root, allow-listed by name, and git says right now that it is
 *    ignored with nothing tracked and nothing untracked-and-unignored in it;
 *    no agent is working or waiting there, no build/test/install/dev server
 *    runs in it, and no such job runs anywhere with an unknown folder;
 *  - shared caches: a real folder directly inside its known root (itself a
 *    real folder), still allow-listed for its kind, and no package manager or
 *    browser download is running for this user;
 *  - nothing has a file in it open or as a working directory, and the
 *    in-use picture is complete.
 * Then disk-remove.ts quarantines it, re-checks the inode, refuses if a .env
 * file or .git folder is inside, and deletes it with the system rm. pnpm's
 * store is only ever pruned by pnpm. Every step is logged, as this user.
 * Unloading Hosts stops the job between items and kills any running rm,
 * find or pnpm with its whole process group.
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
  /** This user's processes now. */
  processes(): Promise<RawProcess[]>;
  openPaths?(): Promise<OpenPaths>;
  /** macOS: working directories for these processes (the process list only knows them for listeners). */
  cwds?(pids: readonly number[]): Promise<Map<number, string>>;
  pnpmStore(): Promise<string | null>;
  log(entry: ActionLogEntry): Promise<void>;
  /** Told what was freed, so the cached scan drops it. */
  cleared?(path: string, bytes: number): void;
  git?: GitRun;
  flavour?(): Promise<RmFlavour>;
  /** Tests only: runs after quarantine and checks, just before rm. */
  beforeRemove?(quarantined: string): Promise<void> | void;
  prune?(group: ChildGroup): Promise<{ ok: boolean; message: string }>;
  now?: () => number;
}

interface Checked { ok: boolean; reason: string | null; payload: DiskTokenPayload | null; name: string; where: string; bytes: number }

/** One fresh look at the host, taken just before an item. */
export interface Fresh { open: OpenPaths; workspaces: WorkspaceInfo[] | null; processes: RawProcess[] | null }

const safe = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => { try { return await action(); } catch { return fallback; } };

const defaultPrune = async (group: ChildGroup) => {
  const result = await group.run("pnpm", ["store", "prune"], { timeoutMs: 15 * 60_000, env: { ...process.env, NO_COLOR: "1" } });
  return result.code === 0 ? { ok: true, message: "pnpm removed the packages no project uses." } : { ok: false, message: result.killed ? "Pruning was stopped before it finished." : "pnpm couldn't prune its store." };
};

export class DiskCleaner {
  private job: DiskJob = { state: "idle", freedBytes: 0, results: [], message: null };
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly group = new ChildGroup();

  constructor(private readonly deps: CleanerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  status(): DiskJob { return { ...this.job, results: [...this.job.results] }; }

  /** Unloading: stop between items, kill any running rm/find/pnpm group, and wait for the job to end. */
  async close(): Promise<void> { this.group.killAll(); await this.wait(); }

  /** The ask-first list: light checks only (the full checks run again just before each item goes). */
  async preview(tokens: readonly string[]): Promise<DiskPlan> {
    const items: DiskPlan["items"] = [];
    const guard = await this.protection(await safe(() => this.deps.listWorkspaces(), [] as WorkspaceInfo[]));
    for (const token of tokens) {
      const payload = this.deps.tokens.verify(token);
      if (!payload) { items.push({ name: "Folder", where: "", owner: "", bytes: 0, action: "delete", cost: "", ok: false, reason: "This list is out of date. Check again and try once more." }); continue; }
      const st = await safe(() => lstat(payload.p), null);
      const same = !!st && st.dev === payload.d && st.ino === payload.i && !st.isSymbolicLink() && st.isDirectory();
      const words = CLEARABLE_NAMES[basename(payload.p)];
      const blocked = protectedReason(payload.p, guard);
      items.push({
        name: payload.n ?? basename(payload.p), where: homeRelative(payload.p, this.deps.places.home), owner: payload.o, bytes: payload.b, action: payload.a,
        cost: payload.c ?? (payload.a === "prune" ? "Removes only packages no project uses." : words?.cost ?? "Made again when it's needed."),
        ok: same && !blocked, reason: !st ? "It's already gone." : !same ? "It changed since it was checked. Check again first." : blocked,
      });
    }
    return { items, bytes: items.filter((item) => item.ok).reduce((sum, item) => sum + item.bytes, 0) };
  }

  /** Start clearing in the background; one job at a time. */
  start(tokens: readonly string[]): DiskJob {
    if (this.running || this.group.closed) return this.status();
    this.job = { state: "running", freedBytes: 0, results: [], message: `Clearing ${tokens.length} item${tokens.length === 1 ? "" : "s"}… Each one is checked again just before it goes.` };
    this.running = this.run(tokens).catch((error) => {
      console.error("daemon-link: disk clear failed", error instanceof Error ? error.name : "unknown");
      this.job.message = "Clearing stopped early. Nothing was deleted without its checks.";
    }).finally(() => { this.job.state = "done"; this.running = null; });
    return this.status();
  }
  wait(): Promise<void> { return this.running ?? Promise.resolve(); }

  /** A fresh look at the host: open files, Paseo's workspaces, this user's processes (with macOS cwds for jobs). */
  async fresh(): Promise<Fresh> {
    const [open, workspaces, processes] = await Promise.all([
      (this.deps.openPaths ?? (() => openPaths(this.deps.places.platform, this.deps.uid)))().catch(() => ({ paths: [], complete: false })),
      safe(() => this.deps.listWorkspaces(), null as WorkspaceInfo[] | null),
      safe(() => this.deps.processes(), null as RawProcess[] | null),
    ]);
    if (processes && this.deps.places.platform === "darwin") {
      const unknown = processes.filter((proc) => !proc.cwd && (classifyJob(proc.argv) !== null || isAgentTool(proc))).map((proc) => proc.pid);
      const found = await safe(() => (this.deps.cwds ?? darwinCwds)(unknown), new Map<number, string>());
      for (const proc of processes) if (!proc.cwd && found.has(proc.pid)) proc.cwd = found.get(proc.pid)!;
    }
    return { open, workspaces, processes };
  }

  private async run(tokens: readonly string[]): Promise<void> {
    for (const token of tokens) {
      if (this.group.closed) { this.job.message = "Hosts was unloaded; clearing stopped between items."; return; }
      const checked = await this.check(token, await this.fresh());
      const owner = checked.payload?.o ?? "";
      if (!checked.ok) {
        this.job.results.push({ name: checked.name, owner, ok: false, bytes: 0, message: checked.reason ?? "Not cleared." });
        if (checked.payload) await this.record(checked.payload.a === "prune" ? "disk-prune" : "disk-clear", checked, "denied", 0, `Not cleared: ${checked.reason}`);
        continue;
      }
      const payload = checked.payload!;
      if (payload.a === "prune") {
        const pruned = await (this.deps.prune ?? defaultPrune)(this.group);
        this.job.results.push({ name: checked.name, owner, ok: pruned.ok, bytes: 0, message: pruned.message });
        await this.record("disk-prune", checked, pruned.ok ? "done" : "failed", 0, `${pruned.message} Confirmed in the Paseo app.`);
        continue;
      }
      const outcome: DeleteResult = await quarantineAndRemove(payload.p, { dev: payload.d, ino: payload.i, bytes: payload.b }, { group: this.group, flavour: this.deps.flavour, beforeRemove: this.deps.beforeRemove });
      this.job.freedBytes += outcome.removedBytes;
      if (outcome.ok) this.deps.cleared?.(payload.p, payload.b);
      const message = outcome.ok ? `Cleared ${checked.name} (${formatSize(outcome.removedBytes)}).` : outcome.error ?? "It wasn't cleared.";
      this.job.results.push({ name: checked.name, owner, ok: outcome.ok, bytes: outcome.removedBytes, message });
      await this.record("disk-clear", checked, outcome.ok ? "done" : "failed", outcome.removedBytes, `${message} Confirmed in the Paseo app.`);
    }
    const ok = this.job.results.filter((result) => result.ok).length;
    this.job.message = `${ok} of ${tokens.length} cleared, ${formatSize(this.job.freedBytes)} freed.${ok < tokens.length ? " The rest were left; each says why." : ""}`;
  }

  private async protection(workspaces: readonly WorkspaceInfo[]): Promise<ProtectedSet> {
    const roots = (await Promise.all(workspaces.map((workspace) => safe(() => realpath(workspace.directory), workspace.directory)))).concat(workspaces.map((workspace) => workspace.directory));
    const worktrees = await safe(() => this.deps.unlinkedWorktrees(roots), [] as string[]);
    const { places } = this.deps;
    const aliases = await Promise.all([places.home, places.paseoHome, places.stateDir].map((path) => safe(() => realpath(path), path)));
    return protectedSet(places, roots, worktrees, aliases);
  }

  /** Every rule, against the fresh look. Public so tests can ask about one item. */
  async check(token: string, now: Fresh): Promise<Checked> {
    const { places, uid } = this.deps;
    const payload = this.deps.tokens.verify(token);
    const no = (reason: string): Checked => ({ ok: false, reason, payload, name: payload ? payload.n ?? basename(payload.p) : "Folder", where: payload ? homeRelative(payload.p, places.home) : "", bytes: 0 });
    if (!payload) return no("This list is out of date. Check again and try once more.");
    const path = payload.p;
    const st = await safe(() => lstat(path), null);
    if (!st) return no("It's already gone.");
    if (st.isSymbolicLink()) return no("It's a link to somewhere else, and Hosts never follows links.");
    if (!st.isDirectory()) return no("It isn't a folder.");
    if (st.dev !== payload.d || st.ino !== payload.i) return no("It isn't the same folder that was checked any more. Check again first.");
    if (Math.floor(st.mtimeMs) !== payload.m) return no("It changed since it was checked (something wrote to it). Check again first.");
    if (st.uid !== uid) return no("It belongs to another user, and Hosts only clears this user's files.");
    if (!now.workspaces) return no("Paseo's workspaces couldn't be read, so Hosts can't tell what's protected right now.");
    if (!now.processes) return no("This host's processes couldn't be read, so Hosts can't tell what's running.");
    const guard = await this.protection(now.workspaces);
    const protectedWhy = protectedReason(path, guard);
    if (protectedWhy) return no(protectedWhy);
    const name = basename(path);
    const parent = dirname(path);

    if (payload.k === "workspace") {
      if ((await safe(() => realpath(path), null)) !== path) return no("Its real location is somewhere else (a link on the way), so Hosts leaves it.");
      const folders = await Promise.all(now.workspaces.map(async (workspace) => ({ workspace, path: await safe(() => realpath(workspace.directory), null) })));
      const claimed = folders.filter((folder) => folder.path).map((folder) => folder.path!);
      const unlinked = await safe(() => this.deps.unlinkedWorktrees(claimed), [] as string[]);
      const root = [...claimed, ...unlinked].filter((folder) => isWithin(path, folder)).sort((a, b) => b.length - a.length)[0] ?? null;
      if (!root) return no("It isn't inside one of your Paseo workspaces any more.");
      if (!isClearableName(name) && !isIgnoredOnlyName(name)) return no("It isn't on the list of folders Hosts may clear.");
      const busy = folders.filter((folder) => folder.path === root).map((folder) => busyReason(workspaceState(folder.workspace.status), folder.workspace.devServers)).find(Boolean);
      if (busy) return no(busy);
      const jobs = now.processes.filter((proc) => classifyJob(proc.argv) !== null);
      if (jobs.some((proc) => !proc.cwd)) return no("A build, test or install is running and Hosts can't tell in which folder, so it won't clear any workspace until that finishes.");
      const worker = now.processes.find((proc) => proc.cwd && (proc.cwd === root || isWithin(proc.cwd, root)) && (isAgentTool(proc) || classifyJob(proc.argv) !== null));
      if (worker) return no(`Something is running in this workspace (${classifyJob(worker.argv)?.label ?? "an agent"}). Clear it once that's finished.`);
      const verdict = (await safe(() => gitVerdicts([path], this.deps.git ?? runGit, this.now() + 30_000), new Map())).get(path);
      if (!gitAllows(verdict)) return no("Git didn't confirm it's ignored build output with nothing else inside, so Hosts leaves it.");
    } else {
      if (PROTECTED_NAME.test(name)) return no("Agents' and Paseo's own files are never cleared.");
      const download = now.processes.find((proc) => isPackageDownload(proc.argv));
      if (download) return no("A package install or browser download is running and may be using its caches. Try again once it's finished.");
      // A real folder directly inside a known root that is itself a real folder. No canonicalising.
      const roots = payload.k === "npm" ? [join(places.home, ".npm")]
        : payload.k === "versions" ? places.browserRoots
        : payload.k === "tool" ? places.cacheBases
        : payload.k === "tmp" ? places.tmpDirs
        : payload.k === "pnpm" ? [dirname(path)] : [];
      if (!roots.includes(parent) || !await realRoot(parent)) return no("It isn't directly inside a cache folder Hosts knows, so Hosts leaves it.");
      if (payload.k === "npm" && name !== "_cacache" && name !== "_npx") return no("It isn't npm's cache.");
      if (payload.k === "versions" && !olderVersions(await safe(() => readdir(parent), [] as string[])).includes(name)) return no("It's the newest download of its kind now, so it stays.");
      if (payload.k === "tool" && !toolCacheName(name)) return no("It isn't one of the tool caches Hosts knows.");
      if (payload.k === "tmp") {
        if (TMP_NEVER.test(name)) return no("It isn't a leftover in the temporary folder.");
        if ((this.now() - st.mtimeMs) / 3_600_000 < TMP_MIN_AGE_HOURS) return no("It changed in the last 6 hours, so it may still be in use.");
      }
      if (payload.k === "pnpm") {
        const store = await safe(() => this.deps.pnpmStore(), null);
        if (!store || store !== path || payload.a !== "prune") return no("It isn't pnpm's store, or pnpm isn't available.");
      } else if (payload.a !== "delete") return no("Hosts doesn't know how to clear this.");
    }
    if (!now.open.complete) return no("Hosts couldn't check what's in use right now, so it left this alone.");
    if (usedBeneath(path, now.open.paths)) return no("Something has a file in it open right now. Try again once it's closed.");
    return { ok: true, reason: null, payload, name: payload.n ?? name, where: homeRelative(path, places.home), bytes: payload.b };
  }

  private record(action: ActionLogEntry["action"], checked: Checked, status: ActionLogEntry["status"], bytes: number, message: string) {
    return this.deps.log({ at: this.now(), action, source: "disk", pid: null, name: checked.name, owner: `${checked.payload?.o ?? ""}${checked.where ? ` · ${checked.where}` : ""}`.replace(/^ · /, "") || null, status, signaled: 0, message, bytes }).catch(() => undefined);
  }
}
