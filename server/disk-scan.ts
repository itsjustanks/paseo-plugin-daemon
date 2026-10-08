import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, statfs, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLEARABLE_NAMES, IGNORED_ONLY_MAX_DEPTH, IGNORED_ONLY_NAMES, PROTECTED_NAME, TMP_MIN_AGE_HOURS, TMP_NEVER,
  ago, describeName, diskSpace, formatSize, neverDelete, olderVersions, toolCacheName,
  type CacheGroup, type ClearItem, type DiskReport, type DiskSpace, type WorkspaceState, type WorkspaceUsage,
} from "../shared/disk";
import { stateDirectory } from "./binaries";
import { gitVerdicts, type GitRun, runGit } from "./disk-git";
import { runWorker, type WalkItem, type WalkResult, type WalkRoot } from "./disk-worker";
import type { MintInput } from "./disk-clear";

/**
 * 0.14.0's disk scan: what each Paseo workspace's folder holds, what of it is
 * safe to clear, and the shared caches. Heavy, so it is:
 *  - on demand only (never from the 10-second loop), with the last answer
 *    cached in memory and in $PASEO_HOME/daemon-link/disk-scan.json;
 *  - one at a time: asking while one runs joins it;
 *  - in a child process at the lowest CPU and disk priority (disk-worker.ts);
 *  - time-boxed: at the limit it stops and says which sizes are floors and
 *    which folders weren't reached.
 * Plugin calls get 30 seconds, so a scan runs in the background and the app
 * polls the report. Workspace status (working, idle, dev servers) is read
 * fresh on every report; sizes come from the last scan.
 */

export const SCAN_SECONDS = 240;

/** One Paseo workspace as the SDK describes it, read defensively (fields vary across Paseo versions). */
export interface WorkspaceInfo { id: string; name: string; project: string | null; directory: string; worktree: boolean; status: string | null; activityAt: number | null; branch: string | null; devServers: string[] }

export interface DiskPlaces { platform: "linux" | "darwin"; home: string; paseoHome: string; tmpDirs: string[]; cacheBases: string[] }

