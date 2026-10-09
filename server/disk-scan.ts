import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, statfs, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLEARABLE_NAMES, CREDENTIAL_PATTERN, IGNORED_ONLY_MAX_DEPTH, IGNORED_ONLY_NAMES, PROTECTED_NAME, TMP_NEVER, TOP_SOURCE_PATTERN,
  ago, describeName, isOnePressName, isWithin, layoutFor, leftoverMessage, probeChecksFor, strayWords, TOOL_LAYOUT, diskSpace, formatSize, protectedReason, protectedSet, toolCacheName, type ProtectedSet,
  type CacheGroup, type ClearItem, type DiskReport, type DiskSpace, type LeftoverState, type WorkspaceState, type WorkspaceUsage,
} from "../shared/disk";
import { stateDirectory } from "./binaries";
import type { JournalStatus } from "./disk-quarantine";
import { findLock, outsideWalkReason } from "./disk-nodemodules";
import { ChildGroup } from "./disk-children";
import { friendlyPath } from "../shared/paths";
import { gitAllows, gitVerdicts, groupGit, type GitRun, type GitVerdict } from "./disk-git";
import { runWorker, type WalkItem, type WalkResult, type WalkRoot } from "./disk-worker";

/**
 * 0.14.0's disk scan (read-only): what each Paseo workspace's folder holds,
 * what of it looks safe to clear (build output git ignores), and the shared
 * caches and temporary files. It never deletes anything; "Ask an agent to
 * clean this up" passes the list on (cleanupAskText).
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
 * for size); `stateDir` is Hosts' own folder (always protected).
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
  if (state === "working") return "An agent is working here. Delete once the agent is done.";
  if (state === "waiting") return "An agent here is waiting for you, so its files stay as they are.";
  if (devServers.length) return `A dev server is running here (${devServers[0]}). Stop it first.`;
  return null;
}

export const homeRelative = (path: string, home: string) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);

/** Raw per-folder facts from a scan, kept between reports. */
export interface ScanFolder { key: string; path: string; kind: "workspace" | "worktree"; result: WalkResult | null }
/** Something shared, measured by the scan. Shown for its size; an agent can be asked to clean it up. */
export interface ScanCache {
  kind: "npm" | "npx" | "pnpm" | "browsers" | "tool" | "tmp";
  key: string; path: string; label: string; what: string; cost: string; group: string;
  dev: number; ino: number; mtimeMs: number; bytes: number; partial: boolean;
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
  /** pnpm's store folder, from pnpm's config files and default places; pnpm itself never runs. */
  pnpmStore?(): Promise<string | null>;
  walk?: typeof runWorker;
}

/** The walk gets this share of what's left of the deadline; git's checks get the rest. */
export const WALK_SHARE = 0.8;

/** What clearing each kind of shared thing would mean, for the agent's message. */
const CACHE_HOW: Record<ScanCache["kind"], string> = {
  npm: "use npm's own command: npm cache clean --force",
  pnpm: "use pnpm's own command: pnpm store prune (it removes only packages no project uses)",
  npx: "tools fetched with npx; they download again when next used",
  browsers: "browser downloads; check which projects still need each version before removing any",
  tool: "a tool's download cache; it fills again when the tool next needs it",
  tmp: "left in the temporary folder; check nothing is using it",
};

/**
 * pnpm's store, found without running pnpm (review fix: `pnpm store path`
 * creates, links and removes files under home). `store-dir` from the
 * environment or pnpm's config files (~/.npmrc, pnpm's global rc), else the
 * default place for this system. Null when none of them exists.
 */
