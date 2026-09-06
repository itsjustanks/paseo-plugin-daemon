import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/react-native";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { HISTORY_LENGTH, POLL_INTERVAL_MS, series, useAge, useDebounced, useHistory } from "./history";
import { PROCESS_LIMIT, SORTS, processKey, useMonitorRpc, type Impact, type PressureState, type Process, type Snapshot, type Sort } from "./rpc";
import {
  Button,
  Card,
  ConfirmButton,
  Facts,
  Grid,
  IconButton,
  Meter,
  Notice,
  Section,
  Segmented,
  Spark,
  StatusPill,
  Tag,
  TokensProvider,
  alpha,
  formatBytes,
  formatDuration,
  formatLoad,
  formatPercent,
  toneColor,
  useTokens,
  useUi,
  type Tone,
} from "./ui";

// ------------------------------------------------------------------ config

const QUERY_KEY = ["monitor", "snapshot"] as const;
/** Older than this and the header says "stale"; two missed polls plus slack. */
const STALE_AFTER_SECONDS = 6;
/** Polls a graceful-stopped process may survive before Force Stop is offered. */
const FORCE_AFTER_POLLS = 3;
/** Pending stops older than this are dropped so a reused PID cannot inherit them. */
const PENDING_TTL_MS = 60_000;

type Tab = "overview" | "processes";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "processes", label: "Processes" },
];

function pressureTone(state: PressureState): Tone {
  return state === "critical" ? "danger" : state === "high" ? "warning" : "ok";
}

function pressureLabel(state: PressureState): string {
  return state === "critical" ? "Critical pressure" : state === "high" ? "High pressure" : "Normal";
}

function impactTone(impact: Impact): Tone {
  return impact === "pressure-driver" ? "danger" : impact === "high" ? "warning" : "neutral";
}

function impactLabel(impact: Impact): string {
  return impact === "pressure-driver" ? "Likely pressure driver" : impact === "high" ? "High" : impact === "idle" ? "Idle" : "Normal";
}

function stateTone(state: string): Tone {
  const lower = state.toLowerCase();
  if (lower.startsWith("z")) return "warning";
  if (lower.startsWith("r")) return "accent";
  return "neutral";
}

// ------------------------------------------------------------ pending stops

interface PendingStop {
  key: string;
  name: string;
  pid: number;
  startedAt: number;
  /** Polls in which the identity was still present after the graceful attempt. */
  survivedPolls: number;
}

/**
 * Tracks graceful stops so the UI can (a) show "stopping…" and (b) promote the
 * control to Force Stop after the process outlives several polls. The server
 * gate is the real guard; this just decides when to show the option.
 */
