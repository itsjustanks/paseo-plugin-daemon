import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { CLEARABLE_NAMES, formatSize, isClearableName, isIgnoredOnlyName, isWithin, protectedReason, type DiskJob, type DiskPlan } from "../shared/disk";
import type { ActionLogEntry } from "../shared/processes";
import { ChildGroup } from "./disk-children";
import { gitAllows, gitVerdicts, groupGit, type GitRun } from "./disk-git";
import { hostSnapshot, usedBeneath, type HostSnapshot } from "./disk-inuse";
import type { QuarantineInventory } from "./disk-quarantine";
import { quarantineAndRemove, type DeleteResult, type RmFlavour } from "./disk-remove";
import { busyReason, canonicalChain, homeRelative, protectionFor, workspaceState, type DiskPlaces, type WorkspaceInfo } from "./disk-scan";
import { classifyJob, isPackageDownload } from "./jobs";
import { isAgentTool } from "./scope";

/**
 * Clearing (0.14.0, narrowed after two deletion-safety reviews). Exactly two
 * things can be cleared, after the person has seen the list and confirmed:
 *
 *  1. Build output inside a Paseo workspace or worktree: an allow-listed
 *     folder that git says right now is ignored, with nothing tracked and
 *     nothing untracked-but-not-ignored beneath it. Deleted by quarantine and
 *     the system rm (disk-remove.ts).
 *  2. Shared caches, only through each tool's own command: `npm cache clean
 *     --force`, `pnpm store prune`, `npx --no-install playwright uninstall`.
 *     Hosts deletes no cache folder itself, and nothing in /tmp, browser
 *     download folders or other caches at all.
 *
 * Immediately before each item, with a fresh, COMPLETE snapshot of this
 * user's processes and open files (anything less refuses, and says why):
 *  - workspace folders: same real folder as the scan (lstat device, inode,
 *    mtime; never a symlink), owned by this user; no ancestor is a symlink and
 *    the path is its own real path; outside the protected set (never equal to
 *    or enclosing home, a workspace or worktree root or /; never equal to,
 *    enclosing or inside agents' history, Paseo's data or Hosts' folder);
 *    inside a workspace or worktree root; git's three answers; no agent
 *    working or waiting there; no build, test, install or dev server in it,
 *    and none anywhere whose folder can't be told; nothing open beneath it;
 *  - cache commands: the tool is still there, and no package install or
 *    browser download is running for this user.
 * Every child (git, rm, the commands) runs in its own process group with a
 * timeout, killed on unload. Every step is logged, as this user.
 */

export const TOKEN_TTL_MS = 30 * 60_000;
/** What a token is for: a workspace build folder (deleted), or a cache cleaned by its own tool. */
export type ItemKind = "workspace" | "npm" | "pnpm" | "playwright";

/** p path, d device, i inode, m mtime (ms, floored), a action, k kind, o owner label, b bytes the scan measured, n display name, c cost words, x expiry. */
export interface DiskTokenPayload { p: string; d: number; i: number; m: number; a: "delete" | "command"; k: ItemKind; o: string; b: number; n?: string; c?: string; x: number }

export interface MintInput { path: string; dev: number; ino: number; mtimeMs: number; action: "delete" | "command"; kind: ItemKind; owner: string; bytes: number; name?: string; cost?: string }

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
  /** A fresh, complete-or-refusing look at this user's processes and open files. */
  snapshot?(): Promise<HostSnapshot>;
  inventory?: QuarantineInventory;
  log(entry: ActionLogEntry): Promise<void>;
  /** Told what was freed, so the cached scan drops it. */
  cleared?(path: string, bytes: number): void;
  git?: GitRun;
  flavour?(): Promise<RmFlavour>;
  /** Tests only: runs after quarantine and checks, just before rm. */
  beforeRemove?(quarantined: string): Promise<void> | void;
  /** Runs a tool's own cache command (tests swap it). */
  command?(kind: Exclude<ItemKind, "workspace">, group: ChildGroup): Promise<{ ok: boolean; message: string }>;
  /** Whether a tool's command is available now. */
  toolReady?(kind: Exclude<ItemKind, "workspace">, group: ChildGroup): Promise<boolean>;
  now?: () => number;
}

