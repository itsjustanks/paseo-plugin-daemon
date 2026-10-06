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
 */

/** The screen's header title for a tab (0.12.1): "Hosts", "Hosts · Processes". */
export function tabTitle(tab: TabId): string {
  return tab === "overview" ? "Hosts" : `Hosts · ${TAB_LABELS[tab]}`;
}
export const TAB_LABELS: Record<TabId, string> = { overview: "Overview", processes: "Processes", servers: "Dev servers", help: "Help" };
export const TAB_IDS = ["overview", "processes", "servers", "help"] as const;
export type TabId = (typeof TAB_IDS)[number];

/** The fold-outs that an old tab id or a button can open: on Dev servers, and (0.12.1) Project Sync on Overview. */
export const FOLD_IDS = ["private", "ssh", "links", "sync"] as const;
export type Fold = (typeof FOLD_IDS)[number];
/** The tab each fold-out lives on. */
export const FOLD_TAB: Record<Fold, TabId> = { private: "servers", ssh: "servers", links: "servers", sync: "overview" };

export type TabTarget = { tab: TabId; fold: Fold | null };

/** Old ids from 0.8 to 0.10, and a few plain aliases, to where they live now. */
const LEGACY: Record<string, TabTarget> = {
  health: { tab: "processes", fold: null },
  "daemon-health": { tab: "processes", fold: null },
  connect: { tab: "servers", fold: "private" },
  pair: { tab: "servers", fold: "private" },
  private: { tab: "servers", fold: "private" },
  ssh: { tab: "servers", fold: "ssh" },
  browser: { tab: "servers", fold: null },
  links: { tab: "servers", fold: "links" },
  sync: { tab: "overview", fold: "sync" },
  "project-sync": { tab: "overview", fold: "sync" },
  transfers: { tab: "overview", fold: "sync" },
  "dev-servers": { tab: "servers", fold: null },
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
