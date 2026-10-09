import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describeName, formatSize, isOnePressName, isWithin, protectedReason, type DiskJob, type DiskPlan, type ProbeChecks } from "../shared/disk";
import { friendlyPath } from "../shared/paths";
import type { ActionLogEntry } from "../shared/processes";
import { ChildGroup } from "./disk-children";
import { gitAllows, gitVerdicts, groupGit, type GitRun } from "./disk-git";
import { hostSnapshot, usedBeneath, workspaceUsers, type HostSnapshot } from "./disk-inuse";
import { JOURNAL_PROBLEM, type QuarantineInventory } from "./disk-quarantine";
import { quarantineAndRemove, type DeleteResult, type RmFlavour } from "./disk-remove";
import { NO_LOCKFILE, busyReason, canonicalChain, hasLockfile, homeRelative, protectionFor, workspaceState, type DiskPlaces, type WorkspaceInfo } from "./disk-scan";
import { classifyJob } from "./jobs";

/**
 * One-press Clear (0.16.0). Ported from the reviewed 0.14 cleanup branch,
 * narrowed to ONE kind of thing: an allow-listed build folder (node_modules,
 * .next, dist that git ignores…) INSIDE a Paseo workspace or worktree root.
 * Nothing in /tmp, no shared cache, no browser download, no workspace whose
 * root is under a temporary folder: those are "Ask an agent" only.
 *
 * The person sees the warning dialog (from `preview`, which runs every check
 * fresh) and confirms. Then, for each item, inside one overall deadline:
 *  1. the signed token (path, device, inode, mtime, owner, bytes, expiry);
 *  2. the same real folder: lstat device + inode + mtime, a folder, not a
 *     link, owned by this user; every ancestor real (no symlink) and the path
 *     its own real path;
 *  3. Paseo's workspaces (read inside the deadline) and the protected set:
 *     never home, Paseo's data, agents' history, Hosts' folder, a workspace
 *     or worktree root or /, nor anything enclosing them;
 *  4. its name is on the allow-list; it's inside a workspace or worktree
 *     root; that root isn't under a temporary folder;
 *  5. no agent working or waiting in that workspace, no dev server Paseo
 *     knows of there;
 *  6. git, right now: ignored, nothing tracked beneath, nothing untracked
 *     and unignored beneath;
 *  7. THEN a fresh, complete snapshot of this user's processes and open
 *     files (taken after git, so it reflects git having finished): anything
 *     less refuses; any process in that workspace other than an idle
 *     interactive shell refuses (installs and scripts recognised by their
 *     rewritten titles too); a process whose folder can't be told refuses;
 *     anything open beneath the folder refuses;
 *  8. quarantine, inode check, the physical inside-check (.env, .git, bare
 *     repository), rm with stay-on-one-disk (disk-remove.ts).
 * A damaged quarantine journal stops every clear. Every outcome is logged.
 */

export const TOKEN_TTL_MS = 30 * 60_000;
/** The whole clear (every item) gets this long; each step gets only what's left. */
export const CLEAR_DEADLINE_MS = 20 * 60_000;
/** One registry read inside a clear. */
const REGISTRY_MS = 20_000;
/** Git's three questions for one item. */
const GIT_MS = 30_000;

/** p path, r its workspace root, d device, i inode, m mtime (ms, floored), w workspace label, b bytes, n what it is, c cost, x expiry. */
export interface DiskTokenPayload { p: string; r: string; d: number; i: number; m: number; w: string; b: number; n: string; c: string; x: number }
export interface MintInput { path: string; root: string; dev: number; ino: number; mtimeMs: number; workspace: string; bytes: number; what: string; cost: string }

export class DiskTokens {
  constructor(private readonly key: Buffer = randomBytes(32), private readonly now: () => number = Date.now) {}
  mint(item: MintInput): string {
    const payload: DiskTokenPayload = { p: item.path, r: item.root, d: item.dev, i: item.ino, m: Math.floor(item.mtimeMs), w: item.workspace.slice(0, 80), b: Math.max(0, Math.round(item.bytes)), n: item.what.slice(0, 80), c: item.cost.slice(0, 160), x: this.now() + TOKEN_TTL_MS };
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
      if (typeof payload.p !== "string" || !payload.p.startsWith("/") || typeof payload.r !== "string" || typeof payload.d !== "number" || typeof payload.i !== "number" || typeof payload.m !== "number" || typeof payload.x !== "number" || payload.x < this.now()) return null;
      return payload;
    } catch { return null; }
  }
}

/** Temporary folders: a workspace whose root is under one is out of scope for Clear. */
export function defaultTmpRoots(): string[] {
  const roots = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"]);
  for (const dir of [tmpdir(), process.env.TMPDIR ?? ""]) {
    if (!dir) continue;
    roots.add(dir.replace(/\/+$/, ""));
    try { roots.add(realpathSync(dir).replace(/\/+$/, "")); } catch { /* Only what exists. */ }
  }
  return [...roots].filter((root) => root.startsWith("/") && root !== "/");
}