export async function findPnpmStore(places: Pick<DiskPlaces, "platform" | "home">, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string | null> {
  const home = places.home;
  const expand = (value: string) => value.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
  const configured: string[] = [];
  for (const key of ["npm_config_store_dir", "pnpm_config_store_dir", "NPM_CONFIG_STORE_DIR"]) if (env[key]) configured.push(env[key]!);
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
  const rcFiles = [join(home, ".npmrc"), ...(places.platform === "darwin" ? [join(home, "Library", "Preferences", "pnpm", "rc")] : []), join(xdgConfig, "pnpm", "rc")];
  for (const file of rcFiles) {
    if (signal?.aborted) return null;
    const text = await readConfigFile(file, signal);
    const match = /^\s*store-dir\s*=\s*(.+?)\s*$/m.exec(text);
    if (match) configured.push(match[1]!);
  }
  const defaults = [
    ...(env.PNPM_HOME ? [join(env.PNPM_HOME, "store")] : []),
    ...(places.platform === "darwin" ? [join(home, "Library", "pnpm", "store")] : [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "pnpm", "store")]),
  ];
  for (const candidate of [...configured.map(expand), ...defaults]) {
    if (signal?.aborted) return null;
    if (!candidate.startsWith("/")) continue;
    const st = await safe(() => lstat(candidate), null);
    if (st?.isDirectory() && !st.isSymbolicLink()) return candidate;
  }
  return null;
}

/** Config files are small; anything past this is never read. */
export const CONFIG_READ_LIMIT = 64 * 1024;

/**
 * A config file's text, read safely (review fix): only a regular file (a
 * symlink only when its target is one), opened non-blocking so a FIFO swapped
 * in can't hold the open, checked again on the open handle, at most
 * CONFIG_READ_LIMIT bytes, and abandoned on cancellation. "" otherwise.
 */
