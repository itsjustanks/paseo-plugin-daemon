import { lstat, readdir, readFile, realpath, statfs, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLEARABLE_NAMES, IGNORED_ONLY_MAX_DEPTH, IGNORED_ONLY_NAMES, PROTECTED_NAME, TMP_NEVER,
  ago, describeName, diskSpace, formatSize, protectedReason, protectedSet, toolCacheName, type ProtectedSet,
  type CacheGroup, type ClearItem, type DiskReport, type DiskSpace, type WorkspaceState, type WorkspaceUsage,
} from "../shared/disk";
import { stateDirectory } from "./binaries";
import { ChildGroup } from "./disk-children";
import { gitAllows, gitVerdicts, groupGit, type GitRun, type GitVerdict } from "./disk-git";
import type { QuarantineInventory } from "./disk-quarantine";
import { runWorker, type WalkItem, type WalkResult, type WalkRoot } from "./disk-worker";
import type { ItemKind, MintInput } from "./disk-clear";

/**
 * 0.14.0's disk scan: what each Paseo workspace's folder holds, what of it is
 * build output git ignores, and the shared caches and temporary files.
 * Heavy, so it is:
 *  - on demand only (never from the 10-second loop), with the last answer
 *    cached in memory and in $PASEO_HOME/daemon-link/disk-scan.json;
 *  - one at a time: asking while one runs joins it;
 *  - in child processes at the lowest priority, each in its own process
 *    group that unloading kills (the walk, git, and the tools' version checks);
 *  - under ONE deadline covering everything: reading Paseo's workspaces,
 *    finding folders and caches, the walk, and git. Whatever doesn't finish is
 *    shown as not checked and is never clearable.
 * Plugin calls get 30 seconds, so a scan runs in the background and the app
 * polls the report. Workspace status (working, idle, dev servers) is read
 * fresh on every report; sizes come from the last scan.
 */

export const SCAN_SECONDS = 240;

/** One Paseo workspace as the SDK describes it, read defensively (fields vary across Paseo versions). */
export interface WorkspaceInfo { id: string; name: string; project: string | null; directory: string; worktree: boolean; status: string | null; activityAt: number | null; branch: string | null; devServers: string[] }

/**
 * Where things are. `browserRoots` are folders of browser downloads (shown
 * for size; Playwright's is cleaned only by Playwright); `stateDir` is Hosts'
 * own folder (always protected).
 */
export interface DiskPlaces { platform: "linux" | "darwin"; home: string; paseoHome: string; stateDir: string; tmpDirs: string[]; cacheBases: string[]; browserRoots: string[] }

export function defaultPlaces(platform: "linux" | "darwin"): DiskPlaces {
  const home = homedir();
  const paseoHome = process.env.PASEO_HOME || join(home, ".paseo");
  const cacheBases = platform === "darwin" ? [join(home, "Library", "Caches"), join(home, ".cache")] : [join(home, ".cache")];
  const browserRoots = [
    ...cacheBases.map((base) => join(base, "ms-playwright")),
    join(home, ".cache", "puppeteer"),
    join(home, ".agent-browser", "browsers"), join(home, ".cache", "agent-browser"),
    // The fleet's containers keep a second agent-browser home here (shown only when it's this user's).
    "/opt/agent-home/.agent-browser/browsers",
  ];
  return { platform, home, paseoHome, stateDir: stateDirectory(), cacheBases, browserRoots: [...new Set(browserRoots)], tmpDirs: platform === "darwin" ? ["/private/tmp"] : [...new Set(["/tmp", tmpdir()])] };
}

const safe = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => { try { return await action(); } catch { return fallback; } };

/**
 * Every folder from / down to `path` is a real folder (none is a symlink)
 * and `path` is its own real path. Anything else (a symlinked home, a cache
 * folder that is a link into ~/.codex) is refused.
 */
export async function canonicalChain(path: string): Promise<boolean> {
  if (!path.startsWith("/")) return false;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    const st = await safe(() => lstat(current), null);
    if (!st || st.isSymbolicLink()) return false;
  }
  return (await safe(() => realpath(path), null)) === path;
}

