import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { processPreview, processReport, processStop, sameness, twinKeys, type ActionLogEntry, type ProcessReport, type ProcessRow, type ReportSort, type StopPlan } from "../shared/processes";
import { Accordion, AccordionItem, Banner, Button, Card, Chip, Divider, HostIcon, ItemTitle, Meta, Note, QuietLine, RADIUS, Row, SPACE, TYPE, tint, toneColor, type Tone } from "./kit";
import { formatBytes, formatDuration, formatPercent } from "./ui";
import { AskAgentButton } from "./ask";
import { StopProcess, StuckPlugins } from "./guard";
import type { HealthIssue } from "../shared/health";

type Theme = PluginTheme;
export type Say = (message: { text: string; tone: Tone } | null) => void;
type Filter = "all" | "jobs" | "stoppable";

const PAGE = 25;
const POLL_MS = 5000;
const SORTS: ReadonlyArray<{ id: ReportSort; label: string }> = [
  { id: "cpu", label: "CPU" },
  { id: "memory", label: "Memory" },
  { id: "age", label: "Age" },
  { id: "name", label: "Name" },
];
const SORTED: Record<ReportSort, string> = { cpu: "Most CPU first", memory: "Most memory first", age: "Running longest first", name: "By name" };
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "jobs", label: "Heavy jobs" },
  { id: "stoppable", label: "Can stop here" },
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

function Pills<Id extends string>({ theme, label, items, value, onChange }: { theme: Theme; label: string; items: ReadonlyArray<{ id: Id; label: string }>; value: Id; onChange(id: Id): void }) {
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm }}>
      <Text style={{ ...TYPE.secondary, color: theme.colors.foregroundMuted, width: 56 }}>{label}</Text>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={`${label}: ${item.label}`} accessibilityState={{ selected }} onPress={() => onChange(item.id)}
            style={{ borderRadius: RADIUS.pill, borderWidth: 1, borderColor: selected ? theme.colors.accent : theme.colors.border, backgroundColor: selected ? tint(theme.colors.accent, 0.12) ?? theme.colors.surface2 : "transparent", paddingHorizontal: SPACE.row, paddingVertical: SPACE.xs + SPACE.hair }}>
            <Text style={{ ...TYPE.secondary, color: selected ? theme.colors.accent : theme.colors.foreground, fontWeight: selected ? "700" : "500" }}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
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