export async function readConfigFile(path: string, signal?: AbortSignal, limit = CONFIG_READ_LIMIT): Promise<string> {
  if (signal?.aborted) return "";
  const link = await safe(() => lstat(path), null);
  if (!link) return "";
  const target = link.isSymbolicLink() ? await safe(() => stat(path), null) : link;
  if (!target?.isFile()) return "";
  const handle = await safe(() => open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK), null);
  if (!handle) return "";
  const read = (async () => {
    try {
      if (!(await handle.stat()).isFile()) return "";
      const buffer = Buffer.alloc(Math.min(limit, CONFIG_READ_LIMIT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch { return ""; } finally { await handle.close().catch(() => undefined); }
  })();
  if (!signal) return read;
  return new Promise((resolve) => {
    const stop = () => resolve("");
    signal.addEventListener("abort", stop, { once: true });
    read.then((text) => { signal.removeEventListener("abort", stop); resolve(signal.aborted ? "" : text); });
  });
}

/** A sign this computer uses pnpm: a pnpm-lock.yaml at the top of a workspace (a stat, no walk). */
async function usesPnpm(workspaces: readonly WorkspaceInfo[]): Promise<boolean> {
  for (const workspace of workspaces.slice(0, 30)) if (await safe(() => stat(join(workspace.directory, "pnpm-lock.yaml")), null)) return true;
  return false;
}

/** Biggest first, stable (0.15.0): ties by where it is, then name, so rows don't jump on refresh. */
export const bySize = (a: { bytes: number; where: string; name: string }, b: { bytes: number; where: string; name: string }) => b.bytes - a.bytes || a.where.localeCompare(b.where) || a.name.localeCompare(b.name);
/** Inside a workspace: what looks safe to clear first, each biggest first. */
export const bySafeThenSize = (a: { safe: boolean; bytes: number; where: string; name: string }, b: { safe: boolean; bytes: number; where: string; name: string }) => Number(b.safe) - Number(a.safe) || bySize(a, b);

export class DiskScanner {
  private data: ScanData | null = null;
  private running: Promise<void> | null = null;
  private progress = { done: 0, total: 0 };
  private loaded = false;
  private readonly now: () => number;
  private readonly group = new ChildGroup();
  /** Stops the running scan's discovery steps (deadline or unload). */
  private abort: AbortController | null = null;

  constructor(private readonly deps: ScannerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  last(): ScanData | null { return this.data; }

  /** Unloading: kill every child's process group (walk, git, version checks) and wait for the scan to stop. */
  async close(): Promise<void> { this.abort?.abort(); this.group.killAll(); await this.wait(); }

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
    // Past the deadline (or on unload) the discovery steps stop where they are, rather than running on unseen.
    const abort = new AbortController();
    this.abort = abort;
    if (this.group.closed) abort.abort(); // Unloading began before the scan got here.
    const signal = abort.signal;
    // Takes the work as a function: once cancelled nothing new is started, and every promise it does
    // start has its rejection handled, even one that settles after the step gave up (review fix).
    const within = <T>(start: () => Promise<T>, fallback: T): Promise<T> => new Promise((resolve) => {
      if (signal.aborted) { resolve(fallback); return; }
      let work: Promise<T>;
      try { work = start(); } catch { resolve(fallback); return; }
      const timer = setTimeout(() => { abort.abort(); resolve(fallback); }, left());
      (timer as { unref?: () => void }).unref?.();
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(fallback); }, { once: true });
      work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
    });
    const warnings: string[] = [];
    const workspaces = await within(() => this.deps.listWorkspaces(), [] as WorkspaceInfo[]);
    if (!workspaces.length) warnings.push("Paseo's workspaces couldn't be read in time, so only shared caches were checked. Open Hosts once after the daemon starts, then check again.");
    const folders = await within(() => this.folders(workspaces, signal), [] as ScanFolder[]);
    const caches = await within(() => this.cacheCandidates(warnings, workspaces, signal), [] as ScanCache[]);
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
      clearable: Object.keys(CLEARABLE_NAMES), ignoredOnly: Object.keys(IGNORED_ONLY_NAMES), ignoredMaxDepth: IGNORED_ONLY_MAX_DEPTH, maxItemsPerRoot: 200, credential: CREDENTIAL_PATTERN, topSource: TOP_SOURCE_PATTERN, layouts: TOOL_LAYOUTS, nodeModules: true,
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
    this.data = { startedAt, finishedAt: this.now(), partial, done: byId.size, total: roots.length, folders, git, caches: caches.filter((cache) => cache.bytes > 0 || cache.partial), warnings };
    const file = this.cacheFile();
    if (file) await safe(async () => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(this.data), { mode: 0o600 }); }, undefined);
  }

  /** Each folder once (several workspaces can share one), plus worktrees under $PASEO_HOME/worktrees that none claims. */
  private async folders(workspaces: readonly WorkspaceInfo[], signal?: AbortSignal): Promise<ScanFolder[]> {
    const out: ScanFolder[] = [];
    const seen = new Set<string>();
    for (const workspace of workspaces) {
      if (signal?.aborted) return out;
      const path = await safe(() => realpath(workspace.directory), null);
      if (!path || seen.has(path) || path === this.deps.places.home || path === "/") continue;
      seen.add(path);
      out.push({ key: `ws:${path}`, path, kind: "workspace", result: null });
    }
    for (const path of await this.unlinkedWorktrees([...seen], signal)) out.push({ key: `wt:${path}`, path, kind: "worktree", result: null });
    return out;
  }

  async unlinkedWorktrees(claimed: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const base = join(this.deps.places.paseoHome, "worktrees");
    const out: string[] = [];
    const isClaimed = (path: string) => claimed.some((folder) => folder === path || folder.startsWith(`${path}/`) || path.startsWith(`${folder}/`));
    for (const project of await safe(() => readdir(base), [] as string[])) {
      if (signal?.aborted) return out;
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
  private async cacheCandidates(warnings: string[], workspaces: readonly WorkspaceInfo[], signal?: AbortSignal): Promise<ScanCache[]> {
    const { places, uid } = this.deps;
    const out: ScanCache[] = [];
    const guard = await protectionFor(places, workspaces, (claimed) => this.unlinkedWorktrees(claimed, signal));
    const add = async (kind: ScanCache["kind"], path: string, label: string, what: string, group: string) => {
      if (signal?.aborted) return;
      const st = await safe(() => lstat(path), null);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return;
      if (PROTECTED_NAME.test(basename(path)) || protectedReason(path, guard) || !await canonicalChain(path)) return;
      out.push({ kind, key: `${kind}:${path}`, path, label, what, cost: CACHE_HOW[kind], group, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, bytes: -1, partial: false });
    };
    const npm = join(places.home, ".npm");
    await add("npm", join(npm, "_cacache"), "npm cache", "Packages npm downloaded", "Package managers");
    await add("npx", join(npm, "_npx"), "npx downloads", "Tools fetched with npx", "Package managers");
    const store = signal?.aborted ? null : await (this.deps.pnpmStore ?? (() => findPnpmStore(places, process.env, signal)))().catch(() => null);
    if (store && store.startsWith("/")) await add("pnpm", store, "pnpm store", "Packages shared by your pnpm projects", "Package managers");
    else if (await usesPnpm(workspaces)) warnings.push("pnpm store: not found.");
    for (const root of places.browserRoots) {
      const label = basename(root) === "ms-playwright" ? "Playwright browsers" : basename(dirname(root)) === ".agent-browser" ? "agent-browser browsers" : basename(root);
      await add("browsers", root, label, "Browser downloads", "Browser downloads");
    }
    for (const base of places.cacheBases) {
      for (const name of await safe(() => readdir(base), [] as string[])) {
        const what = toolCacheName(name);
        if (what) await add("tool", join(base, name), name, what, "Tool caches");
      }
    }
    for (const dir of places.tmpDirs) {
      for (const name of await safe(() => readdir(dir), [] as string[])) {
        if (TMP_NEVER.test(name) || name.startsWith(".hosts-")) continue;
        await add("tmp", join(dir, name), name, "Left in the temporary folder", "Temporary files");
      }
    }
    if (!out.length) warnings.push("No shared caches were found here.");
    return out;
  }

  /** The report: sizes from the last scan, status read fresh. */
  /**
   * The report: sizes from the last scan, status read fresh. `mint` (0.16.0)
   * signs a Clear token for each item that looks safe, in a workspace whose
   * root it accepts; it returns null where Clear isn't offered.
   */
  async report(workspacesNow: readonly WorkspaceInfo[], disks: DiskSpace[], mint?: (item: { path: string; root: string; dev: number; ino: number; mtimeMs: number; workspace: string; bytes: number; what: string; cost: string }) => string | null): Promise<DiskReport> {
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
      const found: ClearItem[] = [];
      for (const item of folder.result?.items ?? []) {
        const path = join(folder.path, item.rel);
        const blocked = itemBlocked(item, data?.git[path] ?? null, path, guard);
        if (blocked === "hide") continue;
        const words = describeName(item.name)!;
        const why = blocked ?? await outsideWalkReason(item.name, path, folder.path, item) ?? busy;
        const workspace = owners[0]?.name ?? friendlyPath(folder.path, { home, paseoHome: this.deps.places.paseoHome }).label;
        const token = !why && mint ? mint({ path, root: folder.path, dev: item.dev, ino: item.ino, mtimeMs: item.mtimeMs, workspace, bytes: item.bytes - item.sharedBytes, what: words.what, cost: words.cost }) : null;
        found.push({ safe: !why, name: item.name, what: words.what, cost: words.cost, where: item.rel, path, bytes: item.bytes, sharedBytes: item.sharedBytes, partial: item.partial, blocked: why, token, ...(blocked === ASK_ONLY ? { askOnly: true } : {}) });
      }
      const items = found.sort(bySafeThenSize).slice(0, 60);
      const activeAt = owners.map((owner) => owner.activityAt ?? 0).reduce((a, b) => Math.max(a, b), 0) || null;
      workspaces.push({
        id: folder.key, names: owners.map((owner) => owner.name), project: owners[0]?.project ?? null, folder: homeRelative(folder.path, home), path: folder.path,
        worktree: folder.kind === "worktree" || owners.some((owner) => owner.worktree), branch: owners.find((owner) => owner.branch)?.branch ?? null,
        state, activeAt, devServers, totalBytes: folder.result?.totalBytes ?? 0,
        clearableBytes: items.filter((item) => item.safe).reduce((sum, item) => sum + item.bytes - item.sharedBytes, 0),
        partial: !!folder.result?.partial, busy, items, skipped: !!data && !this.running && (!folder.result || !!folder.result.skipped),
        measured: !!folder.result && !folder.result.skipped, workspaceIds: owners.map((owner) => owner.id),
      });
    }
    workspaces.sort((a, b) => b.totalBytes - a.totalBytes || (a.names[0] ?? "\uffff").localeCompare(b.names[0] ?? "\uffff") || a.folder.localeCompare(b.folder));
    const groups = new Map<string, CacheGroup>();
    for (const cache of data?.caches ?? []) {
      const group = groups.get(cache.group) ?? { id: cache.group.toLowerCase().replace(/[^a-z]+/g, "-"), title: cache.group, totalBytes: 0, items: [] };
      group.items.push({
        safe: false, name: cache.label, what: cache.what, cost: cache.cost, where: friendlyPath(cache.path, { home, paseoHome: this.deps.places.paseoHome }).label, path: cache.path, bytes: cache.bytes, sharedBytes: 0, partial: cache.partial,
        blocked: null, askId: cache.kind === "tmp" ? cache.key : null,
      });
      group.totalBytes += cache.bytes;
      groups.set(cache.group, group);
    }
    const caches = [...groups.values()].map((group) => ({ ...group, items: group.items.sort(bySize) })).sort((a, b) => b.totalBytes - a.totalBytes || a.title.localeCompare(b.title));
    return {
      disks,
      scan: {
        state: this.running ? "running" : data ? "done" : "never",
        startedAt: data?.startedAt ?? null, finishedAt: data?.finishedAt ?? null,
        done: this.running ? this.progress.done : data?.done ?? 0, total: this.running ? this.progress.total : data?.total ?? 0,
        partial: !!data?.partial,
        message: this.running ? "Checking what's using space. This runs quietly in the background and can take a few minutes." : data?.partial ? "The check stopped at its time limit, so some sizes are at least what's shown and some folders weren't reached." : null,
      },
      workspaces, caches, clearableBytes: workspaces.reduce((sum, workspace) => sum + workspace.clearableBytes, 0), warnings: data?.warnings ?? [],
    };
  }
}

