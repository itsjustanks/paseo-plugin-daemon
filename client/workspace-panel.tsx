import { type PluginWorkspacePanelProps, useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { askSubjectFor, hostHealth, workspaceHealth, type HealthIssue } from "../shared/health";
import type { WatchResult } from "../shared/watch";
import type { PluginTheme } from "@getpaseo/plugin";
import * as link from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS, hostsSettings } from "../shared/settings";
import { formatMinutes, type TunnelMinutes } from "../shared/tunnel-lease";
import { filterWorkspaceProcesses, workspacePorts } from "../shared/workspace-filter";
import { rollupResources, type ResourceRollup } from "../shared/workspace-resources";
import { AskAgentButton, HostsNavigationProvider, OpenTerminalButton } from "./ask";
import { DaemonSurface, PageHeader } from "./daemon";
import { Accordion, AccordionItem, Dot, Fact, Meta, Row, SectionTitle, SPACE, TYPE, toneColor, type Tone as KitTone } from "./kit";
import { OpenRow } from "./open-row";
import { useOpenService } from "./open-service";
import { PROCESS_LIMIT, processKey, useMonitorRpc, type Process, type Snapshot } from "./rpc";
import { ForceStopModal, ProcessRow, ServiceCard, errorText, usePendingStops, useProcessActions } from "./surface";
import { TunnelCard } from "./tunnel-row";
import { Button, Card, Facts, Grid, Meter, Notice, TokensProvider, formatBytes, formatPercent, useTokens, useUi } from "./ui";

const QUERY_KEY = ["monitor", "workspace-snapshot"] as const;
/** Enough rows to cover a busy workspace; the server bounds this too. */
const WORKSPACE_LIMIT = PROCESS_LIMIT * 4;

/** Rows shown before "Show all": the heaviest first, so the list stays calm. */
const ROWS_FOLDED = 8;

/**
 * The workspace tab, also shown in the Projects explorer. In "workspace"
 * scope it leads with this workspace's dev servers, each with a one-press
 * Open, then its health verdict, resources, processes, and browser links; in
 * "host" scope it is the full Hosts surface.
 */
export function WorkspacePanel(props: PluginWorkspacePanelProps) {
  const settings = useSettings(hostsSettings);
  // Hooks run unconditionally; the scope decision happens after them.
  const tokens = useUi(props.theme, props.layout.compact);
  const values = settings.status === "ready" ? settings.values : HOSTS_SETTINGS_DEFAULTS;
  if (values.panelScope === "host") return <DaemonSurface {...props} />;
  return (
    <TokensProvider value={tokens}>
      <HostsNavigationProvider navigation={props.navigation}>
      <WorkspaceBody key={`${props.host.id}:${props.workspaceId}`} theme={props.theme} hostId={props.host.id} workspaceId={props.workspaceId} intervalSeconds={values.snapshotIntervalSeconds} minutes={values.tunnelMinutes} settingsLoading={settings.status === "loading"} />
      </HostsNavigationProvider>
    </TokensProvider>
  );
}

/**
 * What this workspace costs the host right now: summed CPU and resident memory
 * of its processes, each as a share of the machine when the host total is
 * known. A metric the host has not measured yet reads as unknown, never 0.
 */
function ResourceBody({ rollup, snapshot }: { rollup: ResourceRollup; snapshot: Snapshot }) {
  const t = useTokens();
  const { cpu, memory } = snapshot.system;
  const cpuPending = rollup.processCount - rollup.cpuSampled;
  const memoryPending = rollup.processCount - rollup.memorySampled;
  return (
    <>
      {rollup.processCount === 0 ? (
        <Text style={t.text.caption}>Nothing is running in this workspace, so it uses none of the host's CPU or memory.</Text>
      ) : (
        <Grid min={220}>
          <ResourceFigure
            title="CPU"
            value={rollup.cpuPercent === null ? "sampling…" : formatPercent(rollup.cpuPercent, 1)}
            share={rollup.cpuOfHostPercent}
            facts={[
              rollup.cpuOfHostPercent !== null ? { value: `${formatPercent(rollup.cpuOfHostPercent, 1)} of ${cpu.cores} cores` } : null,
              rollup.cpuOfHostLoadPercent !== null ? { value: `${formatPercent(rollup.cpuOfHostLoadPercent, 1)} of the host's ${formatPercent(cpu.percent, 1)} load` } : null,
              rollup.cpuPercent !== null && rollup.cpuOfHostPercent === null ? { value: "host share unknown" } : null,
              cpuPending > 0 ? { value: `${cpuPending} still sampling` } : null,
            ]}
          />
          <ResourceFigure
            title="Memory"
            value={rollup.rssBytes === null ? "unknown" : formatBytes(rollup.rssBytes)}
            share={rollup.memoryOfHostPercent}
            facts={[
              rollup.memoryOfHostPercent !== null ? { value: `${formatPercent(rollup.memoryOfHostPercent, 1)} of ${formatBytes(memory.totalBytes)}` } : null,
              rollup.memoryOfHostUsedPercent !== null ? { value: `${formatPercent(rollup.memoryOfHostUsedPercent, 1)} of what the host uses` } : null,
              rollup.rssBytes !== null && rollup.memoryOfHostPercent === null ? { value: "host total unknown" } : null,
              memoryPending > 0 ? { value: `${memoryPending} without a reading` } : null,
            ]}
          />
        </Grid>
      )}
    </>
  );
}