export interface CleanerDeps {
  places: DiskPlaces;
  uid: number;
  tokens: DiskTokens;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  unlinkedWorktrees(claimed: readonly string[]): Promise<string[]>;
  /** A fresh, complete-or-refusing look at this user's processes and open files. */
  snapshot?(): Promise<HostSnapshot>;
  inventory: QuarantineInventory;
  log(entry: ActionLogEntry): Promise<void>;
  /** Told what was freed, so the cached scan drops it. */
  cleared?(path: string, bytes: number): void;
  git?: GitRun;
  flavour?(): Promise<RmFlavour>;
  probe?: (path: string, group: ChildGroup, deadline: number, checks?: ProbeChecks) => Promise<{ ok: boolean; why: string | null }>;
  /** Tests only: runs after quarantine and checks, just before rm. */
  beforeRemove?(quarantined: string): Promise<void> | void;
  /** Temporary folders (default: the system's); tests pass their own. */
  tmpRoots?: readonly string[];
  now?: () => number;
}

export interface Checked { ok: boolean; reason: string | null; payload: DiskTokenPayload | null; workspace: string; where: string; path: string; bytes: number; root?: string }

/** Resolves to the value, or `fallback` once `ms` pass or `signal` aborts. The slow work is not awaited further. */
function within<T>(start: () => Promise<T>, ms: number, fallback: T, signal: AbortSignal): Promise<T> {
  if (signal.aborted || ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    let work: Promise<T>;
    try { work = start(); } catch { resolve(fallback); return; }
    const timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(fallback); }, { once: true });
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

const IDLE: DiskJob = { state: "idle", freedBytes: 0, results: [], message: null, finishedAt: null };

export class DiskCleaner {
  private job: DiskJob = { ...IDLE };
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly group = new ChildGroup();
  private readonly abort = new AbortController();
  private readonly tmpRoots: readonly string[];

  constructor(private readonly deps: CleanerDeps) {
    this.now = deps.now ?? Date.now;
    this.tmpRoots = deps.tmpRoots ?? defaultTmpRoots();
  }

  get isRunning(): boolean { return this.running !== null; }
  status(): DiskJob { return { ...this.job, results: [...this.job.results] }; }

  /** Unloading: stop between items, kill any git/rm/probe group, and wait for the job to end. */
  async close(): Promise<void> { this.abort.abort(); this.group.killAll(); await this.wait(); }
  wait(): Promise<void> { return this.running ?? Promise.resolve(); }

  /** A complete snapshot or why not; one retry, since a process starting mid-look makes one incomplete. */
  private async snapshot(): Promise<HostSnapshot> {
    const take = () => (this.deps.snapshot ?? (() => hostSnapshot(this.deps.places.platform, this.deps.uid)))()
      .catch(() => ({ processes: [], open: [], complete: false, why: "This user's processes couldn't be read." }));
    const first = await take();
    return first.complete ? first : take();
  }

  /** Right before rm (0.16.0 review fix): a fresh snapshot; anything using the workspace or the quarantine puts it back. */
  private finalCheck(root: string): (quarantined: string) => Promise<string | null> {
    return async (quarantined) => {
      const snap = await this.snapshot();
      if (!snap.complete) return `Hosts couldn't get a complete picture of what's running just before deleting (${(snap.why ?? "unknown reason").replace(/\.$/, "")}), so it was put back.`;
      const users = workspaceUsers(snap, root, (argv) => classifyJob(argv)?.label ?? null);
      if (users?.unknownFolder) return "Something started and Hosts can't tell in which folder, so it was put back.";
      if (users) return `Something started in this workspace (${users.why}), so it was put back.`;
      if (usedBeneath(quarantined, snap.open)) return "Something opened a file in it, so it was put back.";
      return null;
    };
  }

  /**
   * The warning dialog's list: every check, run fresh now, against one
   * snapshot taken after the git checks. Deletes nothing.
   */
  async preview(tokens: readonly string[]): Promise<DiskPlan> {
    const deadline = this.now() + 2 * 60_000;
    const checkedAt = this.now();
    const prepared = [];
    for (const token of tokens) prepared.push(await this.checkBeforeSnapshot(token, deadline));
    const snap = prepared.some((item) => item.ok) ? await this.snapshot() : null;
    const items = prepared.map((item) => (item.ok && snap ? this.checkAgainstSnapshot(item, snap) : item)).map((item) => ({
      workspace: item.workspace, where: item.where, path: item.path, what: item.payload?.n ?? "Build folder", cost: item.payload?.c ?? "Made again when it's needed.",
      bytes: item.payload?.b ?? 0, ok: item.ok, reason: item.reason,
    }));
    const ok = items.filter((item) => item.ok);
    return { items, bytes: ok.reduce((sum, item) => sum + item.bytes, 0), count: ok.length, checkedAt };
  }