interface Checked { ok: boolean; reason: string | null; payload: DiskTokenPayload | null; name: string; where: string; bytes: number }

const safe = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => { try { return await action(); } catch { return fallback; } };

/** Each tool's own cache command: argv only, no shell, its own process group, a timeout. */
export const CACHE_COMMANDS: Record<Exclude<ItemKind, "workspace">, { file: string; args: string[]; check: string[]; done: string }> = {
  npm: { file: "npm", args: ["cache", "clean", "--force"], check: ["--version"], done: "npm cleared its download cache." },
  pnpm: { file: "pnpm", args: ["store", "prune"], check: ["--version"], done: "pnpm removed the packages no project uses." },
  playwright: { file: "npx", args: ["--no-install", "playwright", "uninstall"], check: ["--no-install", "playwright", "--version"], done: "Playwright removed the browsers no installed Playwright uses." },
};

export async function runCacheCommand(kind: Exclude<ItemKind, "workspace">, group: ChildGroup, home: string): Promise<{ ok: boolean; message: string }> {
  const command = CACHE_COMMANDS[kind];
  const result = await group.run(command.file, command.args, { timeoutMs: 15 * 60_000, cwd: home, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
  return result.code === 0 ? { ok: true, message: command.done } : { ok: false, message: result.killed || result.timedOut ? "It was stopped before it finished." : `${command.file} couldn't finish it.` };
}

export async function cacheToolReady(kind: Exclude<ItemKind, "workspace">, group: ChildGroup, home: string): Promise<boolean> {
  const command = CACHE_COMMANDS[kind];
  return (await group.run(command.file, command.check, { timeoutMs: 20_000, cwd: home, env: { ...process.env, NO_COLOR: "1", CI: "1" } })).code === 0;
}

export class DiskCleaner {
  private job: DiskJob = { state: "idle", freedBytes: 0, results: [], message: null };
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly group = new ChildGroup();

  constructor(private readonly deps: CleanerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  status(): DiskJob { return { ...this.job, results: [...this.job.results] }; }

  /** Unloading: stop between items, kill any running git/rm/command group, and wait for the job to end. */
  async close(): Promise<void> { this.group.killAll(); await this.wait(); }

  /** The ask-first list: light checks only (the full checks run again just before each item goes). */
  async preview(tokens: readonly string[]): Promise<DiskPlan> {
    const items: DiskPlan["items"] = [];
    const guard = await protectionFor(this.deps.places, await safe(() => this.deps.listWorkspaces(), [] as WorkspaceInfo[]), this.deps.unlinkedWorktrees);
    for (const token of tokens) {
      const payload = this.deps.tokens.verify(token);
      if (!payload) { items.push({ name: "Folder", where: "", owner: "", bytes: 0, action: "delete", cost: "", ok: false, reason: "This list is out of date. Check again and try once more." }); continue; }
      const base = { name: payload.n ?? basename(payload.p), where: homeRelative(payload.p, this.deps.places.home), owner: payload.o, bytes: payload.b, action: payload.a };
      if (payload.a === "command") { items.push({ ...base, cost: payload.c ?? "", ok: true, reason: null }); continue; }
      const st = await safe(() => lstat(payload.p), null);
      const same = !!st && st.dev === payload.d && st.ino === payload.i && !st.isSymbolicLink() && st.isDirectory();
      const blocked = protectedReason(payload.p, guard);
      items.push({ ...base, cost: payload.c ?? CLEARABLE_NAMES[basename(payload.p)]?.cost ?? "Made again when it's needed.", ok: same && !blocked, reason: !st ? "It's already gone." : !same ? "It changed since it was checked. Check again first." : blocked });
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

  private snapshot(): Promise<HostSnapshot> {
    return (this.deps.snapshot ?? (() => hostSnapshot(this.deps.places.platform, this.deps.uid)))().catch(() => ({ processes: [], open: [], complete: false, why: "This user's processes couldn't be read." }));
  }

  private async run(tokens: readonly string[]): Promise<void> {
    for (const token of tokens) {
      if (this.group.closed) { this.job.message = "Hosts was unloaded; clearing stopped between items."; return; }
      const checked = await this.check(token);
      const owner = checked.payload?.o ?? "";
      if (!checked.ok) {
        this.job.results.push({ name: checked.name, owner, ok: false, bytes: 0, message: checked.reason ?? "Not cleared." });
        if (checked.payload) await this.record(checked.payload.a === "command" ? "disk-prune" : "disk-clear", checked, "denied", 0, `Not cleared: ${checked.reason}`);
        continue;
      }
      const payload = checked.payload!;
      if (payload.a === "command") {
        const kind = payload.k as Exclude<ItemKind, "workspace">;
        const outcome = await (this.deps.command ?? ((k, group) => runCacheCommand(k, group, this.deps.places.home)))(kind, this.group);
        this.job.results.push({ name: checked.name, owner, ok: outcome.ok, bytes: 0, message: outcome.message });
        await this.record("disk-prune", checked, outcome.ok ? "done" : "failed", 0, `${outcome.message} (${CACHE_COMMANDS[kind].file} ${CACHE_COMMANDS[kind].args.join(" ")}) Confirmed in the Paseo app.`);
        continue;
      }
      const outcome: DeleteResult = await quarantineAndRemove(payload.p, { dev: payload.d, ino: payload.i, bytes: payload.b }, { group: this.group, flavour: this.deps.flavour, beforeRemove: this.deps.beforeRemove, inventory: this.deps.inventory });
      this.job.freedBytes += outcome.removedBytes;
      if (outcome.ok) this.deps.cleared?.(payload.p, payload.b);
      const message = outcome.ok ? `Cleared ${checked.name} (${formatSize(outcome.removedBytes)}).` : outcome.error ?? "It wasn't cleared.";
      this.job.results.push({ name: checked.name, owner, ok: outcome.ok, bytes: outcome.removedBytes, message });
      await this.record("disk-clear", checked, outcome.ok ? "done" : "failed", outcome.removedBytes, `${message} Confirmed in the Paseo app.`);
    }
    const ok = this.job.results.filter((result) => result.ok).length;
    this.job.message = `${ok} of ${tokens.length} done, ${formatSize(this.job.freedBytes)} freed.${ok < tokens.length ? " The rest were left; each says why." : ""}`;
  }

  /** Every rule, against a fresh look. Public so tests can ask about one item. */
  async check(token: string): Promise<Checked> {
    const { places, uid } = this.deps;
    const payload = this.deps.tokens.verify(token);
    const no = (reason: string): Checked => ({ ok: false, reason, payload, name: payload ? payload.n ?? basename(payload.p) : "Folder", where: payload ? homeRelative(payload.p, places.home) : "", bytes: 0 });
    if (!payload) return no("This list is out of date. Check again and try once more.");
    const snap = await this.snapshot();
    if (!snap.complete) return no(`Hosts couldn't get a complete picture of what's running (${(snap.why ?? "unknown reason").replace(/\.$/, "")}), so it cleared nothing.`);

    if (payload.a === "command") {
      if (payload.k === "workspace") return no("Hosts doesn't know how to clear this.");
      const download = snap.processes.find((proc) => isPackageDownload(proc.argv));
      if (download) return no("A package install or browser download is running and may be using its cache. Try again once it's finished.");
      if (!await (this.deps.toolReady ?? ((k, group) => cacheToolReady(k, group, places.home)))(payload.k, this.group)) return no(`${CACHE_COMMANDS[payload.k].file} isn't available here any more.`);
      return { ok: true, reason: null, payload, name: payload.n ?? payload.k, where: homeRelative(payload.p, places.home), bytes: payload.b };
    }
    if (payload.k !== "workspace" || payload.a !== "delete") return no("Hosts doesn't know how to clear this.");

    const path = payload.p;
    const st = await safe(() => lstat(path), null);
    if (!st) return no("It's already gone.");
    if (st.isSymbolicLink()) return no("It's a link to somewhere else, and Hosts never follows links.");
    if (!st.isDirectory()) return no("It isn't a folder.");
    if (st.dev !== payload.d || st.ino !== payload.i) return no("It isn't the same folder that was checked any more. Check again first.");
    if (Math.floor(st.mtimeMs) !== payload.m) return no("It changed since it was checked (something wrote to it). Check again first.");
    if (st.uid !== uid) return no("It belongs to another user, and Hosts only clears this user's files.");
    if (!await canonicalChain(path)) return no("There's a link somewhere on the way to it, or it isn't where its name says, so Hosts leaves it.");
    const workspaces = await safe(() => this.deps.listWorkspaces(), null as WorkspaceInfo[] | null);
    if (!workspaces) return no("Paseo's workspaces couldn't be read, so Hosts can't tell what's protected right now.");
    const guard = await protectionFor(places, workspaces, this.deps.unlinkedWorktrees);
    const protectedWhy = protectedReason(path, guard);
    if (protectedWhy) return no(protectedWhy);
    const name = basename(path);
    if (!isClearableName(name) && !isIgnoredOnlyName(name)) return no("It isn't on the list of folders Hosts may clear.");
    const roots = [...guard.workspaceRoots, ...guard.worktreeRoots];
    const root = roots.filter((folder) => isWithin(path, folder)).sort((a, b) => b.length - a.length)[0] ?? null;
    if (!root) return no("It isn't inside one of your Paseo workspaces any more.");
    const busy = workspaces.filter((workspace) => guard.byRoot.get(root)?.includes(workspace.id)).map((workspace) => busyReason(workspaceState(workspace.status), workspace.devServers)).find(Boolean);
    if (busy) return no(busy);
    const jobs = snap.processes.filter((proc) => classifyJob(proc.argv) !== null);
    if (jobs.some((proc) => !proc.cwd)) return no("A build, test or install is running and Hosts can't tell in which folder, so it won't clear any workspace until that finishes.");
    const worker = snap.processes.find((proc) => proc.cwd && (proc.cwd === root || isWithin(proc.cwd, root)) && (isAgentTool({ argv: proc.argv, comm: "" } as never) || classifyJob(proc.argv) !== null));
    if (worker) return no(`Something is running in this workspace (${classifyJob(worker.argv)?.label ?? "an agent"}). Clear it once that's finished.`);
    const verdict = (await safe(() => gitVerdicts([path], this.deps.git ?? groupGit(this.group), this.now() + 30_000), new Map())).get(path);
    if (!gitAllows(verdict)) return no("Git didn't confirm it's ignored build output with nothing else inside, so Hosts leaves it.");
    if (usedBeneath(path, snap.open)) return no("Something has a file in it open right now. Try again once it's closed.");
    return { ok: true, reason: null, payload, name: payload.n ?? name, where: homeRelative(path, places.home), bytes: payload.b };
  }

  private record(action: ActionLogEntry["action"], checked: Checked, status: ActionLogEntry["status"], bytes: number, message: string) {
    return this.deps.log({ at: this.now(), action, source: "disk", pid: null, name: checked.name, owner: `${checked.payload?.o ?? ""}${checked.where ? ` · ${checked.where}` : ""}`.replace(/^ · /, "") || null, status, signaled: 0, message, bytes }).catch(() => undefined);
  }
}