function Stat({ theme, label, value, tone }: { theme: Theme; label: string; value: string; tone?: Tone }) {
  return (
    <View style={{ minWidth: 72 }}>
      <Text style={{ ...TYPE.secondary, color: tone && tone !== "neutral" ? toneColor(theme, tone) : theme.colors.foreground, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text style={{ ...TYPE.small, color: theme.colors.foregroundMuted }}>{label}</Text>
    </View>
  );
}

/** One process: name, what it is, whose it is, its figures; details and the stop control behind a press. */
function ProcessItem({ theme, row, compact, byTree, selected, onSelect, onStop, first, twin }: { theme: Theme; row: ProcessRow; compact: boolean; byTree: boolean; selected: boolean; onSelect(): void; onStop(): void; first: boolean; twin: boolean }) {
  const [open, setOpen] = useState(false);
  const flagged = row.flags.length > 0;
  const cpu = byTree ? row.tree.cpuPercent : row.cpuPercent;
  const rss = byTree ? row.tree.rssBytes : row.rssBytes;
  const tag = row.job ? JOB_WORD[row.job.kind] : null;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: theme.colors.border, paddingVertical: SPACE.row, gap: SPACE.sm }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
        {row.stoppable ? <Check theme={theme} checked={selected} label={`Select ${row.name} (PID ${row.pid}) to stop`} onPress={onSelect} /> : <View style={{ width: CHECK_SIZE }} />}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${row.name}, PID ${row.pid}. ${open ? "Hide" : "Show"} details`} onPress={() => setOpen(!open)}
          style={{ flex: 1, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: SPACE.sm }}>
          <View style={{ flex: 1, gap: SPACE.hair, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACE.sm }}>
              <ItemTitle theme={theme}>{row.name}</ItemTitle>
              {tag ? <Chip theme={theme} label={byTree && row.tree.count > 1 ? `${tag} · ${row.tree.count} processes` : tag} tone={flagged ? "warning" : "neutral"} /> : flagged ? <Chip theme={theme} label="Needs attention" tone="warning" /> : null}
            </View>
            <Meta theme={theme}>{row.owner.label}{row.ports.length ? ` · ${row.ports.map((port) => `:${port}`).join(" ")}` : ""}{twin ? ` · PID ${row.pid}` : ""}</Meta>
            {row.flags.map((flag) => <Text key={flag.code} style={{ ...TYPE.secondary, color: toneColor(theme, "warning") }}>{flag.text}</Text>)}
          </View>
          <View style={{ flexDirection: "row", gap: SPACE.row, flexWrap: "wrap" }}>
            <Stat theme={theme} label="CPU" value={cpu === null ? "…" : formatPercent(cpu)} tone={row.hotSeconds >= 120 ? "warning" : undefined} />
            <Stat theme={theme} label="Memory" value={formatBytes(rss)} tone={row.flags.some((flag) => flag.code === "memory-heavy") ? "warning" : undefined} />
            <Stat theme={theme} label="Running" value={formatDuration(row.ageSeconds)} />
          </View>
        </Pressable>
      </View>
      {open ? (
        <View style={{ paddingLeft: CHECK_SIZE + SPACE.row, gap: SPACE.sm }}>
          <View style={{ backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.control, padding: SPACE.row }}>
            <Text selectable style={{ ...TYPE.mono, color: theme.colors.foreground }}>{row.command}</Text>
          </View>
          <Meta theme={theme}>{[`PID ${row.pid}`, `parent ${row.ppid}`, row.cwd ? `in ${row.cwd}` : null, row.tree.count > 1 ? `${row.tree.count - 1} child process${row.tree.count === 2 ? "" : "es"}, ${formatBytes(row.tree.rssBytes)} together` : null].filter(Boolean).join(" · ")}</Meta>
          {row.stoppable || row.flags.length ? (
            <Row>
              {row.flags.length ? <AskAgentButton theme={theme} subject={{ kind: "process", pid: row.pid }} /> : null}
              {row.stoppable ? <Button theme={theme} label="Stop…" icon="OctagonX" danger accessibilityLabel={`Stop ${row.name} (PID ${row.pid})…`} onPress={onStop} /> : null}
            </Row>
          ) : null}
          {!row.stoppable ? <Note theme={theme}>{row.protectedReason ?? "It can't be stopped here."}</Note> : null}
        </View>
      ) : null}
    </View>
  );
}

const ACTION_WORD: Record<ActionLogEntry["action"], string> = {
  stop: "Asked to stop", "force-stop": "Force stopped", "auto-force-stop": "Stopped forcefully",
  "plugin-reload": "Reloaded plugin", "plugin-stop": "Stopped stuck plugin", "plugin-force-stop": "Force stopped stuck plugin", "auto-stop": "Stopped automatically (memory nearly full)",
  "disk-clear": "Cleared to free space", "disk-prune": "Pruned pnpm's store",
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
  return (
    <Modal title={plan ? (ready.length ? title : "Nothing can be stopped") : "Stop processes"} icon={HostIcon ? <HostIcon name="OctagonX" size={18} color={theme.colors.statusDanger} /> : undefined} open={plan !== null} onOpenChange={(open: boolean) => { if (!open && !busy) onCancel(); }}>
      <Modal.Content>
        <View style={{ gap: SPACE.row, padding: SPACE.card }}>
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
            <Button theme={theme} label={ready.length ? "Cancel" : "Close"} onPress={onCancel} disabled={busy} />
            {ready.length ? <Button theme={theme} label={ready.length + children === 1 ? "Stop it" : `Stop ${ready.length + children} processes`} icon="OctagonX" danger busy={busy} onPress={onConfirm} /> : null}
          </View>
        </View>
      </Modal.Content>
    </Modal>
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
  const [sort, setSort] = useState<ReportSort>("cpu");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [plan, setPlan] = useState<StopPlan | null>(null);
  const [planTokens, setPlanTokens] = useState<string[]>([]);
  const input = useMemo(() => ({ sort, filter, query: search.trim(), limit, offset: 0 }), [sort, filter, search, limit]);
  const query = useQuery({ queryKey: [...processesKey(hostId), input], queryFn: () => report(input), refetchInterval: POLL_MS, placeholderData: keepPreviousData, retry: 1 });
  const data = query.data;
  const rows = data?.processes ?? [];

  const ask = useMutation({
    mutationFn: async (pids: number[]) => {
      const tokens = rows.filter((row) => pids.includes(row.pid) && row.actionToken).map((row) => row.actionToken!);
      if (tokens.length === 0) throw new Error("Those processes have changed. Refresh and try again.");
      setPlanTokens(tokens);
      return preview({ tokens });
    },
    onSuccess: setPlan,
    onError: (error) => say({ text: error instanceof Error ? error.message : String(error), tone: "danger" }),
  });
  const confirm = useMutation({
    mutationFn: () => stop({ tokens: planTokens }),
    onSuccess: (outcome) => {
      setPlan(null);
      setSelected(new Set());
      const failed = outcome.results.filter((result) => !result.ok);
      say({ text: outcome.results.map((result) => (result.ok ? result.message : `${result.name}: ${result.message}`)).join(" "), tone: failed.length === outcome.results.length ? "danger" : failed.length ? "warning" : "success" });
      void query.refetch();
    },
    onError: (error) => { setPlan(null); say({ text: error instanceof Error ? error.message : String(error), tone: "danger" }); },
  });

  if (!data) {
    return query.error
      ? <Banner theme={theme} tone="danger" title="This host's processes couldn't be read"><Note theme={theme}>{query.error instanceof Error ? query.error.message : String(query.error)}</Note><Row><Button theme={theme} label="Try again" onPress={() => void query.refetch()} /></Row></Banner>
      : <View style={{ padding: SPACE.section, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /></View>;
  }
  if (!data.supported) return <Banner theme={theme} tone="neutral" title="Not available on this host">{data.warnings.map((warning) => <Note key={warning} theme={theme}>{warning}</Note>)}</Banner>;

  const toggle = (pid: number) => setSelected((previous) => { const next = new Set(previous); if (next.has(pid)) next.delete(pid); else next.add(pid); return next; });
  const chosen = [...selected].filter((pid) => rows.some((row) => row.pid === pid && row.stoppable));
  const byTree = filter === "jobs";
  const twins = twinKeys(rows);
  return (
    <>
      {issues.some((issue) => issue.code === "plugin-stuck") ? (
        <Banner theme={theme} tone={issues.some((issue) => issue.code === "plugin-stuck" && issue.severity === "critical") ? "danger" : "warning"} title="A Paseo plugin isn't answering">
          <StuckPlugins theme={theme} issues={issues} say={say} onDone={() => { onChanged?.(); void query.refetch(); }} />
        </Banner>
      ) : null}
      <RunawayBanner theme={theme} report={data} say={say} onDone={() => { onChanged?.(); void query.refetch(); }} onJobs={() => { setFilter("jobs"); setLimit(PAGE); }} />
      <LoadCard theme={theme} report={data} />
      <Card theme={theme} title={filter === "jobs" ? "Heavy jobs" : "Heaviest processes"} icon="ListOrdered" subtitle={filter === "jobs" ? "Each job with everything it started, added together" : SORTED[sort]}>
        <Pills<Filter> theme={theme} label="Show" items={FILTERS} value={filter} onChange={(next) => { setFilter(next); setLimit(PAGE); }} />
        <Pills<ReportSort> theme={theme} label="Sort" items={SORTS} value={sort} onChange={setSort} />
        <TextInput accessibilityLabel="Search processes" value={search} onChangeText={(text) => { setSearch(text); setLimit(PAGE); }} placeholder="Search by name, workspace, folder or PID" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
          style={{ ...TYPE.body, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.control, paddingHorizontal: SPACE.row, paddingVertical: SPACE.sm + SPACE.hair }} />
        {chosen.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm, padding: SPACE.row, borderRadius: RADIUS.control, backgroundColor: tint(theme.colors.statusDanger, 0.07) ?? theme.colors.surface2 }}>
            <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1, minWidth: 160 }}>{`${chosen.length} selected`}</Text>
            <Button theme={theme} label="Clear" onPress={() => setSelected(new Set())} />
            <Button theme={theme} label={`Stop ${chosen.length} selected…`} icon="OctagonX" danger busy={ask.isPending} onPress={() => ask.mutate(chosen)} />
          </View>
        ) : null}
        {rows.length === 0 ? (
          <Note theme={theme}>{search ? `Nothing matches "${search}".` : filter === "jobs" ? "No builds, tests, type checks, installs or dev servers are running." : filter === "stoppable" ? "Nothing here can be stopped right now." : "No processes."}</Note>
        ) : (
          <View>{rows.map((row, index) => <ProcessItem key={`${row.pid}-${row.name}`} theme={theme} row={row} compact={compact} byTree={byTree} first={index === 0} twin={twins.has(sameness(row))} selected={selected.has(row.pid)} onSelect={() => toggle(row.pid)} onStop={() => ask.mutate([row.pid])} />)}</View>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm }}>
          <Meta theme={theme}>{`${rows.length} of ${data.matched}${data.matched !== data.total ? ` matching (${data.total} in all)` : ""} · updated ${new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}</Meta>
          {data.matched > rows.length ? <Button theme={theme} label="Show more" onPress={() => setLimit(limit + PAGE)} /> : null}
        </View>
      </Card>
      {!data.projectsVerified ? <QuietLine theme={theme} icon="ShieldAlert">Paseo projects aren't verified on this host right now, so workspace names are missing and only processes started from Paseo can be stopped.</QuietLine> : null}
      <Accordion theme={theme}>
        <AccordionItem theme={theme} compact={compact} icon="History" title="Recent stops and restarts" summary={data.recentActions.length ? `${data.recentActions.length} logged · last: ${data.recentActions[0]!.name}` : "None yet"}>
          <RecentStops theme={theme} entries={data.recentActions} />
        </AccordionItem>
        <AccordionItem theme={theme} compact={compact} icon="ShieldCheck" title="What can be stopped here" summary="Only your own projects' jobs, and always after asking">
          <Note theme={theme}>Only processes started from Paseo or running inside your Paseo projects can be stopped here. Paseo itself, its plugins, agents, terminals and databases never are. Nothing is stopped without asking, unless you turn on the memory guard in Settings → Hosts.</Note>
          <Meta theme={theme}>A stop asks the process to finish first and forces it only if it is still running after the grace period. Each one is logged, without command lines (where: Overview → Technical details).</Meta>
        </AccordionItem>
      </Accordion>
      <StopSheet theme={theme} plan={plan} busy={confirm.isPending} onCancel={() => setPlan(null)} onConfirm={() => confirm.mutate()} />
    </>
  );
}