/** The protected set, canonical: every protected path both as given and as its real path. */
export interface Protection extends ProtectedSet { workspaceRoots: string[]; byRoot: Map<string, string[]> }
export async function protectionFor(places: Pick<DiskPlaces, "home" | "paseoHome" | "stateDir">, workspaces: readonly WorkspaceInfo[], unlinkedWorktrees: (claimed: readonly string[]) => Promise<string[]>): Promise<Protection> {
  const real = (path: string) => safe(() => realpath(path), path);
  const byRoot = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const root = await real(workspace.directory);
    byRoot.set(root, [...(byRoot.get(root) ?? []), workspace.id]);
  }
  const workspaceRoots = [...byRoot.keys()];
  const worktreeRoots = await safe(() => unlinkedWorktrees(workspaceRoots), [] as string[]);
  const canonical = { home: await real(places.home), paseoHome: await real(places.paseoHome), stateDir: await real(places.stateDir) };
  const raw = protectedSet(places, [...workspaceRoots, ...workspaces.map((workspace) => workspace.directory)], worktreeRoots);
  const resolved = protectedSet(canonical, workspaceRoots, await Promise.all(worktreeRoots.map(real)));
  return {
    whole: [...new Set([...raw.whole, ...resolved.whole])],
    inside: [...new Set([...raw.inside, ...resolved.inside])],
    worktreeRoots: [...new Set([...raw.worktreeRoots, ...resolved.worktreeRoots])],
    workspaceRoots, byRoot,
  };
}

/** A workspace descriptor from `paseo.workspaces.list` → what Hosts needs, or null when it has no folder. */
export function readWorkspace(raw: unknown): WorkspaceInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  const directory = text(w.workspaceDirectory) ?? text(w.directory);
  const id = text(w.id) ?? text(w.workspaceId);
  if (!directory || !id || w.archivingAt) return null;
  const git = (w.gitRuntime && typeof w.gitRuntime === "object" ? w.gitRuntime : {}) as Record<string, unknown>;
  const scripts = Array.isArray(w.scripts) ? w.scripts as Array<Record<string, unknown>> : [];
  const activity = text(w.activityAt) ?? text(w.statusEnteredAt);
  return {
    id, directory,
    name: text(w.title) ?? text(w.name) ?? basename(directory),
    project: text(w.projectCustomName) ?? text(w.projectDisplayName),
    worktree: w.workspaceKind === "worktree" || git.isPaseoOwnedWorktree === true,
    status: text(w.status),
    activityAt: activity ? Date.parse(activity) || null : null,
    branch: text(git.currentBranch),
    devServers: scripts.filter((script) => script.lifecycle === "running").map((script) => `${text(script.scriptName) ?? "Dev server"}${typeof script.port === "number" ? ` :${script.port}` : ""}`),
  };
}

const STATE_RANK: Record<WorkspaceState, number> = { working: 0, waiting: 1, failed: 2, idle: 3, unlinked: 4 };
export function workspaceState(status: string | null): WorkspaceState {
  if (status === "running") return "working";
  if (status === "attention" || status === "needs_input") return "waiting";
  if (status === "failed") return "failed";
  return "idle";
}

/** Why nothing in a folder may be cleared right now, in plain words; null when it may. */
export function busyReason(state: WorkspaceState, devServers: readonly string[]): string | null {
  if (state === "working") return "An agent is working here. Clear it once the agent is done.";
  if (state === "waiting") return "An agent here is waiting for you, so its files stay as they are.";
  if (devServers.length) return `A dev server is running here (${devServers[0]}). Stop it first.`;
  return null;
}

export const homeRelative = (path: string, home: string) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);

/** Raw per-folder facts from a scan, kept between reports. */
export interface ScanFolder { key: string; path: string; kind: "workspace" | "worktree"; result: WalkResult | null }
/** Something shared, measured by the scan. `command` names the tool that may clean it; without one it is shown for size only. */
export interface ScanCache {
  kind: "npm" | "npx" | "pnpm" | "browsers" | "tool" | "tmp";
  key: string; path: string; label: string; what: string; cost: string; group: string;
  dev: number; ino: number; mtimeMs: number; bytes: number; partial: boolean;
  command: Exclude<ItemKind, "workspace"> | null;
}
export interface ScanData {
  startedAt: number; finishedAt: number | null; partial: boolean; done: number; total: number;
  folders: ScanFolder[];
  /** Per item path: git's answers. */
  git: Record<string, GitVerdict>;
  caches: ScanCache[];
  warnings: string[];
}

