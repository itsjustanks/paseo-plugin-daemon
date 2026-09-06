import type { PaseoApi } from "@getpaseo/client";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RawProcess } from "./platform";
import { detectService } from "./heuristics";
import { homeRelative } from "./redaction";

export interface ProjectMatch {
  id: string; name: string; path: string; workspace: string | null;
  kind: "dev-server" | "agent" | "project-tool";
  shareable: boolean; canStop: boolean; shareablePorts: number[];
}
type Root = { id: string; name: string; path: string; workspace: string | null; servicePorts: number[] };
export const containsDirectory = (root: string, directory: string) => {
  const rest = relative(root, directory);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const executableWords = (process: RawProcess) => process.argv.slice(0, 4).map((arg) => arg.split(/[\\/]/).pop()!.toLowerCase());
export function isAgentTool(process: RawProcess): boolean {
  return executableWords(process).some((word) => /^(codex|claude|opencode|aider|gemini|copilot|goose|cursor-agent)(?:\.[cm]?js)?$/.test(word));
}
export function isInfrastructure(process: RawProcess): boolean {
  return executableWords(process).some((word) => /^(postgres|postmaster|redis-server|mongod|mysqld|sshd|systemd|cloudflared|paseo|agent-browser)(?:[ .-]|$)/.test(word));
}

/** Registry access uses the plugin's own borrowed SDK session, never browser-supplied paths. */
export class ProjectScope {
  private api?: PaseoApi;
  private roots: Root[] = [];
  private updated = 0;
  private pending?: Promise<void>;
  private failure = "Open Daemon Link on this host once to load its Paseo projects.";
  private broadRoots = 0;
  constructor(private canonical: (path: string) => Promise<string> = realpath, private home = homedir(), private now = Date.now) {}
  bind(api: PaseoApi) { this.api = api; }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.updated && this.now() - this.updated < 5000) return;
    if (!this.api) throw new Error(this.failure);
    this.pending = this.load(this.api).catch(() => {
      this.roots = []; this.updated = 0;
      this.failure = "Paseo projects could not be verified. Refresh this host; sharing and process controls are paused.";
      throw new Error(this.failure);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(api: PaseoApi) {
    const projects = (await api.projects.list()).projects;
    const roots: Root[] = projects.map((p) => ({ id: p.projectId, name: p.projectDisplayName, path: p.projectRootPath, workspace: null, servicePorts: [] }));
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await api.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const workspace of result.entries) {
        if (workspace.archivingAt || !projects.some((project) => project.projectId === workspace.projectId)) continue;
        roots.push({ id: workspace.projectId, name: workspace.projectDisplayName, path: workspace.workspaceDirectory || workspace.projectRootPath, workspace: workspace.name,
          servicePorts: workspace.scripts.filter((script) => script.type === "service" && script.lifecycle === "running" && script.port !== null).map((script) => script.port!) });
      }
      if (!result.pageInfo.hasMore) break;
      const next = result.pageInfo.nextCursor;
      if (!next || seen.has(next) || page === 19) throw new Error("Incomplete workspace registry");
      seen.add(next); cursor = next;
    }
    this.broadRoots = 0;
    const canonicalRoots = await Promise.all(roots.map(async (root) => {
      if (!isAbsolute(root.path)) return null;
      const path = await this.canonical(root.path).catch(() => null);
      if (!path) return null;
      // A project registered as / or the home directory must not authorize the whole account.
      if (containsDirectory(path, resolve(this.home))) { this.broadRoots++; return null; }
      return { ...root, path };
    }));
    this.roots = canonicalRoots.filter((root): root is Root => root !== null).sort((a, b) => b.path.length - a.path.length || Number(!!b.workspace) - Number(!!a.workspace));
    this.updated = this.now(); this.failure = "";
  }

  match(process: RawProcess, ports: readonly number[] = []): ProjectMatch | null {
    if (!process.cwd || !isAbsolute(process.cwd) || isInfrastructure(process)) return null;
    const candidates = this.roots.filter((candidate) => containsDirectory(candidate.path, process.cwd!));
    const root = candidates.find((candidate) => ports.some((port) => candidate.servicePorts.includes(port))) || candidates[0];
    if (!root) return null;
    const agent = isAgentTool(process);
    const knownServer = detectService(process.argv, [...ports])?.kind === "dev-server";
    const shareablePorts = agent ? [] : ports.filter((port) => ![9222, 9229, 9230].includes(port) && (knownServer || root.servicePorts.includes(port)));
    const service = shareablePorts.length > 0;
    return { id: root.id, name: root.name, path: homeRelative(root.path, this.home), workspace: root.workspace,
      kind: agent ? "agent" : service ? "dev-server" : "project-tool", shareable: service, canStop: service, shareablePorts };
  }

  async root(id: string): Promise<{ id: string; name: string; path: string }> {
    await this.refresh();
    const root = this.roots.find((item) => item.id === id && item.workspace === null) || this.roots.find((item) => item.id === id);
    if (!root) throw new Error("This project is no longer registered on this host.");
    return { id: root.id, name: root.name, path: root.path };
  }

  status() {
    const projects = [...new Map(this.roots.map((root) => [root.id, { id: root.id, name: root.name, path: homeRelative(root.path, this.home) }])).values()];
    return { status: this.failure ? "unavailable" as const : "ready" as const, projects,
      message: this.failure || (this.broadRoots ? "Broad home/root projects are excluded. Register each project directory separately." : "Verified against this host's Paseo projects and workspaces.") };
  }
}
