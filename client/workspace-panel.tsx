import { type PluginWorkspacePanelProps, useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import * as link from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS, hostsSettings } from "../shared/settings";
import { filterWorkspaceProcesses, workspacePorts } from "../shared/workspace-filter";
import { DaemonSurface } from "./daemon";
import { PROCESS_LIMIT, processKey, useMonitorRpc, type Process, type Snapshot } from "./rpc";
import { ForceStopModal, ProcessRow, ServiceCard, errorText, usePendingStops, useProcessActions } from "./surface";
import { Button, Card, Grid, Notice, Section, StatusPill, Tag, TokensProvider, useTokens, useUi } from "./ui";

const QUERY_KEY = ["monitor", "workspace-snapshot"] as const;
/** Enough rows to cover a busy workspace; the server bounds this too. */
const WORKSPACE_LIMIT = PROCESS_LIMIT * 4;

/**
 * The workspace tab. In "workspace" scope it narrows the host snapshot to the
 * open workspace's processes; in "host" scope it is the full Hosts surface.
 */
export function WorkspacePanel(props: PluginWorkspacePanelProps) {
  const settings = useSettings(hostsSettings);
  // Hooks run unconditionally; the scope decision happens after them.
  const tokens = useUi(props.theme, props.layout.compact);
  const values = settings.status === "ready" ? settings.values : HOSTS_SETTINGS_DEFAULTS;
  if (values.panelScope === "host") return <DaemonSurface {...props} />;
  return (
    <TokensProvider value={tokens}>
      <WorkspaceBody key={`${props.host.id}:${props.workspaceId}`} hostId={props.host.id} workspaceId={props.workspaceId} intervalSeconds={values.snapshotIntervalSeconds} settingsLoading={settings.status === "loading"} />
    </TokensProvider>
  );
}

function WorkspaceBody({ hostId, workspaceId, intervalSeconds, settingsLoading }: { hostId: string; workspaceId: string; intervalSeconds: number; settingsLoading: boolean }) {
  const t = useTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rpc = useMonitorRpc();
  const linkStatus = useRpc(link.linkStatus);
  const tunnelStop = useRpc(link.tunnelStop);
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
  const links = useQuery({ queryKey: ["daemon-link", hostId, "status"], queryFn: () => linkStatus({}), refetchInterval: intervalSeconds * 1000, retry: 1 });

  const host = snapshotQuery.data;
  const snapshot = useMemo<Snapshot | undefined>(() => {
    if (!host || !workspace) return undefined;
    const services = filterWorkspaceProcesses(host.services, workspace);
    const items = filterWorkspaceProcesses(host.processes.items, workspace, workspacePorts(services));
    return { ...host, services, processes: { items, total: items.length, truncated: host.processes.truncated } };
  }, [host, workspace]);
  const ports = useMemo(() => (snapshot ? workspacePorts([...snapshot.services, ...snapshot.processes.items]) : []), [snapshot]);
  const tunnels = useMemo(() => (links.data?.tunnels ?? []).filter((tunnel) => ports.includes(tunnel.port)), [links.data, ports]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    void links.refetch();
  }, [queryClient, links]);
  const pendingStops = usePendingStops(snapshot);
  const { actions, liveForceTarget, forceMutation, setForceTarget } = useProcessActions({ rpc, snapshot, pendingStops, refresh });
  const closeTunnel = useMutation({ mutationFn: (id: string) => tunnelStop({ id }), onSuccess: () => { void links.refetch(); }, onError: (error) => toast.error(errorText(error)) });

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
        <Notice icon="FolderCode" action={<Button label="Refresh" onPress={refresh} loading={snapshotQuery.isFetching} />}>
          Only processes running inside this workspace's directory are listed. Switch the panel to the whole host under Settings → Plugins → Daemon Link → Hosts.
        </Notice>
        {settingsLoading ? <Text style={t.text.caption}>Loading Hosts settings; using defaults until they arrive.</Text> : null}
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
            <Section title="Dev servers in this workspace" trailing={<Text style={t.text.caption}>{snapshot.services.length > 0 ? `${snapshot.services.length} found` : ""}</Text>}>
              {snapshot.services.length === 0 ? (
                <Notice icon="Server">No verified dev server is running inside this workspace. Start its dev command in a terminal here and it appears automatically.</Notice>
              ) : (
                <Grid min={300}>
                  {snapshot.services.map((process) => <ServiceCard key={processKey(process)} process={process} actions={actions} />)}
                </Grid>
              )}
            </Section>
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
                <Notice icon="Globe">No temporary browser link points at this workspace. Create one from Hosts → Dev Relay when you need to open an app on another device.</Notice>
              ) : (
                tunnels.map((tunnel) => (
                  <Card key={tunnel.id}>
                    <Text style={t.text.body}>Port {tunnel.port} · {tunnel.state}</Text>
                    <Text style={t.text.caption}>Expires {new Date(tunnel.expiresAt).toLocaleTimeString()} · {tunnel.message}</Text>
                    <Button label="Close browser link" disabled={closeTunnel.isPending} onPress={() => closeTunnel.mutate(tunnel.id)} />
                  </Card>
                ))
              )}
            </Section>
          </>
        ) : null}
      </View>
      <ForceStopModal target={liveForceTarget} busy={forceMutation.isPending} onCancel={() => setForceTarget(null)} onConfirm={(process) => forceMutation.mutate(process)} />
    </ScrollView>
  );
}
