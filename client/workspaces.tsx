import React from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago, diskReport, formatSize, stateWords, type CacheGroup, type ClearItem, type DiskReport, type DiskSpace, type WorkspaceUsage } from "../shared/disk";
import { AskAgentButton } from "./ask";
import { Accordion, AccordionItem, Button, Card, Disclosure, Divider, ItemTitle, Meta, Note, Row, SectionTitle, SPACE, TYPE, type Tone } from "./kit";
import { Meter } from "./processes";

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

/** The report, polled quickly while a check runs and slowly otherwise. `scan()` starts a check. */
export function useDiskReport(hostId: string) {
  const read = useRpc(diskReport);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: diskKey(hostId), queryFn: () => read({}), retry: 1,
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

/** Status first: the disk, what looks safe to clear, and the check's age. */
export function DiskCard({ theme, report, loading, scanning, onScan, onCaches, askNow, onAsked }: {
  theme: Theme; report: DiskReport | undefined; loading: boolean; scanning: boolean; onScan(): void; onCaches(): void;
  /** "Clean up disk space" (Command Center, `/disk clean`): open the ask sheet as soon as there's something to ask about. */
  askNow?: boolean; onAsked?(): void;
}) {
  const disk = report?.disks[0] ?? null;
  const scan = report?.scan;
  const running = scan?.state === "running" || scanning;
  const idle = idleClearable(report);
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
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>Hosts hasn't looked inside your workspaces yet. It finds build files, installed packages and caches that are usually safe to clear.</Text>
          <Row><Button theme={theme} label="Check what's using space" icon="ScanSearch" primary busy={loading} onPress={onScan} /></Row>
        </View>
      ) : (
        <View style={{ gap: SPACE.row }}>
          <View style={{ gap: SPACE.sm }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{idle.bytes > 0 ? `About ${formatSize(idle.bytes)} looks safe to clear in ${idle.workspaces} idle workspace${idle.workspaces === 1 ? "" : "s"}.` : "Nothing looks safe to clear in your idle workspaces right now."}</Text>
            {idle.bytes > 0 ? (
              <>
                <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: "idle" }} label="Ask an agent to clean this up" primary openNow={askNow} onOpened={onAsked} /></Row>
                <Meta theme={theme}>{AGENT_PROMISE}</Meta>
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
function ItemLine({ theme, item }: { theme: Theme; item: ClearItem }) {
  const shared = item.sharedBytes > 0 && item.sharedBytes >= item.bytes * 0.2;
  return (
    <View style={{ gap: SPACE.hair }}>
      <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${item.what} · ${size(item.bytes, item.partial)}`}</Text>
      <Meta theme={theme}>{[item.where, item.blocked ?? item.cost, shared ? `${formatSize(item.sharedBytes)} of it is shared with pnpm's store, so clearing frees about ${formatSize(frees(item))}` : null].filter(Boolean).join(" · ")}</Meta>
    </View>
  );
}

const ITEMS_SHOWN = 6;

/** One workspace folder: its row's summary says it all; opening shows where, what's in it, and Ask an agent. */
export function WorkspaceRow({ theme, compact, workspace, checking }: { theme: Theme; compact: boolean; workspace: WorkspaceUsage; checking: boolean }) {
  const linked = workspace.state !== "unlinked";
  const title = linked ? `${workspace.names[0]}${workspace.names.length > 1 ? ` +${workspace.names.length - 1}` : ""}` : "Not linked to a workspace";
  const summary = [
    workspace.measured === false ? (checking ? "Checking…" : "Not checked yet") : size(workspace.totalBytes, workspace.partial),
    workspace.clearableBytes > 0 ? `${formatSize(workspace.clearableBytes)} looks safe to clear` : null,
    stateWords(workspace.state, workspace.activeAt),
    workspace.branch,
    workspace.devServers.length ? `Dev server ${workspace.devServers.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
  const shown = workspace.items.slice(0, ITEMS_SHOWN), more = workspace.items.slice(ITEMS_SHOWN);
  return (
    <AccordionItem theme={theme} compact={compact} icon={STATE_ICON[workspace.state]} title={title} summary={summary} tone={workspace.state === "failed" ? "warning" : undefined}>
      <View style={{ gap: SPACE.xs }}>
        {workspace.names.length > 1 ? <Meta theme={theme}>{`Used by ${workspace.names.length} workspaces: ${workspace.names.join(", ")}`}</Meta> : null}
        <Meta theme={theme}>{[workspace.project ? `Project ${workspace.project}` : null, `Folder ${workspace.folder}`, workspace.worktree ? "a Paseo worktree" : null].filter(Boolean).join(" · ")}</Meta>
      </View>
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
          {shown.map((item, index) => <ItemLine key={`${item.where}-${index}`} theme={theme} item={item} />)}
          {more.length ? (
            <Disclosure theme={theme} label={`${more.length} more`} quiet>
              <View style={{ gap: SPACE.row }}>{more.map((item, index) => <ItemLine key={`more-${item.where}-${index}`} theme={theme} item={item} />)}</View>
            </Disclosure>
          ) : null}
        </View>
      ) : workspace.measured === false ? (checking ? <Meta theme={theme}>Checking this folder…</Meta> : null) : <Meta theme={theme}>No build files, installed packages or test reports here.</Meta>}
      {workspace.clearableBytes > 0 && !workspace.busy ? (
        <View style={{ gap: SPACE.xs }}>
          <Row><AskAgentButton theme={theme} subject={{ kind: "cleanup", id: workspace.id }} label="Ask an agent to clean this up" /></Row>
          <Meta theme={theme}>{AGENT_PROMISE}</Meta>
        </View>
      ) : null}
    </AccordionItem>
  );
}

const CACHE_ITEMS_SHOWN = 5;

function CacheLine({ theme, item }: { theme: Theme; item: ClearItem }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 200, gap: SPACE.hair }}>
        <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${item.name} · ${size(item.bytes, item.partial)}`}</Text>
        <Meta theme={theme}>{item.what}</Meta>
      </View>
      {item.askId ? <AskAgentButton theme={theme} subject={{ kind: "folder", id: item.askId }} /> : null}
    </View>
  );
}

/**
 * Shared caches and temporary files, grouped and sized. Hosts deletes none of
 * them; one button asks an agent to clean them up with the tools' own
 * commands. A group shows its biggest few; the rest fold away.
 */
export function CacheList({ theme, groups }: { theme: Theme; groups: readonly CacheGroup[] }) {
  if (!groups.length) return <Meta theme={theme}>No shared caches or leftovers were found.</Meta>;
  return (
    <View style={{ gap: SPACE.section }}>
      {groups.map((group) => {
        const shown = group.items.slice(0, CACHE_ITEMS_SHOWN), more = group.items.slice(CACHE_ITEMS_SHOWN);
        return (
          <View key={group.id} style={{ gap: SPACE.row }}>
            <ItemTitle theme={theme}>{`${group.title} · ${formatSize(group.totalBytes)}${group.items.length > 1 ? ` · ${group.items.length} items` : ""}`}</ItemTitle>
            {shown.map((item, index) => <CacheLine key={`${item.where}-${index}`} theme={theme} item={item} />)}
            {more.length ? (
              <Disclosure theme={theme} label={`${more.length} more`} quiet>
                <View style={{ gap: SPACE.row }}>{more.map((item, index) => <CacheLine key={`more-${item.where}-${index}`} theme={theme} item={item} />)}</View>
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
export function WorkspaceList({ theme, compact, report }: { theme: Theme; compact: boolean; report: DiskReport | undefined }) {
  const rows = report?.workspaces ?? [];
  if (!rows.length) return null;
  return (
    <View style={{ gap: SPACE.sm }}>
      <SectionTitle theme={theme} icon="FolderTree">Workspaces, biggest first</SectionTitle>
      <Accordion theme={theme}>
        {rows.map((workspace) => <WorkspaceRow key={workspace.id} theme={theme} compact={compact} workspace={workspace} checking={report?.scan.state === "running"} />)}
      </Accordion>
    </View>
  );
}
