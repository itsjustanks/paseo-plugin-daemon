import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TOKENS_MAX, ago, diskClear, diskClearStatus, diskPreview, diskReport, formatSize, stateWords,
  type CacheGroup, type ClearItem, type DiskJob, type DiskPlan, type DiskReport, type DiskSpace, type WorkspaceUsage,
} from "../shared/disk";
import { AskAgentButton } from "./ask";
import { Accordion, AccordionItem, Button, Card, Disclosure, Divider, HostIcon, ItemTitle, Meta, Note, Row, SectionTitle, SPACE, TYPE, type Tone } from "./kit";
import { Meter, type Say } from "./processes";

type Theme = PluginTheme;

/**
 * The Workspaces tab's disk side (0.14.0): how full the disk is, what each
 * Paseo workspace uses and what of it is safe to clear, the shared caches,
 * and one ask-first sheet for every clear, CleanMyMac-style.
 *
 * The check is heavy, so it runs in the background on the daemon, one at a
 * time; this polls while it runs and shows the last answer with its age.
 * Status first, then the list biggest first; folders and paths only appear
 * when a row is opened.
 */

export const diskKey = (hostId: string) => ["daemon-link", hostId, "disk"] as const;

const DISK_TONE: Record<DiskSpace["level"], Tone> = { ok: "success", warning: "warning", critical: "danger" };
const STATE_ICON: Record<WorkspaceUsage["state"], string> = { working: "Bot", waiting: "MessageCircle", failed: "CircleAlert", idle: "Folder", unlinked: "FolderX" };

const size = (bytes: number, partial = false) => `${partial ? "at least " : ""}${formatSize(bytes)}`;
/** What clearing an item frees: bytes not shared with pnpm's store. */
const frees = (item: ClearItem) => Math.max(0, item.bytes - item.sharedBytes);
/** At most TOKENS_MAX per clear, biggest first (a bulk clear of many workspaces can find more). */
const tokensOf = (items: readonly ClearItem[]) => items.filter((item) => item.token).sort((a, b) => frees(b) - frees(a)).slice(0, TOKENS_MAX).map((item) => item.token!);

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

/** Preview, the sheet, the clear itself and its progress; one flow for every clear button. */
export function useClear(say: Say, onDone: () => void) {
  const preview = useRpc(diskPreview), clear = useRpc(diskClear), status = useRpc(diskClearStatus);
  const [sheet, setSheet] = useState<{ plan: DiskPlan; tokens: string[]; title: string } | null>(null);
  const [job, setJob] = useState<DiskJob | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const ask = useMutation({
    mutationFn: async (input: { tokens: string[]; title: string }) => ({ plan: await preview({ tokens: input.tokens }), ...input }),
    onSuccess: setSheet,
    onError: (error) => say({ text: error instanceof Error ? error.message : String(error), tone: "danger" }),
  });
  const confirm = useMutation({
    mutationFn: async () => {
      const tokens = sheet!.tokens;
      setSheet(null);
      let current = await clear({ tokens });
      setJob(current);
      while (current.state === "running" && live.current) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        current = await status({});
        if (live.current) setJob(current);
      }
      return current;
    },
    onSuccess: (done) => {
      setJob(null);
      const failed = done.results.filter((result) => !result.ok).length;
      say({ text: done.message ?? "Done.", tone: failed && failed === done.results.length ? "danger" : failed ? "warning" : "success" });
      onDone();
    },
    onError: (error) => { setJob(null); say({ text: error instanceof Error ? error.message : String(error), tone: "danger" }); },
  });
  return {
    start: (items: readonly ClearItem[], title: string) => { const tokens = tokensOf(items); if (tokens.length) ask.mutate({ tokens, title }); },
    busy: ask.isPending || confirm.isPending,
    job,
    sheet,
    cancel: () => setSheet(null),
    confirm: () => confirm.mutate(),
  };
}