export interface ScannerDeps {
  places: DiskPlaces;
  uid: number;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  /** Dev servers the monitor sees, by folder (for workspaces Paseo didn't start them from). */
  devServersIn?(folder: string): string[];
  git?: GitRun;
  now?: () => number;
  scanSeconds?: number;
  /** Where the last result is kept between reloads; null to keep it in memory only. */
  cacheFile?: string | null;
  /** pnpm's store folder, when pnpm is here. */
  pnpmStore?(group: ChildGroup): Promise<string | null>;
  /** Whether a tool's own cleanup command is available (npm, pnpm, Playwright). */
  toolReady?(kind: Exclude<ItemKind, "workspace">, group: ChildGroup): Promise<boolean>;
  inventory?: QuarantineInventory;
  walk?: typeof runWorker;
}

/** The walk gets this share of what's left of the deadline; git's checks get the rest. */
export const WALK_SHARE = 0.8;

const SIZE_ONLY: Record<ScanCache["kind"], string | null> = {
  npm: null, pnpm: null,
  npx: "Shown for its size. npm's clean doesn't touch it, and Hosts doesn't delete it.",
  browsers: "Shown for its size. Hosts doesn't delete browser downloads; Playwright's own clean removes only the ones no project uses.",
  tool: "Shown for its size. Hosts doesn't delete tool caches.",
  tmp: "Shown for its size. Hosts doesn't delete anything in the temporary folder; ask an agent if it should go.",
};

const BUTTON: Record<Exclude<ItemKind, "workspace">, string> = { npm: "Clean with npm…", pnpm: "Prune with pnpm…", playwright: "Remove unused browsers…" };

export class DiskScanner {
  private data: ScanData | null = null;
  private running: Promise<void> | null = null;
  private progress = { done: 0, total: 0 };
  private loaded = false;
  private readonly now: () => number;
  private readonly group = new ChildGroup();

