import { chatAttribution, chatGroups } from "../shared/processes";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago, diskClearStatus, diskLeftoverDismiss, diskReport, formatSize, stateWords, type CacheGroup, type ClearItem, type DiskJob, type DiskReport, type DiskSpace, type WorkspaceUsage } from "../shared/disk";
import { runningIn, type ProcessRow } from "../shared/processes";
import { ClearResults } from "./clear";
import { useSafeToast } from "./feedback";
import { StopProcess } from "./guard";
import { AskAgentButton, OpenChatButton } from "./ask";
import { PathDetails, PathLabel } from "./paths";
import { friendlyPath } from "../shared/paths";
import { Button, Card, Divider, ItemTitle, Meta, Note, Row, SectionTitle, SPACE, TYPE, type Tone } from "./kit";
import { nextResourceSort, type ResourceSort } from "../shared/resource-table";
import { cacheTableRows, itemTableRows, workspaceTableRows, type ItemSort, type WorkspaceSort } from "../shared/disk-tables";
import { ResourceCells, ResourceHeader, ResourceTable, ResourceToolbar, type ResourceColumn } from "./resource-table";
import { Meter, type Say } from "./processes";

type Theme = PluginTheme;

/**
 * Workspaces combines process attribution with the last measured disk report.
 * Search, filters and sorting are local and never start another disk scan.
 * Tool-managed workspace deletion still uses reviewed tokens and confirmation;
 * shared caches and ambiguous contents retain their Ask an agent action.
 */

export const diskKey = (hostId: string) => ["daemon-link", hostId, "disk"] as const;

const DISK_TONE: Record<DiskSpace["level"], Tone> = { ok: "success", warning: "warning", critical: "danger" };
/** The one sentence beside every clean-up button. */
export const AGENT_PROMISE = "An agent will check nothing's in use or unsaved, then clear it. You see the message before it's sent.";

const size = (bytes: number, partial = false) => `${partial ? "at least " : ""}${formatSize(bytes)}`;
/** What clearing an item would free: bytes not shared with pnpm's store. */
const frees = (item: ClearItem) => Math.max(0, item.bytes - item.sharedBytes);

/** The report, polled quickly while a check runs and slowly otherwise, only while `enabled` (Workspaces showing). `scan()` starts a check. */
export function useDiskReport(hostId: string, enabled = true) {
  const read = useRpc(diskReport);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: diskKey(hostId), queryFn: () => read({}), retry: 1, enabled,
    refetchInterval: (state) => (state.state.data?.scan.state === "running" ? 4000 : 60_000),
  });
  const scan = useMutation({ mutationFn: () => read({ scan: true }), onSuccess: (report) => client.setQueryData(diskKey(hostId), report) });
  return { query, report: query.data, scan };
}

/** What looks safe to clear in idle workspaces (no agent working, no dev server), and how many workspaces it's in. */
export function idleClearable(report: DiskReport | undefined): { workspaces: number; bytes: number } {
  const idle = (report?.workspaces ?? []).filter((workspace) => !workspace.busy && workspace.clearableBytes > 0);
  return { workspaces: idle.length, bytes: idle.reduce((sum, workspace) => sum + workspace.clearableBytes, 0) };
}

export function cacheBytes(report: DiskReport | undefined): number {
  return (report?.caches ?? []).flatMap((group) => group.items).reduce((sum, item) => sum + item.bytes, 0);
}

/**
 * What interrupted deletes left (0.16.0 review fix): each with its plain
 * sentence and Ask an agent; a "may be incomplete" note stays until the
 * person dismisses it. Hosts deletes none of it by itself.
 */