/** One figure with its meter against the host; the meter stays empty while the share is unknown. */
function ResourceFigure({ title, value, share, facts }: { title: string; value: string; share: number | null; facts: Array<{ value: string } | null> }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.xs }}>
      <Text style={t.text.label}>{title}</Text>
      <Text style={t.text.value} accessibilityLabel={`${title} ${value}`}>{value}</Text>
      <Meter percent={share} />
      <Facts items={facts} />
    </View>
  );
}

/** One issue, in its own words; with "Ask an agent" (0.12.0) when an agent can help with it. */
function IssueRow({ theme, issue, watched }: { theme: PluginTheme; issue: HealthIssue; watched: readonly WatchResult[] }) {
  const subject = askSubjectFor(issue, watched);
  return (
    <View style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm }}>
        <View style={{ paddingTop: SPACE.sm }}><Dot color={toneColor(theme, issue.severity === "critical" ? "danger" : "warning")} /></View>
        <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1 }}>{issue.message}</Text>
      </View>
      {subject ? <View style={{ paddingLeft: SPACE.md }}><Row><AskAgentButton theme={theme} subject={subject} /></Row></View> : null}
    </View>
  );
}

function WorkspaceBody({ theme, hostId, workspaceId, intervalSeconds, minutes, settingsLoading }: { theme: PluginTheme; hostId: string; workspaceId: string; intervalSeconds: number; minutes: TunnelMinutes; settingsLoading: boolean }) {
  const t = useTokens();
  const queryClient = useQueryClient();
  const rpc = useMonitorRpc();
  const linkStatus = useRpc(link.linkStatus);
  const workspace = useWorkspace(workspaceId, ({ directory, projectRootPath, name }) => ({ directory, projectRootPath, name }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const snapshotQuery = useQuery({
    queryKey: [...QUERY_KEY, hostId, workspaceId],
    queryFn: () => rpc.snapshot({ query: "", sort: "cpu", limit: WORKSPACE_LIMIT }),
    refetchInterval: intervalSeconds * 1000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 0,
    gcTime: 30_000,
    enabled: workspace !== null,
  });
  // Links poll faster than the snapshot: a pressed Open waits on this query to learn the link is connected.
  const links = useQuery({ queryKey: ["daemon-link", hostId, "status"], queryFn: () => linkStatus({}), refetchInterval: Math.min(intervalSeconds, 3) * 1000, retry: 1 });
  const opener = useOpenService({ links, minutes });
  // The cached daemon verdict; the server re-checks on the same interval, so this never probes the host twice.
  const readHealth = useRpc(hostHealth);
  const healthQuery = useQuery({ queryKey: ["daemon-link", hostId, "health"], queryFn: () => readHealth({}), refetchInterval: intervalSeconds * 1000, retry: 1, enabled: workspace !== null });
  const health = useMemo(() => (healthQuery.data && workspace ? workspaceHealth(healthQuery.data, workspace) : null), [healthQuery.data, workspace]);

  const host = snapshotQuery.data;
  const snapshot = useMemo<Snapshot | undefined>(() => {
    if (!host || !workspace) return undefined;
    const services = filterWorkspaceProcesses(host.services, workspace);
    const items = filterWorkspaceProcesses(host.processes.items, workspace, workspacePorts(services));
    return { ...host, services, processes: { items, total: items.length, truncated: host.processes.truncated } };
  }, [host, workspace]);
  const ports = useMemo(() => (snapshot ? workspacePorts([...snapshot.services, ...snapshot.processes.items]) : []), [snapshot]);
  // Host totals come from the same sample as the rows, so the shares compare like with like.
  const rollup = useMemo(() => (snapshot ? rollupResources([...snapshot.services, ...snapshot.processes.items], snapshot.system) : null), [snapshot]);
  const tunnels = useMemo(() => (links.data?.tunnels ?? []).filter((tunnel) => ports.includes(tunnel.port)), [links.data, ports]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    void links.refetch();
    void healthQuery.refetch();
  }, [queryClient, links, healthQuery]);
  const pendingStops = usePendingStops(snapshot);
  const { actions, liveForceTarget, forceMutation, setForceTarget } = useProcessActions({ rpc, snapshot, pendingStops, refresh });
  const available = links.data?.cloudflared === true;

  // Services already have their own card; the process list shows the rest.
  const rows = useMemo(() => {
    if (!snapshot) return [] as Process[];
    const serviceKeys = new Set(snapshot.services.map(processKey));
    return snapshot.processes.items.filter((process) => !serviceKeys.has(processKey(process)));
  }, [snapshot]);

  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = () => {
    setRefreshing(true);
    void readHealth({ refresh: true }).then((verdict) => queryClient.setQueryData(["daemon-link", hostId, "health"], verdict)).catch(() => undefined).finally(() => setRefreshing(false));
    refresh();
  };
  const tone: KitTone = snapshotQuery.isError ? "danger" : !health ? "neutral" : health.status === "critical" ? "danger" : health.status === "warning" ? "warning" : health.status === "ok" ? "success" : "neutral";
  const line = snapshotQuery.isError ? "This host can't be read right now" : !health ? "Checking…" : health.issues.length ? `${health.issues.length} thing${health.issues.length === 1 ? "" : "s"} need${health.issues.length === 1 ? "s" : ""} attention` : "All good";
  const checked = healthQuery.data ? new Date(healthQuery.data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  // Summed shares of one core read oddly past 100% ("610% CPU"); say cores instead.
  const cpuWords = rollup?.cpuPercent == null ? "CPU measuring" : rollup.cpuPercent >= 100 ? `${(rollup.cpuPercent / 100).toFixed(1)} CPU cores` : `${formatPercent(rollup.cpuPercent, 1)} of a CPU core`;
  const memoryWords = rollup?.rssBytes == null ? "unknown" : formatBytes(rollup.rssBytes);

  // 0.12.1: the new Hosts style. The workspace's name and state up top with one Refresh link, its dev servers, then
  // anything wrong; resources, other processes, links and the technical bits (folder, schedule) fold away.
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: t.compact ? SPACE.md : SPACE.section, paddingBottom: SPACE.section * 2, alignItems: "stretch" }}>
      <View style={{ width: "100%", maxWidth: t.maxWidth, alignSelf: "center", gap: SPACE.section }}>
        <PageHeader theme={theme} host={workspace?.name ?? "This workspace"} tone={tone} line={line} onRefresh={refreshNow} refreshing={refreshing} />
        {snapshotQuery.isError ? (
          <Notice icon="CircleAlert" tone="danger" action={<Button label="Try again" onPress={refreshNow} loading={snapshotQuery.isFetching} />}>
            {snapshot ? `The latest reading failed: ${errorText(snapshotQuery.error)}. Showing the last good one.` : `This host can't be read: ${errorText(snapshotQuery.error)}`}
          </Notice>
        ) : null}
        {host?.scope?.status === "unavailable" ? <Notice icon="ShieldAlert" tone="warning">{host.scope.message}</Notice> : null}
        {!snapshot && snapshotQuery.isPending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <ActivityIndicator size="small" color={t.color.muted} />
            <Text style={t.text.body}>Checking…</Text>
          </View>
        ) : null}
        {snapshot ? (
          <View style={{ gap: SPACE.row }}>
            <SectionTitle theme={theme} icon="Server">Dev servers</SectionTitle>
            {snapshot.services.length === 0 ? (
              <Text style={t.text.body}>No dev server is running in this workspace. Run its dev command in a terminal here and it appears with an Open button.</Text>
            ) : (
              <>
                {!available && links.data ? (
                  <Notice icon="Globe" tone="warning" action={<Button label={opener.installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={opener.installing} disabled={opener.installing} onPress={() => opener.installLinks()} />}>
                    One-time setup for the Open button: install the link helper on this host. No account, domain or password is needed.
                  </Notice>
                ) : null}
                <Grid min={300}>
                  {snapshot.services.map((process) => (
                    <ServiceCard key={processKey(process)} process={process} actions={actions} footer={
                      <>
                        <OpenRow ports={process.ports} tunnels={links.data?.tunnels ?? []} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} />
                        <OpenTerminalButton theme={theme} pid={process.pid} />
                      </>
                    } />
                  ))}
                </Grid>
              </>
            )}
          </View>
        ) : null}
        {health && health.issues.length ? (
          <View style={{ gap: SPACE.row }}>
            <SectionTitle theme={theme} icon="TriangleAlert">What needs attention</SectionTitle>
            {health.issues.map((issue, index) => <IssueRow key={`${issue.code}-${issue.ports.join("-")}-${index}`} theme={theme} issue={issue} watched={healthQuery.data?.watched ?? []} />)}
          </View>
        ) : null}
        {snapshot && rollup ? (
          <Accordion theme={theme}>
            <AccordionItem theme={theme} compact={t.compact} icon="Gauge" title="What this workspace uses" summary={rollup.processCount ? `${cpuWords} · ${memoryWords} memory · ${rollup.processCount} process${rollup.processCount === 1 ? "" : "es"}` : "Nothing running"}>
              <ResourceBody rollup={rollup} snapshot={snapshot} />
            </AccordionItem>
            <AccordionItem theme={theme} compact={t.compact} icon="ListOrdered" title="Other processes in this workspace" summary={rows.length ? `${rows.length} running` : "None"}>
              {rows.length === 0 ? (
                <Text style={t.text.body}>No other processes are running in this workspace.{snapshot.processes.truncated ? " The host's list was cut short; Hosts → Processes has everything." : ""}</Text>
              ) : (
                <>
                  <Card padded={false}>
                    {(showAll ? rows : rows.slice(0, ROWS_FOLDED)).map((process, index) => (
                      <ProcessRow key={processKey(process)} process={process} first={index === 0} expanded={expanded === processKey(process)} onToggle={() => setExpanded(expanded === processKey(process) ? null : processKey(process))} actions={actions} />
                    ))}
                  </Card>
                  {rows.length > ROWS_FOLDED ? <View style={{ flexDirection: "row" }}><Button label={showAll ? "Show the heaviest only" : `Show all ${rows.length}`} onPress={() => setShowAll(!showAll)} /></View> : null}
                </>
              )}
            </AccordionItem>
            <AccordionItem theme={theme} compact={t.compact} icon="Globe" title="Browser links" summary={tunnels.length ? `${tunnels.length} open · Open adds ${formatMinutes(minutes)}` : "None open"}>
              {tunnels.length === 0 ? (
                <Text style={t.text.body}>No temporary browser link points at this workspace. Press Open beside a dev server to make one.</Text>
              ) : (
                tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)
              )}
            </AccordionItem>
            <AccordionItem theme={theme} compact={t.compact} icon="SlidersHorizontal" title="Technical details" summary="Its folder, ports and how often Hosts checks">
              {workspace?.directory ? <Fact theme={theme} label="Folder" value={workspace.directory} /> : null}
              {ports.length ? <Fact theme={theme} label="Ports" value={ports.map((port) => `:${port}`).join(" ")} /> : null}
              <Fact theme={theme} label="Checks every" value={`${intervalSeconds} seconds${healthQuery.data?.background === false ? ", while Hosts is open" : ", even with Paseo closed"}`} />
              {checked ? <Fact theme={theme} label="Last checked" value={checked} /> : null}
              {settingsLoading ? <Meta theme={theme}>Loading Hosts settings; using the defaults until they arrive.</Meta> : null}
              <Meta theme={theme}>Only what runs in this workspace's folder is listed. The whole host, with a safe stop for any job Paseo started, is on the Hosts screen → Processes. To show the whole host here instead: Settings → Hosts → Panel shows.</Meta>
            </AccordionItem>
          </Accordion>
        ) : null}
      </View>
      <ForceStopModal target={liveForceTarget} busy={forceMutation.isPending} onCancel={() => setForceTarget(null)} onConfirm={(process) => forceMutation.mutate(process)} />
    </ScrollView>
  );
}