/**
 * One journal entry as the person and an agent see it (final gate): the
 * Workspaces note and the "Ask an agent" handoff come from the same state, so
 * they can't tell different stories. The runtime uses this for both.
 */
export function leftoverView(entry: JournalStatus["entries"][number], places: { home: string; paseoHome: string }, now = Date.now()) {
  const where = friendlyPath(entry.original, places).label;
  return {
    where,
    message: leftoverMessage(entry.state, where, entry.setAside),
    title: `A folder an interrupted delete left (${formatSize(entry.bytes)})`,
    text: folderAskText({ path: entry.setAside ? join(entry.quarantine, entry.name) : entry.original, bytes: entry.bytes, branch: null, changedAt: entry.at, kind: "leftover", original: entry.original, state: entry.state, setAside: entry.setAside }, places.home, now),
  };
}

/** The handoff's first line for each leftover state; same facts as leftoverMessage, never more. */
export function leftoverLead(state: LeftoverState, where: string, size: string, setAside: boolean): string {
  if (state === "aside") return `A delete in Hosts stopped before it removed anything. ${where} (${size}) is set aside, not deleted: Hosts couldn't put it back without replacing something, so it left it alone.`;
  if (state === "incomplete") return `A delete in Hosts was interrupted; ${where} may be incomplete. Run the project's install or build to be sure.${setAside ? ` What's there (about ${size} before) is set aside, untouched.` : ""}`;
  return `Hosts couldn't check a folder an interrupted delete set aside (${where}, about ${size} before). Nothing has been deleted since.`;
}