function Leftovers({ theme, report }: { theme: Theme; report: DiskReport }) {
  const dismiss = useRpc(diskLeftoverDismiss);
  const client = useQueryClient();
  const toast = useSafeToast();
  return (
    <View style={{ gap: SPACE.row }}>
      <ItemTitle theme={theme}>Left over from an interrupted delete</ItemTitle>
      {(report.leftovers ?? []).map((leftover) => (
        <View key={leftover.id} style={{ gap: SPACE.sm }}>
          <Note theme={theme} tone={leftover.state === "incomplete" ? "danger" : "warning"}>{leftover.message ?? `Left over from an interrupted delete: ${leftover.where}`}</Note>
          <Meta theme={theme}>{`${formatSize(leftover.bytes)} when it was set aside · ${ago(leftover.at)}`}</Meta>
          <Row>
            <AskAgentButton theme={theme} subject={{ kind: "folder", id: leftover.id }} />
            {leftover.state === "incomplete" ? <Button theme={theme} label="Dismiss" accessibilityLabel={`Dismiss the note about ${leftover.where}`} onPress={() => void dismiss({ id: leftover.id }).then((result) => { if (!result.ok) toast.show("That note couldn't be dismissed. Check disk space again.", { variant: "warning" }); void client.invalidateQueries({ queryKey: ["daemon-link"] }); })} /> : null}
          </Row>
        </View>
      ))}
    </View>
  );
}

