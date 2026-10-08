import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 0.14.0: disk usage, read-only. Hosts shows how full the disk is, what each
 * Paseo workspace uses, what of it looks safe to clear, and the shared caches
 * and temporary files, by size. It deletes nothing: "Ask an agent to clean
 * this up" hands an agent the exact list, with the checks to do before each
 * deletion. One-press clearing is being reviewed for a later release.
 *
 * "Looks safe to clear" (inside a workspace or worktree): an allow-listed
 * folder (node_modules, .next, coverage…) that git says is ignored, with
 * nothing tracked and nothing untracked-but-not-ignored beneath it, no .env,
 * .git or bare repository inside, outside every protected place, and not in
 * a workspace where an agent is working or a dev server runs. It's a hint for
 * the agent, which checks again before deleting anything.
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

/** System and session folders in /tmp that aren't listed as leftovers. */
export const TMP_NEVER = /^(\.X11-unix|\.ICE-unix|\.font-unix|\.XIM-unix|\.Test-unix|tmux-|ssh-|systemd-|snap-|com\.apple|launchd|powerlog|claude|codex|paseo)/i;

/**
 * What Hosts protects (0.14.0): a folder in or around one of these never
 * "looks safe to clear", whatever else is true of it.
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

/** Something found inside a workspace, or a shared cache or temporary folder. Read-only: Hosts deletes nothing. */
export const ClearItemSchema = z.object({
  /** It looks safe to clear by Hosts' rules (git ignores it, nothing in use found…); a hint for the agent, never an action. */
  safe: z.boolean(),
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
  /** Why it doesn't look safe to clear, in plain words; null when it does. */
  blocked: z.string().nullable(),
  /** "Ask an agent" about this one folder (its id in the last check), for /tmp folders. */
  askId: z.string().nullable().optional(),
  /** 0.15.0: the full path, shown only when a row is opened (with Copy path). */
  path: z.string().optional(),
  /** 0.16.0: signed handle for one-press Clear (a build folder inside a workspace only); null when Hosts won't clear it. */
  token: z.string().nullable().optional(),
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
  /** 0.15.0: the full folder, shown only when the row is opened (with Copy path). */
  path: z.string().optional(),
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
  /** The Paseo workspace ids that use this folder, so a workspace's own panel can find its row. */
  workspaceIds: z.array(z.string()).optional(),
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
  /** 0.16.0: what an interrupted clear set aside and couldn't put back; shown, never deleted by Hosts. */
  leftovers: z.array(z.object({ id: z.string(), name: z.string(), where: z.string(), bytes: z.number().min(0), at: z.number() })).optional(),
  /** 0.16.0: the record of interrupted clears is damaged; nothing is cleared until it's checked. */
  journalProblem: z.string().nullable().optional(),
});
export type DiskReport = z.infer<typeof DiskReportSchema>;

/** The cached report; `scan: true` starts a fresh scan in the background (one at a time) and answers at once. */
export const diskReport = defineRpc({ name: "daemon-link.disk.report", input: z.object({ scan: z.boolean().optional() }), output: DiskReportSchema });

// ------------------------------------------------- one-press Clear (0.16.0)

/** Big deletes need a second step in the warning dialog. */
export const BIG_DELETE_BYTES = 10 * 1024 ** 3;
export const BIG_DELETE_COUNT = 20;
export const isBigDelete = (bytes: number, count: number) => bytes > BIG_DELETE_BYTES || count > BIG_DELETE_COUNT;

/** The warning dialog's list, from a fresh check of every item (nothing in use, nothing changed). */
export const DiskPlanSchema = z.object({
  items: z.array(z.object({
    /** The workspace it's in (its name, or its folder). */
    workspace: z.string(),
    /** Its friendly path inside the workspace ("apps/web/node_modules"). */
    where: z.string(),
    /** The full path, for the opened row. */
    path: z.string(),
    /** What it is ("Installed packages"). */
    what: z.string(),
    /** What deleting it costs ("Comes back on the next install"). */
    cost: z.string(),
    bytes: z.number().min(0),
    ok: z.boolean(),
    /** Why it won't be deleted; null when it will. */
    reason: z.string().nullable(),
  })),
  /** What will go, in all (ok items only). */
  bytes: z.number().min(0),
  count: z.number().int().min(0),
  /** When these checks ran (epoch ms): "Checked just now". */
  checkedAt: z.number(),
});
export type DiskPlan = z.infer<typeof DiskPlanSchema>;

export const DiskJobSchema = z.object({
  state: z.enum(["idle", "running", "done"]),
  freedBytes: z.number().min(0),
  results: z.array(z.object({ workspace: z.string(), where: z.string(), ok: z.boolean(), bytes: z.number().min(0), message: z.string() })),
  message: z.string().nullable(),
  /** When this job finished (epoch ms), so the app shows one result per job. */
  finishedAt: z.number().nullable().optional(),
});
export type DiskJob = z.infer<typeof DiskJobSchema>;

export const TOKENS_MAX = 200;
const Tokens = z.object({ tokens: z.array(z.string().min(1).max(2048)).min(1).max(TOKENS_MAX) });
/** Re-checks every item fresh and returns exactly what would go. Deletes nothing. */
export const diskPreview = defineRpc({ name: "daemon-link.disk.preview", input: Tokens, output: DiskPlanSchema });
/** Starts deleting in the background, each item checked again just before it goes; poll `diskClearStatus`. */
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

// ------------------------------------------- one workspace's panel

/** A workspace's panel speaks up about disk only past one of these; otherwise it's one quiet line. */
export const PANEL_CLEARABLE_BYTES = 500 * 1024 * 1024;
export const PANEL_DISK_PERCENT = DISK_WARNING_PERCENT;