/** The ask-first sheet: exactly what goes, grouped by kind with what it costs; what won't and why; one confirm. */
export function ClearSheet({ theme, flow }: { theme: Theme; flow: ReturnType<typeof useClear> }) {
  const sheet = flow.sheet;
  const ready = sheet?.plan.items.filter((item) => item.ok) ?? [];
  const refused = sheet?.plan.items.filter((item) => !item.ok) ?? [];
  const groups = new Map<string, typeof ready>();
  for (const item of ready) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);
  const total = ready.reduce((sum, item) => sum + item.bytes, 0);
  const prunes = ready.filter((item) => item.action === "prune").length;
  const title = ready.length ? (prunes === ready.length ? "Prune pnpm's store?" : `Clear ${formatSize(total)}?`) : "Nothing can be cleared";
  return (
    <Modal title={title} icon={HostIcon ? <HostIcon name="Trash2" size={18} color={theme.colors.statusDanger} /> : undefined} open={sheet !== null} onOpenChange={(open: boolean) => { if (!open) flow.cancel(); }}>
      <Modal.Content>
        <View style={{ gap: SPACE.row, padding: SPACE.card, maxHeight: 640 }}>
          {sheet?.title ? <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{sheet.title}</Text> : null}
          <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: SPACE.row }}>
            {[...groups].map(([name, items]) => (
              <View key={name} style={{ gap: SPACE.xs }}>
                <ItemTitle theme={theme}>{`${name}${items.length > 1 ? ` · ${items.length} folders` : ""} · ${formatSize(items.reduce((sum, item) => sum + item.bytes, 0))}`}</ItemTitle>
                <Meta theme={theme}>{items[0]!.cost}</Meta>
                {items.map((item, index) => <Text key={`${item.where}-${index}`} style={{ ...TYPE.secondary, color: theme.colors.foreground }}>{`${item.owner ? `${item.owner} · ` : ""}${item.where} · ${formatSize(item.bytes)}`}</Text>)}
              </View>
            ))}
            {refused.map((item, index) => (
              <View key={`refused-${index}`} style={{ gap: SPACE.hair }}>
                <ItemTitle theme={theme}>{`${item.name}: won't be cleared`}</ItemTitle>
                <Meta theme={theme}>{item.reason}</Meta>
              </View>
            ))}
          </ScrollView>
          {ready.length ? <Note theme={theme}>Each folder is checked again just before it goes. Anything in use, changed since the check, or tracked by git is left alone, and .env files and .git folders are never deleted. Every step is logged.</Note> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: SPACE.sm }}>
            <Button theme={theme} label={ready.length ? "Cancel" : "Close"} onPress={flow.cancel} />
            {ready.length ? <Button theme={theme} label={prunes === ready.length ? "Prune" : `Clear ${formatSize(total)}`} icon="Trash2" danger busy={flow.busy} onPress={flow.confirm} /> : null}
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Items that idle workspaces (no agent working, no dev server) may clear, and how many workspaces they're in. */
export function idleClearable(report: DiskReport | undefined): { items: ClearItem[]; workspaces: number; bytes: number } {
  const idle = (report?.workspaces ?? []).filter((workspace) => !workspace.busy && workspace.clearableBytes > 0);
  const items = idle.flatMap((workspace) => workspace.items.filter((item) => item.token)).sort((a, b) => frees(b) - frees(a)).slice(0, TOKENS_MAX);
  return { items, workspaces: idle.length, bytes: items.reduce((sum, item) => sum + frees(item), 0) };
}