  constructor(private readonly deps: ScannerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  last(): ScanData | null { return this.data; }

  /** Unloading: kill every child's process group (walk, git, version checks) and wait for the scan to stop. */
  async close(): Promise<void> { this.group.killAll(); await this.wait(); }

  /** A cleared folder leaves the cached scan at once, so the list doesn't offer it again. */
  forget(path: string, bytes: number): void {
    if (!this.data) return;
    for (const folder of this.data.folders) {
      const result = folder.result;
      if (!result || !path.startsWith(`${folder.path}/`)) continue;
      const before = result.items.length;
      result.items = result.items.filter((item) => join(folder.path, item.rel) !== path);
      if (result.items.length !== before) result.totalBytes = Math.max(0, result.totalBytes - bytes);
    }
  }

  /** Start a scan unless one is running (then join it). Returns at once; `wait()` resolves when it ends. */
  start(): void {
    if (this.running || this.group.closed) return;
    this.running = this.scan().catch((error) => {
      console.error("daemon-link: disk scan failed", error instanceof Error ? error.name : "unknown");
    }).finally(() => { this.running = null; });
  }
  wait(): Promise<void> { return this.running ?? Promise.resolve(); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.cacheFile();
    if (!file || this.data) return;
    try { this.data = JSON.parse(await readFile(file, "utf8")) as ScanData; } catch { /* No earlier scan. */ }
  }
  private cacheFile(): string | null { return this.deps.cacheFile === undefined ? join(stateDirectory(), "disk-scan.json") : this.deps.cacheFile; }

  private async scan(): Promise<void> {
    await this.load();
    const startedAt = this.now();
    const deadline = startedAt + (this.deps.scanSeconds ?? SCAN_SECONDS) * 1000;
    const left = () => Math.max(0, deadline - this.now());
    // Every step before the walk shares the same deadline: a slow registry or a hung tool can't stretch it.
    const within = <T>(work: Promise<T>, fallback: T): Promise<T> => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), left());
      (timer as { unref?: () => void }).unref?.();
      work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
    });
    const warnings: string[] = [];
    const workspaces = await within(this.deps.listWorkspaces(), [] as WorkspaceInfo[]);
    if (!workspaces.length) warnings.push("Paseo's workspaces couldn't be read in time, so only shared caches were checked. Open Hosts once after the daemon starts, then check again.");
    const folders = await within(this.folders(workspaces), [] as ScanFolder[]);
    const caches = await within(this.cacheCandidates(warnings, workspaces), [] as ScanCache[]);
    const roots: WalkRoot[] = [
      ...folders.map((folder) => ({ id: folder.key, path: folder.path, mode: "workspace" as const })),
      ...caches.map((cache) => ({ id: cache.key, path: cache.path, mode: "whole" as const })),
    ];
    this.progress = { done: 0, total: roots.length };
    this.data = { startedAt, finishedAt: null, partial: false, done: 0, total: roots.length, folders, git: {}, caches: [], warnings };
    const byId = new Map<string, WalkResult>();
    const walkUntil = this.now() + left() * WALK_SHARE;
    const run = await (this.deps.walk ?? runWorker)<WalkResult>({
      op: "scan", roots, deadline: walkUntil,
      clearable: Object.keys(CLEARABLE_NAMES), ignoredOnly: Object.keys(IGNORED_ONLY_NAMES), ignoredMaxDepth: IGNORED_ONLY_MAX_DEPTH, maxItemsPerRoot: 200,
    }, Math.max(1000, walkUntil - this.now() + 10_000), (result) => {
      byId.set(result.id, result);
      this.progress.done += 1;
      if (this.data) this.data.done = this.progress.done;
      const folder = folders.find((item) => item.key === result.id);
      if (folder) folder.result = result;
    }, this.group);
    if (run.error) warnings.push("The disk check couldn't run here.");
    const partial = run.timedOut || [...byId.values()].some((result) => result.partial || result.skipped) || byId.size < roots.length;
    // Git's three answers for every candidate inside a workspace, inside the same deadline, killable on unload.
    const candidates = folders.flatMap((folder) => (folder.result?.items ?? []).map((item) => join(folder.path, item.rel)));
    const verdicts = candidates.length && !this.group.closed ? await safe(() => gitVerdicts(candidates, this.deps.git ?? groupGit(this.group), deadline, this.now), new Map<string, GitVerdict>()) : new Map<string, GitVerdict>();
    const git: ScanData["git"] = {};
    for (const [path, verdict] of verdicts) git[path] = verdict;
    for (const cache of caches) {
      const result = byId.get(cache.key);
      if (result) { cache.dev = result.dev; cache.ino = result.ino; cache.bytes = result.totalBytes; cache.partial = result.partial || !!result.skipped; }
      else { cache.bytes = 0; cache.partial = true; }
    }
    this.data = { startedAt, finishedAt: this.now(), partial, done: byId.size, total: roots.length, folders, git, caches: caches.filter((cache) => cache.bytes > 0 || cache.partial || cache.command), warnings };
    const file = this.cacheFile();
    if (file) await safe(async () => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(this.data), { mode: 0o600 }); }, undefined);
  }

  /** Each folder once (several workspaces can share one), plus worktrees under $PASEO_HOME/worktrees that none claims. */
  private async folders(workspaces: readonly WorkspaceInfo[]): Promise<ScanFolder[]> {
    const out: ScanFolder[] = [];
    const seen = new Set<string>();
    for (const workspace of workspaces) {
      const path = await safe(() => realpath(workspace.directory), null);
      if (!path || seen.has(path) || path === this.deps.places.home || path === "/") continue;
      seen.add(path);
      out.push({ key: `ws:${path}`, path, kind: "workspace", result: null });
    }
    for (const path of await this.unlinkedWorktrees([...seen])) out.push({ key: `wt:${path}`, path, kind: "worktree", result: null });
    return out;
  }

  async unlinkedWorktrees(claimed: readonly string[]): Promise<string[]> {
    const base = join(this.deps.places.paseoHome, "worktrees");
    const out: string[] = [];
    const isClaimed = (path: string) => claimed.some((folder) => folder === path || folder.startsWith(`${path}/`) || path.startsWith(`${folder}/`));
    for (const project of await safe(() => readdir(base), [] as string[])) {
      const projectPath = join(base, project);
      const info = await safe(() => lstat(projectPath), null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const own = await safe(() => lstat(join(projectPath, ".git")), null);
      const candidates = own ? [projectPath] : (await safe(() => readdir(projectPath), [] as string[])).map((name) => join(projectPath, name));
      for (const candidate of candidates) {
        // A worktree folder must be a real folder where it is: a symlink here is never followed.
        const st = await safe(() => lstat(candidate), null);
        if (!st?.isDirectory() || st.isSymbolicLink() || isClaimed(candidate)) continue;
        out.push(candidate);
      }
    }
    return out;
  }

  /**
   * Shared caches and /tmp leftovers to measure. Each is a real folder with no
   * symlink anywhere on its path, owned by this user, outside the protected
   * set. They're shown for size; npm's cache, pnpm's store and Playwright's
   * browsers also offer that tool's own command when the tool is here.
   */
  private async cacheCandidates(warnings: string[], workspaces: readonly WorkspaceInfo[]): Promise<ScanCache[]> {
    const { places, uid } = this.deps;
    const out: ScanCache[] = [];
    const guard = await protectionFor(places, workspaces, (claimed) => this.unlinkedWorktrees(claimed));
    const ready = (kind: Exclude<ItemKind, "workspace">) => (this.deps.toolReady ?? (async () => false))(kind, this.group).catch(() => false);
    const add = async (kind: ScanCache["kind"], path: string, label: string, what: string, cost: string, group: string, command: ScanCache["command"] = null) => {
      const st = await safe(() => lstat(path), null);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return;
      if (PROTECTED_NAME.test(basename(path)) || protectedReason(path, guard) || !await canonicalChain(path)) return;
      out.push({ kind, key: `${kind}:${path}`, path, label, what, cost, group, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, bytes: -1, partial: false, command });
    };
    const npm = join(places.home, ".npm");
    await add("npm", join(npm, "_cacache"), "npm cache", "Packages npm downloaded", "npm clears it with its own command; packages download again when a project next installs them.", "Package managers", await ready("npm") ? "npm" : null);
    await add("npx", join(npm, "_npx"), "npx downloads", "Tools fetched with npx", "", "Package managers");
    const store = await (this.deps.pnpmStore ?? (async () => null))(this.group).catch(() => null);
    if (store && store.startsWith("/")) await add("pnpm", store, "pnpm store", "Packages shared by your pnpm projects", "pnpm prunes it with its own command, removing only packages no project uses.", "Package managers", await ready("pnpm") ? "pnpm" : null);
    const playwright = await ready("playwright");
    for (const root of places.browserRoots) {
      const isPlaywright = basename(root) === "ms-playwright";
      await add("browsers", root, isPlaywright ? "Playwright browsers" : basename(dirname(root)) === ".agent-browser" ? "agent-browser browsers" : basename(root), "Browser downloads", isPlaywright ? "Playwright removes only the browsers no installed Playwright uses; a project that needs one downloads it again." : "", "Browser downloads", isPlaywright && playwright ? "playwright" : null);
    }
    for (const base of places.cacheBases) {
      for (const name of await safe(() => readdir(base), [] as string[])) {
        const what = toolCacheName(name);
        if (what) await add("tool", join(base, name), name, what, "", "Tool caches");
      }
    }
    for (const dir of places.tmpDirs) {
      for (const name of await safe(() => readdir(dir), [] as string[])) {
        if (TMP_NEVER.test(name) || name.startsWith(".hosts-")) continue;
        await add("tmp", join(dir, name), name, "Left in the temporary folder", "", "Temporary files");
      }
    }
    if (!out.length) warnings.push("No shared caches were found here.");
    return out;
  }

  /** The report: sizes from the last scan, status read fresh. Tokens are minted by the caller. */
  async report(workspacesNow: readonly WorkspaceInfo[], mint: (item: MintInput) => string, disks: DiskSpace[]): Promise<DiskReport> {
    await this.load();
    const data = this.data;
    const { home } = this.deps.places;
    const guard = await protectionFor(this.deps.places, workspacesNow, (claimed) => this.unlinkedWorktrees(claimed));
    const byFolder = new Map<string, WorkspaceInfo[]>();
    for (const workspace of workspacesNow) {
      const path = await safe(() => realpath(workspace.directory), workspace.directory);
      byFolder.set(path, [...(byFolder.get(path) ?? []), workspace]);
    }
    const workspaces: WorkspaceUsage[] = [];
    const folderList = data?.folders ?? [...byFolder.keys()].map((path) => ({ key: `ws:${path}`, path, kind: "workspace" as const, result: null }));
    for (const folder of folderList) {
      const owners = byFolder.get(folder.path) ?? [];
      const state: WorkspaceState = owners.length ? owners.map((owner) => workspaceState(owner.status)).sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0]! : "unlinked";
      const devServers = [...new Set([...owners.flatMap((owner) => owner.devServers), ...(this.deps.devServersIn?.(folder.path) ?? [])])];
      const busy = busyReason(state, devServers);
      const label = owners.length ? owners.map((owner) => owner.name).join(", ") : basename(folder.path);
      const items: ClearItem[] = (folder.result?.items ?? []).flatMap((item) => {
        const path = join(folder.path, item.rel);
        const blocked = itemBlocked(item, data?.git[path] ?? null, path, guard);
        if (blocked === "hide") return [];
        const words = describeName(item.name)!;
        const why = blocked ?? busy;
        return [{
          token: why ? null : mint({ path, dev: item.dev, ino: item.ino, mtimeMs: item.mtimeMs, action: "delete", kind: "workspace", owner: label, bytes: item.bytes - item.sharedBytes }),
          name: item.name, what: words.what, cost: words.cost, where: item.rel, bytes: item.bytes, sharedBytes: item.sharedBytes, partial: item.partial, action: "delete" as const, blocked: why, button: "Clear…",
        }];
      }).sort((a, b) => b.bytes - a.bytes).slice(0, 60);
      const activeAt = owners.map((owner) => owner.activityAt ?? 0).reduce((a, b) => Math.max(a, b), 0) || null;
      workspaces.push({
        id: folder.key, names: owners.map((owner) => owner.name), project: owners[0]?.project ?? null, folder: homeRelative(folder.path, home),
        worktree: folder.kind === "worktree" || owners.some((owner) => owner.worktree), branch: owners.find((owner) => owner.branch)?.branch ?? null,
        state, activeAt, devServers, totalBytes: folder.result?.totalBytes ?? 0,
        clearableBytes: items.filter((item) => item.token).reduce((sum, item) => sum + item.bytes - item.sharedBytes, 0),
        partial: !!folder.result?.partial, busy, items, skipped: !!data && !this.running && (!folder.result || !!folder.result.skipped),
        measured: !!folder.result && !folder.result.skipped,
      });
    }
    workspaces.sort((a, b) => b.totalBytes - a.totalBytes || a.folder.localeCompare(b.folder));
    const groups = new Map<string, CacheGroup>();
    for (const cache of data?.caches ?? []) {
      const group = groups.get(cache.group) ?? { id: cache.group.toLowerCase().replace(/[^a-z]+/g, "-"), title: cache.group, totalBytes: 0, items: [] };
      const blocked = cache.command ? null : SIZE_ONLY[cache.kind];
      group.items.push({
        token: cache.command ? mint({ path: cache.path, dev: cache.dev, ino: cache.ino, mtimeMs: cache.mtimeMs, action: "command", kind: cache.command, owner: cache.group, bytes: cache.bytes, name: cache.label, cost: cache.cost }) : null,
        name: cache.label, what: cache.what, cost: cache.cost, where: homeRelative(cache.path, home), bytes: cache.bytes, sharedBytes: 0, partial: cache.partial,
        action: cache.command ? "command" : "delete", blocked, button: cache.command ? BUTTON[cache.command] : undefined, askId: cache.kind === "tmp" ? cache.key : null,
      });
      group.totalBytes += cache.bytes;
      groups.set(cache.group, group);
    }
    const caches = [...groups.values()].map((group) => ({ ...group, items: group.items.sort((a, b) => b.bytes - a.bytes) })).sort((a, b) => b.totalBytes - a.totalBytes);
    const leftovers = this.deps.inventory ? (await safe(() => this.deps.inventory!.list(), [])).map((entry) => ({ id: `leftover:${entry.quarantine}`, name: entry.name, where: homeRelative(entry.original, home), bytes: entry.bytes, at: entry.at })) : [];
    return {
      disks,
      scan: {
        state: this.running ? "running" : data ? "done" : "never",
        startedAt: data?.startedAt ?? null, finishedAt: data?.finishedAt ?? null,
        done: this.running ? this.progress.done : data?.done ?? 0, total: this.running ? this.progress.total : data?.total ?? 0,
        partial: !!data?.partial,
        message: this.running ? "Checking what's using space. This runs quietly in the background and can take a few minutes." : data?.partial ? "The check stopped at its time limit, so some sizes are at least what's shown and some folders weren't reached." : null,
      },
      workspaces, caches, clearableBytes: workspaces.reduce((sum, workspace) => sum + workspace.clearableBytes, 0), warnings: data?.warnings ?? [], leftovers,
    };
  }
}

