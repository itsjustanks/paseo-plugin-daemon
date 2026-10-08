import { Transfers } from "./transfers";
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { hostHealth } from "../shared/health";
import * as rpc from "../shared/link";
import * as peerRpc from "../shared/peers";
import { processReport } from "../shared/processes";
import { hostsSettings } from "../shared/settings";
import { TUNNEL_MINUTES_DEFAULT, formatMinutes, type TunnelMinutes } from "../shared/tunnel-lease";
import { resolveTab, type Fold } from "../shared/tabs";
import { SayProvider, useSay } from "./feedback";
import { HostsNavigationProvider, OpenTerminalButton } from "./ask";
import { syncScreenParams } from "./native";
import { HelpTab, type SetupCheck } from "./guide";
import { OverviewTab } from "./home";
import { Accordion, AccordionItem, IconBadge, MessageBar, QuietLine, SectionTitle, SPACE, TYPE, type Tone } from "./kit";
import { CacheList, DiskCard, WorkspaceList, idleClearable, useDiskReport } from "./workspaces";
import { formatSize } from "../shared/disk";
import { TAB_IDS, TabBar, TabLine, type TabId } from "./navigation";
import { OpenRow } from "./open-row";
import { errorMessage, useOpenService } from "./open-service";
import { Peers } from "./peers";
import { ProcessesTab, processesKey } from "./processes";
import { useMonitorRpc, processKey } from "./rpc";
import { Connections } from "./ssh";
import { ServiceCard, usePendingStops, useProcessActions } from "./surface";
import { TunnelCard } from "./tunnel-row";
import { Button, Card, Facts, Grid, Notice, StatusPill, TokensProvider, formatBytes, useTokens, useUi } from "./ui";

/**
 * The Hosts screen (Paseo 0.11) or sidebar surface (older apps).
 *
 * Four tabs (0.11.0), by what someone comes to do: Overview says whether the
 * host is healthy; Processes finds what is slowing it down and stops it after
 * asking; Workspaces opens your apps and shows disk use; Help answers plain questions. Connect
 * and Project Sync were tabs until 0.10: both are about other computers, so
 * they fold out under Workspaces (`shared/tabs.ts` maps the old ids).
 */
/** `params.tab` (and `params.open`) arrive with Paseo 0.11 screens; `initialTab` is for the preview. */
type DaemonProps = PluginSurfaceProps & { shortcuts?: boolean; params?: Record<string, string>; initialTab?: string };

export function DaemonSurface(props: DaemonProps) {
  return <TokensProvider value={useUi(props.theme, props.layout.compact)}><HostsNavigationProvider navigation={props.navigation}><DaemonBody key={props.host.id} {...props} /></HostsNavigationProvider></TokensProvider>;
}

