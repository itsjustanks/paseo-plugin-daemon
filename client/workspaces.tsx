import React from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago, diskClearStatus, diskLeftoverDismiss, diskReport, formatSize, stateWords, type CacheGroup, type ClearItem, type DiskJob, type DiskReport, type DiskSpace, type WorkspaceUsage } from "../shared/disk";
import { runningIn, type ProcessRow } from "../shared/processes";
import { ClearResults } from "./clear";
import { useSafeToast } from "./feedback";
import { StopProcess } from "./guard";
import { AskAgentButton } from "./ask";
import { PathDetails, PathLabel } from "./paths";
import { friendlyPath } from "../shared/paths";
import { Accordion, AccordionItem, Button, Card, Disclosure, Divider, ItemTitle, Meta, Note, Row, SectionTitle, SPACE, TYPE, type Tone } from "./kit";
import { Meter, type Say } from "./processes";

type Theme = PluginTheme;

/**
 * The Workspaces tab's disk side (0.14.0, read-only): how full the disk is,
 * what each Paseo workspace uses and what of it looks safe to clear, and the
 * shared caches and temporary files by size. Hosts deletes nothing here.
 * Where a Clear button would be there's "Ask an agent to clean this up": the
 * agent gets the exact list with paths and sizes, checks that nothing is in
 * use or unsaved, and then clears it.
 *
 * The check is heavy, so it runs in the background on the daemon, one at a
 * time; this polls while it runs and shows the last answer with its age.
 * Status first, then the list biggest first; folders and paths only appear
 * when a row is opened.
 */

export const diskKey = (hostId: string) => ["daemon-link", hostId, "disk"] as const;

const DISK_TONE: Record<DiskSpace["level"], Tone> = { ok: "success", warning: "warning", critical: "danger" };
const STATE_ICON: Record<WorkspaceUsage["state"], string> = { working: "Bot", waiting: "MessageCircle", failed: "CircleAlert", idle: "Folder", unlinked: "FolderX" };
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
 * sentence and Ask an agent; a "removed part of…" record stays until the
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
          <Note theme={theme} tone={leftover.state === "left" ? "warning" : "danger"}>{leftover.message ?? `Left over from an interrupted delete: ${leftover.where}`}</Note>
          <Meta theme={theme}>{`${formatSize(leftover.bytes)} when it was set aside · ${ago(leftover.at)}`}</Meta>
          <Row>
            <AskAgentButton theme={theme} subject={{ kind: "folder", id: leftover.id }} />
            {leftover.state === "partial" || leftover.state === "unconfirmed" ? <Button theme={theme} label="Dismiss" accessibilityLabel={`Dismiss the note about ${leftover.where}`} onPress={() => void dismiss({ id: leftover.id }).then((result) => { if (!result.ok) toast.show("That note couldn't be dismissed. Check disk space again.", { variant: "warning" }); void client.invalidateQueries({ queryKey: ["daemon-link"] }); })} /> : null}
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
        <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${item.what} · ${size(item.bytes, item.partial)}`}</Text>
        <PathLabel theme={theme} compact={compact} label={label} />
        <Meta theme={theme}>{[item.blocked ?? item.cost, shared ? `${formatSize(item.sharedBytes)} of it is shared with pnpm's store, so clearing frees about ${formatSize(frees(item))}` : null].filter(Boolean).join(" · ")}</Meta>
      </Pressable>
      {open ? <PathDetails theme={theme} full={item.path ?? item.where} /> : null}
    </View>
  );
}

const ITEMS_SHOWN = 6;