export function cacheClearable(report: DiskReport | undefined): { items: ClearItem[]; bytes: number } {
  const items = (report?.caches ?? []).flatMap((group) => group.items).filter((item) => item.token && item.action === "delete");
  return { items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
}

/** Status first: the disk, what's safe to clear, and the check's age. */
export function DiskCard({ theme, report, loading, scanning, flow, onScan, onCaches }: {
  theme: Theme; report: DiskReport | undefined; loading: boolean; scanning: boolean; flow: ReturnType<typeof useClear>; onScan(): void; onCaches(): void;
}) {
  const disk = report?.disks[0] ?? null;
  const scan = report?.scan;
  const running = scan?.state === "running" || scanning;
  const idle = idleClearable(report);
  const caches = cacheClearable(report);
  const job = flow.job;
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
      {job ? (
        <Row>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={{ ...TYPE.body, color: theme.colors.foreground, flexShrink: 1 }}>{`Clearing… ${job.results.length} done, ${formatSize(job.freedBytes)} freed so far.`}</Text>
        </Row>
      ) : running ? (
        <View style={{ gap: SPACE.xs }}>
          <Row>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={{ ...TYPE.body, color: theme.colors.foreground, flexShrink: 1 }}>{scan && scan.total ? `Checking what's using space… ${scan.done} of ${scan.total} folders` : "Checking what's using space…"}</Text>
          </Row>
          <Meta theme={theme}>It runs quietly in the background and takes a minute or two. You can leave this page.</Meta>
        </View>
      ) : !scan || scan.state === "never" ? (
        <View style={{ gap: SPACE.sm }}>
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>Hosts hasn't looked inside your workspaces yet. It finds build files, installed packages and caches you can safely clear.</Text>
          <Row><Button theme={theme} label="Check what's using space" icon="ScanSearch" primary busy={loading} onPress={onScan} /></Row>
        </View>
      ) : (
        <View style={{ gap: SPACE.row }}>
          <View style={{ gap: SPACE.sm }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{idle.bytes > 0 ? `${formatSize(idle.bytes)} is safe to clear in ${idle.workspaces} idle workspace${idle.workspaces === 1 ? "" : "s"}.` : "Nothing to clear in your idle workspaces right now."}</Text>
            {idle.bytes > 0 ? <Row><Button theme={theme} label={`Clear ${formatSize(idle.bytes)} from ${idle.workspaces} workspace${idle.workspaces === 1 ? "" : "s"}…`} icon="Trash2" primary busy={flow.busy} onPress={() => flow.start(idle.items, `Build files and installed packages from ${idle.workspaces} idle workspace${idle.workspaces === 1 ? "" : "s"}. Agents that are working and dev servers that are running are left alone.`)} /></Row> : null}
          </View>
          {caches.bytes > 0 ? (
            <View style={{ gap: SPACE.sm }}>
              <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${formatSize(caches.bytes)} more in shared caches and temporary files.`}</Text>
              <Row><Button theme={theme} label="Review caches" icon="Archive" onPress={onCaches} /></Row>
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

/** One found folder inside a workspace: what it is, where, its size, and why not when it can't be cleared. */
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

/** One workspace folder: its rows' summary says it all; opening shows where, what's in it, and Clear. */
export function WorkspaceRow({ theme, compact, workspace, flow, checking }: { theme: Theme; compact: boolean; workspace: WorkspaceUsage; flow: ReturnType<typeof useClear>; checking: boolean }) {
  const clearable = workspace.items.filter((item) => item.token);
  const linked = workspace.state !== "unlinked";
  const title = linked ? `${workspace.names[0]}${workspace.names.length > 1 ? ` +${workspace.names.length - 1}` : ""}` : "Not linked to a workspace";
  const summary = [
    workspace.measured === false ? (checking ? "Checking…" : "Not checked yet") : size(workspace.totalBytes, workspace.partial),
    workspace.clearableBytes > 0 ? `${formatSize(workspace.clearableBytes)} safe to clear` : null,
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
          <Note theme={theme}>No Paseo workspace uses this worktree any more, probably because its workspace was archived. Hosts never deletes a whole worktree: it may hold work that isn't pushed. An agent can check it and remove it properly.</Note>
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
      ) : workspace.measured === false ? (checking ? <Meta theme={theme}>Checking this folder…</Meta> : null) : <Meta theme={theme}>No build files, installed packages or test reports to clear here.</Meta>}
      {clearable.length ? <Row><Button theme={theme} label={`Clear ${formatSize(workspace.clearableBytes)}…`} icon="Trash2" busy={flow.busy} onPress={() => flow.start(clearable, `From ${title}.`)} /></Row> : null}
    </AccordionItem>
  );
}

const CACHE_ITEMS_SHOWN = 5;

function CacheLine({ theme, item, flow }: { theme: Theme; item: ClearItem; flow: ReturnType<typeof useClear> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 200, gap: SPACE.hair }}>
        <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${item.name} · ${size(item.bytes, item.partial)}`}</Text>
        <Meta theme={theme}>{item.blocked ?? `${item.what}. ${item.cost}`}</Meta>
      </View>
      {item.token ? <Button theme={theme} label={item.action === "prune" ? "Prune…" : "Clear…"} busy={flow.busy} accessibilityLabel={`${item.action === "prune" ? "Prune" : "Clear"} ${item.name}`} onPress={() => flow.start([item], item.action === "prune" ? "pnpm removes the packages that none of your projects use. Packages a project needs stay." : `${item.what}.`)} /> : null}
    </View>
  );
}

/**
 * Shared caches, grouped; each with what clearing costs, and Clear (or Prune
 * for pnpm). A group shows its biggest few; the rest fold away (a temporary
 * folder can hold hundreds of leftovers), and one button clears the group.
 */
export function CacheList({ theme, groups, flow }: { theme: Theme; groups: readonly CacheGroup[]; flow: ReturnType<typeof useClear> }) {
  const all = groups.flatMap((group) => group.items).filter((item) => item.token && item.action === "delete");
  if (!groups.length) return <Meta theme={theme}>No shared caches or leftovers were found.</Meta>;
  return (
    <View style={{ gap: SPACE.section }}>
      {groups.map((group) => {
        const clearable = group.items.filter((item) => item.token && item.action === "delete");
        const shown = group.items.slice(0, CACHE_ITEMS_SHOWN), more = group.items.slice(CACHE_ITEMS_SHOWN);
        return (
          <View key={group.id} style={{ gap: SPACE.row }}>
            <ItemTitle theme={theme}>{`${group.title} · ${formatSize(group.totalBytes)}${group.items.length > 1 ? ` · ${group.items.length} items` : ""}`}</ItemTitle>
            {shown.map((item, index) => <CacheLine key={`${item.where}-${index}`} theme={theme} item={item} flow={flow} />)}
            {more.length ? (
              <Disclosure theme={theme} label={`${more.length} more`} quiet>
                <View style={{ gap: SPACE.row }}>{more.map((item, index) => <CacheLine key={`more-${item.where}-${index}`} theme={theme} item={item} flow={flow} />)}</View>
              </Disclosure>
            ) : null}
            {clearable.length > 1 ? <Row><Button theme={theme} label={`Clear these ${clearable.length} (${formatSize(clearable.reduce((sum, item) => sum + item.bytes, 0))})…`} busy={flow.busy} onPress={() => flow.start(clearable, `${group.title}.`)} /></Row> : null}
          </View>
        );
      })}
      {all.length > 1 && groups.length > 1 ? <Row><Button theme={theme} label={`Clear all ${formatSize(all.reduce((sum, item) => sum + item.bytes, 0))}…`} icon="Trash2" busy={flow.busy} onPress={() => flow.start(all, "Shared caches and temporary leftovers. pnpm's store is pruned separately.")} /></Row> : null}
    </View>
  );
}

/** The list of workspace rows, biggest first, with a plain heading line. */
export function WorkspaceList({ theme, compact, report, flow }: { theme: Theme; compact: boolean; report: DiskReport | undefined; flow: ReturnType<typeof useClear> }) {
  const rows = report?.workspaces ?? [];
  if (!rows.length) return null;
  return (
    <View style={{ gap: SPACE.sm }}>
      <SectionTitle theme={theme} icon="FolderTree">Workspaces, biggest first</SectionTitle>
      <Accordion theme={theme}>
        {rows.map((workspace) => <WorkspaceRow key={workspace.id} theme={theme} compact={compact} workspace={workspace} flow={flow} checking={report?.scan.state === "running"} />)}
      </Accordion>
    </View>
  );
}