  /** Start deleting in the background; one job at a time. */
  start(tokens: readonly string[]): DiskJob {
    if (this.running || this.group.closed) return this.status();
    this.job = { state: "running", freedBytes: 0, results: [], message: `Deleting ${tokens.length} folder${tokens.length === 1 ? "" : "s"}… Each one is checked again just before it goes.`, finishedAt: null };
    this.running = this.run(tokens).catch((error) => {
      console.error("daemon-link: disk clear failed", error instanceof Error ? error.name : "unknown");
      this.job.message = "Clearing stopped early. Nothing was deleted without its checks.";
    }).finally(() => { this.job.state = "done"; this.job.finishedAt = this.now(); this.running = null; });
    return this.status();
  }

  private async run(tokens: readonly string[]): Promise<void> {
    const deadline = this.now() + CLEAR_DEADLINE_MS;
    for (const token of tokens) {
      if (this.group.closed || this.abort.signal.aborted) { this.job.message = "Hosts was unloaded; clearing stopped between folders."; break; }
      if (this.now() >= deadline) { this.job.results.push({ workspace: "", where: "", ok: false, bytes: 0, message: "The time for this clear ran out; the rest were left." }); break; }
      const checked = await this.check(token, deadline);
      if (!checked.ok) {
        this.job.results.push({ workspace: checked.workspace, where: checked.where, ok: false, bytes: 0, message: checked.reason ?? "Not deleted." });
        if (checked.payload) await this.record(checked, "denied", 0, `Not deleted: ${checked.reason}`);
        continue;
      }
      const payload = checked.payload!;
      const outcome: DeleteResult = await quarantineAndRemove(payload.p, { dev: payload.d, ino: payload.i, bytes: payload.b }, {
        group: this.group, flavour: this.deps.flavour, beforeRemove: this.deps.beforeRemove, inventory: this.deps.inventory, probe: this.deps.probe, deadline,
        finalCheck: this.finalCheck(checked.root!),
      });
      this.job.freedBytes += outcome.removedBytes;
      if (outcome.ok) this.deps.cleared?.(payload.p, payload.b);
      const message = outcome.ok ? `Deleted (${formatSize(outcome.removedBytes)}).` : outcome.error ?? "It wasn't deleted.";
      this.job.results.push({ workspace: checked.workspace, where: checked.where, ok: outcome.ok, bytes: outcome.removedBytes, message });
      await this.record(checked, outcome.ok ? "done" : "failed", outcome.removedBytes, `${message} Confirmed in the Paseo app.`);
    }
    const ok = this.job.results.filter((result) => result.ok).length;
    this.job.message = `Deleted ${formatSize(this.job.freedBytes)} from ${ok} folder${ok === 1 ? "" : "s"}.${ok < tokens.length ? " The rest were left; each says why." : ""}`;
  }

  /** Every rule, against a fresh look; the snapshot is taken after git. Public so tests can ask about one item. */
  async check(token: string, deadline = this.now() + CLEAR_DEADLINE_MS): Promise<Checked> {
    const before = await this.checkBeforeSnapshot(token, deadline);
    if (!before.ok) return before;
    if (this.now() >= deadline) return { ...before, ok: false, reason: "The time for this clear ran out before it got here." };
    return this.checkAgainstSnapshot(before, await this.snapshot());
  }