/** "Ask an agent" about a folder Hosts won't remove itself: an unlinked worktree, a /tmp leftover, or what an interrupted clear left. */
export function folderAskText(folder: { path: string; bytes: number; branch: string | null; changedAt: number | null; kind?: "worktree" | "tmp" | "leftover"; original?: string }, home: string, now = Date.now()): string {
  const kind = folder.kind ?? "worktree";
  const lead = kind === "worktree" ? `Hosts found a Paseo worktree that no workspace uses any more. It takes up ${formatSize(folder.bytes)}.`
    : kind === "tmp" ? `Hosts found a folder in the temporary folder that takes up ${formatSize(folder.bytes)}. Hosts doesn't delete anything there itself.`
    : `A clear Hosts started was interrupted, and this folder was left set aside (${formatSize(folder.bytes)}). Hosts never deletes it by itself.`;
  const check = kind === "worktree"
    ? ["Please check whether anything in it still matters: uncommitted changes (git status) and commits that aren't pushed anywhere (git log --branches --not --remotes).", "Tell me what you find. If nothing is needed, suggest removing it properly with \"git worktree remove\" from its main repository, then \"git worktree prune\"."]
    : kind === "tmp" ? ["Please check what it is and whether anything is still using it or needs it.", "Tell me what you find, and whether it's safe to delete."]
    : [`It was moved aside from ${folder.original ? homeRelative(folder.original, home) : "its folder"}. Please check whether it's needed (it was build output Hosts was clearing), and whether it should go back or be deleted.`];
  return [
    lead, "",
    `Folder: ${homeRelative(folder.path, home)}`,
    ...(folder.branch ? [`Branch: ${folder.branch}`] : []),
    ...(folder.changedAt ? [`Last changed: ${ago(folder.changedAt, now)}`] : []),
    "", ...check, "Ask me before you delete anything.",
  ].join("\n");
}

