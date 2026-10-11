import { CancelButton, DangerLine, DestructiveButton, errorText, useCopy, useOnce, Sheet } from "./feedback";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { OUTSIDE_PASEO_WARNING, chatAttribution, ownerGroup, processActionKey, processDetails, processPreview, processReport, processStop, STOP_BATCH_MAX, type ActionLogEntry, type ProcessReport, type ProcessRow, type ReportSort, type StopPlan } from "../shared/processes";
import { Accordion, AccordionItem, Banner, Button, Card, Divider, HostIcon, ItemTitle, Meta, Note, QuietLine, RADIUS, Row, SPACE, TYPE, tint, toneColor, type Tone } from "./kit";
import { formatBytes, formatDuration, formatPercent } from "./ui";
import { AskAgentButton, OpenChatButton } from "./ask";
import { PathDetails, PathLabel } from "./paths";
import { StopProcess, StuckPlugins } from "./guard";
import { nextResourceSort, type ResourceSort } from "../shared/resource-table";
import { ResourceCells, ResourceHeader, ResourceTable, ResourceToolbar, type ResourceColumn } from "./resource-table";
import type { HealthIssue } from "../shared/health";

import { HousekeepingSection } from "./housekeeping";

type Theme = PluginTheme;
export type Say = (message: { text: string; tone: Tone } | null) => void;
type Filter = "all" | "jobs" | "stoppable" | "protected" | "known-chat" | "no-chat" | "attention";

const PAGE = 25;
const POLL_MS = 5000;
export const PROCESS_COLUMNS: readonly ResourceColumn[] = [
  { id: "name", label: "Process / PID", weight: 1.8, sortable: true },
  { id: "attribution", label: "Workspace / chat", weight: 2 },
  { id: "memory", label: "Memory", sortable: true, compactInline: true },
  { id: "cpu", label: "CPU", sortable: true, compactInline: true },
  { id: "age", label: "Running", sortable: true, compactInline: true },
  { id: "actions", label: "Actions", weight: 1.4 },
];
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "jobs", label: "Heavy jobs" },
  { id: "stoppable", label: "Can stop here" },
  { id: "protected", label: "Protected" },
  { id: "known-chat", label: "Known chat" },
  { id: "no-chat", label: "No chat" },
  { id: "attention", label: "Needs attention" },
];
const JOB_WORD: Record<NonNullable<ProcessRow["job"]>["kind"], string> = { "dev-server": "Dev server", build: "Build", test: "Tests", typecheck: "Type check", install: "Install" };

export const processesKey = (hostId: string) => ["daemon-link", hostId, "processes"] as const;

/** How full a share is, as a tone: under 80% calm, under 90% a warning, then danger. */
export function shareTone(percent: number | null): Tone {
  if (percent === null) return "neutral";
  return percent >= 90 ? "danger" : percent >= 80 ? "warning" : "success";
}

/** Memory in the words this host warrants: against the container's limit when it has one. */
export function memoryWords(report: Pick<ProcessReport, "container" | "host" | "memoryBasis" | "memoryBasisBytes">): { used: number; limit: number; percent: number | null; where: string } {
  if (report.memoryBasis === "container" && report.container?.memoryLimitBytes) {
    return { used: report.container.memoryUsedBytes, limit: report.container.memoryLimitBytes, percent: report.container.memoryPercent, where: "this container's limit" };
  }
  const { memoryUsedBytes: used, memoryTotalBytes: limit } = report.host;
  return { used, limit, percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : null, where: "this machine's memory" };
}