/** "Ask an agent" about a folder Hosts won't remove itself: an unlinked worktree, a /tmp leftover, or what an interrupted clear left. */
export function folderAskText(folder: { path: string; bytes: number; branch: string | null; changedAt: number | null; kind?: "worktree" | "tmp" | "leftover"; original?: string; state?: LeftoverState; setAside?: boolean }, home: string, now = Date.now()): string {
  const kind = folder.kind ?? "worktree";
  const lead = kind === "worktree" ? `Hosts found a Paseo worktree that no workspace uses any more. It takes up ${formatSize(folder.bytes)}.`
    : kind === "leftover" ? leftoverLead(folder.state ?? "unchecked", folder.original ? homeRelative(folder.original, home) : "a build folder", formatSize(folder.bytes), folder.setAside ?? true)
    : `Hosts found a folder in the temporary folder that takes up ${formatSize(folder.bytes)}. Hosts doesn't delete anything itself.`;
  const check = kind === "worktree"
    ? ["Please check whether anything in it still matters: uncommitted changes (git status) and commits that aren't pushed anywhere (git log --branches --not --remotes).", "Tell me what you find. If nothing is needed, suggest removing it properly with \"git worktree remove\" from its main repository, then \"git worktree prune\"."]
    : kind === "leftover" && folder.setAside === false
      ? ["Please run the project's install or build so the folder is complete again, and tell me what you find."]
    : kind === "leftover"
      ? ["Please check what's in it and whether the original place now has something new in it.", "If it's only build output (installed packages, build files), it can be deleted; otherwise it may need moving back. Tell me what you find."]
      : ["Please check what it is and whether anything is still using it or needs it.", "Tell me what you find, and whether it's safe to delete."];
  return [
    lead, "",
    `Folder: ${homeRelative(folder.path, home)}`,
    ...(folder.branch ? [`Branch: ${folder.branch}`] : []),
    ...(folder.changedAt ? [`Last changed: ${ago(folder.changedAt, now)}`] : []),
    "", ...check, "Ask me before you delete anything.",
  ].join("\n");
}