/** Status first: the disk, what looks safe to clear, and the check's age. */
export function DiskCard({ theme, report, loading, scanning, onScan, onCaches, askNow, onAsked, onDelete }: {
  theme: Theme; report: DiskReport | undefined; loading: boolean; scanning: boolean; onScan(): void; onCaches(): void;
  /** 0.16.0: one-press Delete for what looks safe in idle workspaces (a warning first). */
  onDelete?(tokens: string[]): void;
  /** "Clean up disk space" (Command Center, `/disk clean`): open the ask sheet as soon as there's something to ask about. */
  askNow?: boolean; onAsked?(): void;
}) {
  const disk = report?.disks[0] ?? null;
  const scan = report?.scan;
  const running = scan?.state === "running" || scanning;
  const idle = idleClearable(report);
  const idleItems = (report?.workspaces ?? []).filter((workspace) => !workspace.busy).flatMap((workspace) => workspace.items.filter((item) => item.safe && item.token));
  const idleTokens = idleItems.map((item) => item.token!);
  const idleTokenBytes = idleItems.reduce((sum, item) => sum + frees(item), 0);
  const caches = cacheBytes(report);
  return (
    <Card theme={theme} title="Disk space" icon="HardDrive" tone={disk ? DISK_TONE[disk.level] : "accent"} subtitle={report && report.disks.length > 1 ? `${report.disks.length} disks hold your workspaces; the fullest is shown` : undefined}>
      {disk ? (
        <View style={{ gap: SPACE.xs }}>
          <Text style={{ ...TYPE.figure, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>{`${formatSize(disk.freeBytes)} free`}</Text>
          <Meter theme={theme} percent={disk.percent} tone={DISK_TONE[disk.level]} />
          <Meta theme={theme}>{`${Math.round(disk.percent)}% of ${formatSize(disk.totalBytes)} used`}</Meta>
          {disk.sentence ? <Note theme={theme} tone={DISK_TONE[disk.level]}>{disk.sentence}</Note> : null}
        </View>
      ) : <Meta theme={theme}>{loading ? "Checking…" : "This disk's size couldn't be read."}</Meta>}
      {report?.journalProblem ? <Note theme={theme} tone="danger">{report.journalProblem}</Note> : null}
      {report?.leftovers?.length ? <Leftovers theme={theme} report={report} /> : null}
      <Divider theme={theme} />
      {running ? (
        <View style={{ gap: SPACE.xs }}>
          <Row>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={{ ...TYPE.body, color: theme.colors.foreground, flexShrink: 1 }}>{scan && scan.total ? `Checking what's using space… ${scan.done} of ${scan.total} folders` : "Checking what's using space…"}</Text>
          </Row>
          <Meta theme={theme}>It runs quietly in the background and takes a minute or two. You can leave this page.</Meta>
        </View>
      ) : !scan || scan.state === "never" ? (
        <View style={{ gap: SPACE.sm }}>
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>Hosts hasn't looked inside your workspaces yet. Checking finds build files, installed packages and caches that are usually safe to clear. It reads a lot of files, so it only runs when you ask.</Text>
          <Row><Button theme={theme} label="Check disk space" icon="ScanSearch" primary busy={scanning} onPress={onScan} /></Row>
        </View>
      ) : (
        <View style={{ gap: SPACE.row }}>
          <View style={{ gap: SPACE.sm }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{idle.bytes > 0 ? `About ${formatSize(idle.bytes)} looks safe to clear in ${idle.workspaces} idle workspace${idle.workspaces === 1 ? "" : "s"}.` : "Nothing looks safe to clear in your idle workspaces right now."}</Text>
            {idle.bytes > 0 ? (
              <>
                <Row>
                  {onDelete && idleTokens.length ? <Button theme={theme} label={`Delete ${formatSize(idleTokenBytes)} in idle workspaces…`} icon="Trash2" danger accessibilityLabel={`Delete ${idleTokens.length} build folders in idle workspaces. Shows a warning first.`} onPress={() => onDelete(idleTokens)} /> : null}
                  <AskAgentButton theme={theme} subject={{ kind: "cleanup", id: "idle" }} label="Ask an agent to clean this up" primary={!onDelete || !idleTokens.length} openNow={askNow} onOpened={onAsked} />
                </Row>
                <Meta theme={theme}>{onDelete && idleTokens.length ? "Delete shows exactly what goes, checked again just before, and asks first. An agent can do it instead." : AGENT_PROMISE}</Meta>
              </>
            ) : null}
          </View>
          {caches > 0 ? (
            <View style={{ gap: SPACE.sm }}>
              <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${formatSize(caches)} more in shared caches and temporary files.`}</Text>
              <Row>
                <Button theme={theme} label="Review caches" icon="Archive" onPress={onCaches} />
                {/* "Clean up disk space" with nothing safe in idle workspaces: the caches are the biggest thing left to ask about. */}
                {askNow && idle.bytes === 0 ? <AskAgentButton theme={theme} subject={{ kind: "cleanup", id: "caches" }} label="Ask an agent to clean these up" openNow onOpened={onAsked} /> : null}
              </Row>
            </View>
          ) : null}
          <Meta theme={theme}>{`Checked ${scan.finishedAt ? ago(scan.finishedAt) : "just now"}. Press Refresh at the top to check again.`}</Meta>
          {scan.partial && scan.message ? <Meta theme={theme}>{scan.message}</Meta> : null}
        </View>
      )}
      {report?.warnings.map((warning) => <Meta key={warning} theme={theme}>{warning}</Meta>)}
    </Card>
  );
}

/** One found folder inside a workspace: what it is, where, its size, and why not when it doesn't look safe. */
/** One found folder: what it is and its size; tap to see where it is in full, with Copy path (0.15.0). */
function ItemLine({ theme, item, owner, compact }: { theme: Theme; item: ClearItem; owner: string | null; compact: boolean }) {
  const [open, setOpen] = React.useState(false);
  const shared = item.sharedBytes > 0 && item.sharedBytes >= item.bytes * 0.2;
  const label = owner ? `${owner} · ${item.where}` : item.where;
  return (
    <View style={{ gap: SPACE.hair }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${item.what}, ${size(item.bytes, item.partial)}. ${open ? "Hide" : "Show"} where it is`} onPress={() => setOpen(!open)} style={{ gap: SPACE.hair }}>
        <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{item.name}</Text>
        <PathLabel theme={theme} compact={compact} label={label} />
        <Meta theme={theme}>{[item.blocked ?? item.cost, shared ? `${formatSize(item.sharedBytes)} of it is shared with pnpm's store, so clearing frees about ${formatSize(frees(item))}` : null].filter(Boolean).join(" · ")}</Meta>
      </Pressable>
      {open ? <PathDetails theme={theme} full={item.path ?? item.where} /> : null}
    </View>
  );
}

const TABLE_PAGE = 25;
const WORKSPACE_COLUMNS: readonly ResourceColumn[] = [
  { id: "name", label: "Workspace / project", weight: 2.5, sortable: true },
  { id: "state", label: "Status", weight: 1.3 },
  { id: "disk", label: "Total disk", sortable: true, compactInline: true, numeric: true },
  { id: "reclaimable", label: "Reclaimable", sortable: true, compactInline: true, numeric: true },
  { id: "running", label: "Running", sortable: true, compactInline: true },
  { id: "actions", label: "Actions", width: 240 },
];
const ITEM_COLUMNS: readonly ResourceColumn[] = [
  { id: "name", label: "Name / path", weight: 3, sortable: true },
  { id: "type", label: "Type / group", weight: 2 },
  { id: "size", label: "Size", sortable: true, numeric: true },
  { id: "actions", label: "Actions", width: 200 },
];
const OUTPUT_COLUMNS = ITEM_COLUMNS.filter((column) => column.id !== "actions");
function TablePages({ theme, count, page, onPage }: { theme: Theme; count: number; page: number; onPage(page: number): void }) {
  return <Row><Meta theme={theme}>{`${count ? page * TABLE_PAGE + 1 : 0}–${Math.min(count, (page + 1) * TABLE_PAGE)} of ${count}`}</Meta>
    {page > 0 ? <Button theme={theme} label="Previous page" onPress={() => onPage(page - 1)} /> : null}
    {(page + 1) * TABLE_PAGE < count ? <Button theme={theme} label="Next page" onPress={() => onPage(page + 1)} /> : null}
  </Row>;
}

/** Search only the last measured output list; it never initiates a disk check. */
function BuildOutputList({ theme, items, owner, compact }: { theme: Theme; items: readonly ClearItem[]; owner: string | null; compact: boolean }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ResourceSort<ItemSort>>({ id: "size", direction: "desc" });
  const [page, setPage] = useState(0);
  const rows = itemTableRows(items, search, sort);
  const shownPage = Math.min(page, Math.max(0, Math.ceil(rows.length / TABLE_PAGE) - 1));
  return <View style={{ gap: SPACE.sm }}>
    {items.length > 3 ? <ResourceToolbar theme={theme} label="Search build outputs" search={search} onSearch={(text) => { setSearch(text); setPage(0); }} /> : null}
    <ResourceTable theme={theme} compact={compact} header={(narrow) => <ResourceHeader theme={theme} columns={OUTPUT_COLUMNS} compact={narrow} sort={sort} onSort={(id) => { setSort(nextResourceSort(sort, id as ItemSort)); setPage(0); }} />}>{(narrow) => <>
      {rows.slice(shownPage * TABLE_PAGE, (shownPage + 1) * TABLE_PAGE).map((item) => <View key={item.path ?? item.where} style={{ paddingVertical: SPACE.sm }}><ResourceCells theme={theme} columns={OUTPUT_COLUMNS} compact={narrow} cells={{
        name: <ItemLine theme={theme} item={item} owner={owner} compact={narrow} />,
        type: <Meta theme={theme}>{item.what}</Meta>, size: <Note theme={theme}>{size(item.bytes, item.partial)}</Note>,
      }} /></View>)}
    </>}</ResourceTable>
    {!rows.length ? <Note theme={theme}>No build outputs match. Clear the search to see the measured folders.</Note> : null}
    {rows.length > TABLE_PAGE ? <TablePages theme={theme} count={rows.length} page={shownPage} onPage={setPage} /> : null}
  </View>;
}

/** One workspace folder: its row's summary says it all; opening shows where, what's in it, and Ask an agent. */
/** What a workspace is running now (0.16.0), from the same list as Processes: heaviest first, each with ask-first Stop. */
export function RunningHere({ theme, rows, say }: { theme: Theme; rows: readonly ProcessRow[]; say: Say }) {
  if (!rows.length) return <Meta theme={theme}>Nothing is running in this workspace.</Meta>;
  return (
    <View style={{ gap: SPACE.sm }}>
      {chatGroups(rows).map((chat) => (
        <View key={chat.id} style={{ gap: SPACE.sm }}>
          <ItemTitle theme={theme}>{chat.title}</ItemTitle>
          {chat.rows.map((row) => (
            <View key={row.pid} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACE.sm }}>
              <View style={{ flex: 1, minWidth: 180, gap: SPACE.hair }}>
                <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${row.name}${row.job ? ` · ${row.job.label}` : ""}`}</Text>
                <Meta theme={theme}>{chatAttribution(row)}</Meta>
                {!row.stoppable ? <Text style={{ ...TYPE.secondary, color: theme.colors.foreground }}>{row.protectedReason ?? "It can't be stopped here."}</Text> : null}
                <Meta theme={theme}>{[formatSize(row.rssBytes), row.cpuPercent === null ? null : `${Math.round(row.cpuPercent)}% CPU`, row.ports.length ? row.ports.map((port) => `:${port}`).join(" ") : null, row.flags[0]?.text ?? null].filter(Boolean).join(" · ")}</Meta>
              </View>
              <OpenChatButton theme={theme} agentId={row.chat?.id} />
              {row.stoppable ? <StopProcess theme={theme} pid={row.pid} say={say} /> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * One workspace (0.16.0: the one place to manage it). Collapsed: one line
 * (name · status · size · N running). Open: its status, what's running here
 * with ask-first Stop, its disk with one-press Delete (a warning first) for
 * the build folders that look safe, the last clear's results, and Ask an agent.
 */
export function WorkspaceRow({ theme, compact, workspace, checking, processes = [], say = () => undefined, onDelete, onWatchBrowser, job = null }: {
  theme: Theme; compact: boolean; workspace: WorkspaceUsage; checking: boolean; onWatchBrowser?(workspaceId: string): void;
  processes?: readonly ProcessRow[]; say?: Say; onDelete?(tokens: string[]): void; job?: DiskJob | null;
}) {
  const [open, setOpen] = useState(false);
  const linked = workspace.state !== "unlinked";
  const title = linked ? `${workspace.names[0]}${workspace.names.length > 1 ? ` +${workspace.names.length - 1}` : ""}` : "Not linked to a workspace";
  const label = workspace.names[0] ?? friendlyPath(workspace.folder).label;
  const tokens = workspace.items.filter((item) => item.safe && item.token).map((item) => item.token!);
  const deletable = workspace.items.filter((item) => item.safe && item.token).reduce((sum, item) => sum + frees(item), 0);
  return (
    <View style={{ borderBottomWidth: 1, borderColor: theme.colors.border, paddingVertical: SPACE.row, gap: SPACE.row }}>
      <ResourceCells theme={theme} columns={WORKSPACE_COLUMNS} compact={compact} cells={{
        name: <View style={{ gap: SPACE.xs, minWidth: 0 }}><ItemTitle theme={theme}>{title}</ItemTitle>
          {workspace.project ? <Meta theme={theme}>{workspace.project}</Meta> : null}
          <PathLabel theme={theme} compact={compact} label={friendlyPath(workspace.folder).label} />
        </View>,
        state: <Meta theme={theme}>{stateWords(workspace.state, workspace.activeAt)}</Meta>,
        disk: <Note theme={theme}>{workspace.measured === false ? checking ? "Checking…" : "Not checked" : size(workspace.totalBytes, workspace.partial)}</Note>,
        reclaimable: <Note theme={theme}>{workspace.measured === false ? "Not checked" : size(workspace.clearableBytes, workspace.partial)}</Note>,
        running: <Note theme={theme}>{String(processes.length)}</Note>,
        actions: <Row><Button theme={theme} label={open ? "Hide details" : "Details"} accessibilityLabel={`${open ? "Hide details" : "Details"} for ${label}`} onPress={() => setOpen(!open)} />{onWatchBrowser ? workspace.workspaceIds?.map((id, index) => <Button key={id} theme={theme} icon="Globe" label={workspace.workspaceIds!.length > 1 ? `Watch ${workspace.names[index] ?? "workspace"} browser` : "Watch browser"} accessibilityLabel={`Watch agent browser in ${workspace.names[index] ?? label}`} onPress={() => onWatchBrowser(id)} />) : null}</Row>,
      }} />
      {open ? <View style={{ gap: SPACE.row }}>
        <View style={{ gap: SPACE.xs }}>
          <Meta theme={theme}>{[stateWords(workspace.state, workspace.activeAt), workspace.branch ? `branch ${workspace.branch}` : null, workspace.project ? `project ${workspace.project}` : null, workspace.worktree ? "a Paseo worktree" : null].filter(Boolean).join(" · ")}</Meta>
          {workspace.names.length > 1 ? <Meta theme={theme}>{`Used by ${workspace.names.length} workspaces: ${workspace.names.join(", ")}`}</Meta> : null}
          <PathLabel theme={theme} compact={compact} prefix="Folder " label={friendlyPath(workspace.folder).label} />
          <PathDetails theme={theme} full={workspace.path ?? workspace.folder} />
        </View>
        <View style={{ gap: SPACE.sm }}>
          <ItemTitle theme={theme}>{processes.length ? `Running here · ${processes.length}` : "Running here"}</ItemTitle>
          <RunningHere theme={theme} rows={processes} say={say} />
        </View>
        <View style={{ gap: SPACE.sm }}>
          <ItemTitle theme={theme}>{workspace.measured === false ? "Disk" : `Disk · ${size(workspace.totalBytes, workspace.partial)}`}</ItemTitle>
          {workspace.busy ? <Note theme={theme} tone="warning">{workspace.busy}</Note> : null}
          {!linked && workspace.worktree ? (
            <View style={{ gap: SPACE.sm }}>
              <Note theme={theme}>No Paseo workspace uses this worktree any more, probably because its workspace was archived. It may hold work that isn't pushed, so an agent should check it before it's removed.</Note>
              <Row><AskAgentButton theme={theme} subject={{ kind: "folder", id: workspace.id }} /></Row>
            </View>
          ) : null}
          {workspace.skipped ? <Meta theme={theme}>The last check ran out of time before it reached this folder. Press Refresh at the top to check again.</Meta> : null}
          {workspace.items.length ? (
            <BuildOutputList theme={theme} items={workspace.items} owner={workspace.names[0] ?? null} compact={compact} />
          ) : workspace.measured === false ? (checking ? <Meta theme={theme}>Checking this folder…</Meta> : null) : <Meta theme={theme}>No build files, installed packages or test reports here.</Meta>}
          {tokens.length && onDelete && !workspace.busy ? (
            <View style={{ gap: SPACE.xs }}>
              <Row>
                <Button theme={theme} label={`Delete ${tokens.length} folder${tokens.length === 1 ? "" : "s"} (${formatSize(deletable)})…`} icon="Trash2" danger accessibilityLabel={`Delete ${tokens.length} build folder${tokens.length === 1 ? "" : "s"} in ${label}. Shows a warning first.`} onPress={() => onDelete(tokens)} />
                <AskAgentButton theme={theme} subject={{ kind: "cleanup", id: workspace.id }} label="Ask an agent instead" />
              </Row>
              <Meta theme={theme}>Shows exactly what goes, checked again just before, and asks first. Only folders a tool makes and manages are deleted; ask an agent about the rest.</Meta>
            </View>
          ) : (workspace.clearableBytes > 0 || workspace.items.some((item) => item.askOnly && item.bytes > 0)) && !workspace.busy ? (
            <View style={{ gap: SPACE.xs }}>
              <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: workspace.id }} label="Ask an agent to clean this up" /></Row>
              <Meta theme={theme}>{AGENT_PROMISE}</Meta>
            </View>
          ) : null}
          <ClearResults theme={theme} job={job} workspace={label} />
        </View>
      </View> : null}
    </View>
  );
}

function CacheLine({ theme, item, group, compact }: { theme: Theme; item: ClearItem; group: string; compact: boolean }) {
  const [open, setOpen] = useState(false);
  return <View style={{ borderBottomWidth: 1, borderColor: theme.colors.border, paddingVertical: SPACE.row, gap: SPACE.sm }}>
    <ResourceCells theme={theme} columns={ITEM_COLUMNS} compact={compact} cells={{
      name: <View style={{ gap: SPACE.xs, minWidth: 0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}. ${open ? "Hide" : "Show"} full path`} onPress={() => setOpen(!open)}><ItemTitle theme={theme}>{item.name}</ItemTitle></Pressable>
        <PathLabel theme={theme} compact={compact} label={item.where} />
        {item.blocked ? <Meta theme={theme}>{item.blocked}</Meta> : null}
      </View>,
      type: <View><Meta theme={theme}>{item.what}</Meta><Meta theme={theme}>{group}</Meta></View>,
      size: <View><Note theme={theme}>{size(item.bytes, item.partial)}</Note>{item.sharedBytes > 0 ? <Meta theme={theme}>{`${formatSize(item.sharedBytes)} shared; about ${formatSize(frees(item))} reclaimable`}</Meta> : null}</View>,
      actions: item.askId ? <Row><AskAgentButton theme={theme} subject={{ kind: "folder", id: item.askId }} /></Row> : <Meta theme={theme}>Ask about shared caches below</Meta>,
    }} />
    {open ? <View style={{ gap: SPACE.xs }}><PathDetails theme={theme} full={item.path ?? item.where} /><Meta theme={theme}>{item.cost}</Meta></View> : null}
  </View>;
}
export function CacheList({ theme, groups, compact = false }: { theme: Theme; groups: readonly CacheGroup[]; compact?: boolean }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<ResourceSort<ItemSort>>({ id: "size", direction: "desc" });
  const [page, setPage] = useState(0);
  const rows = cacheTableRows(groups, search, filter, sort);
  const shownPage = Math.min(page, Math.max(0, Math.ceil(rows.length / TABLE_PAGE) - 1));
  if (!groups.length) return <Meta theme={theme}>No shared caches or leftovers were found. Refresh checks disk space when you need a new measurement.</Meta>;
  return <View style={{ gap: SPACE.row }}>
    <ResourceToolbar theme={theme} label="Search caches and temporary files" search={search} onSearch={(text) => { setSearch(text); setPage(0); }} filter={filter} onFilter={(id) => { setFilter(id); setPage(0); }}
      filters={[{ id: "all", label: "All groups and types" }, ...groups.map((group) => ({ id: group.id, label: group.title })), ...[...new Set(groups.flatMap((group) => group.items.map((item) => item.what)))].map((type) => ({ id: `type:${type}`, label: type }))]} />
    <ResourceTable theme={theme} compact={compact} header={(narrow) => <ResourceHeader theme={theme} columns={ITEM_COLUMNS} compact={narrow} sort={sort} onSort={(id) => { setSort(nextResourceSort(sort, id as ItemSort)); setPage(0); }} />}>{(narrow) => <>
      {rows.slice(shownPage * TABLE_PAGE, (shownPage + 1) * TABLE_PAGE).map(({ group, item }) => <CacheLine key={`${group.id}:${item.path ?? item.where}`} theme={theme} item={item} group={group.title} compact={narrow} />)}
    </>}</ResourceTable>
    {!rows.length ? <Note theme={theme}>No measured entries match these filters. Clear the search or choose All groups and types.</Note> : null}
    <TablePages theme={theme} count={rows.length} page={shownPage} onPage={setPage} />
    {groups.filter((group) => !group.items.length).map((group) => <Meta key={group.id} theme={theme}>{`${group.title}: ${formatSize(group.totalBytes)} total; no individual entries measured.`}</Meta>)}
    <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: "caches" }} label="Ask an agent to clean these up" /></Row>
    <Meta theme={theme}>An agent will use npm's and pnpm's own clean commands, check what's still needed or in use, and tell you what it freed. You see the message before it's sent.</Meta>
  </View>;
}

/** Search and sort the last disk report without starting another scan. */
export function WorkspaceList({ theme, compact, report, processes = [], say, onDelete, onWatchBrowser, job = null }: { theme: Theme; compact: boolean; report: DiskReport | undefined; processes?: readonly ProcessRow[]; say?: Say; onWatchBrowser?(workspaceId: string): void; onDelete?(tokens: string[]): void; job?: DiskJob | null }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<ResourceSort<WorkspaceSort>>({ id: "disk", direction: "desc" });
  const [page, setPage] = useState(0);
  const rows = workspaceTableRows(report?.workspaces ?? [], processes, search, filter, sort);
  const shownPage = Math.min(page, Math.max(0, Math.ceil(rows.length / TABLE_PAGE) - 1));
  if (!report?.workspaces.length) return null;
  return <Card theme={theme} title="Workspace disk and files" icon="FolderTree" flush>
    <ResourceToolbar theme={theme} label="Search workspaces, projects, branches or paths" search={search} onSearch={(text) => { setSearch(text); setPage(0); }} filter={filter} onFilter={(id) => { setFilter(id); setPage(0); }}
      filters={[{ id: "all", label: "All statuses" }, ...["working", "waiting", "failed", "idle", "unlinked"].map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))]} />
    <ResourceTable theme={theme} compact={compact} header={(narrow) => <ResourceHeader theme={theme} columns={WORKSPACE_COLUMNS} compact={narrow} sort={sort} onSort={(id) => { setSort(nextResourceSort(sort, id as WorkspaceSort)); setPage(0); }} />}>{(narrow) => <>
      {rows.slice(shownPage * TABLE_PAGE, (shownPage + 1) * TABLE_PAGE).map(({ workspace, processes: running }) => <WorkspaceRow key={workspace.id} theme={theme} compact={narrow} workspace={workspace} checking={report.scan.state === "running"} processes={running} say={say} onDelete={onDelete} onWatchBrowser={onWatchBrowser} job={job} />)}
    </>}</ResourceTable>
    {!rows.length ? <Note theme={theme}>No workspaces match. Clear the search or choose All statuses. Search uses the last disk check.</Note> : null}
    <TablePages theme={theme} count={rows.length} page={shownPage} onPage={setPage} />
  </Card>;
}

/**
 * Follows a clear the person started (0.16.0) and says how it went: a toast
 * ("Deleted 4.2 GB from 6 folders"), the results for each row, and a fresh
 * report.
 */
export function useClearJob(hostId: string) {
  const status = useRpc(diskClearStatus);
  const toast = useSafeToast();
  const client = useQueryClient();
  const [job, setJob] = React.useState<DiskJob | null>(null);
  const [following, setFollowing] = React.useState(false);
  React.useEffect(() => {
    if (!following) return;
    let live = true;
    const tick = async () => {
      const next = await status({}).catch(() => null);
      if (!live) return;
      if (next) setJob(next);
      if (next && next.state !== "running") {
        setFollowing(false);
        const deleted = next.results.filter((result) => result.ok).length;
        if (deleted) toast.show(`Deleted ${formatSize(next.freedBytes)} from ${deleted} folder${deleted === 1 ? "" : "s"}`, { variant: "success" });
        else toast.show(next.results[0]?.message ? `Nothing was deleted: ${next.results[0].message}` : "Nothing was deleted.", { variant: "warning" });
        void client.invalidateQueries({ queryKey: diskKey(hostId) });
        return;
      }
      setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => { live = false; };
  }, [following]);
  return { job, follow: (started: DiskJob) => { setJob(started); setFollowing(true); }, running: following };
}