export function Meter({ theme, percent, tone }: { theme: Theme; percent: number | null; tone: Tone }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const color = tone === "success" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <View accessible={false} style={{ height: 6, borderRadius: RADIUS.pill, backgroundColor: tint(theme.colors.foregroundMuted, 0.18) ?? theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(value)}%`, height: "100%", backgroundColor: color }} />
    </View>
  );
}

/** One figure with its label, its meter and a muted line under it. */
function Figure({ theme, label, value, percent, tone, hint }: { theme: Theme; label: string; value: string; percent: number | null; tone: Tone; hint: string }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 240, gap: SPACE.xs }}>
      <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, fontWeight: "500" }}>{label}</Text>
      <Text style={{ ...TYPE.figure, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Meter theme={theme} percent={percent} tone={tone} />
      <Meta theme={theme}>{hint}</Meta>
    </View>
  );
}

/** The load at a glance: memory against what actually limits it, CPU, and heavy jobs against your limit. */
function LoadCard({ theme, report }: { theme: Theme; report: ProcessReport }) {
  const memory = memoryWords(report);
  const container = report.container;
  const cpuHint = container?.cpuCoresUsed != null
    ? `This container is using ${container.cpuCoresUsed.toFixed(1)} of ${container.cpuLimitCores ?? report.host.cores} cores`
    : `${report.host.cores} cores · load ${report.host.load1.toFixed(1)}`;
  const jobs = report.heavyJobs;
  return (
    <Card theme={theme} title="This host's load" icon="Gauge" subtitle={report.memoryBasis === "container" ? `A container on a machine with ${formatBytes(report.host.memoryTotalBytes)} of memory` : undefined}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.section }}>
        <Figure theme={theme} label="Memory" value={`${formatBytes(memory.used)} of ${formatBytes(memory.limit)}`} percent={memory.percent} tone={shareTone(memory.percent)} hint={`${formatPercent(memory.percent)} of ${memory.where}`} />
        <Figure theme={theme} label="CPU" value={report.sampling || report.host.cpuPercent === null ? "Measuring…" : formatPercent(report.host.cpuPercent)} percent={report.host.cpuPercent} tone={report.host.cpuPressure === "critical" ? "danger" : report.host.cpuPressure === "high" ? "warning" : "success"} hint={cpuHint} />
        <Figure theme={theme} label="Heavy jobs" value={`${jobs.count} of ${jobs.limit}`} percent={Math.min(100, (jobs.count / Math.max(1, jobs.limit)) * 100)} tone={jobs.count > jobs.limit ? "warning" : "success"} hint={`Builds, tests, type checks, installs and dev servers running now. ${jobs.limit} at once is the limit.`} />
      </View>
      <Meta theme={theme}>{`Paseo itself uses ${formatBytes(report.paseoBytes)}. ${report.total} processes in all.`}</Meta>
    </Card>
  );
}

/** Runaways: the one place this tab raises its voice, each with the decision it needs. */
function RunawayBanner({ theme, report, say, onDone, onJobs }: { theme: Theme; report: ProcessReport; say: Say; onDone(): void; onJobs(): void }) {
  if (report.runaways.length === 0) return null;
  const critical = report.runaways.some((runaway) => runaway.severity === "critical");
  const stoppable = new Set(report.processes.filter((row) => row.stoppable).map((row) => row.pid));
  // 0.13.0: the report says whether each runaway can be stopped, even when its row isn't on this page.
  const canStop = (runaway: ProcessReport["runaways"][number]) => runaway.stoppable ?? runaway.pids.some((pid) => stoppable.has(pid));
  return (
    <Banner theme={theme} tone={critical ? "danger" : "warning"} title={report.runaways.length === 1 ? "Something needs attention" : `${report.runaways.length} things need attention`}>
      {report.runaways.map((runaway, index) => (
        <View key={`${runaway.code}-${index}`} style={{ gap: SPACE.sm }}>
          <Note theme={theme}>{runaway.title}</Note>
          {runaway.code === "too-many-jobs" ? <Row><Button theme={theme} label="Show the heavy jobs" icon="ListFilter" onPress={onJobs} /></Row> : null}
          {(runaway.code === "cpu-runaway" || runaway.code === "memory-heavy") && runaway.pids.length ? (
            <Row>
              <AskAgentButton theme={theme} subject={{ kind: "process", pid: runaway.pids[0]! }} />
              {canStop(runaway) ? <StopProcess theme={theme} pid={runaway.pids[0]!} say={say} onDone={onDone} /> : null}
            </Row>
          ) : null}
        </View>
      ))}
    </Banner>
  );
}

const CHECK_SIZE = 22;

function Check({ theme, checked, label, onPress }: { theme: Theme; checked: boolean; label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }} hitSlop={SPACE.sm} onPress={onPress}
      style={{ width: CHECK_SIZE, height: CHECK_SIZE, borderRadius: SPACE.xs + SPACE.hair, borderWidth: 2, borderColor: checked ? theme.colors.accent : theme.colors.border, backgroundColor: checked ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center", marginTop: SPACE.hair }}>
      {checked && HostIcon ? <HostIcon name="Check" size={14} color={theme.colors.accentForeground} /> : null}
    </Pressable>
  );
}

/** Flat resource row with a visible, ask-first Stop and details kept folded. */
export function ProcessItem({ theme, hostId, row, compact, byTree, selected, onSelect, onStop, first, busy = false }: { theme: Theme; hostId?: string; row: ProcessRow; compact: boolean; byTree: boolean; selected: boolean; onSelect(): void; onStop(): void; first: boolean; twin: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const copy = useCopy();
  const cpu = byTree ? row.tree.cpuPercent : row.cpuPercent;
  const rss = byTree ? row.tree.rssBytes : row.rssBytes;
  const tag = row.job ? JOB_WORD[row.job.kind] : null;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: theme.colors.border, paddingVertical: SPACE.row, gap: SPACE.sm }}>
      <ResourceCells theme={theme} columns={PROCESS_COLUMNS} compact={compact} cells={{
        name: <View style={{ flexDirection: "row", gap: SPACE.sm, minWidth: 0 }}>
          {row.stoppable && row.actionToken ? <Check theme={theme} checked={selected} label={`Select ${row.name} (PID ${row.pid}) to stop`} onPress={onSelect} /> : null}
          <View style={{ flex: 1, minWidth: 0, gap: SPACE.xs }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${row.name}, PID ${row.pid}. ${open ? "Hide" : "Show"} details`} onPress={() => setOpen(!open)}>
              <ItemTitle theme={theme}>{row.name}</ItemTitle><Meta theme={theme}>{`PID ${row.pid}`}</Meta>
            </Pressable>
            {tag ? <Meta theme={theme}>{byTree && row.tree.count > 1 ? `${tag} · ${row.tree.count} processes` : tag}</Meta> : null}
            {row.ports.length ? <Meta theme={theme}>{row.ports.map((port) => `:${port}`).join(" ")}</Meta> : null}
            {row.flags.map((flag) => <Text key={flag.code} style={{ ...TYPE.small, color: toneColor(theme, "warning") }}>{flag.text}</Text>)}
          </View>
        </View>,
        attribution: <View style={{ gap: SPACE.xs, minWidth: 0 }}>
          <Meta theme={theme}>{row.owner.project ? ownerGroup(row.owner) : row.owner.label}</Meta>
          <Meta theme={theme}>{chatAttribution(row)}</Meta>
          {row.chat ? <Row><OpenChatButton theme={theme} agentId={row.chat.id} hostId={hostId} /></Row> : null}
        </View>,
        memory: <Note theme={theme}>{formatBytes(rss)}</Note>,
        cpu: <Note theme={theme}>{cpu === null ? "Measuring…" : formatPercent(cpu)}</Note>,
        age: <Note theme={theme}>{formatDuration(row.ageSeconds)}</Note>,
        actions: row.stoppable ? <Row><Button theme={theme} label="Stop…" icon="OctagonX" danger busy={busy} disabled={!row.actionToken || busy} accessibilityLabel={`Stop ${row.name} (PID ${row.pid})…`} onPress={onStop} /></Row>
          : <Meta theme={theme}>{row.protectedReason ?? "Protected: it can't be stopped here."}</Meta>,
      }} />
      {open ? (
        <View style={{ paddingLeft: compact ? 0 : CHECK_SIZE + SPACE.row, gap: SPACE.sm }}>
          <View style={{ backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.control, padding: SPACE.row }}>
            <Text selectable style={{ ...TYPE.mono, color: theme.colors.foreground }}>{row.command}</Text>
          </View>
          <Meta theme={theme}>{[`PID ${row.pid}`, `parent ${row.ppid}`, row.tree.count > 1 ? `${row.tree.count - 1} child process${row.tree.count === 2 ? "" : "es"}, ${formatBytes(row.tree.rssBytes)} together` : null].filter(Boolean).join(" · ")}</Meta>
          {row.where ?? row.cwd ? <PathLabel theme={theme} compact={compact} prefix="In " label={(row.where ?? row.cwd)!} /> : null}
          {row.cwdPath ?? row.cwd ? <PathDetails theme={theme} full={(row.cwdPath ?? row.cwd)!} /> : null}
          <Row>
            {row.flags.length ? <AskAgentButton theme={theme} subject={{ kind: "process", pid: row.pid }} /> : null}
            <Button theme={theme} label="Copy details" icon="Copy" accessibilityLabel={`Copy details of ${row.name} (PID ${row.pid})`} onPress={() => void copy(processDetails(row), "Details copied")} />
          </Row>
        </View>
      ) : null}
    </View>
  );
}