/** The rules an agent cleaning up must follow, said once and reused. */
export const CLEANUP_RULES = [
  "Before deleting each one, check it yourself:",
  "1. Git: nothing inside is tracked and there's no uncommitted or unpushed work (git status, git check-ignore, git log --branches --not --remotes in that project).",
  "2. Nothing is using it: no running process has it as its working folder or has a file open in it (lsof, or /proc on Linux), and no dev server, build, test or install is running in that project.",
  "3. It holds nothing that must stay: never delete a .git folder or any git repository, .env files, ~/.claude, ~/.codex, Paseo's data folder, or a whole project or worktree folder. Don't follow symlinks.",
  "For shared caches, use the tools' own commands (npm cache clean --force, pnpm store prune) rather than deleting their folders.",
  "If anything looks unsure, skip it and ask me. When you're done, tell me what you deleted and how much space it freed.",
];

/** One line per item: where, how big, and what it is. */
/** One item for the agent (0.15.0): the friendly name first ("site · apps/web/node_modules"), then the path it needs. */
const itemLine = (item: { label?: string; where: string }, bytes: number, what: string, partial = false) =>
  `- ${item.label ?? item.where} · ${partial ? "at least " : ""}${formatSize(bytes)} · ${what}${item.label && item.label !== item.where ? `\n  Path: ${item.where}` : ""}`;
const biggestFirst = <T extends { bytes: number; where: string }>(items: readonly T[]) => [...items].sort((a, b) => b.bytes - a.bytes || a.where.localeCompare(b.where));

/**
 * The message for "Ask an agent to clean this up" (0.14.0): the exact items
 * that look safe to clear, with paths and sizes, and the checks to do before
 * deleting each one. Hosts deletes nothing itself.
 */