/** One workspace folder: its row's summary says it all; opening shows where, what's in it, and Ask an agent. */
/** What a workspace is running now (0.16.0), from the same list as Processes: heaviest first, each with ask-first Stop. */
function RunningHere({ theme, rows, say }: { theme: Theme; rows: readonly ProcessRow[]; say: Say }) {
  if (!rows.length) return <Meta theme={theme}>Nothing is running in this workspace.</Meta>;
  return (
    <View style={{ gap: SPACE.sm }}>
      {rows.map((row) => (
        <View key={row.pid} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACE.sm }}>
          <View style={{ flex: 1, minWidth: 180, gap: SPACE.hair }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${row.name}${row.job ? ` · ${row.job.label}` : ""}`}</Text>
            <Meta theme={theme}>{[formatSize(row.rssBytes), row.cpuPercent === null ? null : `${Math.round(row.cpuPercent)}% CPU`, row.ports.length ? row.ports.map((port) => `:${port}`).join(" ") : null, row.flags[0]?.text ?? null].filter(Boolean).join(" · ")}</Meta>
          </View>
          {row.stoppable ? <StopProcess theme={theme} pid={row.pid} say={say} /> : <Meta theme={theme}>{row.owner.kind === "agent" ? "Stop it from its chat" : "Can't be stopped here"}</Meta>}
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
export function WorkspaceRow({ theme, compact, workspace, checking, processes = [], say = () => undefined, onDelete, job = null }: {
  theme: Theme; compact: boolean; workspace: WorkspaceUsage; checking: boolean;
  processes?: readonly ProcessRow[]; say?: Say; onDelete?(tokens: string[]): void; job?: DiskJob | null;
}) {
  const linked = workspace.state !== "unlinked";
  const title = linked ? `${workspace.names[0]}${workspace.names.length > 1 ? ` +${workspace.names.length - 1}` : ""}` : "Not linked to a workspace";
  const label = workspace.names[0] ?? friendlyPath(workspace.folder).label;
  const summary = [
    stateWords(workspace.state, workspace.activeAt),
    workspace.measured === false ? (checking ? "Checking…" : "Size not checked yet") : size(workspace.totalBytes, workspace.partial),
    processes.length ? `${processes.length} running` : null,
  ].filter(Boolean).join(" · ");
  const shown = workspace.items.slice(0, ITEMS_SHOWN), more = workspace.items.slice(ITEMS_SHOWN);
  const tokens = workspace.items.filter((item) => item.safe && item.token).map((item) => item.token!);
  const deletable = workspace.items.filter((item) => item.safe && item.token).reduce((sum, item) => sum + frees(item), 0);
  return (
    <AccordionItem theme={theme} compact={compact} icon={STATE_ICON[workspace.state]} title={title} summary={summary} tone={workspace.state === "failed" ? "warning" : undefined}>
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
          <View style={{ gap: SPACE.row }}>
            {shown.map((item, index) => <ItemLine key={`${item.where}-${index}`} theme={theme} item={item} owner={workspace.names[0] ?? null} compact={compact} />)}
            {more.length ? (
              <Disclosure theme={theme} label={`${more.length} more`} quiet>
                <View style={{ gap: SPACE.row }}>{more.map((item, index) => <ItemLine key={`more-${item.where}-${index}`} theme={theme} item={item} owner={workspace.names[0] ?? null} compact={compact} />)}</View>
              </Disclosure>
            ) : null}
          </View>
        ) : workspace.measured === false ? (checking ? <Meta theme={theme}>Checking this folder…</Meta> : null) : <Meta theme={theme}>No build files, installed packages or test reports here.</Meta>}
        {tokens.length && onDelete && !workspace.busy ? (
          <View style={{ gap: SPACE.xs }}>
            <Row>
              <Button theme={theme} label={`Delete ${tokens.length} folder${tokens.length === 1 ? "" : "s"} (${formatSize(deletable)})…`} icon="Trash2" danger accessibilityLabel={`Delete ${tokens.length} build folder${tokens.length === 1 ? "" : "s"} in ${label}. Shows a warning first.`} onPress={() => onDelete(tokens)} />
              <AskAgentButton theme={theme} subject={{ kind: "cleanup", id: workspace.id }} label="Ask an agent instead" />
            </Row>
            <Meta theme={theme}>Shows exactly what goes, checked again just before, and asks first. Only build folders git ignores are deleted.</Meta>
          </View>
        ) : workspace.clearableBytes > 0 && !workspace.busy ? (
          <View style={{ gap: SPACE.xs }}>
            <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: workspace.id }} label="Ask an agent to clean this up" /></Row>
            <Meta theme={theme}>{AGENT_PROMISE}</Meta>
          </View>
        ) : null}
        <ClearResults theme={theme} job={job} workspace={label} />
      </View>
    </AccordionItem>
  );
}

const CACHE_ITEMS_SHOWN = 5;

function CacheLine({ theme, item, compact }: { theme: Theme; item: ClearItem; compact: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={{ gap: SPACE.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row, flexWrap: "wrap" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}, ${size(item.bytes, item.partial)}. ${open ? "Hide" : "Show"} where it is`} onPress={() => setOpen(!open)} style={{ flex: 1, minWidth: 200, gap: SPACE.hair }}>
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${item.name} · ${size(item.bytes, item.partial)}`}</Text>
          <Meta theme={theme}>{item.what}</Meta>
          <PathLabel theme={theme} compact={compact} label={item.where} />
        </Pressable>
        {item.askId ? <AskAgentButton theme={theme} subject={{ kind: "folder", id: item.askId }} /> : null}
      </View>
      {open ? <PathDetails theme={theme} full={item.path ?? item.where} /> : null}
    </View>
  );
}
export function CacheList({ theme, groups, compact = false }: { theme: Theme; groups: readonly CacheGroup[]; compact?: boolean }) {
  if (!groups.length) return <Meta theme={theme}>No shared caches or leftovers were found.</Meta>;
  return (
    <View style={{ gap: SPACE.section }}>
      {groups.map((group) => {
        const shown = group.items.slice(0, CACHE_ITEMS_SHOWN), more = group.items.slice(CACHE_ITEMS_SHOWN);
        return (
          <View key={group.id} style={{ gap: SPACE.row }}>
            <ItemTitle theme={theme}>{`${group.title} · ${formatSize(group.totalBytes)}${group.items.length > 1 ? ` · ${group.items.length} items` : ""}`}</ItemTitle>
            {shown.map((item, index) => <CacheLine key={`${item.where}-${index}`} theme={theme} item={item} compact={compact} />)}
            {more.length ? (
              <Disclosure theme={theme} label={`${more.length} more`} quiet>
                <View style={{ gap: SPACE.row }}>{more.map((item, index) => <CacheLine key={`more-${item.where}-${index}`} theme={theme} item={item} compact={compact} />)}</View>
              </Disclosure>
            ) : null}
          </View>
        );
      })}
      <View style={{ gap: SPACE.xs }}>
        <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: "caches" }} label="Ask an agent to clean these up" /></Row>
        <Meta theme={theme}>An agent will use npm's and pnpm's own clean commands, check what's still needed or in use, and tell you what it freed. You see the message before it's sent.</Meta>
      </View>
    </View>
  );
}

/** The list of workspace rows, biggest first, with a plain heading line. */
export function WorkspaceList({ theme, compact, report, processes = [], say, onDelete, job = null }: { theme: Theme; compact: boolean; report: DiskReport | undefined; processes?: readonly ProcessRow[]; say?: Say; onDelete?(tokens: string[]): void; job?: DiskJob | null }) {
  const rows = report?.workspaces ?? [];
  if (!rows.length) return null;
  return (
    <View style={{ gap: SPACE.sm }}>
      <SectionTitle theme={theme} icon="FolderTree">Workspaces, biggest first</SectionTitle>
      <Accordion theme={theme}>
        {rows.map((workspace) => <WorkspaceRow key={workspace.id} theme={theme} compact={compact} workspace={workspace} checking={report?.scan.state === "running"} processes={runningIn(processes, workspace)} say={say} onDelete={onDelete} job={job} />)}
      </Accordion>
    </View>
  );
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
