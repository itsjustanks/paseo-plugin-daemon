import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RawProcess } from "./platform";
import { detectService } from "./heuristics";
import { friendlyPath } from "../shared/paths";
import type { ProcessChat } from "../shared/processes";
import { homeRelative, redactSecrets } from "./redaction";

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
type Program = Pick<RawProcess, "argv" | "comm" | "executable">;
const executableWords = (process: Program) => [process.executable ?? "", process.comm, ...process.argv.slice(0, 4)].map((arg) => arg.split(/[\\/]/).pop()!.toLowerCase());
export function isAgentTool(process: Program): boolean {
  return executableWords(process).some((word) => /^(codex|claude|opencode|aider|gemini|copilot|goose|cursor-agent)(?:\.[cm]?js)?$/.test(word));
}
// Only OS executable identity selects a service family. Runtime argv can then
// identify the service hosted by that runtime; argv never impersonates an exe.
const INFRASTRUCTURE_EXECUTABLES = new Set([
  "postgres", "postmaster", "mysqld", "mariadbd", "redis-server", "valkey-server", "keydb-server",
  "mongod", "mongos", "memcached", "clickhouse", "clickhouse-server", "etcd", "consul", "nomad", "vault",
  "rabbitmq", "rabbitmq-server", "elasticsearch", "opensearch", "kafka", "zookeeper", "minio", "influxd",
  "cassandra", "neo4j", "couchdb", "meilisearch", "typesense-server", "qdrant", "chroma", "ollama",
  "dockerd", "containerd", "podman", "colima", "limactl", "nginx", "httpd", "caddy", "traefik", "haproxy",
  "sshd", "launchd", "cron", "crond", "rsyslogd", "tailscaled", "cloudflared", "1password", "1password-ssh-agent",
  "1passwordsshagent", "op-ssh-agent", "paseo", "agent-browser",
]);
const JAVA_SERVICE_MAIN = /^(?:org\.elasticsearch\.bootstrap\.Elasticsearch|org\.opensearch\.bootstrap\.OpenSearch|kafka\.Kafka|org\.apache\.kafka\.|org\.apache\.zookeeper\.server\.|org\.apache\.cassandra\.service\.CassandraDaemon|org\.neo4j\.(?:server|cli)\.)/;
export function isInfrastructure(process: Pick<RawProcess, "executable" | "argv">): boolean {
  if (!process.executable?.startsWith("/")) return false;
  const executable = process.executable.split("/").pop()!.replace(/ \(deleted\)$/, "").toLowerCase();
  if (INFRASTRUCTURE_EXECUTABLES.has(executable) || /^(?:systemd|containerd-shim|qemu-system)/.test(executable)) return true;
  if (executable === "beam.smp") return process.argv.some((arg) => /rabbit/i.test(arg));
  if (executable === "java") return process.argv.some((arg) => JAVA_SERVICE_MAIN.test(arg));
  if (executable === "op") return process.argv.some((arg, i) => /^(?:--)?ssh-agent$/.test(arg) || (arg === "ssh" && process.argv[i + 1] === "agent"));
  return false;
}

/**
 * How long a passive read (the app's polling: status dot, Overview, Processes,
 * Workspaces) reuses the registry (0.14.0; was 5 s, which re-read
 * `projects.list` and every `workspaces.list` page on almost every poll and
 * showed up as ~110 slow requests an hour on a busy daemon). User actions
 * (Refresh, stop, share, clear, restart) pass `force` and always read fresh.
 */
export const PASSIVE_TTL_MS = 60_000;
/** After a failed read, passive reads wait this long before trying again (forced reads don't). */
export const FAILURE_BACKOFF_MS = 10_000;
/** The longest one registry read (projects plus workspace pages) may take before it counts as failed. */
export const REGISTRY_READ_MS = 20_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The registry read timed out.")), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Registry access uses the plugin's own borrowed SDK session, never browser-supplied paths. */
export class ProjectScope {
  private api?: PaseoApi;
  private roots: Root[] = [];
  /** Every active workspace descriptor from the last read, unfiltered (0.14.0: disk usage reads these). */
  private descriptors: unknown[] = [];
  private agents = new Map<string, ProcessChat>();
  private failedAt = 0;
  private updated = 0;
  private pending?: Promise<void>;
  private failure = "Open Hosts on this host once to load its Paseo projects.";
  private broadRoots = 0;
  constructor(private canonical: (path: string) => Promise<string> = realpath, private home = homedir(), private now = Date.now) {}
  bind(api: PaseoApi) { this.api = api; }

