import type { CacheGroup, ClearItem, WorkspaceUsage } from "./disk";
import { runningIn, type ProcessRow } from "./processes";
import { compareResource, matchesResource, type ResourceSort } from "./resource-table";

export type WorkspaceSort = "name" | "disk" | "reclaimable" | "running";
export function workspaceTableRows(workspaces: readonly WorkspaceUsage[], processes: readonly ProcessRow[], query: string, filter: string, sort: ResourceSort<WorkspaceSort>) {
  const value = ({ workspace: w, processes: p }: { workspace: WorkspaceUsage; processes: readonly ProcessRow[] }) =>
    sort.id === "name" ? w.names[0] ?? w.folder : sort.id === "running" ? p.length : w.measured === false ? null : sort.id === "reclaimable" ? w.clearableBytes : w.totalBytes;
  return workspaces.filter((w) => (filter === "all" || w.state === filter) && matchesResource(query, [...w.names, w.project, w.branch, w.folder, w.path]))
    .map((workspace) => ({ workspace, processes: runningIn(processes, workspace) }))
    .sort((a, b) => compareResource(value(a), value(b), sort.direction) || (a.workspace.names[0] ?? a.workspace.folder).localeCompare(b.workspace.names[0] ?? b.workspace.folder) || a.workspace.id.localeCompare(b.workspace.id));
}
export type ItemSort = "name" | "size";
export function itemTableRows(items: readonly ClearItem[], query: string, sort: ResourceSort<ItemSort>) {
  return items.filter((item) => matchesResource(query, [item.name, item.what, item.where, item.path]))
    .sort((a, b) => compareResource(sort.id === "name" ? a.name : a.bytes, sort.id === "name" ? b.name : b.bytes, sort.direction) || a.where.localeCompare(b.where));
}
export function cacheTableRows(groups: readonly CacheGroup[], query: string, filter: string, sort: ResourceSort<ItemSort>) {
  return groups.flatMap((group) => group.items.map((item) => ({ group, item })))
    .filter(({ group, item }) => (filter === "all" || group.id === filter || `type:${item.what}` === filter) && matchesResource(query, [item.name, item.where, item.path, item.what, group.title]))
    .sort((a, b) => compareResource(sort.id === "name" ? a.item.name : a.item.bytes, sort.id === "name" ? b.item.name : b.item.bytes, sort.direction) || a.item.where.localeCompare(b.item.where) || a.group.id.localeCompare(b.group.id));
}
