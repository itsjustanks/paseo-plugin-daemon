import { Transfers } from "./transfers";
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { hostHealth } from "../shared/health";
import * as rpc from "../shared/link";
import * as peerRpc from "../shared/peers";
import { processReport } from "../shared/processes";
import { hostsSettings } from "../shared/settings";
import { TUNNEL_MINUTES_DEFAULT, formatMinutes, type TunnelMinutes } from "../shared/tunnel-lease";
import type { SetupCheck } from "./guide";
import { OverviewTab } from "./home";
import { IconBadge, MessageBar, QuietLine, SPACE, TYPE, type Tone } from "./kit";
import { TAB_IDS, TabBar, TabIntro, type TabId } from "./navigation";
import { OpenRow } from "./open-row";
import { errorMessage, useOpenService } from "./open-service";
import { Peers } from "./peers";
import { ProcessesTab, processesKey } from "./processes";
import { useMonitorRpc, processKey } from "./rpc";
import { Connections } from "./ssh";
import { ServiceCard, usePendingStops, useProcessActions } from "./surface";
import { TunnelCard } from "./tunnel-row";
import { Button, Card, Facts, Grid, Notice, Section, Segmented, StatusPill, TokensProvider, alpha, formatBytes, useTokens, useUi } from "./ui";

/**
 * The Hosts screen (Paseo 0.11) or sidebar surface (older apps).
 *
 * Five tabs under the shared design standard's header and tab bar. Overview
 * says whether the host is healthy and what to do next; Processes is the
 * heavy-process view (runaways, memory against the container's limit, an
 * ask-first stop); Dev servers, Connect and Project Sync are the jobs 0.9
 * had. The 0.9 Daemon Health tab is now Processes, and the setup guide and
 * checks are inside Overview's "How it works".
 */
type Route = "private" | "browser" | "ssh";
const ROUTES: { id: Route; label: string; icon: string; description: string }[] = [
  { id: "private", label: "Private localhost", icon: "Laptop", description: "Paired Paseo hosts · nothing public" },
  { id: "browser", label: "Browser link", icon: "Globe", description: "Public URL · any device · expires" },
  { id: "ssh", label: "SSH forward", icon: "Terminal", description: "Your SSH keys · 127.0.0.1 on your laptop" },
];
type Message = { text: string; tone: Tone } | null;
/** `params.tab` arrives with Paseo 0.11 screens (the popover's "See heavy processes"); `initialTab` is for the preview. */
type DaemonProps = PluginSurfaceProps & { shortcuts?: boolean; params?: Record<string, string>; initialTab?: TabId };

export function DaemonSurface(props: DaemonProps) {
  return <TokensProvider value={useUi(props.theme, props.layout.compact)}><DaemonBody key={props.host.id} {...props} /></TokensProvider>;
}

function Choice<Id extends string>({ items, selected, onChange, label }: { items: { id: Id; label: string; icon: string; description: string }[]; selected: Id; onChange(id: Id): void; label: string }) {
  const t = useTokens();
  return <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
    {items.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: selected === item.id }} onPress={() => onChange(item.id)}
      style={({ pressed }) => ({ flexGrow: 1, flexBasis: t.compact ? "100%" : 200, padding: t.space.md, gap: t.space.xs, borderRadius: t.radius.sm, borderWidth: 1, borderColor: selected === item.id ? t.color.accent : t.color.border, backgroundColor: selected === item.id ? alpha(t.color.accent, 0.09) : pressed ? t.color.surface2 : t.color.surface1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}><Icon name={item.icon} size={16} color={selected === item.id ? t.color.accent : t.color.muted} /><Text style={t.text.bodyStrong}>{item.label}</Text></View>
      <Text style={t.text.caption}>{item.description}</Text>
    </Pressable>)}
  </View>;
}

/** Which way the Dev servers tab reaches a server; one line says when each is right. */
type Reach = "browser" | "private";
const REACH_HINT: Record<Reach, string> = {
  browser: "A temporary public link to this host's server. Works from any device, including a phone, with nothing to install; the address is public until it expires.",
  private: "127.0.0.1 on your own computer, over SSH or a paired host. Nothing is published; set it up with your own computer's daemon selected in Paseo.",
};