  /**
   * Every active workspace as Paseo describes it (0.14.0, for disk usage):
   * the raw descriptors from the shared registry read, so the Workspaces view
   * adds no daemon calls of its own. `force` reads fresh (a user action).
   */
  async workspaceDescriptors(force = false): Promise<unknown[]> {
    await this.refresh(force);
    return this.descriptors;
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.updated && this.now() - this.updated < PASSIVE_TTL_MS) return;
    if (!this.api) throw new Error(this.failure);
    if (!force && !this.updated && this.failedAt && this.now() - this.failedAt < FAILURE_BACKOFF_MS) throw new Error(this.failure);
    // Bounded (review fix): a stalled daemon can't hold every caller, the disk check included, on one read forever.
    const generation = ++this.generation;
    this.pending = withDeadline(this.load(this.api, generation), REGISTRY_READ_MS).catch(() => {
      this.generation++; // A read that answers after its deadline is dropped, never written over a newer one.
      this.roots = []; this.descriptors = []; this.agents.clear(); this.updated = 0; this.failedAt = this.now();
      this.failure = "Paseo projects could not be verified. Refresh this host; sharing is paused and chat attribution may be missing.";
      throw new Error(this.failure);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Bumped per read; a read whose number is old by the time it answers writes nothing. */
  private generation = 0;

  private async load(api: PaseoApi, generation = this.generation) {
    const projects = (await api.projects.list()).projects;
    const roots: Root[] = projects.map((p) => ({ id: p.projectId, name: p.projectDisplayName, path: p.projectRootPath, workspace: null, servicePorts: [] }));
    let cursor: string | undefined;
    const seen = new Set<string>();
    const descriptors: Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"] = [];
    for (let page = 0; page < 20; page++) {
      const result = await api.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      descriptors.push(...result.entries);
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
    if (generation !== this.generation) throw new Error("A newer registry read replaced this one.");
    const agents = new Map<string, ProcessChat>();
    // Older hosts may lack agents.list. Failure removes attribution, never invents ownership.
    if (typeof api.agents?.list === "function") {
      try {
        let agentCursor: string | undefined;
        const agentCursors = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const result = await api.agents.list({ page: { limit: 100, ...(agentCursor ? { cursor: agentCursor } : {}) } });
          for (const entry of result.entries) {
            const agent: PaseoAgent = entry.agent;
            const workspace = descriptors.find((item) => item.id === agent.workspaceId);
            const directory = workspace?.workspaceDirectory || workspace?.projectRootPath || agent.cwd;
            agents.set(agent.id, {
              id: agent.id, title: redactSecrets(agent.title || `${agent.provider} chat`, this.home), status: redactSecrets(agent.status),
              workspaceId: agent.workspaceId ?? null,
              workspace: workspace ? redactSecrets(workspace.name, this.home) : null,
              project: workspace ? redactSecrets(workspace.projectDisplayName, this.home) : null,
              workspacePath: directory || null,
              where: directory ? redactSecrets(friendlyPath(directory, { home: this.home }).label, this.home) : null,
            });
          }
          if (!result.pageInfo.hasMore) break;
          const next = result.pageInfo.nextCursor;
          if (!next || agentCursors.has(next) || page === 99) throw new Error("Incomplete agent registry");
          agentCursors.add(next); agentCursor = next;
        }
      } catch { agents.clear(); }
    }
    if (generation !== this.generation) throw new Error("A newer registry read replaced this one.");
    this.agents = agents;
    this.descriptors = descriptors;
    this.broadRoots = 0;
    const canonicalRoots = await Promise.all(roots.map(async (root) => {
      if (!isAbsolute(root.path)) return null;
      const path = await this.canonical(root.path).catch(() => null);
      if (!path) return null;
      // A project registered as / or the home directory must not authorize the whole account.
      if (containsDirectory(path, resolve(this.home))) { this.broadRoots++; return null; }
      return { ...root, path };
    }));
    if (generation !== this.generation) throw new Error("A newer registry read replaced this one.");
    this.roots = canonicalRoots.filter((root): root is Root => root !== null).sort((a, b) => b.path.length - a.path.length || Number(!!b.workspace) - Number(!!a.workspace));
    this.updated = this.now(); this.failure = "";
  }

  agent(id: string | null | undefined): ProcessChat | null { return id ? this.agents.get(id) ?? null : null; }

  match(process: Program & Pick<RawProcess, "cwd">, ports: readonly number[] = []): ProjectMatch | null {
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

  /** `force` for a share or a receive (a user action); listing what can be shared reuses the cache. */
  async root(id: string, force = false): Promise<{ id: string; name: string; path: string }> {
    await this.refresh(force);
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
