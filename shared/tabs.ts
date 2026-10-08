/**
 * The Hosts screen's tabs (0.11.0) and how older links land on them.
 *
 * Four tabs, by what someone comes to do: see whether this computer is fine
 * (Overview), find what's making it slow (Processes), open their app (Dev
 * servers), or learn how it works (Help). Connect and Project Sync were tabs
 * until 0.10; both are about other computers, so they now fold out under Dev
 * servers, and a link to either opens Dev servers with that fold-out open.
 * 0.12.1: copying a project isn't about dev servers, so Project Sync folds
 * out on Overview instead, and `sync` links land there.
 * 0.14.0: Dev servers became Workspaces: each workspace's dev servers, disk
 * use and what's safe to clear. Old `servers` links land there.
 */

/** The screen's header title for a tab (0.12.1): "Hosts", "Hosts · Processes". */
export function tabTitle(tab: TabId): string {
  return tab === "overview" ? "Hosts" : `Hosts · ${TAB_LABELS[tab]}`;
}
export const TAB_LABELS: Record<TabId, string> = { overview: "Overview", processes: "Processes", workspaces: "Workspaces", help: "Help" };
export const TAB_IDS = ["overview", "processes", "workspaces", "help"] as const;
export type TabId = (typeof TAB_IDS)[number];

/** The fold-outs that an old tab id or a button can open: on Dev servers, and (0.12.1) Project Sync on Overview. */
export const FOLD_IDS = ["private", "ssh", "links", "sync", "caches", "cleanup"] as const;
export type Fold = (typeof FOLD_IDS)[number];
/** The tab each fold-out lives on. */
export const FOLD_TAB: Record<Fold, TabId> = { private: "workspaces", ssh: "workspaces", links: "workspaces", sync: "overview", caches: "workspaces", cleanup: "workspaces" };

export type TabTarget = { tab: TabId; fold: Fold | null };

/** Old ids from 0.8 to 0.10, and a few plain aliases, to where they live now. */
const LEGACY: Record<string, TabTarget> = {
  health: { tab: "processes", fold: null },
  "daemon-health": { tab: "processes", fold: null },
  connect: { tab: "workspaces", fold: "private" },
  pair: { tab: "workspaces", fold: "private" },
  private: { tab: "workspaces", fold: "private" },
  ssh: { tab: "workspaces", fold: "ssh" },
  browser: { tab: "workspaces", fold: null },
  links: { tab: "workspaces", fold: "links" },
  sync: { tab: "overview", fold: "sync" },
  "project-sync": { tab: "overview", fold: "sync" },
  transfers: { tab: "overview", fold: "sync" },
  "dev-servers": { tab: "workspaces", fold: null },
  // 0.14.0: Dev servers became Workspaces (dev servers, disk use and cleanup per workspace).
  servers: { tab: "workspaces", fold: null },
  disk: { tab: "workspaces", fold: null },
  storage: { tab: "workspaces", fold: null },
  cleanup: { tab: "workspaces", fold: "cleanup" },
  guide: { tab: "help", fold: null },
};

const isTab = (value: string): value is TabId => (TAB_IDS as readonly string[]).includes(value);
const isFold = (value: string): value is Fold => (FOLD_IDS as readonly string[]).includes(value);

/**
 * Where a screen param (`tab`, and optionally `open`) lands. Unknown or
 * missing ids open Overview; `open` only applies on the tab its fold-out is on.
 */
export function resolveTab(tab?: string | null, open?: string | null): TabTarget {
  const wanted = String(tab ?? "").trim().toLowerCase();
  const target: TabTarget = isTab(wanted) ? { tab: wanted, fold: null } : LEGACY[wanted] ?? { tab: "overview", fold: null };
  const fold = String(open ?? "").trim().toLowerCase();
  if (isFold(fold) && FOLD_TAB[fold] === target.tab) return { tab: target.tab, fold };
  return target;
}
