import type { ProcessRow } from "./processes";
import type { WorkspaceUsage } from "./disk";
import { cwdWithinDirectory } from "./workspace-filter";
import { compareResource, matchesResource, type ResourceSort } from "./resource-table";

/** OS sleep means the process is waiting for work, not that a listening server is offline. */
export function processStateWords(state: string, ports: readonly number[] = []): string {
  const value = state.toLowerCase();
  if (value === "sleeping" || value === "s" || value === "idle" || value === "i") return ports.length ? "Listening · waiting for requests" : "Waiting for work";
  if (value === "running" || value === "r") return ports.length ? "Listening · active" : "Running";
  if (value === "disk-wait" || value === "d" || value === "u") return "Waiting for disk or I/O";
  if (value === "stopped" || value === "t") return "Paused";
  if (value === "zombie" || value === "z") return "Exited · awaiting cleanup";
  return ports.length ? "Listening · activity unknown" : "Activity unknown";
}

export interface InventoryService {
  pid: number; name: string; cpuPercent: number | null; rssBytes: number; cwd: string | null; state: string; ports: readonly number[];
  classification: { label: string };
  actionable?: boolean; actionToken?: string | null;
  project?: { name: string; workspace: string | null } | null;
}
export interface ServiceInventoryRow<T extends InventoryService = InventoryService> {
  service: T; hasWorkspace: boolean; workspace: string; project: string; ownership: string; chatId?: string; status: string;
}
export type ServiceFilter = "all" | "can-stop" | "no-workspace";
export type ServiceSort = "workspace" | "project" | "app" | "ports" | "status" | "cpu" | "memory";

/** Display attribution only. A folder or chat match never grants Stop or port-sharing authority. */
export function serviceInventory<T extends InventoryService>(services: readonly T[], processes: readonly ProcessRow[], workspaces: readonly WorkspaceUsage[] = []): ServiceInventoryRow<T>[] {
  return services.map((service) => {
    const process = processes.find((row) => row.pid === service.pid && row.name === service.name);
    const matches = workspaces.filter((workspace) => cwdWithinDirectory(service.cwd, workspace.path ?? workspace.folder));
    // Ambiguous folder matches stay unknown rather than choosing a convenient owner.
    const disk = matches.length === 1 ? matches[0] : undefined;
    const workspace = process?.chat?.workspace ?? service.project?.workspace ?? process?.owner.workspace ?? (disk?.names.length ? disk.names.join(", ") : null);
    const project = process?.chat?.project ?? service.project?.name ?? process?.owner.project ?? disk?.project;
    return { service, hasWorkspace: !!workspace, workspace: workspace || "No workspace identified", project: project || "No project identified",
      ownership: process?.chat ? `Tagged by chat ${process.chat.title}` : workspace ? "Folder association · no chat identified" : "Owner unknown · no chat identified",
      chatId: process?.chat?.id, status: processStateWords(service.state, service.ports) };
  });
}
export function serviceTableRows<T extends InventoryService>(rows: readonly ServiceInventoryRow<T>[], query: string, sort: ResourceSort<ServiceSort>, filter: ServiceFilter = "all") {
  const value = (row: ServiceInventoryRow<T>) => sort.id === "workspace" ? row.workspace : sort.id === "project" ? row.project : sort.id === "app" ? row.service.classification.label + row.service.name : sort.id === "memory" ? row.service.rssBytes : sort.id === "cpu" ? row.service.cpuPercent : sort.id === "ports" ? row.service.ports[0] ?? null : row.status;
  return rows.filter((row) => (filter === "all" || (filter === "can-stop" ? !!row.service.actionable && !!row.service.actionToken : !row.hasWorkspace)) && matchesResource(query, [row.workspace, row.project, row.ownership, row.service.name, row.service.classification.label, row.service.cwd, ...row.service.ports.map(String)]))
    .sort((a, b) => compareResource(value(a), value(b), sort.direction) || a.service.pid - b.service.pid);
}