/** The page header: the plugin's icon and name, and one line on this host with a coloured dot. */
function PageHeader({ theme, host, tone, line }: { theme: PluginSurfaceProps["theme"]; host: string; tone: Tone; line: string }) {
  const t = useTokens();
  const dot = tone === "success" ? t.color.success : tone === "warning" ? t.color.warning : tone === "danger" ? t.color.danger : t.color.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
      <IconBadge theme={theme} name="Network" size={46} />
      <View style={{ flex: 1, gap: SPACE.hair }}>
        <Text accessibilityRole="header" style={{ ...TYPE.page, color: t.color.fg }}>Hosts</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <Text style={{ ...TYPE.secondary, color: t.color.muted, flexShrink: 1 }}>{`${host} · ${line}`}</Text>
        </View>
      </View>
    </View>
  );
}

function DaemonBody(props: DaemonProps) {
  const t = useTokens();
  const { theme, layout } = props;
  const queryClient = useQueryClient();
  const wanted = props.initialTab ?? props.params?.tab;
  const [tab, setTab] = useState<TabId>(TAB_IDS.includes(wanted as TabId) ? (wanted as TabId) : "overview");
  const [route, setRoute] = useState<Route>("private");
  const [reach, setReach] = useState<Reach>("browser");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pairingRequested, setPairingRequested] = useState(false);
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
  const go = (next: TabId) => { setMessage(null); setTab(next); };
  const navigate = (next: TabId, nextRoute: Route = "private", pairing = false) => { go(next); setRoute(nextRoute); setPairingRequested(pairing); };
  const privateRoute = (port: number) => { setSshRemotePort(port); navigate("connect", "ssh"); };
  const ready = local.data?.scope?.status === "ready" && !local.isError;

  const checks: SetupCheck[] = [
    { state: links.isError ? "error" : links.data ? "ready" : "pending", title: "Daemon Link is reachable", detail: "The plugin on the selected host answers." },
    { state: ready ? "ready" : "pending", title: "Paseo projects verified", detail: local.data?.scope?.message || "Loading the selected host's project list…" },
    { state: apps.length ? "ready" : "pending", title: apps.length ? `${apps.length} dev server${apps.length === 1 ? "" : "s"} found` : "Start a dev server", detail: "It must run inside a registered project or workspace folder." },
    { state: peers.isError ? "error" : peers.data?.peers.length || peers.data?.grants.length ? "ready" : "optional", title: peers.data?.peers.length ? `${peers.data.peers.length} paired host${peers.data.peers.length === 1 ? "" : "s"} saved` : peers.data?.grants.length ? "Pairing code created on this host" : "Pair your second computer", detail: "Only needed for private links. A saved pairing doesn't prove the other host is online; open its service list to check." },
    ...(peers.data?.grants.length ? [{ state: peers.data.relayState === "connected" ? "ready" : "pending", title: "Incoming private relay", detail: `Current connection: ${peers.data.relayState}. Both plugins must stay running.` } satisfies SetupCheck] : []),
    { state: available ? "ready" : "optional", title: "Temporary browser links", detail: available ? "The link helper is installed. Press Open beside a server." : "One-time setup for the Open button; skip it if you only use private routes." },
  ];
  const visible = apps.filter((app) => `${app.project?.name} ${app.classification.label} ${app.ports.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const verdict = health.data;
  const container = summary.data?.container ?? null;
  const headerTone: Tone = links.isError ? "danger" : !verdict ? "neutral" : verdict.status === "ok" ? "success" : verdict.status === "critical" ? "danger" : verdict.status === "warning" ? "warning" : "neutral";
  const headerLine = links.isError ? "Daemon Link isn't answering" : container?.memoryLimitBytes ? `Container with a ${formatBytes(container.memoryLimitBytes)} memory limit` : summary.data?.platform === "darwin" ? "macOS, whole machine" : links.data ? "Daemon Link connected" : "Connecting…";
  const pad = layout.compact ? SPACE.md : SPACE.section;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.color.surface0 }} contentContainerStyle={{ padding: pad, paddingBottom: SPACE.section * 2, maxWidth: t.maxWidth, width: "100%", alignSelf: "center" }}>
      <PageHeader theme={theme} host={props.host.label} tone={headerTone} line={headerLine} />
      <TabBar theme={theme} compact={layout.compact} tabs={TAB_IDS} active={tab} onSelect={go} />
      {tab !== "overview" ? <TabIntro theme={theme} tab={tab} compact={layout.compact} /> : null}
      {message ? <MessageBar theme={theme} tone={message.tone} text={message.text} /> : null}
      <View style={{ gap: t.space.xl }}>
        {links.isError && tab !== "processes" && <Notice icon="WifiOff" tone="danger" action={<Button label="Retry connection" onPress={refresh} />}>{errorMessage(links.error)}</Notice>}
        {local.isError && (tab === "servers" || tab === "connect") && <Notice icon="CircleAlert" tone="danger" action={<Button label="Refresh projects" onPress={refresh} />}>{errorMessage(local.error)}</Notice>}
        {local.data?.scope?.status === "unavailable" && tab === "servers" && <Notice icon="ShieldAlert" tone="warning" action={<Button label="Refresh project access" onPress={refresh} />}>{local.data.scope.message}</Notice>}
      </View>
      {tab === "overview" ? <OverviewTab theme={theme} compact={layout.compact} hostId={props.host.id} host={props.host.label} verdict={verdict} report={summary.data} devServers={apps.length} liveLinks={tunnels.filter((tunnel) => tunnel.state === "connected").length} setupDone={ready && !links.isError} checks={checks} go={go} say={setMessage} onCheck={() => check.mutate()} checking={check.isPending} /> : null}
      {tab === "overview" && props.shortcuts ? <QuietLine theme={theme} icon="SquareSlash">Type /daemon-link in a workspace's message box to open Hosts for that workspace.</QuietLine> : null}
      {tab === "processes" ? <ProcessesTab theme={theme} compact={layout.compact} hostId={props.host.id} say={setMessage} /> : null}
      {tab === "servers" && <View style={{ gap: t.space.xl }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
          <StatusPill tone={ready ? "ok" : "warning"} label={ready ? "Projects verified" : "Projects need attention"} />
          <Facts items={[
            { value: `${ready ? apps.length : "—"} running` },
            { value: `${ready ? local.data?.scope?.projects.length || 0 : "—"} projects` },
            { value: `${tunnels.filter((tunnel) => tunnel.state === "connected").length} live links` },
            { value: `${peers.data?.forwards.length ?? 0} local forwards` },
          ]} />
          <Button label="Refresh" onPress={refresh} loading={local.isFetching && !local.data} />
        </View>
        <View style={{ gap: t.space.sm }}>
          <Segmented<Reach> label="How to reach a server" value={reach} onChange={setReach} options={[{ id: "browser", label: "Browser link" }, { id: "private", label: "Private forward" }]} />
          <Text style={t.text.caption}>{REACH_HINT[reach]}</Text>
        </View>
        {reach === "browser" && !available && links.data ? (
          <Notice icon="Globe" tone="warning" action={<Button label={opener.installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={opener.installing} disabled={opener.installing} onPress={() => opener.installLinks()} />}>
            One-time setup: install the link helper on {props.host.label}. No Cloudflare account, domain or SSH password is needed.
          </Notice>
        ) : null}
        {reach === "private" ? (
          <Notice icon="Laptop" action={<View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}><Button label="Pair hosts" variant="primary" onPress={() => navigate("connect", "private", true)} /><Button label="SSH forwards" onPress={() => navigate("connect", "ssh")} /></View>}>
            Private routes are set up on your own computer's daemon: switch Paseo's host picker to it, then pair it with {props.host.label} or save an SSH forward to the port shown on a card.
          </Notice>
        ) : null}
        {apps.length > 3 ? <TextInput accessibilityLabel="Search dev servers" placeholder="Search project, framework or port" placeholderTextColor={t.color.muted} value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: t.space.md, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface1 }} /> : null}
        {local.isPending ? <Text style={t.text.body}>Checking Paseo projects and their dev servers…</Text> : !apps.length ? (
          <Card><Text style={t.text.heading}>No dev server is running here yet</Text><Text style={t.text.body}>Open a project in Paseo and run its dev command in that project's terminal. It appears here with an Open button.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}><Button label="Show me how" variant="primary" onPress={() => go("overview")} /><Button label="Connect another device" onPress={() => navigate("connect")} /></View></Card>
        ) : !visible.length ? <Notice icon="Search">No dev servers match that search.</Notice> : (
          <Grid min={330}>
            {visible.map((app) => (
              <ServiceCard key={processKey(app)} process={app} actions={actions} footer={
                reach === "browser"
                  ? <OpenRow ports={app.ports} tunnels={tunnels} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} onPrivate={privateRoute} />
                  : <PrivateRow ports={app.ports} forwards={peers.data?.forwards ?? []} onSsh={privateRoute} onPair={() => navigate("connect", "private", true)} />
              } />
            ))}
          </Grid>
        )}
        {tunnels.length > 0 ? (
          <Section title="Browser links on this host" trailing={<Text style={t.text.caption}>Open extends a live link by {formatMinutes(minutes)}</Text>}>
            {tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)}
          </Section>
        ) : null}
        <QuietLine theme={theme} icon="Info">Other listeners, databases, system services and browser-control ports are left out. Link length is under Settings → Hosts; setup steps and checks are in Overview → New to Hosts.</QuietLine>
      </View>}
      {tab === "connect" && <View style={{ gap: t.space.xl }}>
        <Choice<Route> items={ROUTES} selected={route} onChange={setRoute} label="Connection method" />
        {route === "private" && <Peers initialView={pairingRequested ? "pair" : "apps"} hostId={props.host.id} hostLabel={props.host.label} onBrowserLink={() => setRoute("browser")} onGuide={() => go("overview")} />}
        {route === "browser" && <>
          <Card><Text style={t.text.heading}>Open this host's dev server on a phone or another browser</Text><Text style={t.text.body}>Select the host running the server. Open makes a private-session HTTPS link through Cloudflare that lasts {formatMinutes(minutes)} and can be extended without a new address. The other device doesn't need Paseo. Closing a link leaves the dev server running.</Text></Card>
          {!available && <Card><Text style={t.text.heading}>One-time browser-link setup</Text><Text style={t.text.body}>Install the link helper on {props.host.label}. No Cloudflare account, domain or SSH password is needed.</Text><Button label={opener.installing ? "Installing…" : "Set up browser links"} loading={opener.installing} disabled={!links.data || opener.installing} onPress={() => opener.installLinks()} /></Card>}
          {!apps.length && <Notice icon="FolderCode" action={<Button label="Show me how" onPress={() => go("overview")} />}>No dev servers from your Paseo projects are running on this host.</Notice>}
          <Grid min={300}>{apps.map((app) => <ServiceCard key={processKey(app)} process={app} actions={actions} footer={<OpenRow ports={app.ports} tunnels={tunnels} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} />} />)}</Grid>
          {tunnels.length > 0 && <Section title="Browser links on this host">{tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)}</Section>}
        </>}
        {route === "ssh" && <><Notice icon="KeyRound">Use this if you already reach the remote host with SSH keys. Save a forward on your own computer's daemon: the server then answers at 127.0.0.1 on your laptop and nothing is published. Pairing is simpler when both hosts run Paseo.</Notice><Connections profiles={links.data?.profiles || []} states={links.data?.connections || []} refresh={() => { void links.refetch(); }} initialRemotePort={sshRemotePort} /></>}
      </View>}
      {tab === "sync" && <Transfers hostId={props.host.id} openPairing={() => navigate("connect", "private", true)} />}
    </ScrollView>
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
