import { basename } from "node:path";
import { homeRelative } from "../shared/redaction";
import type { ArchivedLeftover } from "../shared/health";
import type { ProcessReport, ReportInput } from "../shared/processes";

/**
 * Dev servers an archived workspace left running (0.15.0). Paseo's
 * `workspace.archived` hook tells Hosts a workspace was archived; for a day
 * after, each health check looks in its folder for processes still
 * listening on a port. Hosts only reports them: stopping one is the usual
 * ask-first Stop, never automatic. In memory only (a daemon restart forgets).
 */

export const ARCHIVED_WATCH_MS = 24 * 60 * 60_000;
/** Paseo may still be closing the workspace's own terminals just after archiving. */
export const ARCHIVED_GRACE_MS = 30_000;
const ARCHIVED_MAX = 10;
/** The process report's query is at most 120 characters. */
const QUERY_MAX = 120;

interface Archived { id: string; name: string; folder: string; at: number }

export class ArchivedWorkspaces {
  private items: Archived[] = [];
  constructor(private readonly home: string, private readonly now: () => number = Date.now) {}

  /** From the hook: fast, never throws, never blocks the archive. */
  record(workspace: { id?: unknown; name?: unknown; cwd?: unknown }): void {
    const cwd = typeof workspace.cwd === "string" ? workspace.cwd.replace(/\/+$/, "") : "";
    if (!cwd.startsWith("/") || cwd === "/" || cwd === this.home) return;
    const id = typeof workspace.id === "string" ? workspace.id : cwd;
    const name = typeof workspace.name === "string" && workspace.name.trim() ? workspace.name.trim().slice(0, 80) : basename(cwd);
    this.prune();
    this.items = [...this.items.filter((item) => item.id !== id), { id, name, folder: homeRelative(cwd, this.home), at: this.now() }].slice(-ARCHIVED_MAX);
  }

  get size(): number { this.prune(); return this.items.length; }

  /** Processes still listening in an archived workspace's folder, from the process report (same rows as Processes). */
  async leftovers(report: (input: ReportInput) => Promise<ProcessReport>): Promise<ArchivedLeftover[]> {
    this.prune();
    const out: ArchivedLeftover[] = [];
    const seen = new Set<number>();
    for (const item of this.items) {
      if (this.now() - item.at < ARCHIVED_GRACE_MS) continue;
      const query = item.folder.length <= QUERY_MAX ? item.folder : basename(item.folder).slice(0, QUERY_MAX);
      const found = await report({ query, filter: "all", sort: "memory", limit: 50, offset: 0 }).catch(() => null);
      for (const row of found?.processes ?? []) {
        if (seen.has(row.pid) || !row.ports.length || !row.cwd || !within(row.cwd, item.folder)) continue;
        seen.add(row.pid);
        out.push({ pid: row.pid, name: row.name, ports: row.ports, cwd: row.cwd, stoppable: row.stoppable, workspace: item.name });
      }
    }
    return out;
  }

  private prune(): void {
    const now = this.now();
    this.items = this.items.filter((item) => now - item.at < ARCHIVED_WATCH_MS);
  }
}

const within = (cwd: string, folder: string) => cwd === folder || cwd.startsWith(`${folder}/`);