export interface WorkspaceDiskView {
  /** "attention": a section with the ask; "quiet": one line. */
  mode: "attention" | "quiet";
  usage: WorkspaceUsage | null;
  disk: DiskSpace | null;
  /** The quiet line, or the section's first sentence. */
  line: string;
  /** Ask an agent to clean up this workspace's folder (its id in the last check), when something in it looks safe to clear. */
  askId: string | null;
}

/**
 * What one workspace's panel says about disk, from the last check and the
 * health verdict's disk (both cached; this never starts a check). It speaks
 * up when 500 MB or more looks safe to clear here, or the disk is 85% full.
 */
export function workspaceDiskView(report: DiskReport | undefined | null, workspaceId: string, verdictDisk: DiskSpace | null | undefined): WorkspaceDiskView {
  const usage = report?.workspaces.find((workspace) => workspace.workspaceIds?.includes(workspaceId)) ?? null;
  const disk = verdictDisk ?? report?.disks[0] ?? null;
  const measured = !!usage && usage.measured !== false;
  const clearable = measured ? usage!.clearableBytes : 0;
  const full = !!disk && disk.percent >= PANEL_DISK_PERCENT;
  const mode = clearable >= PANEL_CLEARABLE_BYTES || full ? "attention" : "quiet";
  const uses = measured ? `This workspace uses ${formatSize(usage!.totalBytes)}${usage!.partial ? " or more" : ""}` : report?.scan.state === "running" ? "Hosts is checking this workspace's size" : "This workspace's size hasn't been checked yet";
  const space = disk ? `the disk is ${Math.round(disk.percent)}% full (${formatSize(disk.freeBytes)} left)` : null;
  const safe = clearable > 0 ? `${formatSize(clearable)} of it looks safe to clear` : null;
  const line = mode === "quiet"
    ? `Disk: ${[measured ? `this workspace uses ${formatSize(usage!.totalBytes)}${usage!.partial ? " or more" : ""}` : "not checked yet", space ? space.replace(/ \(.*\)$/, "") : null].filter(Boolean).join(" · ")}`
    : `${[uses, safe].filter(Boolean).join("; ")}.${space ? ` ${space[0]!.toUpperCase()}${space.slice(1)}.` : ""}`;
  const askId = measured && clearable > 0 && !usage!.busy ? usage!.id : null;
  return { mode, usage, disk, line, askId };
}

/**
 * The "Disk report" attachment (0.14.0): workspaces by size, what looks safe
 * to clear, and the caches and temporary files, from the last check. Plain
 * text an agent can act on; home-relative folders only.
 */
export function diskReportText(report: DiskReport, now = Date.now()): string {
  const disk = report.disks[0];
  const lines = ["Disk report from Hosts (read-only: Hosts deleted nothing)."];
  if (disk) lines.push(`Disk: ${formatSize(disk.freeBytes)} free of ${formatSize(disk.totalBytes)} (${Math.round(disk.percent)}% used).`);
  if (report.scan.state === "never") lines.push("Workspaces haven't been checked yet; run \"Check disk space\" in Hosts for sizes.");
  else lines.push(`Checked ${report.scan.finishedAt ? ago(report.scan.finishedAt, now) : "just now"}${report.scan.state === "running" ? " (a new check is running)" : ""}${report.scan.partial ? "; some sizes are floors" : ""}.`);
  lines.push(`Looks safe to clear in all: ${formatSize(report.clearableBytes)}.`);
  const workspaces = report.workspaces.filter((workspace) => workspace.measured !== false).sort((a, b) => b.totalBytes - a.totalBytes || (a.names[0] ?? "\uffff").localeCompare(b.names[0] ?? "\uffff")).slice(0, 15);
  if (workspaces.length) {
    lines.push("", "Workspaces by size:");
    for (const workspace of workspaces) {
      const name = workspace.names[0] ?? "not linked to a workspace";
      const safe = workspace.clearableBytes > 0 ? `, ${formatSize(workspace.clearableBytes)} looks safe to clear` : "";
      lines.push(`- ${name} (${workspace.folder}): ${formatSize(workspace.totalBytes)}${workspace.partial ? " or more" : ""}${safe}${workspace.busy ? ` (${workspace.busy.replace(/\.$/, "")})` : ""}`);
      const safeItems = workspace.items.filter((entry) => entry.safe).sort((a, b) => (b.bytes - b.sharedBytes) - (a.bytes - a.sharedBytes) || a.where.localeCompare(b.where));
      for (const item of safeItems.slice(0, 5)) lines.push(`  - ${workspace.names[0] ? `${workspace.names[0]} · ` : ""}${item.where}: ${formatSize(Math.max(0, item.bytes - item.sharedBytes))} (${item.what})`);
    }
  }
  const groups = report.caches.filter((group) => group.totalBytes > 0).sort((a, b) => b.totalBytes - a.totalBytes || a.title.localeCompare(b.title));
  if (groups.length) {
    lines.push("", "Shared caches and temporary files:");
    for (const group of groups) {
      lines.push(`- ${group.title}: ${formatSize(group.totalBytes)}`);
      for (const item of [...group.items].sort((a, b) => b.bytes - a.bytes || a.where.localeCompare(b.where)).slice(0, 5)) lines.push(`  - ${item.where}: ${formatSize(item.bytes)} (${item.what})`);
    }
  }
  lines.push("", "Before deleting anything, check it isn't in use or holding unsaved work. Clear build files and caches, never source, .git or .env files.");
  return lines.join("\n");
}