/**
 * Why a found folder can't be cleared, "hide" when it's part of the project
 * (git doesn't ignore it, tracks something in it, or sees untracked work in
 * it), or null when it may be cleared. Clearable needs git's three definite
 * answers (disk-git.ts); no answer, a cut-off check, a .env, .git or bare
 * repository inside, or a protected path all say no.
 */
export function itemBlocked(item: Pick<WalkItem, "name" | "hasEnv" | "hasGit" | "ignoredOnly" | "partial">, git: GitVerdict | null, path: string, guard: ProtectedSet): string | null | "hide" {
  if (git && (git.ignored === false || git.tracked === true || git.untracked === true)) return "hide";
  // dist/build/out are only build output when git says so; otherwise they're just part of the project.
  if (item.ignoredOnly && !gitAllows(git)) return "hide";
  if (item.partial) return "Not fully checked before the time ran out. Check again to clear it.";
  if (!gitAllows(git)) return "Git couldn't confirm it's ignored build output (no repository, or no answer in time), so Hosts leaves it.";
  if (item.hasEnv) return "It has a .env file inside, so Hosts leaves it.";
  if (item.hasGit) return "It has a git repository inside, so Hosts leaves it.";
  return protectedReason(path, guard);
}

/** The disks the given folders live on, fullest first, one entry per device (statfs and stat only: instant). */
export async function disksFor(paths: readonly string[], fs: { stat: typeof stat; statfs: typeof statfs } = { stat, statfs }): Promise<DiskSpace[]> {
  const byDev = new Map<number, string>();
  for (const path of paths) {
    const info = await safe(() => fs.stat(path), null);
    if (info && !byDev.has(info.dev)) byDev.set(info.dev, path);
  }
  const disks: DiskSpace[] = [];
  for (const [, path] of byDev) {
    const stats = await safe(() => fs.statfs(path), null);
    if (stats) disks.push(diskSpace(byDev.size === 1 ? "This computer's disk" : `Disk with ${basename(path) || path}`, stats));
  }
  return disks.sort((a, b) => b.percent - a.percent);
}