/** The page header: the plugin's icon and name, one line on this host with a coloured dot, and the page's one Refresh link (0.12.1). */
export function PageHeader({ theme, title = "Hosts", host, tone, line, onRefresh, refreshing }: { theme: PluginSurfaceProps["theme"]; title?: string; host: string; tone: Tone; line: string; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useTokens();
  const dot = tone === "success" ? t.color.success : tone === "warning" ? t.color.warning : tone === "danger" ? t.color.danger : t.color.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
      <IconBadge theme={theme} name="Network" size={46} />
      <View style={{ flex: 1, gap: SPACE.hair }}>
        <Text accessibilityRole="header" style={{ ...TYPE.page, color: t.color.fg }}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <Text style={{ ...TYPE.secondary, color: t.color.muted, flexShrink: 1 }}>{host ? `${host} · ${line}` : line}</Text>
        </View>
      </View>
      {onRefresh ? (
        <Pressable accessibilityRole="link" accessibilityLabel="Refresh" disabled={refreshing} onPress={onRefresh} hitSlop={SPACE.sm} style={{ alignSelf: "flex-start", paddingTop: SPACE.xs }}>
          <Text style={{ ...TYPE.secondary, fontWeight: "600", color: refreshing ? t.color.muted : t.color.accent }}>{refreshing ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DaemonBody(props: DaemonProps) {
  const t = useTokens();
  const { theme, layout } = props;
  const queryClient = useQueryClient();
  const asked = props.initialTab ?? props.params?.tab;
  const start = resolveTab(asked, props.params?.open);
  const [tab, setTab] = useState<TabId>(start.tab);
  // Which Workspaces fold-out a button (or an old link) asked to open; `asked` remounts it so a second press re-opens it.
  const [fold, setFold] = useState<{ id: Fold | null; asked: number }>({ id: start.fold, asked: 0 });
  const [search, setSearch] = useState("");
  // 0.15.0: replies are Paseo toasts where the app has them; the message bar stays only for older apps.
  const [message, setMessage] = useSay();
  const [pairingRequested, setPairingRequested] = useState(start.fold === "private" && asked === "pair");
  const [sshRemotePort, setSshRemotePort] = useState<number | undefined>();
  const settings = useSettings(hostsSettings);
  const minutes: TunnelMinutes = settings.status === "ready" ? settings.values.tunnelMinutes : TUNNEL_MINUTES_DEFAULT;
  const status = useRpc(rpc.linkStatus), peerStatus = useRpc(peerRpc.peerStatus), healthRpc = useRpc(hostHealth), reportRpc = useRpc(processReport);
  const monitor = useMonitorRpc();
  const links = useQuery({ queryKey: ["daemon-link", props.host.id, "status"], queryFn: () => status({}), refetchInterval: 3000, retry: 1 });
  const peers = useQuery({ queryKey: ["daemon-link", props.host.id, "peers"], queryFn: () => peerStatus({}), refetchInterval: 3000, retry: 1 });
  const local = useQuery({ queryKey: ["daemon-link", props.host.id, "services"], queryFn: () => monitor.snapshot({ query: "", sort: "name", limit: 25 }), refetchInterval: 5000, retry: 1 });
  const health = useQuery({ queryKey: ["daemon-link", props.host.id, "health"], queryFn: () => healthRpc({}), refetchInterval: 20_000, retry: 1 });
  const summary = useQuery({ queryKey: [...processesKey(props.host.id), "summary"], queryFn: () => reportRpc({ limit: 1 }), refetchInterval: 20_000, retry: 1, enabled: tab === "overview" });
  const check = useMutation({ mutationFn: () => healthRpc({ refresh: true }), onSuccess: (verdict) => { queryClient.setQueryData(["daemon-link", props.host.id, "health"], verdict); void summary.refetch(); } });
  const apps = useMemo(() => local.data?.services.filter((process) => process.project?.shareable && !process.protectedReason) || [], [local.data]);
  const available = links.data?.cloudflared === true;
  const tunnels = links.data?.tunnels ?? [];
  const opener = useOpenService({ links, minutes });
  const refresh = () => { void local.refetch(); void links.refetch(); void peers.refetch(); void health.refetch(); };
  const pendingStops = usePendingStops(local.data);
  const { actions } = useProcessActions({ rpc: monitor, snapshot: local.data, pendingStops, refresh });
  const go = (next: TabId, nextFold: Fold | null = null, pairing = false) => {
    setMessage(null);
    setTab(next);
    setFold((previous) => ({ id: nextFold, asked: previous.asked + 1 }));
    setPairingRequested(pairing);
    // 0.11+ screens: the app's header title follows the tab ("Hosts · Processes").
    syncScreenParams({ ...(next === "overview" ? {} : { tab: next }), ...(nextFold ? { open: nextFold } : {}) }, props.params);
  };
  // A link that opens this screen again while it's showing (the dot's "See heavy processes") moves it to that tab.
  const paramTab = props.params?.tab, paramOpen = props.params?.open;
  useEffect(() => {
    if (props.params === undefined) return;
    const target = resolveTab(paramTab, paramOpen);
    setTab(target.tab);
    if (target.fold) setFold((previous) => ({ id: target.fold, asked: previous.asked + 1 }));
  }, [paramTab, paramOpen]);
  // 0.14.0: the disk report is read (and polled) only while Workspaces shows. A check never starts by itself:
  // "Check disk space" there, Refresh on Workspaces, or the Command Center's "Check disk space" starts one.
  const disk = useDiskReport(props.host.id, tab === "workspaces");
  const refreshAll = () => { check.mutate(); void queryClient.invalidateQueries({ queryKey: ["daemon-link", props.host.id] }); if (tab === "workspaces") disk.scan.mutate(); };
  // 0.15.0: a check takes a minute or two, so say when it's done (a toast, or the message bar on older apps).
  const scanState = disk.report?.scan.state;
  const lastScanState = useRef(scanState);
  useEffect(() => {
    const before = lastScanState.current;
    lastScanState.current = scanState;
    if (before !== "running" || scanState !== "done" || !disk.report) return;
    const safe = idleClearable(disk.report);
    setMessage({ tone: "success", text: safe.bytes > 0 ? `Disk check finished: about ${formatSize(safe.bytes)} looks safe to clear in ${safe.workspaces} idle workspace${safe.workspaces === 1 ? "" : "s"}.` : "Disk check finished: nothing looks safe to clear in your idle workspaces right now." });
  }, [scanState]);
  const toHelp = (next: TabId, nextFold?: Fold) => go(next, nextFold ?? null, nextFold === "private");
  const privateRoute = (port: number) => { setSshRemotePort(port); go("workspaces", "ssh"); };
  const ready = local.data?.scope?.status === "ready" && !local.isError;

  const checks: SetupCheck[] = [
    { state: links.isError ? "error" : links.data ? "ready" : "pending", title: "Hosts is answering", detail: "The plugin on the selected host answers." },
    { state: ready ? "ready" : "pending", title: "Paseo projects found", detail: local.data?.scope?.message || "Loading the selected host's project list…" },
    // Optional (0.12.1): a calm host with no dev server running has nothing left to do.
    { state: apps.length ? "ready" : "optional", title: apps.length ? `${apps.length} dev server${apps.length === 1 ? "" : "s"} found` : "Start a dev server", detail: "It must run inside a project or workspace folder that Paseo knows." },
    { state: peers.isError ? "error" : peers.data?.peers.length || peers.data?.grants.length ? "ready" : "optional", title: peers.data?.peers.length ? `${peers.data.peers.length} paired computer${peers.data.peers.length === 1 ? "" : "s"} saved` : peers.data?.grants.length ? "Pairing code created on this host" : "Pair your own computer", detail: "Only needed for private links. A saved pairing doesn't prove the other computer is online; open its app list to check." },
    ...(peers.data?.grants.length ? [{ state: peers.data.relayState === "connected" ? "ready" : "pending", title: "Incoming private connection", detail: `Current connection: ${peers.data.relayState}. Hosts must keep running on both computers.` } satisfies SetupCheck] : []),
    { state: available ? "ready" : "optional", title: "Browser links", detail: available ? "The link helper is installed. Press Open beside a server." : "One-time setup for the Open button; skip it if you only use private links." },
  ];
  const visible = apps.filter((app) => `${app.project?.name} ${app.classification.label} ${app.ports.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const verdict = health.data;
  const container = summary.data?.container ?? null;
  const liveLinks = tunnels.filter((tunnel) => tunnel.state === "connected").length;
  const forwards = peers.data?.forwards ?? [];
  const profiles = links.data?.profiles ?? [];
  const headerTone: Tone = links.isError ? "danger" : !verdict ? "neutral" : verdict.status === "ok" ? "success" : verdict.status === "critical" ? "danger" : verdict.status === "warning" ? "warning" : "neutral";
  // The memory basis is said here once (0.12.1), not again on Overview's Memory row.
  const headerLine = links.isError ? "Hosts isn't answering" : container?.memoryLimitBytes ? `Container with a ${formatBytes(container.memoryLimitBytes)} memory limit` : summary.data?.platform === "darwin" ? "macOS, whole machine" : links.data ? "Connected" : "Connecting…";
  const pad = layout.compact ? SPACE.md : SPACE.section;
  const foldOpen = (id: Fold) => fold.id === id;
  const foldKey = (id: Fold) => `${id}-${fold.id === id ? fold.asked : "closed"}`;

  return (
    <SayProvider say={setMessage}>
    <ScrollView style={{ flex: 1, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: pad, paddingBottom: SPACE.section * 2, maxWidth: t.maxWidth, width: "100%", alignSelf: "center" }}>
      <PageHeader theme={theme} host={props.host.label} tone={headerTone} line={headerLine} onRefresh={refreshAll} refreshing={check.isPending} />
      <TabBar theme={theme} compact={layout.compact} tabs={TAB_IDS} active={tab} onSelect={(next) => go(next)} />
      <TabLine theme={theme} tab={tab} />
      {message ? <MessageBar theme={theme} tone={message.tone} text={message.text} /> : null}
      <View style={{ gap: t.space.xl }}>
        {links.isError && tab !== "processes" && tab !== "help" && <Notice icon="WifiOff" tone="danger" action={<Button label="Retry connection" onPress={refresh} />}>{errorMessage(links.error)}</Notice>}
        {local.isError && tab === "workspaces" && <Notice icon="CircleAlert" tone="danger" action={<Button label="Refresh projects" onPress={refresh} />}>{errorMessage(local.error)}</Notice>}
        {local.data?.scope?.status === "unavailable" && tab === "workspaces" && <Notice icon="ShieldAlert" tone="warning" action={<Button label="Refresh project access" onPress={refresh} />}>{local.data.scope.message}</Notice>}
      </View>
      {tab === "overview" ? <OverviewTab theme={theme} compact={layout.compact} hostId={props.host.id} verdict={verdict} report={summary.data} devServers={apps.length} liveLinks={liveLinks} setupDone={ready && !links.isError} checks={checks} go={toHelp} say={setMessage}
        sync={<AccordionItem key={foldKey("sync")} theme={theme} compact={layout.compact} icon="FolderSync" title="Copy a project from another computer" summary="Preview its Git history before it arrives (Project Sync)" open={foldOpen("sync")}>
          <Transfers hostId={props.host.id} openPairing={() => go("workspaces", "private", true)} />
        </AccordionItem>} /> : null}
      {tab === "processes" ? <ProcessesTab theme={theme} compact={layout.compact} hostId={props.host.id} say={setMessage} issues={verdict?.issues ?? []} onChanged={() => void health.refetch()} /> : null}
      {tab === "help" ? <HelpTab theme={theme} compact={layout.compact} go={toHelp} minutes={formatMinutes(minutes)} shortcuts={!!props.shortcuts} /> : null}
      {tab === "workspaces" && <View style={{ gap: t.space.xl }}>
        <DiskCard theme={theme} report={disk.report} loading={disk.query.isPending} scanning={disk.scan.isPending} onScan={() => disk.scan.mutate()} onCaches={() => go("workspaces", "caches")} askNow={fold.id === "cleanup"} onAsked={() => go("workspaces")} />
        {apps.length || !ready ? (
          <View style={{ gap: t.space.md }}>
            <SectionTitle theme={theme} icon="Server">{apps.length ? `Dev servers running now · ${apps.length}` : "Dev servers"}</SectionTitle>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
              <StatusPill tone={local.isPending ? "neutral" : !ready ? "warning" : apps.length ? "ok" : "neutral"} label={local.isPending ? "Checking…" : ready ? (apps.length ? `${apps.length} running` : "None running") : "Projects need attention"} />
              {ready ? <Facts items={[{ value: `in ${local.data?.scope?.projects.length || 0} project${local.data?.scope?.projects.length === 1 ? "" : "s"}` }]} /> : null}
            </View>
            {!available && links.data && apps.length ? (
              <Notice icon="Globe" tone="warning" action={<Button label={opener.installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={opener.installing} disabled={opener.installing} onPress={() => opener.installLinks()} />}>
                One-time setup for the Open button: install the link helper on {props.host.label}. No account, domain or password is needed.
              </Notice>
            ) : null}
            {apps.length > 3 ? <TextInput accessibilityLabel="Search dev servers" placeholder="Search project, framework or port" placeholderTextColor={t.color.muted} value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: t.space.md, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface1 }} /> : null}
            {local.isPending ? <Text style={t.text.body}>Checking Paseo projects and their dev servers…</Text> : !apps.length ? null : !visible.length ? <Notice icon="Search">No dev servers match that search.</Notice> : (
              <Grid min={330}>
                {visible.map((app) => (
                  <ServiceCard key={processKey(app)} process={app} actions={actions} footer={
                    <>
                      <OpenRow ports={app.ports} tunnels={tunnels} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} onPrivate={privateRoute} />
                      <OpenTerminalButton theme={theme} pid={app.pid} />
                    </>
                  } />
                ))}
              </Grid>
            )}
          </View>
        ) : null}
        <WorkspaceList theme={theme} compact={layout.compact} report={disk.report} />
        <Accordion theme={theme}>
          {disk.report && disk.report.scan.state !== "never" ? (
            <AccordionItem key={foldKey("caches")} theme={theme} compact={layout.compact} icon="Archive" title="Shared caches and temporary files" summary={disk.report.caches.length ? `${formatSize(disk.report.caches.reduce((sum, group) => sum + group.totalBytes, 0))} · package downloads, tool caches, old browser downloads, /tmp leftovers` : disk.report.scan.state === "running" ? "Checking…" : "Nothing found"} open={foldOpen("caches")}>
              <CacheList theme={theme} groups={disk.report.caches} />
            </AccordionItem>
          ) : null}
          {tunnels.length > 0 ? (
            <AccordionItem key={foldKey("links")} theme={theme} compact={layout.compact} icon="Globe" title="Browser links you've opened" summary={`${tunnels.length} on this host · ${liveLinks} live · Open adds ${formatMinutes(minutes)}`} open={foldOpen("links")}>
              {tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)}
            </AccordionItem>
          ) : null}
          <AccordionItem key={foldKey("private")} theme={theme} compact={layout.compact} icon="Laptop" title="Open privately on your own computer" summary={forwards.length ? `${forwards.length} private link${forwards.length === 1 ? "" : "s"} open · nothing is published` : "Pair with your own computer; nothing is published"} open={foldOpen("private")}>
            <Text style={t.text.body}>Switch Paseo's host picker to your own computer, then pair it with {props.host.label}. Its dev servers then open at 127.0.0.1 on your computer.</Text>
            {apps.length ? apps.map((app) => (
              <View key={processKey(app)} style={{ gap: t.space.xs }}>
                <Text style={t.text.bodyStrong}>{app.project?.name || app.name}</Text>
                <PrivateRow ports={app.ports} forwards={forwards} onSsh={privateRoute} onPair={() => go("workspaces", "private", true)} />
              </View>
            )) : null}
            <Peers initialView={pairingRequested ? "pair" : "apps"} hostId={props.host.id} hostLabel={props.host.label} onBrowserLink={() => go("workspaces")} onGuide={() => go("help")} />
          </AccordionItem>
          <AccordionItem key={foldKey("ssh")} theme={theme} compact={layout.compact} icon="KeyRound" title="Use your SSH keys instead" summary={profiles.length ? `${profiles.length} saved forward${profiles.length === 1 ? "" : "s"}` : "For a host you already reach with SSH"} open={foldOpen("ssh")}>
            <Text style={t.text.body}>Save a forward on your own computer's daemon: the server then answers at 127.0.0.1 on your laptop and nothing is published. Pairing is simpler when both computers run Paseo.</Text>
            <Connections profiles={profiles} states={links.data?.connections || []} refresh={() => { void links.refetch(); }} initialRemotePort={sshRemotePort} />
          </AccordionItem>
        </Accordion>
        {!apps.length && ready ? <QuietLine theme={theme} icon="Server">No dev server is running. Run a project's dev command in its Paseo terminal and it appears here with an Open button.</QuietLine> : null}
        <QuietLine theme={theme} icon="Info">Databases, system services and other listeners are left out. Link length is under Settings → Hosts.</QuietLine>
      </View>}
    </ScrollView>
    </SayProvider>
  );
}

/** The private-route footer: what to forward, and where to go to do it. */
function PrivateRow({ ports, forwards, onSsh, onPair }: { ports: readonly number[]; forwards: readonly { remotePort: number; localPort: number }[]; onSsh(port: number): void; onPair(): void }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm, borderTopWidth: 1, borderTopColor: t.color.borderSubtle, paddingTop: t.space.sm }}>
      {ports.map((port) => {
        const forward = forwards.find((item) => item.remotePort === port);
        return (
          <View key={port} style={{ gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm, flexWrap: "wrap" }}>
              <Text style={t.text.bodyStrong}>remote :{port} → your 127.0.0.1:{forward ? forward.localPort : port}</Text>
              <StatusPill tone={forward ? "ok" : "neutral"} label={forward ? "Forward active" : "Not forwarded"} />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
              <Button label="SSH forward…" variant="primary" icon="Terminal" accessibilityLabel={`Save an SSH forward for port ${port}`} onPress={() => onSsh(port)} />
              <Button label="Paired-host link…" icon="Laptop" accessibilityLabel={`Open port ${port} through a paired host`} onPress={onPair} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