const ACTION_WORD: Record<ActionLogEntry["action"], string> = {
  stop: "Asked to stop", "force-stop": "Force stopped", "auto-force-stop": "Stopped forcefully",
  "plugin-reload": "Reloaded plugin", "plugin-stop": "Stopped stuck plugin", "plugin-force-stop": "Force stopped stuck plugin", "auto-stop": "Stopped automatically (memory nearly full)", "disk-clear": "Cleared build folder",
};

/** Every stop, newest first, from this host's action log: the content of the "Recent stops" fold-out. */
function RecentStops({ theme, entries }: { theme: Theme; entries: readonly ActionLogEntry[] }) {
  if (entries.length === 0) return <Note theme={theme}>Nothing has been stopped or restarted from Hosts yet.</Note>;
  return (
    <>
      {entries.map((entry, index) => (
        <View key={`${entry.at}-${index}`} style={{ gap: SPACE.hair }}>
          {index > 0 ? <Divider theme={theme} /> : null}
          <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{`${ACTION_WORD[entry.action]}: ${entry.name}${entry.pid ? ` (PID ${entry.pid})` : ""}`}</Text>
          <Meta theme={theme}>{[new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), entry.owner, entry.status === "signaled" ? `${entry.signaled} process${entry.signaled === 1 ? "" : "es"} signalled` : entry.status === "done" ? "done" : entry.status.replace(/-/g, " ")].filter(Boolean).join(" · ")}</Meta>
        </View>
      ))}
    </>
  );
}