export function defaultPlaces(platform: "linux" | "darwin"): DiskPlaces {
  const home = homedir();
  const paseoHome = process.env.PASEO_HOME || join(home, ".paseo");
  return platform === "darwin"
    ? { platform, home, paseoHome, tmpDirs: ["/private/tmp"], cacheBases: [join(home, "Library", "Caches"), join(home, ".cache")] }
    : { platform, home, paseoHome, tmpDirs: [...new Set(["/tmp", tmpdir()])], cacheBases: [join(home, ".cache")] };
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
export interface ScanCache {
  kind: "workspace" | "unlinked" | "npm" | "pnpm" | "versions" | "tool" | "tmp";
  key: string; path: string; label: string; what: string; cost: string; group: string;
  dev: number; ino: number; mtimeMs: number; bytes: number; sharedBytes: number; partial: boolean; action: "delete" | "prune"; blocked: string | null;
}
export interface ScanData {
  startedAt: number; finishedAt: number | null; partial: boolean; done: number; total: number;
  folders: ScanFolder[];
  /** Per item path: git's answers. */
  git: Record<string, { tracked: boolean | null; ignored: boolean | null }>;
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
  pnpmStore?(): Promise<string | null>;
  walk?: typeof runWorker;
}

const pnpmStorePath = () => new Promise<string | null>((resolve) => {
  execFile("pnpm", ["store", "path"], { timeout: 10_000, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
});

const safe = async <T>(action: () => Promise<T>, fallback: T): Promise<T> => { try { return await action(); } catch { return fallback; } };

export class DiskScanner {
  private data: ScanData | null = null;
  private running: Promise<void> | null = null;
  private progress = { done: 0, total: 0 };
  private loaded = false;
  private readonly now: () => number;

  constructor(private readonly deps: ScannerDeps) { this.now = deps.now ?? Date.now; }

  get isRunning(): boolean { return this.running !== null; }
  last(): ScanData | null { return this.data; }

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
    this.data.caches = this.data.caches.filter((cache) => cache.path !== path || cache.action === "prune");
  }

  /** Start a scan unless one is running (then join it). Returns at once; `wait()` resolves when it ends. */
  start(): void {
    if (this.running) return;
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
    const { places } = this.deps;
    const startedAt = this.now();
    const warnings: string[] = [];
    const workspaces = await safe(() => this.deps.listWorkspaces(), [] as WorkspaceInfo[]);
    if (!workspaces.length) warnings.push("Paseo's workspaces couldn't be read, so only shared caches were checked. Open Hosts once after the daemon starts.");
    const folders = await this.folders(workspaces);
    const caches = await this.cacheCandidates(warnings);
    const roots: WalkRoot[] = [
      ...folders.map((folder) => ({ id: folder.key, path: folder.path, mode: "workspace" as const })),
      ...caches.filter((cache) => cache.kind !== "tmp" || cache.bytes < 0).map((cache) => ({ id: cache.key, path: cache.path, mode: "whole" as const })),
    ];
    this.progress = { done: 0, total: roots.length };
    this.data = { startedAt, finishedAt: null, partial: false, done: 0, total: roots.length, folders, git: {}, caches: [], warnings };
    const seconds = this.deps.scanSeconds ?? SCAN_SECONDS;
    const byId = new Map<string, WalkResult>();
    const walk = this.deps.walk ?? runWorker;
    const run = await walk<WalkResult>({
      op: "scan", roots, deadline: startedAt + seconds * 1000,
      clearable: Object.keys(CLEARABLE_NAMES), ignoredOnly: Object.keys(IGNORED_ONLY_NAMES), ignoredMaxDepth: IGNORED_ONLY_MAX_DEPTH, maxItemsPerRoot: 200,
    }, (seconds + 30) * 1000, (result) => {
      byId.set(result.id, result);
      this.progress.done += 1;
      if (this.data) this.data.done = this.progress.done;
      const folder = folders.find((item) => item.key === result.id);
      if (folder) folder.result = result;
    });
    if (run.error) warnings.push("The disk check couldn't run here.");
    const partial = run.timedOut || [...byId.values()].some((result) => result.partial || result.skipped) || byId.size < roots.length;
    // Git's verdict on every candidate inside a workspace (tracked → source; dist/build/out must be ignored).
    const candidates = folders.flatMap((folder) => (folder.result?.items ?? []).map((item) => join(folder.path, item.rel)));
    const verdicts = candidates.length ? await safe(() => gitVerdicts(candidates, this.deps.git ?? runGit), new Map()) : new Map();
    const git: ScanData["git"] = {};
    for (const [path, verdict] of verdicts) git[path] = { tracked: verdict.tracked, ignored: verdict.ignored };
    for (const cache of caches) {
      const result = byId.get(cache.key);
      if (result) {
        cache.dev = result.dev; cache.ino = result.ino; cache.bytes = result.totalBytes; cache.partial = result.partial || !!result.skipped;
        if (cache.kind === "tmp") {
          const ageHours = (this.now() - Math.max(result.newestMtimeMs, cache.mtimeMs)) / 3_600_000;
          if (ageHours < TMP_MIN_AGE_HOURS) cache.blocked = "Changed in the last 6 hours, so it may still be in use.";
          if (result.hasEnv || result.hasGit) cache.blocked = "Has a .env file or a .git folder inside, so Hosts leaves it.";
        }
      } else if (cache.bytes < 0) { cache.bytes = 0; cache.partial = true; }
      else if (cache.kind === "tmp" && (this.now() - cache.mtimeMs) / 3_600_000 < TMP_MIN_AGE_HOURS) cache.blocked = "Changed in the last 6 hours, so it may still be in use.";
    }
    this.data = { startedAt, finishedAt: this.now(), partial, done: byId.size, total: roots.length, folders, git, caches: caches.filter((cache) => cache.bytes > 0 || cache.partial), warnings };
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
        const real = await safe(() => realpath(candidate), null);
        const st = real ? await safe(() => lstat(real), null) : null;
        if (!real || !st?.isDirectory() || isClaimed(real)) continue;
        out.push(real);
      }
    }
    return out;
  }

  /** Shared caches and /tmp leftovers to measure (sizes are filled in by the walk). */
  private async cacheCandidates(warnings: string[]): Promise<ScanCache[]> {
    const { places, uid } = this.deps;
    const out: ScanCache[] = [];
    const add = async (kind: ScanCache["kind"], path: string, label: string, what: string, cost: string, group: string, action: "delete" | "prune" = "delete") => {
      const real = await safe(() => realpath(path), null);
      const st = real ? await safe(() => lstat(real), null) : null;
      if (!real || !st || st.isSymbolicLink() || (!st.isDirectory() && kind !== "tmp") || st.uid !== uid) return;
      if (PROTECTED_NAME.test(basename(real)) || neverDelete(real, places)) return;
      out.push({ kind, key: `${kind}:${real}`, path: real, label, what, cost, group, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, bytes: st.isDirectory() ? -1 : st.blocks * 512, sharedBytes: 0, partial: false, action, blocked: null });
    };
    const npm = join(places.home, ".npm");
    await add("npm", join(npm, "_cacache"), "npm cache", "Packages npm downloaded", "Packages download again when a project next installs them.", "Package managers");
    await add("npm", join(npm, "_npx"), "npx downloads", "Tools fetched with npx", "Fetched again the next time you run them with npx.", "Package managers");
    const store = await (this.deps.pnpmStore ?? pnpmStorePath)();
    if (store) await add("pnpm", store, "pnpm store", "Packages shared by your pnpm projects", "Pruning removes only packages no project uses; nothing a project needs is lost.", "Package managers", "prune");
    // Browser downloads: keep the newest of each kind.
    const browserDirs = [
      ...places.cacheBases.map((base) => join(base, "ms-playwright")),
      join(places.home, ".cache", "puppeteer", "chrome"), join(places.home, ".cache", "puppeteer", "chrome-headless-shell"),
      join(places.home, ".agent-browser", "browsers"), join(places.home, ".cache", "agent-browser"),
    ];
    for (const dir of [...new Set(browserDirs)]) {
      const names = await safe(() => readdir(dir), [] as string[]);
      for (const name of olderVersions(names)) {
        await add("versions", join(dir, name), name, "An older browser download", "Downloaded again only if a project still asks for this version.", "Old browser downloads");
      }
    }
    for (const base of places.cacheBases) {
      for (const name of await safe(() => readdir(base), [] as string[])) {
        const what = toolCacheName(name);
        if (what) await add("tool", join(base, name), name, what, "Filled again the next time the tool needs it.", "Tool caches");
      }
    }
    for (const dir of places.tmpDirs) {
      for (const name of await safe(() => readdir(dir), [] as string[])) {
        if (TMP_NEVER.test(name) || name.startsWith(".hosts-")) continue;
        await add("tmp", join(dir, name), name, "Left in the temporary folder", "Temporary files. Nothing should need them after 6 hours.", "Temporary files");
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
        const blocked = itemBlocked(item, data?.git[path] ?? null, path, this.deps.places);
        if (blocked === "hide") return [];
        const words = describeName(item.name)!;
        const why = blocked ?? busy;
        return [{
          token: why ? null : mint({ path, dev: item.dev, ino: item.ino, mtimeMs: item.mtimeMs, action: "delete", kind: "workspace", owner: label, bytes: item.bytes - item.sharedBytes }),
          name: item.name, what: words.what, cost: words.cost, where: item.rel, bytes: item.bytes, sharedBytes: item.sharedBytes, partial: item.partial, action: "delete" as const, blocked: why,
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
      const item: ClearItem = {
        token: cache.blocked || cache.kind === "workspace" || cache.kind === "unlinked" ? null : mint({ path: cache.path, dev: cache.dev, ino: cache.ino, mtimeMs: cache.mtimeMs, action: cache.action, kind: cache.kind, owner: cache.group, bytes: cache.bytes, name: cache.label, cost: cache.cost }),
        name: cache.label, what: cache.what, cost: cache.cost, where: homeRelative(cache.path, home), bytes: cache.bytes, sharedBytes: cache.sharedBytes, partial: cache.partial, action: cache.action, blocked: cache.blocked,
      };
      group.items.push(item);
      group.totalBytes += cache.bytes;
      groups.set(cache.group, group);
    }
    const caches = [...groups.values()].map((group) => ({ ...group, items: group.items.sort((a, b) => b.bytes - a.bytes) })).sort((a, b) => b.totalBytes - a.totalBytes);
    const clearable = workspaces.reduce((sum, workspace) => sum + workspace.clearableBytes, 0)
      + caches.flatMap((group) => group.items).filter((item) => item.token && item.action === "delete").reduce((sum, item) => sum + item.bytes, 0);
    return {
      disks,
      scan: {
        state: this.running ? "running" : data ? "done" : "never",
        startedAt: data?.startedAt ?? null, finishedAt: data?.finishedAt ?? null,
        done: this.running ? this.progress.done : data?.done ?? 0, total: this.running ? this.progress.total : data?.total ?? 0,
        partial: !!data?.partial,
        message: this.running ? "Checking what's using space. This runs quietly in the background and can take a few minutes." : data?.partial ? "The check stopped at its time limit, so some sizes are at least what's shown and some folders weren't reached." : null,
      },
      workspaces, caches, clearableBytes: clearable, warnings: data?.warnings ?? [],
    };
  }
}

/**
 * "Ask an agent" about a worktree folder no workspace uses any more. Hosts
 * never removes a worktree itself: the SDK has no way to remove one that's
 * already been archived, and an rm would leave git's records behind and could
 * lose unpushed work. So it asks an agent to check and to ask before deleting.
 */
export function folderAskText(folder: { path: string; bytes: number; branch: string | null; changedAt: number | null }, home: string, now = Date.now()): string {
  const lines = [
    `Hosts found a Paseo worktree that no workspace uses any more. It takes up ${formatSize(folder.bytes)}.`,
    "",
    `Folder: ${homeRelative(folder.path, home)}`,
    ...(folder.branch ? [`Branch: ${folder.branch}`] : []),
    ...(folder.changedAt ? [`Last changed: ${ago(folder.changedAt, now)}`] : []),
    "",
    "Please check whether anything in it still matters: uncommitted changes (git status) and commits that aren't pushed anywhere (git log --branches --not --remotes).",
    "Tell me what you find. If nothing is needed, suggest removing it properly with \"git worktree remove\" from its main repository, then \"git worktree prune\".",
    "Ask me before you delete anything.",
  ];
  return lines.join("\n");
}

/**
 * Why a found folder can't be cleared, "hide" when it isn't clearable at all
 * (git tracks it, or it's a dist/build/out that git doesn't ignore: it's
 * just part of the project), or null when it may be.
 */
export function itemBlocked(item: Pick<WalkItem, "name" | "hasEnv" | "hasGit" | "ignoredOnly">, git: { tracked: boolean | null; ignored: boolean | null } | null, path: string, places: Pick<DiskPlaces, "home" | "paseoHome">): string | null | "hide" {
  if (item.ignoredOnly && git?.ignored !== true) return "hide";
  if (!git || git.tracked === null) return "Git couldn't check it, so Hosts leaves it.";
  // Tracked means it's part of the project (a source folder that happens to be called "coverage"): not listed at all.
  if (git.tracked) return "hide";
  if (item.hasEnv) return "It has a .env file inside, so Hosts leaves it.";
  if (item.hasGit) return "It has a .git folder inside, so Hosts leaves it.";
  return neverDelete(path, places);
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
