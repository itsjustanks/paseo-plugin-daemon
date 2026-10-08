import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { homeRelative } from "../shared/redaction";
import type { ArchivedLeftover } from "../shared/health";
import { REPORT_LIMIT_MAX, type ProcessReport, type ReportInput } from "../shared/processes";

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
/** Pages read per folder per check (review fix: a listener isn't hidden behind heavier matches). */
const PAGES_MAX = 20;

/** `folders`: the folder as Paseo gave it and, once known, its real path (the kernel reports real paths). */
interface Archived { id: string; name: string; folders: string[]; at: number }

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
    const item: Archived = { id, name, folders: [homeRelative(cwd, this.home)], at: this.now() };
    this.items = [...this.items.filter((entry) => entry.id !== id), item].slice(-ARCHIVED_MAX);
    // The real path is looked up after the hook has returned, and a failure just keeps the given folder.
    void this.resolve(cwd).then((real) => {
      const folder = real && real !== "/" && real !== this.home ? homeRelative(real, this.home) : null;
      if (folder && !item.folders.includes(folder)) item.folders.push(folder);
    }).catch(() => undefined);
  }

  /** The canonical path (symlinks resolved), or null. Overridable for tests. */
  protected resolve(cwd: string): Promise<string | null> { return realpath(cwd).then((path) => path.replace(/\/+$/, ""), () => null); }

  get size(): number { this.prune(); return this.items.length; }

  /** Processes still listening in an archived workspace's folder, from the process report (same rows as Processes). */
  async leftovers(report: (input: ReportInput) => Promise<ProcessReport>): Promise<ArchivedLeftover[]> {
    this.prune();
    const out: ArchivedLeftover[] = [];
    const seen = new Set<number>();
    for (const item of this.items) {
      if (this.now() - item.at < ARCHIVED_GRACE_MS) continue;
      for (const folder of item.folders) {
        const query = folder.length <= QUERY_MAX ? folder : basename(folder).slice(0, QUERY_MAX);
        for (let page = 0, offset = 0; page < PAGES_MAX; page += 1) {
          const found = await report({ query, filter: "all", sort: "memory", limit: REPORT_LIMIT_MAX, offset }).catch(() => null);
          const rows = found?.processes ?? [];
          for (const row of rows) {
            if (seen.has(row.pid) || !row.ports.length || !row.cwd || !within(row.cwd, folder)) continue;
            seen.add(row.pid);
            out.push({ pid: row.pid, name: row.name, ports: row.ports, cwd: row.cwd, stoppable: row.stoppable, workspace: item.name });
          }
          offset += rows.length;
          if (!rows.length || rows.length < REPORT_LIMIT_MAX || offset >= (found?.matched ?? 0)) break;
        }
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