function usePendingStops(snapshot: Snapshot | undefined) {
  const [pending, setPending] = useState<Record<string, PendingStop>>({});
  const lastAt = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot || snapshot.timestamp === lastAt.current) return;
    lastAt.current = snapshot.timestamp;
    const alive = new Set<string>();
    for (const process of snapshot.processes.items) alive.add(processKey(process));
    for (const process of snapshot.services) alive.add(processKey(process));
    const now = Date.now();
    setPending((previous) => {
      let changed = false;
      const next: Record<string, PendingStop> = {};
      for (const entry of Object.values(previous)) {
        if (now - entry.startedAt > PENDING_TTL_MS) {
          changed = true;
          continue;
        }
        if (alive.has(entry.key)) {
          next[entry.key] = { ...entry, survivedPolls: entry.survivedPolls + 1 };
          changed = true;
        } else {
          // Gone from the page; either exited or filtered out. Keep it one more
          // poll so a filtered-out row does not silently lose its state.
          if (entry.survivedPolls > 0) {
            changed = true;
            continue;
          }
          next[entry.key] = { ...entry, survivedPolls: 1 };
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [snapshot]);

  const mark = useCallback((process: Process) => {
    const key = processKey(process);
    setPending((previous) => ({ ...previous, [key]: { key, name: process.name, pid: process.pid, startedAt: Date.now(), survivedPolls: 0 } }));
  }, []);

  const clear = useCallback((key: string) => {
    setPending((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  return { pending, mark, clear };
}

// ----------------------------------------------------------------- surface

export function MonitorSurface({ theme, layout, host }: PluginSurfaceProps) {
  const t = useUi(theme, layout.compact);
  return (
    <TokensProvider value={t}>
      <MonitorBody key={host.id} hostId={host.id} />
    </TokensProvider>
  );
}

function MonitorBody({ hostId }: { hostId: string }) {
  const t = useTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rpc = useMonitorRpc();

  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("cpu");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const chooseSort = (next: Sort) => {
    setDirection(next === sort ? direction === "asc" ? "desc" : "asc" : ["name", "pid"].includes(next) ? "asc" : "desc");
    setSort(next); setOffset(0);
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const [forceTarget, setForceTarget] = useState<Process | null>(null);
  const query = useDebounced(search.trim(), 250);

  // The Overview never filters, so it always asks for the unfiltered top slice.
  // The Processes tab asks with the user's query and sort. One query key per
  // shape keeps the cache honest and last-good data survives a refetch.
  const input = useMemo(
    () => (tab === "processes" ? { query, sort, direction, offset, limit: PROCESS_LIMIT } : { query: "", sort: "cpu" as Sort, limit: PROCESS_LIMIT }),
    [tab, query, sort, direction, offset],
  );
  const snapshotQuery = useQuery({
    queryKey: [...QUERY_KEY, hostId, input],
    queryFn: () => rpc.snapshot(input),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 0,
    gcTime: 30_000,
  });

  const snapshot = snapshotQuery.data;
  useEffect(() => { if (snapshot && offset >= snapshot.processes.total && offset > 0) setOffset(0); }, [snapshot, offset]);
  const history = useHistory(snapshot);
  const age = useAge(snapshotQuery.dataUpdatedAt || undefined);
  const stale = snapshotQuery.isError || (age !== null && age > STALE_AFTER_SECONDS);
  const { pending, mark, clear } = usePendingStops(snapshot);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const stopMutation = useMutation({
    mutationFn: async (process: Process) => {
      if (!process.actionToken) throw new Error("This process cannot be stopped from Monitor.");
      return rpc.stop({ token: process.actionToken });
    },
    onSuccess: (result, process) => {
      if (result.status === "already-exited") {
        toast.show(`${process.name} (PID ${process.pid}) had already exited`, { variant: "success" });
      } else if (result.ok) {
        mark(process);
        toast.show(`Asked ${process.name} (PID ${process.pid}) to stop`, { variant: "info" });
      } else {
        toast.error(result.message || `Could not stop ${process.name}`);
      }
      refresh();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const forceMutation = useMutation({
    mutationFn: async (process: Process) => {
      if (!process.actionToken) throw new Error("This process cannot be stopped from Monitor.");
      return rpc.forceStop({ token: process.actionToken });
    },
    onSuccess: (result, process) => {
      setForceTarget(null);
      if (result.ok || result.status === "already-exited") {
        clear(processKey(process));
        toast.show(result.status === "already-exited" ? `${process.name} (PID ${process.pid}) had already exited` : `Force stopped ${process.name} (PID ${process.pid})`, { variant: "success" });
      } else if (result.status === "needs-graceful-first") {
        toast.show(result.message || `Try a graceful stop of ${process.name} first`, { variant: "warning" });
      } else {
        toast.error(result.message || `Could not force stop ${process.name}`);
      }
      refresh();
    },
    onError: (error) => {
      setForceTarget(null);
      toast.error(errorText(error));
    },
  });

  // Keep the modal's target fresh so the token it sends is the latest one.
  const liveForceTarget = useMemo(() => {
    if (!forceTarget || !snapshot) return forceTarget;
    const key = processKey(forceTarget);
    return [...snapshot.processes.items, ...snapshot.services].find((process) => processKey(process) === key) ?? forceTarget;
  }, [forceTarget, snapshot]);

  const actions = {
    pending,
    onStop: (process: Process) => stopMutation.mutate(process),
    onForce: (process: Process) => setForceTarget(process),
    stopping: stopMutation.isPending ? stopMutation.variables : undefined,
  };

  const serviceCount = snapshot?.services.length ?? 0;
  const processCount = snapshot?.processes.total ?? 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.color.surface0 }}
      contentContainerStyle={{ padding: t.compact ? 16 : 24, paddingTop: t.compact ? 16 : 28, paddingBottom: 48, alignItems: "stretch" }}
    >
      <View style={{ width: "100%", maxWidth: t.maxWidth, alignSelf: "center", gap: t.space.lg }}>
        <Header snapshot={snapshot} age={age} stale={stale} fetching={snapshotQuery.isFetching} onRefresh={refresh} />

        <Notice icon="ShieldCheck">CPU and memory cover the whole machine. The process table only includes verified Paseo project/workspace processes. Agent tools are read-only; stop controls are limited to project dev servers.</Notice>
        {snapshot?.scope?.status === "unavailable" && <Notice icon="ShieldAlert" tone="warning">{snapshot.scope.message}</Notice>}
        <Segmented
          label="Daemon Health views"
          options={[
            { id: "overview", label: "System overview", badge: serviceCount > 0 ? String(serviceCount) : undefined },
            { id: "processes", label: "Project processes", badge: processCount > 0 ? String(processCount) : undefined },
          ]}
          value={tab}
          onChange={(next) => {
            setTab(next);
            setExpanded(null);
          }}
        />

        {snapshotQuery.isError ? (
          <Notice icon="CircleAlert" tone="danger" action={<Button label="Retry" onPress={refresh} loading={snapshotQuery.isFetching} />}>
            {snapshot ? `Latest sample failed: ${errorText(snapshotQuery.error)}. Showing the last good data.` : `Could not read the machine: ${errorText(snapshotQuery.error)}`}
          </Notice>
        ) : null}

        {!snapshot && snapshotQuery.isPending ? (
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <ActivityIndicator size="small" color={t.color.muted} />
              <Text style={t.text.body}>Reading the machine…</Text>
            </View>
          </Card>
        ) : null}

        {snapshot && !snapshot.supported ? (
          <Notice icon="TriangleAlert" tone="warning">
            Monitor does not support this platform ({snapshot.platform}). Values shown are read-only and may be incomplete; stopping processes is disabled.
          </Notice>
        ) : null}

        {snapshot?.warnings.map((warning) => (
          <Notice key={warning} icon="TriangleAlert" tone="warning">
            {warning}
          </Notice>
        ))}

        {snapshot ? (
          tab === "overview" ? (
            <Overview snapshot={snapshot} history={history} expanded={expanded} setExpanded={setExpanded} actions={actions} />
          ) : (
            <Processes
              snapshot={snapshot}
              search={search}
              setSearch={(value) => { setSearch(value); setOffset(0); }}
              sort={sort}
              setSort={chooseSort}
              direction={direction}
              offset={offset}
              setOffset={setOffset}
              settling={query !== search.trim() || (snapshotQuery.isFetching && snapshotQuery.isPlaceholderData)}
              expanded={expanded}
              setExpanded={setExpanded}
              actions={actions}
            />
          )
        ) : null}
      </View>

      <ForceStopModal target={liveForceTarget} busy={forceMutation.isPending} onCancel={() => setForceTarget(null)} onConfirm={(process) => forceMutation.mutate(process)} />
    </ScrollView>
  );
}

// ------------------------------------------------------------------ header

function Header({ snapshot, age, stale, fetching, onRefresh }: { snapshot: Snapshot | undefined; age: number | null; stale: boolean; fetching: boolean; onRefresh: () => void }) {
  const t = useTokens();
  const status: { tone: Tone; label: string } = !snapshot
    ? { tone: "neutral", label: "Connecting" }
    : stale
      ? { tone: "warning", label: age === null ? "Stale" : `Stale · ${formatDuration(age)} ago` }
      : snapshot.sampling
        ? { tone: "accent", label: "Sampling" }
        : { tone: "ok", label: "Live" };
  const subtitle = snapshot
    ? `${snapshot.platform} · ${snapshot.system.cpu.cores} cores · up ${formatDuration(snapshot.system.uptimeSeconds)}`
    : "CPU, memory, dev servers and the processes behind the load.";
  return (
    <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", justifyContent: "space-between", gap: t.space.md }}>
      <View style={{ gap: 2, flexShrink: 1 }}>
        <Text style={t.text.title}>Daemon Health</Text>
        <Text style={t.text.caption}>{subtitle}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: t.compact ? "space-between" : "flex-end", gap: t.space.md }}>
        <StatusPill tone={status.tone} label={status.label} />
        <IconButton icon="RefreshCw" label="Refresh now" onPress={onRefresh} loading={fetching && !snapshot} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- overview

interface RowActions {
  pending: Record<string, PendingStop>;
  onStop: (process: Process) => void;
  onForce: (process: Process) => void;
  stopping: Process | undefined;
}

function Overview({
  snapshot,
  history,
  expanded,
  setExpanded,
  actions,
}: {
  snapshot: Snapshot;
  history: ReturnType<typeof useHistory>;
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  actions: RowActions;
}) {
  const t = useTokens();
  const { cpu, memory } = snapshot.system;
  const memoryPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  const worst: PressureState = cpu.pressure.state === "critical" || memory.pressure.state === "critical" ? "critical" : cpu.pressure.state === "high" || memory.pressure.state === "high" ? "high" : "normal";
  const reasons = [...cpu.pressure.reasons, ...memory.pressure.reasons];
  const drivers = [...snapshot.processes.items, ...snapshot.services]
    .filter((process, index, all) => all.findIndex((other) => processKey(other) === processKey(process)) === index)
    .filter((process) => process.impact === "pressure-driver" || process.impact === "high")
    .sort((a, b) => (b.impact === "pressure-driver" ? 1 : 0) - (a.impact === "pressure-driver" ? 1 : 0) || (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    .slice(0, 6);

  return (
    <View style={{ gap: t.space.lg }}>
      {worst !== "normal" ? (
        <Notice icon={worst === "critical" ? "OctagonX" : "TriangleAlert"} tone={pressureTone(worst)}>
          {pressureLabel(worst)}
          {reasons.length > 0 ? `: ${reasons.join("; ")}` : "."}
        </Notice>
      ) : null}

      <Grid min={280}>
        <StatCard
          icon="Cpu"
          title="CPU"
          value={formatPercent(cpu.percent)}
          percent={cpu.percent}
          pressure={cpu.pressure.state}
          values={series(history, (sample) => sample.cpu)}
          facts={[{ value: `load ${formatLoad(cpu.load)}` }, { value: `${cpu.cores} cores` }]}
          sampling={snapshot.sampling && cpu.percent === null}
        />
        <StatCard
          icon="MemoryStick"
          title="Memory"
          value={formatPercent(memoryPercent)}
          percent={memoryPercent}
          pressure={memory.pressure.state}
          values={series(history, (sample) => sample.memory)}
          facts={[
            { value: `${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}` },
            { value: `${formatBytes(memory.availableBytes)} available` },
            memory.swapTotalBytes > 0 ? { value: `swap ${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}` } : null,
          ]}
          sampling={false}
        />
      </Grid>

      <Section title="Project processes with high resource use" trailing={<Text style={t.text.caption}>{drivers.length > 0 ? `${drivers.length} flagged` : ""}</Text>}>
        {drivers.length === 0 ? (
          <Notice icon="Activity">No high-impact project processes are visible in this sample. Other activity on the machine can still contribute to CPU or memory pressure.</Notice>
        ) : (
          <Card padded={false}>
            {drivers.map((process, index) => (
              <ProcessRow key={processKey(process)} process={process} first={index === 0} expanded={expanded === processKey(process)} onToggle={() => setExpanded(expanded === processKey(process) ? null : processKey(process))} actions={actions} />
            ))}
          </Card>
        )}
      </Section>

      <Section title="Verified project dev servers" trailing={<Text style={t.text.caption}>{snapshot.services.length > 0 ? `${snapshot.services.length} found` : ""}</Text>}>
        {snapshot.services.length === 0 ? (
          <Notice icon="Server">No verified project dev servers are running. Start one inside a project registered in Paseo.</Notice>
        ) : (
          <Grid min={300}>
            {snapshot.services.map((process) => (
              <ServiceCard key={processKey(process)} process={process} actions={actions} />
            ))}
          </Grid>
        )}
      </Section>
    </View>
  );
}

function StatCard({
  icon,
  title,
  value,
  percent,
  pressure,
  values,
  facts,
  sampling,
}: {
  icon: string;
  title: string;
  value: string;
  percent: number | null;
  pressure: PressureState;
  values: Array<number | null>;
  facts: Array<{ value: string } | null>;
  sampling: boolean;
}) {
  const t = useTokens();
  const tone = pressureTone(pressure);
  const barTone: Tone = pressure === "normal" ? "accent" : tone;
  return (
    <Card tone={pressure === "normal" ? undefined : tone}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={icon} size={15} color={t.color.muted} />
          <Text style={t.text.label}>{title}</Text>
        </View>
        <StatusPill tone={tone} label={pressureLabel(pressure)} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: t.space.md }}>
        <Text style={t.text.value} accessibilityLabel={`${title} ${value}`}>
          {sampling ? "…" : value}
        </Text>
        <Text style={[t.text.caption, { marginBottom: 4 }]}>last {HISTORY_LENGTH * (POLL_INTERVAL_MS / 1000)}s</Text>
      </View>
      <Spark values={values} tone={barTone} label={`${title} over the last minute`} />
      <Meter percent={percent} tone={barTone} />
      <Facts items={facts} />
    </Card>
  );
}

function ServiceCard({ process, actions }: { process: Process; actions: RowActions }) {
  const t = useTokens();
  const isServer = process.classification.kind === "dev-server";
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
        <View style={{ width: 30, height: 30, borderRadius: t.radius.sm, backgroundColor: t.color.surface2, alignItems: "center", justifyContent: "center" }}>
          <Icon name={isServer ? "Server" : "Activity"} size={15} color={t.color.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={t.text.bodyStrong} numberOfLines={1}>
            {process.name}
          </Text>
          <Text style={t.text.caption} numberOfLines={1}>
            {process.classification.label}
            {process.cwd ? ` · ${process.cwd}` : ""}
          </Text>
        </View>
        <StatusPill tone={stateTone(process.state)} label={process.state} />
      </View>
      {process.ports.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {process.ports.map((port) => (
            <Tag key={port} label={`:${port}`} />
          ))}
        </View>
      ) : null}
      <Facts
        items={[
          { value: `CPU ${formatPercent(process.cpuPercent, 1)}` },
          { value: `RSS ${formatBytes(process.rssBytes)}` },
          { value: `up ${formatDuration(process.ageSeconds)}` },
          { value: `PID ${process.pid}` },
        ]}
      />
      <Text style={t.text.caption}>{process.project?.name} · Manage this server from Project processes.</Text>
    </Card>
  );
}

// --------------------------------------------------------------- processes

function Processes({
  snapshot,
  search,
  setSearch,
  sort,
  setSort,
  settling,
  direction, offset, setOffset,
  expanded,
  setExpanded,
  actions,
}: {
  snapshot: Snapshot;
  search: string;
  setSearch: (value: string) => void;
  sort: Sort;
  setSort: (value: Sort) => void;
  settling: boolean;
  direction: "asc" | "desc"; offset: number; setOffset(value: number): void;
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  actions: RowActions;
}) {
  const t = useTokens();
  const { items, total, truncated } = snapshot.processes;
  const summary = settling ? "Updating…" : total ? `${offset + 1}–${offset + items.length} of ${total} project processes` : "No project processes";
  return (
    <View style={{ gap: t.space.md }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
        <View
          style={{
            flex: t.compact ? undefined : 1,
            minWidth: t.compact ? undefined : 200,
            maxWidth: t.compact ? undefined : 420,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            minHeight: t.control.min,
            paddingHorizontal: 10,
            borderRadius: t.radius.sm,
            borderWidth: 1,
            borderColor: t.color.border,
            backgroundColor: t.color.surface1,
          }}
        >
          <Icon name="Search" size={14} color={t.color.muted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name, command, port or PID"
            placeholderTextColor={t.color.muted}
            accessibilityLabel="Search processes"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, minHeight: t.control.min - 2, color: t.color.fg, fontSize: t.compact ? 14 : 13, paddingVertical: 0 }}
          />
          {search ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={t.control.hit} onPress={() => setSearch("")}>
              <Icon name="X" size={14} color={t.color.muted} />
            </Pressable>
          ) : null}
        </View>
        {t.compact && <><Text style={t.text.caption}>Sort by · {direction === "desc" ? "highest first" : "lowest first"}</Text><Segmented label="Sort processes" options={SORTS} value={sort} onChange={setSort} /><Button label="Reverse sort order" onPress={() => setSort(sort)} /></>}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Text style={t.text.caption}>{summary}</Text>
        <Text style={t.text.caption}>Select a row for details</Text>
      </View>

      {items.length === 0 ? (
        <Notice icon="Search">{search ? `No processes match "${search}".` : "No processes in verified Paseo projects."}</Notice>
      ) : (
        <Card padded={false}>
          {!t.compact && <ProcessHead sort={sort} direction={direction} onSort={setSort} />}
          <ScrollView nestedScrollEnabled scrollEnabled={!t.compact} style={{ maxHeight: t.compact ? undefined : 520 }}>
            {items.map((process, index) => (
              <ProcessRow key={processKey(process)} process={process} first={index === 0} expanded={expanded === processKey(process)} onToggle={() => setExpanded(expanded === processKey(process) ? null : processKey(process))} actions={actions} />
            ))}
          </ScrollView>
        </Card>
      )}
      {total > PROCESS_LIMIT && <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Button label="Previous page" disabled={offset === 0 || settling} onPress={() => setOffset(Math.max(0, offset - PROCESS_LIMIT))} />
        <Text style={t.text.caption}>Page {Math.floor(offset / PROCESS_LIMIT) + 1} of {Math.ceil(total / PROCESS_LIMIT)}</Text>
        <Button label="Next page" disabled={offset + items.length >= total || settling} onPress={() => setOffset(offset + PROCESS_LIMIT)} />
      </View>}
    </View>
  );
}

function ProcessHead({ sort, direction, onSort }: { sort: Sort; direction: "asc" | "desc"; onSort(sort: Sort): void }) {
  const t = useTokens();
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: t.space.md, paddingVertical: 11, backgroundColor: t.color.surface2 }}>
    {([{ id: "name", label: "Process", width: undefined }, { id: "pid", label: "PID", width: 65 }, { id: "cpu", label: "CPU", width: 70 }, { id: "memory", label: "Memory", width: 85 }] as const).map((column) => <Pressable key={column.id} accessibilityRole="button" accessibilityLabel={`Sort by ${column.label}${sort === column.id ? `, ${direction === "asc" ? "ascending" : "descending"}` : ""}`} onPress={() => onSort(column.id)} style={{ width: column.width, flex: column.width ? undefined : 1, minHeight: 26, justifyContent: "center", alignItems: column.width ? "flex-end" : "flex-start" }}><Text style={[t.text.label, { color: sort === column.id ? t.color.accent : t.color.muted }]}>{column.label}{sort === column.id ? direction === "asc" ? " ↑" : " ↓" : ""}</Text></Pressable>)}
    <Text style={[t.text.label, { width: 65, textAlign: "right" }]}>Uptime</Text>
    <Text style={[t.text.label, { width: 132, textAlign: "right" }]}>Impact</Text>
  </View>;
}

function ProcessRow({ process, first, expanded, onToggle, actions }: { process: Process; first: boolean; expanded: boolean; onToggle: () => void; actions: RowActions }) {
  const t = useTokens();
  const tone = impactTone(process.impact);
  const flagged = process.impact === "pressure-driver" || process.impact === "high";
  const pending = actions.pending[processKey(process)];
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: t.color.borderSubtle, borderLeftWidth: flagged ? 2 : 0, borderLeftColor: flagged ? toneColor(t, tone) : "transparent" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${process.name}, PID ${process.pid}, CPU ${formatPercent(process.cpuPercent, 1)}, memory ${formatBytes(process.rssBytes)}. ${expanded ? "Collapse" : "Expand"} details`}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => ({
          paddingVertical: t.compact ? t.space.md : t.space.sm + 2,
          paddingHorizontal: t.space.md,
          minHeight: t.control.min + 8,
          backgroundColor: pressed ? alpha(t.color.muted, 0.08) : "transparent",
          flexDirection: t.compact ? "column" : "row",
          alignItems: t.compact ? "stretch" : "center",
          gap: t.space.sm,
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={t.color.muted} />
            <Text style={[t.text.bodyStrong, { flexShrink: 1 }]} numberOfLines={1}>
              {process.name}
            </Text>
            {pending ? <Tag label={pending.survivedPolls >= FORCE_AFTER_POLLS ? "still running" : "stopping…"} tone={pending.survivedPolls >= FORCE_AFTER_POLLS ? "warning" : undefined} /> : null}
            {process.ports.length > 0 ? <Tag label={process.ports.map((port) => `:${port}`).join(" ")} /> : null}
          </View>
          <Text style={[t.text.caption, { marginLeft: 20 }]} numberOfLines={1}>
            {process.project ? `${process.project.name} · ${process.project.kind === "agent" ? "Agent tool" : process.project.kind === "dev-server" ? "Dev server" : "Project tool"}` : process.classification.label}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.compact ? 10 : 12, marginLeft: t.compact ? 20 : 0, flexShrink: 0, flexWrap: t.compact ? "wrap" : "nowrap" }}>
          <TableFigure label="PID" value={String(process.pid)} width={65} />
          <TableFigure label="CPU" value={formatPercent(process.cpuPercent, 1)} width={70} />
          <TableFigure label="Memory" value={formatBytes(process.rssBytes)} width={85} />
          {!t.compact && <TableFigure label="Uptime" value={formatDuration(process.ageSeconds)} width={65} />}
          <View style={{ width: t.compact ? undefined : 132, alignItems: "flex-end" }}><StatusPill tone={tone} label={impactLabel(process.impact)} /></View>
        </View>
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: t.space.md, paddingBottom: t.space.md, paddingLeft: t.space.md + 20, gap: t.space.sm }}>
          <Text style={t.text.mono} numberOfLines={3}>
            {process.command}
          </Text>
          <Facts
            items={[
              { value: `PID ${process.pid}` },
              { value: `parent ${process.ppid}` },
              { value: `state ${process.state}`, tone: stateTone(process.state) === "warning" ? "warning" : undefined },
              { value: `${formatPercent(process.memoryPercent, 1)} of memory` },
              { value: `age ${formatDuration(process.ageSeconds)}` },
              process.cwd ? { value: `cwd ${process.cwd}` } : null,
            ]}
          />
          {process.classification.reasons.length > 0 ? <Text style={t.text.caption}>{process.classification.label}: {process.classification.reasons.join("; ")}</Text> : null}
          <ProcessActions process={process} actions={actions} />
        </View>
      ) : null}
    </View>
  );
}

function TableFigure({ label, value, width }: { label: string; value: string; width: number }) {
  const t = useTokens();
  return (
    <View style={{ alignItems: "flex-end", width: t.compact ? undefined : width, minWidth: t.compact ? 44 : undefined }}>
      <Text style={t.text.figure}>{value}</Text>
      {t.compact && <Text style={[t.text.caption, { fontSize: 10, lineHeight: 12 }]}>{label}</Text>}
    </View>
  );
}

/** Stop → inline confirm; after the process outlives the graceful attempt, Force Stop (modal). */
function ProcessActions({ process, actions }: { process: Process; actions: RowActions }) {
  const t = useTokens();
  const target = `${process.name} (PID ${process.pid})`;
  const pending = actions.pending[processKey(process)];
  const busy = actions.stopping !== undefined && processKey(actions.stopping) === processKey(process);
  if (!process.actionable || !process.actionToken) {
    return <Text style={t.text.caption}>{process.protectedReason ?? "Protected"}</Text>;
  }
  if (pending && pending.survivedPolls >= FORCE_AFTER_POLLS) {
    return (
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
        <Text style={[t.text.caption, { flex: 1 }]}>Still running after a graceful stop.</Text>
        <Button label="Force stop…" variant="danger" accessibilityLabel={`Force stop ${target}`} onPress={() => actions.onForce(process)} />
      </View>
    );
  }
  if (pending) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <ActivityIndicator size="small" color={t.color.muted} />
        <Text style={t.text.caption}>Waiting for {process.name} to exit…</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <ConfirmButton label="Stop dev server…" confirmLabel="Confirm stop server" target={`${process.project?.name || "Project"}: ${target}`} loading={busy} onConfirm={() => actions.onStop(process)} />
    </View>
  );
}

// ------------------------------------------------------------------- modal

function ForceStopModal({ target, busy, onCancel, onConfirm }: { target: Process | null; busy: boolean; onCancel: () => void; onConfirm: (process: Process) => void }) {
  const t = useTokens();
  return (
    <Modal
      title="Force stop process"
      icon={<Icon name="OctagonX" size={18} color={t.color.danger} />}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <Modal.Content>
        <View style={{ gap: t.space.md, padding: t.compact ? t.space.md : t.space.lg }}>
          {target ? (
            <>
              <Text style={t.text.body}>
                Force stop <Text style={t.text.bodyStrong}>{target.name}</Text> (PID {target.pid})?
              </Text>
              <Text style={t.text.caption}>
                This sends SIGKILL. The process cannot clean up or save anything, and this cannot be undone. Only do this if it ignored the graceful stop.
              </Text>
              {target.ports.length > 0 ? <Text style={t.text.caption}>Listening on {target.ports.map((port) => `:${port}`).join(", ")}.</Text> : null}
              <View style={{ flexDirection: t.compact ? "column-reverse" : "row", justifyContent: "flex-end", gap: t.space.sm }}>
                <Button label="Cancel" variant="secondary" accessibilityLabel={`Cancel force stop of ${target.name}`} onPress={onCancel} disabled={busy} />
                <Button label="Force stop" variant="danger" accessibilityLabel={`Confirm force stop of ${target.name}, PID ${target.pid}`} onPress={() => onConfirm(target)} loading={busy} />
              </View>
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
