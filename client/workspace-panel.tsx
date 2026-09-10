import { type PluginWorkspacePanelProps, useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { hostHealth, workspaceHealth, type HealthIssue, type HealthStatus } from "../shared/health";
import * as link from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS, hostsSettings } from "../shared/settings";
import { formatMinutes, type TunnelMinutes } from "../shared/tunnel-lease";
import { filterWorkspaceProcesses, workspacePorts } from "../shared/workspace-filter";
import { rollupResources, type ResourceRollup } from "../shared/workspace-resources";
import { DaemonSurface } from "./daemon";
import { OpenRow } from "./open-row";
import { useOpenService } from "./open-service";
import { PROCESS_LIMIT, processKey, useMonitorRpc, type Process, type Snapshot } from "./rpc";
import { ForceStopModal, ProcessRow, ServiceCard, errorText, usePendingStops, useProcessActions } from "./surface";
import { TunnelCard } from "./tunnel-row";
import { Button, Card, Facts, Grid, Meter, Notice, Section, StatusPill, Tag, TokensProvider, formatBytes, formatPercent, useTokens, useUi, type Tone } from "./ui";

const QUERY_KEY = ["monitor", "workspace-snapshot"] as const;
/** Enough rows to cover a busy workspace; the server bounds this too. */
const WORKSPACE_LIMIT = PROCESS_LIMIT * 4;

const HEALTH_TONE: Record<HealthStatus, Tone> = { ok: "ok", warning: "warning", critical: "danger", unknown: "neutral" };
const HEALTH_LABEL: Record<HealthStatus, string> = { ok: "Healthy", warning: "Needs attention", critical: "Unreachable", unknown: "Unknown" };

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
      <WorkspaceBody key={`${props.host.id}:${props.workspaceId}`} hostId={props.host.id} workspaceId={props.workspaceId} intervalSeconds={values.snapshotIntervalSeconds} minutes={values.tunnelMinutes} settingsLoading={settings.status === "loading"} />
    </TokensProvider>
  );
}

