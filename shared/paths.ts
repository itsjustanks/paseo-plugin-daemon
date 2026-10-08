/**
 * Friendly file references (0.15.0): one formatter for processes, Workspaces,
 * caches, /tmp, the Disk report and agent messages. In plain view a path is
 * its workspace's name plus the path inside it ("project-hub ·
 * apps/studio/node_modules"), or `~` for home ("~/.cache/ms-playwright");
 * the full path only shows when a row is opened. Pure: no Node modules.
 */

export interface PathRoot {
  /** The workspace (or project) name shown in front. */
  name: string;
  /** Its folder, absolute or home-relative (`~/…`). */
  root: string;
}

export interface PathContext {
  /** The home folder, absolute; when known, absolute paths under it read `~/…`. */
  home?: string | null;
  /** Workspaces and projects, matched longest first. */
  roots?: readonly PathRoot[];
  /** Paseo's home (default `~/.paseo`); worktrees no workspace claims live under its `worktrees`. */
  paseoHome?: string | null;
}

export interface FriendlyPath {
  /** For plain view: "site · apps/web/node_modules", "~/.npm/_cacache", "/tmp/build-x". */
  label: string;
  /** The workspace, project or worktree it belongs to, when one does. */
  workspace: string | null;
  /** The path inside that workspace ("" at its top), else the label's path. */
  rel: string;
  /** The full path: absolute when the home is known, else as given. */
  full: string;
}

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** `~/…` for paths under `home` (when given); anything else as it is. */
export function tildePath(path: string, home?: string | null): string {
  const value = trim(path);
  if (!home || home === "/") return value;
  const base = trim(home);
  if (value === base) return "~";
  return value.startsWith(`${base}/`) ? `~${value.slice(base.length)}` : value;
}

/** The absolute path for a `~/…` one when the home is known. */
export function fullPath(path: string, home?: string | null): string {
  const value = trim(path);
  if (!home) return value;
  if (value === "~") return trim(home);
  return value.startsWith("~/") ? `${trim(home)}${value.slice(1)}` : value;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const relative = (path: string, root: string) => (path === root ? "" : path.slice(root.length + 1));

/** Temporary folders, said the same way on Linux and macOS. */
const TMP_ROOTS: ReadonlyArray<[RegExp, string]> = [
  [/^\/private\/tmp(?=\/|$)/, "/tmp"],
  [/^\/tmp(?=\/|$)/, "/tmp"],
  [/^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?=\/|$)/, "temp"],
  [/^\/var\/folders\/[^/]+\/[^/]+\/T(?=\/|$)/, "temp"],
];

export function friendlyPath(path: string, context: PathContext = {}): FriendlyPath {
  const home = context.home ?? null;
  const given = tildePath(path, home);
  const full = fullPath(given, home);
  const join = (name: string, rel: string) => (rel ? `${name} · ${rel}` : name);
  // A workspace or project folder, the longest (most specific) first.
  const roots = (context.roots ?? []).map((root) => ({ name: root.name, root: tildePath(root.root, home) })).filter((root) => root.root && root.root !== "~" && root.root !== "/").sort((a, b) => b.root.length - a.root.length || a.name.localeCompare(b.name));
  const owner = roots.find((root) => inside(given, root.root));
  if (owner) { const rel = relative(given, owner.root); return { label: join(owner.name, rel), workspace: owner.name, rel, full }; }
  // A worktree no workspace claims: $PASEO_HOME/worktrees/<project>/<name>/…
  const worktrees = `${tildePath(context.paseoHome ?? "~/.paseo", home)}/worktrees`;
  if (inside(given, worktrees) && given !== worktrees) {
    const parts = relative(given, worktrees).split("/");
    const name = parts.slice(0, 2).join("/");
    const rel = parts.slice(2).join("/");
    return { label: join(`worktree ${name}`, rel), workspace: `worktree ${name}`, rel, full };
  }
  for (const [pattern, word] of TMP_ROOTS) {
    const match = pattern.exec(given);
    if (!match) continue;
    const rel = given.slice(match[0].length).replace(/^\//, "");
    const label = word === "/tmp" ? (rel ? `/tmp/${rel}` : "/tmp") : join("temp", rel);
    return { label, workspace: null, rel: label, full };
  }
  return { label: given, workspace: null, rel: given, full };
}

/** Shortened in the middle, so both ends stay readable: "site · apps/…/node_modules". */
export function truncateMiddle(text: string, max: number): string {
  if (max < 5 || text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** How long a path may be in plain view: narrow screens get less. */
export const pathWidth = (compact: boolean) => (compact ? 44 : 88);