export function cleanupAskText(scope: { kind: "workspaces"; title: string; checkedAt: number | null; items: Array<{ label?: string; where: string; bytes: number; what: string; cost: string; partial: boolean }> } | { kind: "caches"; checkedAt: number | null; items: Array<{ label?: string; where: string; bytes: number; what: string; how: string; partial: boolean }> }, now = Date.now()): string {
  const total = scope.items.reduce((sum, item) => sum + item.bytes, 0);
  const when = scope.checkedAt ? ` (checked ${ago(scope.checkedAt, now)})` : "";
  const lines = scope.kind === "workspaces"
    ? [
      `Please free up disk space by clearing build output in ${scope.title}. Hosts found these folders${when}, about ${formatSize(total)} in all. They look safe to clear: git ignores them and nothing was using them when Hosts checked. Please check each one again before deleting it.`,
      "", ...biggestFirst(scope.items).map((item) => itemLine(item, item.bytes, `${item.what}. ${item.cost}`, item.partial)),
    ]
    : [
      `Please free up disk space in the shared caches and temporary files. Hosts measured these${when}, about ${formatSize(total)} in all. Only clear what's really unused.`,
      "", ...biggestFirst(scope.items).map((item) => itemLine(item, item.bytes, `${item.what}: ${item.how}`, item.partial)),
    ];
  return [...lines, "", ...CLEANUP_RULES].join("\n");
}

/**
 * Why a found folder can't be cleared, "hide" when it's part of the project
 * (git doesn't ignore it, tracks something in it, or sees untracked work in
 * it), or null when it may be cleared. Clearable needs git's three definite
 * answers (disk-git.ts); no answer, a cut-off check, a .env, .git or bare
 * repository inside, or a protected path all say no.
 */
export function itemBlocked(item: Pick<WalkItem, "name" | "hasEnv" | "hasGit" | "ignoredOnly" | "partial" | "hasCredential" | "hasTopSource" | "topUnexpected">, git: GitVerdict | null, path: string, guard: ProtectedSet): string | null | "hide" {
  if (git && (git.ignored === false || git.tracked === true || git.untracked === true)) return "hide";
  // dist/build/out are only build output when git says so; otherwise they're just part of the project.
  if (item.ignoredOnly && !gitAllows(git)) return "hide";
  // Final gate: ignored isn't rebuildable. Only tool-managed folders get one-press Delete; the rest: sizes and Ask an agent.
  if (!isOnePressName(item.name)) return ASK_ONLY;
  if (item.partial) return "Not fully checked before the time ran out. Check again to clear it.";
  if (!gitAllows(git)) return "Git couldn't confirm it's ignored build output (no repository, or no answer in time), so Hosts leaves it.";
  if (item.hasEnv) return "It has a .env file inside, so Hosts leaves it.";
  if (item.hasGit) return "It has a git repository inside, so Hosts leaves it.";
  const checks = probeChecksFor(item.name);
  // By structure first: only what the tool itself puts at the top level. Not checked (an old scan) counts as a stray.
  if (checks.layout && item.topUnexpected !== null) return item.topUnexpected ? `${strayWords(item.name, item.topUnexpected)}. Hosts leaves it.` : "Hosts couldn't confirm what's at its top level. Check again to clear it.";
  if (checks.credentials && item.hasCredential !== false) return item.hasCredential ? "It has a file inside that looks like a key or credentials, so Hosts leaves it." : "Hosts couldn't confirm there are no keys or credentials inside. Check again to clear it.";
  if (checks.topSource && item.hasTopSource !== false) return item.hasTopSource ? "It has a source file at its top level that someone may have put there, so Hosts leaves it." : "Hosts couldn't confirm what's at its top level. Check again to clear it.";
  return protectedReason(path, guard);
}

/** Every kind's layout, with .DS_Store, as the walk wants it. */
const TOOL_LAYOUTS = Object.fromEntries(Object.keys(TOOL_LAYOUT).map((name) => [name, layoutFor(name)!]));

/** Shown on a git-ignored folder Hosts won't delete itself (dist, build, coverage, …). */
export const ASK_ONLY = "Hosts doesn't delete this kind of folder itself: it can hold hand-made files. Ask an agent to check it.";
export { NO_LOCKFILE } from "./disk-nodemodules";

/** True when a lockfile restores this node_modules (see findLock). */
export const hasLockfile = async (nodeModules: string, root: string) => !!await findLock(nodeModules, root);

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
