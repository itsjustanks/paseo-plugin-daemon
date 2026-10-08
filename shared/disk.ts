import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 0.14.0: disk usage and safe cleanup.
 *
 * What fills a dev host's disk is almost always regenerable: dependency
 * folders, build output, test reports, tool caches and old browser
 * downloads. Hosts shows what each Paseo workspace uses, how much of it is
 * safe to clear, and clears it only after asking, CleanMyMac-style.
 *
 * Safe to clear means, and only means:
 *  - inside a workspace: a folder on the allow-list below, not tracked by git,
 *    with no .env file or .git inside; dist/build/out only when git confirms
 *    it ignores them;
 *  - shared caches: npm's cache, old Playwright / Puppeteer / agent-browser
 *    downloads (the newest of each kind is kept), known tool caches, pnpm's
 *    store (pruned by pnpm, never deleted), and this user's leftovers in /tmp
 *    older than 6 hours.
 * Never: anything git tracks, .git, .env files, source, Paseo's own data,
 * ~/.claude or ~/.codex, a whole workspace or worktree folder, or anything
 * a process is using. Pure rules here; the server reads, checks and deletes.
 */

// ----------------------------------------------------------- the disk

export const DISK_WARNING_PERCENT = 85;
export const DISK_CRITICAL_PERCENT = 95;

export const DiskLevelSchema = z.enum(["ok", "warning", "critical"]);
export type DiskLevel = z.infer<typeof DiskLevelSchema>;

export const DiskSpaceSchema = z.object({
  /** A short name for the disk: "This computer's disk", or the folder it holds when there are several. */
  label: z.string(),
  totalBytes: z.number().min(0),
  usedBytes: z.number().min(0),
  /** What this user can still write (statfs `bavail`). */
  freeBytes: z.number().min(0),
  percent: z.number().min(0).max(100),
  level: DiskLevelSchema,
  /** One plain sentence when it needs attention; null when there's room. */
  sentence: z.string().nullable(),
});
export type DiskSpace = z.infer<typeof DiskSpaceSchema>;

export function diskLevel(percent: number): DiskLevel {
  return percent >= DISK_CRITICAL_PERCENT ? "critical" : percent >= DISK_WARNING_PERCENT ? "warning" : "ok";
}