/** The verdict for this workspace first: status, when it was checked, and every issue that touches it. */
function HealthCard({ health, background }: { health: ReturnType<typeof workspaceHealth>; background: boolean }) {
  const t = useTokens();
  const checked = new Date(health.checkedAt).toLocaleTimeString();
  return (
    <Card tone={health.status === "ok" ? undefined : HEALTH_TONE[health.status]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Text style={t.text.heading}>Health</Text>
        <StatusPill tone={HEALTH_TONE[health.status]} label={HEALTH_LABEL[health.status]} />
      </View>
      <Facts items={[
        { value: `${health.services.length} dev server${health.services.length === 1 ? "" : "s"}` },
        health.ports.length > 0 ? { value: `ports ${health.ports.map((port) => `:${port}`).join(" ")}` } : null,
        { value: `checked ${checked}` },
        { value: background ? "checks run on the daemon" : "background checks off" },
      ]} />
      {health.issues.length === 0 ? (
        <Text style={t.text.caption}>Nothing wrong with this workspace's servers, browser links, or SSH forwards.</Text>
      ) : (
        health.issues.map((issue, index) => <IssueRow key={`${issue.code}-${issue.ports.join("-")}-${index}`} issue={issue} />)
      )}
    </Card>
  );
}

/**
 * What this workspace costs the host right now: summed CPU and resident memory
 * of its processes, each as a share of the machine when the host total is
 * known. A metric the host has not measured yet reads as unknown, never 0.
 */
function ResourceCard({ rollup, snapshot }: { rollup: ResourceRollup; snapshot: Snapshot }) {
  const t = useTokens();
  const { cpu, memory } = snapshot.system;
  const cpuPending = rollup.processCount - rollup.cpuSampled;
  const memoryPending = rollup.processCount - rollup.memorySampled;
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Text style={t.text.heading}>Resources</Text>
        <Text style={t.text.caption}>{rollup.processCount} process{rollup.processCount === 1 ? "" : "es"} in this workspace</Text>
      </View>
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
    </Card>
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

function IssueRow({ issue }: { issue: HealthIssue }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
      <Tag tone={issue.severity === "critical" ? "danger" : "warning"} label={issue.scope === "host" ? "host" : issue.ports.length > 0 ? `:${issue.ports.join(" :")}` : "process"} />
      <Text style={[t.text.body, { flex: 1 }]}>{issue.message}</Text>
    </View>
  );
}

function WorkspaceBody({ hostId, workspaceId, intervalSeconds, minutes, settingsLoading }: { hostId: string; workspaceId: string; intervalSeconds: number; minutes: TunnelMinutes; settingsLoading: boolean }) {
  const t = useTokens();
  const queryClient = useQueryClient();
  const rpc = useMonitorRpc();
  const linkStatus = useRpc(link.linkStatus);
  const workspace = useWorkspace(workspaceId, ({ directory, projectRootPath, name }) => ({ directory, projectRootPath, name }));
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const status = snapshotQuery.isError ? { tone: "danger" as const, label: "Host unavailable" } : snapshot ? { tone: "ok" as const, label: `Every ${intervalSeconds}s` } : { tone: "neutral" as const, label: "Connecting" };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: t.space.lg, paddingBottom: 48, alignItems: "stretch" }}>
      <View style={{ width: "100%", maxWidth: t.maxWidth, alignSelf: "center", gap: t.space.lg }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <View style={{ gap: 3, flexShrink: 1 }}>
            <Text style={t.text.title}>Hosts · {workspace?.name ?? "this workspace"}</Text>
            <Text style={t.text.label} numberOfLines={1}>{workspace?.directory ?? "Workspace details are loading…"}</Text>
          </View>
          <StatusPill tone={status.tone} label={status.label} />
        </View>
        {settingsLoading ? <Text style={t.text.caption}>Loading Hosts settings; using defaults until they arrive.</Text> : null}
        {snapshot ? (
          <Section title="Dev servers in this workspace" trailing={<Text style={t.text.caption}>{snapshot.services.length > 0 ? `${snapshot.services.length} found · Open creates a ${formatMinutes(minutes)} browser link` : ""}</Text>}>
            {snapshot.services.length === 0 ? (
              <Notice icon="Server" action={<Button label="Refresh" onPress={refresh} loading={snapshotQuery.isFetching} />}>No verified dev server is running inside this workspace. Start its dev command in a terminal here and it appears automatically with an Open button.</Notice>
            ) : (
              <>
                {!available && links.data ? (
                  <Notice icon="Globe" tone="warning" action={<Button label={opener.installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={opener.installing} disabled={opener.installing} onPress={() => opener.installLinks()} />}>
                    Open needs the tunnel helper on this host once. No Cloudflare account, domain, or SSH password is needed. For a private route instead, use Hosts → Connect.
                  </Notice>
                ) : null}
                <Grid min={300}>
                  {snapshot.services.map((process) => (
                    <ServiceCard key={processKey(process)} process={process} actions={actions} footer={
                      <OpenRow ports={process.ports} tunnels={links.data?.tunnels ?? []} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} />
                    } />
                  ))}
                </Grid>
              </>
            )}
          </Section>
        ) : null}
        {health ? <HealthCard health={health} background={healthQuery.data?.background ?? true} /> : null}
        {snapshot && rollup ? <ResourceCard rollup={rollup} snapshot={snapshot} /> : null}
        {snapshotQuery.isError ? (
          <Notice icon="CircleAlert" tone="danger" action={<Button label="Retry" onPress={refresh} loading={snapshotQuery.isFetching} />}>
            {snapshot ? `Latest sample failed: ${errorText(snapshotQuery.error)}. Showing the last good data.` : `Could not read the host: ${errorText(snapshotQuery.error)}`}
          </Notice>
        ) : null}
        {host?.scope?.status === "unavailable" ? <Notice icon="ShieldAlert" tone="warning">{host.scope.message}</Notice> : null}
        {!snapshot && snapshotQuery.isPending ? (
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <ActivityIndicator size="small" color={t.color.muted} />
              <Text style={t.text.body}>Reading the host…</Text>
            </View>
          </Card>
        ) : null}

        {snapshot ? (
          <>
            <Section title="Other workspace processes" trailing={<Text style={t.text.caption}>{rows.length > 0 ? `${rows.length} running` : ""}</Text>}>
              {rows.length === 0 ? (
                <Notice icon="Activity">No other processes are running in this workspace.{snapshot.processes.truncated ? " The host list was truncated; open the Hosts sidebar for the full table." : ""}</Notice>
              ) : (
                <Card padded={false}>
                  {rows.map((process, index) => (
                    <ProcessRow key={processKey(process)} process={process} first={index === 0} expanded={expanded === processKey(process)} onToggle={() => setExpanded(expanded === processKey(process) ? null : processKey(process))} actions={actions} />
                  ))}
                </Card>
              )}
            </Section>
            <Section title="Browser links for this workspace" trailing={ports.length > 0 ? <View style={{ flexDirection: "row", gap: 6 }}>{ports.map((port) => <Tag key={port} label={`:${port}`} />)}</View> : undefined}>
              {tunnels.length === 0 ? (
                <Notice icon="Globe">No temporary browser link points at this workspace. Press Open beside a dev server above to create one.</Notice>
              ) : (
                tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)
              )}
            </Section>
            <Text style={t.text.caption}>Only dev servers, processes, and links that belong to this workspace's directory are listed. Switch the panel to the whole host under Settings → Plugins → Daemon Link → Hosts.</Text>
          </>
        ) : null}
      </View>
      <ForceStopModal target={liveForceTarget} busy={forceMutation.isPending} onCancel={() => setForceTarget(null)} onConfirm={(process) => forceMutation.mutate(process)} />
    </ScrollView>
  );
}