  /** Steps 1–6: the token, the folder itself, the workspaces and protection, the agent's state, git. */
  private async checkBeforeSnapshot(token: string, deadline: number): Promise<Checked & { root?: string; workspaces?: WorkspaceInfo[] }> {
    const { places, uid } = this.deps;
    const payload = this.deps.tokens.verify(token);
    // Where it is, inside its workspace ("apps/web/node_modules"), as the scan showed it.
    const label = (path: string, root: string) => friendlyPath(path, { home: places.home, roots: root ? [{ name: "", root }] : [], paseoHome: places.paseoHome }).rel || basename(path);
    const base = payload ? { workspace: payload.w, where: label(payload.p, payload.r), path: payload.p } : { workspace: "", where: "", path: "" };
    const no = (reason: string): Checked => ({ ok: false, reason, payload, bytes: 0, ...base });
    if (!payload) return no("This list is out of date. Check disk space again and try once more.");
    const blocked = await this.deps.inventory.blocker().catch(() => JOURNAL_PROBLEM);
    if (blocked) return no(blocked);

    const path = payload.p;
    const st = await lstat(path).catch(() => null);
    if (!st) return no("It's already gone.");
    if (st.isSymbolicLink()) return no("It's a link to somewhere else, and Hosts never follows links.");
    if (!st.isDirectory()) return no("It isn't a folder.");
    if (st.dev !== payload.d || st.ino !== payload.i) return no("It isn't the same folder that was checked any more. Check disk space again first.");
    if (Math.floor(st.mtimeMs) !== payload.m) return no("It changed since it was checked (something wrote to it). Check disk space again first.");
    if (st.uid !== uid) return no("It belongs to another user, and Hosts only deletes this user's files.");
    if (!await canonicalChain(path)) return no("There's a link somewhere on the way to it, or it isn't where its name says, so Hosts leaves it.");
    const workspaces = await within(() => this.deps.listWorkspaces(), Math.min(REGISTRY_MS, deadline - this.now()), null as WorkspaceInfo[] | null, this.abort.signal);
    if (!workspaces) return no("Paseo's workspaces couldn't be read in time, so Hosts can't tell what's protected right now.");
    const guard = await within(() => protectionFor(places, workspaces, this.deps.unlinkedWorktrees), Math.min(REGISTRY_MS, deadline - this.now()), null, this.abort.signal);
    if (!guard) return no("Hosts couldn't work out what's protected in time, so it left it.");
    const protectedWhy = protectedReason(path, guard);
    if (protectedWhy) return no(protectedWhy);
    const name = basename(path);
    if (!isOnePressName(name)) return no("Hosts only deletes folders a tool makes and manages itself; ask an agent about this one.");
    // Exactly that spelling on disk (a case-insensitive disk would also answer to "NODE_MODULES" or "Build").
    const siblings = await readdir(dirname(path)).catch(() => null);
    if (!siblings || !siblings.includes(name)) return no("Its name on disk isn't exactly one Hosts may delete, so it leaves it.");
    const roots = [...guard.workspaceRoots, ...guard.worktreeRoots];
    const root = roots.filter((folder) => isWithin(path, folder)).sort((a, b) => b.length - a.length)[0] ?? null;
    if (!root) return no("It isn't inside one of your Paseo workspaces any more.");
    if (this.tmpRoots.some((tmp) => root === tmp || isWithin(root, tmp))) return no("This workspace is in a temporary folder. Hosts doesn't delete anything there; ask an agent instead.");
    if (name === "node_modules" && !await hasLockfile(path, root)) return no(NO_LOCKFILE);
    const owners = workspaces.filter((workspace) => guard.byRoot.get(root)?.includes(workspace.id));
    const busy = owners.map((workspace) => busyReason(workspaceState(workspace.status), workspace.devServers)).find(Boolean);
    if (busy) return no(busy);
    const gitLeft = Math.min(GIT_MS, deadline - this.now());
    const verdict = gitLeft > 0 ? (await gitVerdicts([path], this.deps.git ?? groupGit(this.group), this.now() + gitLeft, this.now).catch(() => new Map())).get(path) : undefined;
    if (!gitAllows(verdict)) return no("Git didn't confirm it's ignored build output with nothing else inside, so Hosts leaves it.");
    return { ok: true, reason: null, payload, bytes: payload.b, ...base, root, workspaces };
  }

  /** Steps 7: what's running, from a snapshot taken after git. */
  private checkAgainstSnapshot(item: Checked & { root?: string }, snap: HostSnapshot): Checked {
    const no = (reason: string): Checked => ({ ...item, ok: false, reason, bytes: 0 });
    if (!snap.complete) return no(`Hosts couldn't get a complete picture of what's running (${(snap.why ?? "unknown reason").replace(/\.$/, "")}), so it deleted nothing.`);
    const root = item.root!;
    const users = workspaceUsers(snap, root, (argv) => classifyJob(argv)?.label ?? null);
    if (users?.unknownFolder) return no("Something is running and Hosts can't tell in which folder, so it won't delete anything until that finishes.");
    if (users) return no(`Something is running in this workspace (${users.why}). Delete once that's finished.`);
    if (usedBeneath(item.path, snap.open)) return no("Something has a file in it open right now. Try again once it's closed.");
    return { ...item, ok: true, reason: null };
  }

  private record(checked: Checked, status: ActionLogEntry["status"], bytes: number, message: string) {
    return this.deps.log({ at: this.now(), action: "disk-clear", source: "disk", pid: null, name: basename(checked.path) || "folder", owner: `${checked.workspace}${checked.path ? ` · ${homeRelative(checked.path, this.deps.places.home)}` : ""}`.replace(/^ · /, "") || null, status, signaled: 0, message, bytes }).catch(() => undefined);
  }
}

/** For the scan: the token for one safe workspace item, or null when Clear must not offer it (temporary folders). */
export function clearCost(name: string): { what: string; cost: string } {
  const words = describeName(name);
  return { what: words?.what ?? "Build folder", cost: words?.cost ?? "Made again when it's needed." };
}