/** The ask-first sheet: exactly what will be stopped (children too), what won't and why, and what happens next. */
export function StopSheet({ theme, plan, busy, onCancel, onConfirm }: { theme: Theme; plan: StopPlan | null; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const ready = plan?.targets.filter((target) => target.ok) ?? [];
  const refused = plan?.targets.filter((target) => !target.ok) ?? [];
  const children = ready.reduce((sum, target) => sum + target.children.length, 0);
  const title = ready.length === 1 ? `Stop ${ready[0]!.name}?` : `Stop ${ready.length} processes?`;
  // Single use (0.15.0): two quick presses stop once.
  const confirmOnce = useOnce(plan !== null, onConfirm);
  return (
    <Sheet title={plan ? (ready.length ? title : "Nothing can be stopped") : "Stop processes"} icon={HostIcon ? <HostIcon name="OctagonX" size={18} color={theme.colors.statusDanger} /> : undefined} open={plan !== null} busy={busy} onClose={() => onCancel()} colors={{ surface: theme.colors.surface1, border: theme.colors.border, foreground: theme.colors.foreground }}>
        <View style={{ gap: SPACE.row, padding: SPACE.card }}>
          {ready.length ? <DangerLine theme={theme}>{`This stops ${ready.length + children === 1 ? "this process" : `these ${ready.length + children} processes`}. Anything not saved in ${ready.length + children === 1 ? "it" : "them"} may be lost.`}</DangerLine> : null}
          {[...new Set(ready.flatMap((target) => [...(target.workspaceWarnings ?? []), ...(target.tagWarnings ?? [])]))].map((warning) => <DangerLine key={warning} theme={theme}>{warning}</DangerLine>)}
          {ready.some((target) => target.outsidePaseo) ? <DangerLine theme={theme}>{OUTSIDE_PASEO_WARNING}</DangerLine> : null}
          {ready.map((target) => (
            <View key={target.pid ?? target.name} style={{ gap: SPACE.hair }}>
              <ItemTitle theme={theme}>{`${target.name} (PID ${target.pid})`}</ItemTitle>
              <Meta theme={theme}>{[formatBytes(target.rssBytes), target.cpuPercent === null ? null : `${formatPercent(target.cpuPercent)} CPU`].filter(Boolean).join(" · ")}</Meta>
              {target.children.length ? <Meta theme={theme}>{`and ${target.children.length} child process${target.children.length === 1 ? "" : "es"}: ${summarizeNames(target.children.map((child) => child.name))}`}</Meta> : null}
            </View>
          ))}
          {refused.map((target, index) => (
            <View key={`refused-${index}`} style={{ gap: SPACE.hair }}>
              <ItemTitle theme={theme}>{`${target.name}${target.pid ? ` (PID ${target.pid})` : ""}: won't be stopped`}</ItemTitle>
              <Meta theme={theme}>{target.reason}</Meta>
            </View>
          ))}
          {ready.length ? (
            <Note theme={theme}>{`${ready.length + children === 1 ? "It is" : `These ${ready.length + children} processes are`} asked to stop first. Anything still running after ${plan!.graceSeconds} seconds is stopped forcefully, which can lose unsaved work. Every step is logged.`}</Note>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: SPACE.sm }}>
            {/* 0.16.0: like every warning dialog: Cancel is the default, Enter never stops anything. */}
            {plan ? <CancelButton theme={theme} label={ready.length ? "Cancel" : "Close"} onPress={onCancel} disabled={busy} /> : null}
            {ready.length ? <DestructiveButton theme={theme} label={ready.length + children === 1 ? "Stop it" : `Stop ${ready.length + children} processes`} busy={busy} onPress={confirmOnce} /> : null}
          </View>
        </View>
    </Sheet>
  );
}

/** "node ×3, esbuild" */
export function summarizeNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

/**
 * The Processes tab. Status first (runaways, then the load), then the list
 * with its controls, then the log; pointers last.
 */
export function ProcessesTab({ theme, compact, hostId, say, issues = [], onChanged }: { theme: Theme; compact: boolean; hostId: string; say: Say; issues?: readonly HealthIssue[]; onChanged?: () => void }) {
  const report = useRpc(processReport), preview = useRpc(processPreview), stop = useRpc(processStop);
  const [sort, setSort] = useState<ResourceSort<ReportSort>>({ id: "memory", direction: "desc" });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<StopPlan | null>(null);
  const [planTokens, setPlanTokens] = useState<string[]>([]);
  const closePlan = () => { setPlan(null); setPlanTokens([]); };
  const input = useMemo(() => ({ sort: sort.id, direction: sort.direction, filter, query: search.trim(), limit: PAGE, offset }), [sort, filter, search, offset]);
  const query = useQuery({ queryKey: [...processesKey(hostId), input], queryFn: () => report(input), refetchInterval: POLL_MS, placeholderData: keepPreviousData, retry: 1 });
  const data = query.data;
  const rows = query.isPlaceholderData ? [] : data?.processes ?? [];

  useEffect(() => {
    const tokens = new Set(data?.processes.filter((row) => row.stoppable).map((row) => row.actionToken));
    setSelected((current) => [...current].every((token) => tokens.has(token)) ? current : new Set([...current].filter((token) => tokens.has(token))));
  }, [data]);

  const ask = useMutation({
    mutationFn: async (tokens: string[]) => {
      if (!tokens.length || tokens.length > STOP_BATCH_MAX) throw new Error(`Select up to ${STOP_BATCH_MAX} processes.`);
      return { plan: await preview({ tokens }), tokens };
    },
    onSuccess: ({ plan, tokens }) => { setPlanTokens(tokens); setPlan(plan); },
    onError: (error) => say({ text: errorText(error), tone: "danger" }),
  });
  const confirm = useMutation({
    mutationFn: () => stop({ tokens: planTokens }),
    onSuccess: (outcome) => {
      closePlan();
      setSelected(new Set());
      const failed = outcome.results.filter((result) => !result.ok);
      say({ text: outcome.results.map((result) => (result.ok ? result.message : `${result.name}: ${result.message}`)).join(" "), tone: failed.length === outcome.results.length ? "danger" : failed.length ? "warning" : "success" });
      void query.refetch();
    },
    onError: (error) => { closePlan(); say({ text: errorText(error), tone: "danger" }); },
  });

  if (!data) {
    return query.error
      ? <Banner theme={theme} tone="danger" title="This host's processes couldn't be read"><Note theme={theme}>{query.error instanceof Error ? query.error.message : String(query.error)}</Note><Row><Button theme={theme} label="Try again" onPress={() => void query.refetch()} /></Row></Banner>
      : <View style={{ padding: SPACE.section, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /></View>;
  }
  if (!data.supported) return <><HousekeepingSection theme={theme} hostId={hostId} compact={compact} /><Banner theme={theme} tone="neutral" title="Not available on this host">{data.warnings.map((warning) => <Note key={warning} theme={theme}>{warning}</Note>)}</Banner></>;

  const toggle = (token: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(token)) next.delete(token); else if (next.size < STOP_BATCH_MAX) next.add(token);
    return next;
  });
  const chosen = [...selected].filter((token) => rows.some((row) => row.actionToken === token && row.stoppable));
  const byTree = filter === "jobs";
  const resetPage = () => { setOffset(0); setSelected(new Set()); };
  return (
    <>
      {issues.some((issue) => issue.code === "plugin-stuck") ? (
        <Banner theme={theme} tone={issues.some((issue) => issue.code === "plugin-stuck" && issue.severity === "critical") ? "danger" : "warning"} title="A Paseo plugin isn't answering">
          <StuckPlugins theme={theme} issues={issues} say={say} onDone={() => { onChanged?.(); void query.refetch(); }} />
        </Banner>
      ) : null}
      <RunawayBanner theme={theme} report={data} say={say} onDone={() => { onChanged?.(); void query.refetch(); }} onJobs={() => { setFilter("jobs"); resetPage(); }} />
      <LoadCard theme={theme} report={data} />
      <HousekeepingSection theme={theme} hostId={hostId} compact={compact} />
      <Card theme={theme} title={filter === "jobs" ? "Heavy jobs" : "Processes"} icon="ListOrdered" subtitle={filter === "jobs" ? "Each job with everything it started, added together" : "Your processes, sorted across the whole host"}>
        <ResourceToolbar theme={theme} label="Search processes" search={search} onSearch={(text) => { setSearch(text); resetPage(); }} filters={FILTERS} filter={filter} onFilter={(next) => { setFilter(next as Filter); resetPage(); }} />
        {query.isFetching ? <Row><ActivityIndicator size="small" color={theme.colors.accent} /><Meta theme={theme}>Updating processes…</Meta></Row> : null}
        {query.error ? <Note theme={theme} tone="warning">{`Couldn't update processes: ${errorText(query.error)}`}</Note> : null}
        {chosen.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm, padding: SPACE.row, borderRadius: RADIUS.control, backgroundColor: tint(theme.colors.statusDanger, 0.07) ?? theme.colors.surface2 }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1, minWidth: 160 }}>{`${chosen.length} selected`}</Text>
            <Button theme={theme} label="Clear" onPress={() => setSelected(new Set())} />
            <Button theme={theme} label={`Stop ${chosen.length} selected…`} icon="OctagonX" danger busy={ask.isPending} disabled={ask.isPending || plan !== null} onPress={() => ask.mutate(chosen)} />
          </View>
        ) : null}
        <ResourceTable compact={compact}>{(narrow) => <>
          <ResourceHeader theme={theme} columns={PROCESS_COLUMNS} compact={narrow} sort={sort} onSort={(id) => { setSort(nextResourceSort(sort, id as ReportSort)); resetPage(); }} />
          {!rows.length && !query.isPlaceholderData ? <Note theme={theme}>{`No processes match these filters${search ? ` and "${search}"` : ""}. Try Everything or clear the search.`}</Note> : null}
          {rows.map((row, index) => <ProcessItem key={processActionKey(row)} hostId={hostId} theme={theme} row={row} compact={narrow} byTree={byTree} first={index === 0} twin={false} selected={selected.has(processActionKey(row))} onSelect={() => row.actionToken && toggle(row.actionToken)} busy={ask.isPending || plan !== null} onStop={() => row.actionToken && ask.mutate([row.actionToken])} />)}
        </>}</ResourceTable>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm }}>
          <Meta theme={theme}>{`${rows.length ? offset + 1 : 0}–${offset + rows.length} of ${data.matched}${data.matched !== data.total ? ` matching (${data.total} in all)` : ""} · updated ${new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}</Meta>
          {offset > 0 ? <Button theme={theme} label="Previous page" disabled={query.isPlaceholderData} onPress={() => { setOffset(Math.max(0, offset - PAGE)); setSelected(new Set()); }} /> : null}
          {data.matched > offset + PAGE ? <Button theme={theme} label="Next page" disabled={query.isPlaceholderData} onPress={() => { setOffset(offset + PAGE); setSelected(new Set()); }} /> : null}
        </View>
      </Card>
      {!data.projectsVerified ? <QuietLine theme={theme} icon="ShieldAlert">Paseo projects aren't verified on this host right now, so some workspace and chat names may be missing. Stop still checks every protection rule.</QuietLine> : null}
      <Accordion theme={theme}>
        <AccordionItem theme={theme} compact={compact} icon="History" title="Recent stops and restarts" summary={data.recentActions.length ? `${data.recentActions.length} logged · last: ${data.recentActions[0]!.name}` : "None yet"}>
          <RecentStops theme={theme} entries={data.recentActions} />
        </AccordionItem>
        <AccordionItem theme={theme} compact={compact} icon="ShieldCheck" title="What can be stopped here" summary="Your own jobs, after a warning; protected programs explain why">
          <Note theme={theme}>Your own processes can be stopped after a warning. Processes started outside Paseo get an extra warning. Paseo itself, its plugins, agent programs, terminal shells, databases, system services and Mac desktop apps stay protected. Manual stops ask first. The optional memory guard and confirmed live Housekeeping can stop eligible jobs automatically; Housekeeping has a narrow exception for browsers owned by finished chats.</Note>
          <Meta theme={theme}>A stop asks the process to finish first and forces it only if it is still running after the grace period. Each one is logged, without command lines (where: Overview → Technical details).</Meta>
        </AccordionItem>
      </Accordion>
      <StopSheet theme={theme} plan={plan} busy={confirm.isPending} onCancel={closePlan} onConfirm={() => confirm.mutate()} />
    </>
  );
}