export function formatSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1024; unit += 1; }
  if (unit === 0) return `${Math.round(value)} bytes`;
  return `${value >= 100 || unit < 2 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

/** statfs figures to the summary, the way `df` counts: used against used plus what's still writable. */
export function diskSpace(label: string, stats: { bsize: number; blocks: number; bfree: number; bavail: number }): DiskSpace {
  const total = stats.blocks * stats.bsize;
  const used = Math.max(0, (stats.blocks - stats.bfree) * stats.bsize);
  const free = Math.max(0, stats.bavail * stats.bsize);
  const percent = used + free > 0 ? Math.min(100, Math.round((used / (used + free)) * 1000) / 10) : 0;
  const level = diskLevel(percent);
  return { label, totalBytes: total, usedBytes: used, freeBytes: free, percent, level, sentence: diskSentence(percent, free, level) };
}

export function diskSentence(percent: number, freeBytes: number, level: DiskLevel = diskLevel(percent)): string | null {
  if (level === "critical") return `The disk is ${Math.round(percent)}% full (${formatSize(freeBytes)} left). Agents will start failing to write files soon.`;
  if (level === "warning") return `The disk is ${Math.round(percent)}% full (${formatSize(freeBytes)} left). Clearing build files and caches under Workspaces can help.`;
  return null;
}

// ------------------------------------------------- what may be cleared

/** Regenerable folders inside a workspace, by exact name, with what clearing one costs. */
export const CLEARABLE_NAMES: Readonly<Record<string, { what: string; cost: string }>> = {
  node_modules: { what: "Installed packages", cost: "Comes back on the next install (a few minutes)." },
  ".next": { what: "Next.js build files", cost: "Rebuilt the next time the app builds or starts." },
  ".nuxt": { what: "Nuxt build files", cost: "Rebuilt the next time the app builds or starts." },
  ".svelte-kit": { what: "SvelteKit build files", cost: "Rebuilt the next time the app builds or starts." },
  ".turbo": { what: "Turborepo cache", cost: "Builds run a little slower once while it refills." },
  ".vite": { what: "Vite cache", cost: "Rebuilt the next time the dev server starts." },
  ".parcel-cache": { what: "Parcel cache", cost: "Rebuilt on the next build." },
  ".cache": { what: "Build tool cache", cost: "Builds run a little slower once while it refills." },
  coverage: { what: "Test coverage reports", cost: "Made again the next time tests run with coverage." },
  "test-results": { what: "Old test results", cost: "Made again the next time tests run." },
  "playwright-report": { what: "Old test reports", cost: "Made again the next time tests run." },
  "storybook-static": { what: "Storybook build", cost: "Rebuilt by the next Storybook build." },
  __pycache__: { what: "Python compiled files", cost: "Python remakes these automatically." },
  ".pytest_cache": { what: "pytest cache", cost: "Made again the next time tests run." },
};

/** Build output: cleared only when git confirms the folder is ignored. */
export const IGNORED_ONLY_NAMES: Readonly<Record<string, { what: string; cost: string }>> = {
  dist: { what: "Build output", cost: "Rebuilt on the next build." },
  build: { what: "Build output", cost: "Rebuilt on the next build." },
  out: { what: "Build output", cost: "Rebuilt on the next build." },
};
/** dist/build/out deeper than this inside a workspace aren't considered (they're usually a package's own). */
export const IGNORED_ONLY_MAX_DEPTH = 4;

export const isClearableName = (name: string) => Object.prototype.hasOwnProperty.call(CLEARABLE_NAMES, name);
export const isIgnoredOnlyName = (name: string) => Object.prototype.hasOwnProperty.call(IGNORED_ONLY_NAMES, name);
export const describeName = (name: string) => CLEARABLE_NAMES[name] ?? IGNORED_ONLY_NAMES[name] ?? null;

/** A name that is never part of anything cleared: a whole item is blocked if one sits inside it. */
export const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.");

/**
 * Known regenerable tool caches, by folder name under ~/.cache (Linux) or
 * ~/Library/Caches (macOS). Anything else there is left alone. Matching
 * ignores case (Yarn vs yarn).
 */
export const TOOL_CACHES: Readonly<Record<string, string>> = {
  pip: "pip downloads", uv: "uv downloads", yarn: "Yarn downloads", "go-build": "Go build cache", "node-gyp": "Native add-on headers",
  typescript: "TypeScript type downloads", esbuild: "esbuild downloads", electron: "Electron downloads", "electron-builder": "Electron builder downloads",
  cypress: "Cypress app downloads", prisma: "Prisma engine downloads", turbo: "Turborepo cache", deno: "Deno cache", "next-swc": "Next.js compiler downloads",
  pnpm: "pnpm metadata cache", nx: "Nx cache", pkg: "pkg downloads", "ts-node": "ts-node cache", vite: "Vite cache",
};
export const toolCacheName = (name: string): string | null => {
  const key = Object.keys(TOOL_CACHES).find((known) => known.toLowerCase() === name.toLowerCase());
  return key ? TOOL_CACHES[key]! : null;
};

/** Names a cache or /tmp scan never offers, whatever they hold: agents' history and Paseo's own state. */
export const PROTECTED_NAME = /claude|codex|paseo|anthropic|openai/i;

/** /tmp folders are offered only when this old (newest change inside included). */
export const TMP_MIN_AGE_HOURS = 6;
/** System and session folders in /tmp that are never leftovers. */
export const TMP_NEVER = /^(\.X11-unix|\.ICE-unix|\.font-unix|\.XIM-unix|\.Test-unix|tmux-|ssh-|systemd-|snap-|com\.apple|launchd|powerlog|claude|codex|paseo)/i;

/**
 * Versioned downloads (Playwright, Puppeteer, agent-browser): which entries
 * are older versions of a kind that has a newer one. Entries without a
 * version in their name (".links", "b") are never offered.
 * "chromium-1140", "chromium_headless_shell-1140", "mac_arm-131.0.6778.85", "chrome-128.0.1".
 */
export function olderVersions(names: readonly string[]): string[] {
  const parsed = names.flatMap((name) => {
    const match = /^(.*?)[-_]v?(\d+(?:\.\d+)*)$/.exec(name);
    return match && !name.startsWith(".") ? [{ name, family: match[1]!, version: match[2]!.split(".").map(Number) }] : [];
  });
  const newest = new Map<string, number[]>();
  for (const item of parsed) {
    const best = newest.get(item.family);
    if (!best || compareVersions(item.version, best) > 0) newest.set(item.family, item.version);
  }
  return parsed.filter((item) => compareVersions(item.version, newest.get(item.family)!) < 0).map((item) => item.name).sort();
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * What Hosts protects, whatever a scan or a token says (0.14.0, reviewed).
 *  - `whole`: never deleted, and never an ancestor of a target either (so a
 *    /tmp folder that happens to contain $PASEO_HOME is refused): home,
 *    Paseo's home, ~/.claude, ~/.codex, every workspace and worktree root,
 *    Hosts' own state folder, and /.
 *  - `inside`: nothing beneath these is ever deleted: ~/.claude, ~/.codex,
 *    Hosts' state folder, and Paseo's home except inside a worktree root
 *    (where a worktree's own build folders live).
 * Paths are absolute and normalised; callers pass each protected path both
 * as given and as its real path, so a symlinked home is still matched.
 */
export interface ProtectedSet { whole: readonly string[]; inside: readonly string[]; worktreeRoots: readonly string[] }

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
export const isWithin = (path: string, root: string) => { const r = trim(root); return r === "/" ? path !== "/" : path.startsWith(`${r}/`); };

export function protectedReason(target: string, set: ProtectedSet): string | null {
  const path = trim(target);
  for (const raw of set.whole) {
    const root = trim(raw);
    if (path === root) return "That's a whole folder Hosts never deletes.";
    if (isWithin(root, path)) return "It contains a folder Hosts protects (your home, Paseo's data, agents' history or a workspace), so Hosts leaves it.";
  }
  for (const raw of set.inside) {
    const root = trim(raw);
    if (!isWithin(path, root)) continue;
    if (set.worktreeRoots.some((worktree) => isWithin(path, worktree) && isWithin(trim(worktree), root))) continue;
    return /\.(claude|codex)(\/|$)/.test(root) ? "Agents' history and settings are your data. Hosts never deletes them." : "Paseo's own data (settings, history, logs) and Hosts' own files are never deleted.";
  }
  return null;
}

/** The protected set for a home, Paseo home and state folder, plus the given workspace and worktree roots. */
export function protectedSet(places: { home: string; paseoHome: string; stateDir: string }, workspaceRoots: readonly string[], worktreeRoots: readonly string[], aliases: readonly string[] = []): ProtectedSet {
  const agents = [`${trim(places.home)}/.claude`, `${trim(places.home)}/.codex`];
  return {
    whole: [...new Set([places.home, places.paseoHome, ...agents, places.stateDir, ...workspaceRoots, ...worktreeRoots, "/", ...aliases].map(trim))],
    inside: [...new Set([...agents, places.stateDir, places.paseoHome].map(trim))],
    worktreeRoots: worktreeRoots.map(trim),
  };
}

// --------------------------------------------------------- wire types

export const WorkspaceStateSchema = z.enum(["working", "waiting", "failed", "idle", "unlinked"]);
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const ClearItemSchema = z.object({
  /** Signed handle bound to the folder (path, device, inode, scan); null when it may not be cleared. */
  token: z.string().nullable(),
  /** "node_modules", "chromium-1140", "npm cache". */
  name: z.string(),
  /** What it is, in a few words. */
  what: z.string(),
  /** What clearing it costs, in one sentence. */
  cost: z.string(),
  /** Where it is, relative to its workspace folder ("apps/web/node_modules"); shown only when a row is opened. */
  where: z.string(),
  bytes: z.number().min(0),
  /** Bytes shared with folders elsewhere (pnpm's store hard links), which clearing this doesn't free. */
  sharedBytes: z.number().min(0),
  /** The size is a floor: checking it ran out of time. */
  partial: z.boolean(),
  /** "delete" removes the folder; "prune" asks pnpm to drop what no project uses. */
  action: z.enum(["delete", "prune"]),
  /** Why it can't be cleared now, in plain words; null when it can. */
  blocked: z.string().nullable(),
});
export type ClearItem = z.infer<typeof ClearItemSchema>;

export const WorkspaceUsageSchema = z.object({
  /** Stable key for this folder in this scan. */
  id: z.string(),
  /** The workspace names that use this folder ("Sandbox", "Localhost"); empty when none does. */
  names: z.array(z.string()),
  project: z.string().nullable(),
  /** The folder, home-relative ("~/code/site"); shown when a row is opened. */
  folder: z.string(),
  worktree: z.boolean(),
  branch: z.string().nullable(),
  state: WorkspaceStateSchema,
  /** When it was last active (epoch ms), when Paseo says. */
  activeAt: z.number().nullable(),
  /** Dev servers running in it now, as "Next.js :3000". */
  devServers: z.array(z.string()),
  totalBytes: z.number().min(0),
  clearableBytes: z.number().min(0),
  partial: z.boolean(),
  /** Why nothing in it may be cleared right now (an agent is working, a dev server runs); null when it may. */
  busy: z.string().nullable(),
  items: z.array(ClearItemSchema),
  /** Not checked this time (the scan ran out of time first). */
  skipped: z.boolean(),
  /** Its size has been measured (false until a check reaches it: say "Checking…", not "0 bytes"). */
  measured: z.boolean().optional(),
});
export type WorkspaceUsage = z.infer<typeof WorkspaceUsageSchema>;

export const CacheGroupSchema = z.object({ id: z.string(), title: z.string(), totalBytes: z.number().min(0), items: z.array(ClearItemSchema) });
export type CacheGroup = z.infer<typeof CacheGroupSchema>;

export const DiskReportSchema = z.object({
  /** The disks the workspaces live on, fullest first (instant, from statfs). */
  disks: z.array(DiskSpaceSchema),
  scan: z.object({
    state: z.enum(["never", "running", "done"]),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
    /** Folders checked so far, and in all. */
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    /** It stopped at its time limit; some sizes are floors and some folders weren't checked. */
    partial: z.boolean(),
    message: z.string().nullable(),
  }),
  workspaces: z.array(WorkspaceUsageSchema),
  caches: z.array(CacheGroupSchema),
  clearableBytes: z.number().min(0),
  warnings: z.array(z.string()),
});
export type DiskReport = z.infer<typeof DiskReportSchema>;

export const DiskPlanSchema = z.object({
  items: z.array(z.object({ name: z.string(), where: z.string(), owner: z.string(), bytes: z.number(), action: z.enum(["delete", "prune"]), cost: z.string(), ok: z.boolean(), reason: z.string().nullable() })),
  bytes: z.number(),
});
export type DiskPlan = z.infer<typeof DiskPlanSchema>;

export const DiskJobSchema = z.object({
  state: z.enum(["idle", "running", "done"]),
  /** What was freed so far. */
  freedBytes: z.number().min(0),
  results: z.array(z.object({ name: z.string(), owner: z.string(), ok: z.boolean(), bytes: z.number(), message: z.string() })),
  message: z.string().nullable(),
});
export type DiskJob = z.infer<typeof DiskJobSchema>;

export const TOKENS_MAX = 200;
const Tokens = z.object({ tokens: z.array(z.string().min(1).max(1024)).min(1).max(TOKENS_MAX) });

/** The cached report; `scan: true` starts a fresh scan in the background (one at a time) and answers at once. */
export const diskReport = defineRpc({ name: "daemon-link.disk.report", input: z.object({ scan: z.boolean().optional() }), output: DiskReportSchema });
/** The ask-first list: exactly what would go, its size and cost, and what won't and why. */
export const diskPreview = defineRpc({ name: "daemon-link.disk.preview", input: Tokens, output: DiskPlanSchema });
/** Starts clearing in the background; poll `diskClearStatus`. */
export const diskClear = defineRpc({ name: "daemon-link.disk.clear", input: Tokens, output: DiskJobSchema });
export const diskClearStatus = defineRpc({ name: "daemon-link.disk.clear-status", input: z.object({}), output: DiskJobSchema });

/** "Idle 3 days", "Agent working now". */
export function stateWords(state: WorkspaceState, activeAt: number | null, now = Date.now()): string {
  if (state === "working") return "Agent working now";
  if (state === "waiting") return "Waiting for you";
  if (state === "failed") return activeAt ? `Last run failed · ${ago(activeAt, now)}` : "Last run failed";
  if (state === "unlinked") return "Not linked to a workspace";
  return activeAt ? `Idle since ${ago(activeAt, now)}` : "Idle";
}

export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
