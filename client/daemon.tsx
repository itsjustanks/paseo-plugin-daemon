import { Transfers } from "./transfers";
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as rpc from "../shared/link";
import * as peerRpc from "../shared/peers";
import { HOSTS_SETTINGS_DEFAULTS, hostsSettings } from "../shared/settings";
import { TUNNEL_MINUTES_DEFAULT, formatMinutes, type TunnelMinutes } from "../shared/tunnel-lease";
import { OpenRow } from "./open-row";
import { errorMessage, useOpenService } from "./open-service";
import { SetupGuide, useGuideState, type GuideNav, type SetupCheck } from "./overview";
import { Peers } from "./peers";
import { useMonitorRpc, processKey } from "./rpc";
import { Connections } from "./ssh";
import { MonitorSurface, ServiceCard, usePendingStops, useProcessActions } from "./surface";
import { TunnelCard } from "./tunnel-row";
import { Button, Card, Facts, Grid, Notice, Section, Segmented, StatusPill, TokensProvider, alpha, useTokens, useUi } from "./ui";

/**
 * The Hosts sidebar surface.
 *
 * Four tabs. "Dev servers" is what you came for: one card per verified dev
 * server on the selected host, each with Open. The former Overview (counts
 * and "next step" cards) and Local Projects (the list itself) both answered
 * "what can I open?", so they are one tab now, and the former Guide & Setup
 * tab is a collapsed card at its foot. Connect (was Dev Relay), Project Sync
 * and Daemon Health are distinct jobs and keep their own tabs.
 */
type Tab = "servers" | "relay" | "sync" | "health";
type Route = "private" | "browser" | "ssh";
const TABS: { id: Tab; label: string; icon: string; description: string }[] = [
  { id: "servers", label: "Dev servers", icon: "Server", description: "Open what is running here" },
  { id: "relay", label: "Connect", icon: "Network", description: "Pair hosts, browser links, SSH" },
  { id: "sync", label: "Project Sync", icon: "FolderSync", description: "Receive projects and view history" },
  { id: "health", label: "Daemon Health", icon: "Activity", description: "Resources and project processes" },
];
const ROUTES: { id: Route; label: string; icon: string; description: string }[] = [
  { id: "private", label: "Private localhost", icon: "Laptop", description: "Paired Paseo hosts · nothing public" },
  { id: "browser", label: "Browser link", icon: "Globe", description: "Public URL · any device · expires" },
  { id: "ssh", label: "SSH forward", icon: "Terminal", description: "Your SSH keys · 127.0.0.1 on your laptop" },
];
type DaemonProps = PluginSurfaceProps & { shortcuts?: boolean };

export function DaemonSurface(props: DaemonProps) {
  return <TokensProvider value={useUi(props.theme, props.layout.compact)}><DaemonBody key={props.host.id} {...props} /></TokensProvider>;
}

function Choice<Id extends string>({ items, selected, onChange, label }: { items: { id: Id; label: string; icon: string; description: string }[]; selected: Id; onChange(id: Id): void; label: string }) {
  const t = useTokens();
  const narrowNavigation = t.compact && items.length > 3;
  const choices = <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: narrowNavigation ? "nowrap" : "wrap", gap: 8 }}>
    {items.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: selected === item.id }} onPress={() => onChange(item.id)}
      style={({ pressed }) => ({ flexGrow: narrowNavigation ? 0 : 1, flexBasis: narrowNavigation ? "auto" : t.compact ? "44%" : items.length > 3 ? 140 : 180, minHeight: narrowNavigation ? 44 : 68, padding: 12, gap: 5, borderRadius: 10, borderWidth: 1, borderColor: selected === item.id ? t.color.accent : t.color.border, backgroundColor: selected === item.id ? alpha(t.color.accent, 0.09) : pressed ? t.color.surface2 : t.color.surface1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Icon name={item.icon} size={16} color={selected === item.id ? t.color.accent : t.color.muted} /><Text style={t.text.bodyStrong}>{item.label}</Text></View>
      {!narrowNavigation && <Text style={t.text.caption}>{item.description}</Text>}
    </Pressable>)}
  </View>;
  return narrowNavigation ? <ScrollView horizontal showsHorizontalScrollIndicator={false}>{choices}</ScrollView> : choices;
}

/** Which way the Dev servers tab reaches a server; one line says when each is right. */
type Reach = "browser" | "private";
const REACH_HINT: Record<Reach, string> = {
  browser: "A temporary public HTTPS link to this host's server. Works from any device, including a phone; needs nothing installed on your computer; the URL is public until it expires.",
  private: "127.0.0.1:PORT on your own computer over SSH or a paired-host relay. Nothing is published; set it up with your computer's daemon selected in Paseo.",
};

function DaemonBody(props: DaemonProps) {
  const t = useTokens();
  const [tab, setTab] = useState<Tab>("servers"), [route, setRoute] = useState<Route>("private");
  const [reach, setReach] = useState<Reach>("browser");
  const [search, setSearch] = useState("");
  const [pairingRequested, setPairingRequested] = useState(false);
  const [sshRemotePort, setSshRemotePort] = useState<number | undefined>();
  const guide = useGuideState();
  const settings = useSettings(hostsSettings);
  const minutes: TunnelMinutes = settings.status === "ready" ? settings.values.tunnelMinutes : TUNNEL_MINUTES_DEFAULT;
  const status = useRpc(rpc.linkStatus), peerStatus = useRpc(peerRpc.peerStatus);
  const monitor = useMonitorRpc();
  const links = useQuery({ queryKey: ["daemon-link", props.host.id, "status"], queryFn: () => status({}), refetchInterval: 3000, retry: 1 });
  const peers = useQuery({ queryKey: ["daemon-link", props.host.id, "peers"], queryFn: () => peerStatus({}), refetchInterval: 3000, retry: 1 });
  const local = useQuery({ queryKey: ["daemon-link", props.host.id, "services"], queryFn: () => monitor.snapshot({ query: "", sort: "name", limit: 25 }), refetchInterval: 5000, enabled: tab !== "health", retry: 1 });
  const apps = useMemo(() => local.data?.services.filter((process) => process.project?.shareable && !process.protectedReason) || [], [local.data]);
  const available = links.data?.cloudflared === true;
  const tunnels = links.data?.tunnels ?? [];
  const opener = useOpenService({ links, minutes });
  const refresh = () => { void local.refetch(); void links.refetch(); void peers.refetch(); };
  const pendingStops = usePendingStops(local.data);
  const { actions } = useProcessActions({ rpc: monitor, snapshot: local.data, pendingStops, refresh });
  const navigate = (next: Tab, nextRoute: Route = "private", pairing = false) => { setTab(next); setRoute(nextRoute); setPairingRequested(pairing); };
  const guideNav: GuideNav = (target) => {
    if (target === "pair") navigate("relay", "private", true);
    else navigate("relay", target === "relay-ssh" ? "ssh" : target === "relay-browser" ? "browser" : "private");
  };
  const openGuide = () => { setTab("servers"); guide.show(); };
  const privateRoute = (port: number) => { setSshRemotePort(port); navigate("relay", "ssh"); };
  const ready = local.data?.scope?.status === "ready" && !local.isError;

  const checks: SetupCheck[] = [
    { state: links.isError ? "error" : links.data ? "ready" : "pending", title: "Daemon Link is reachable", detail: "This checks the selected host's plugin connection." },
    { state: ready ? "ready" : "pending", title: "Paseo projects verified", detail: local.data?.scope?.message || "Loading the selected host's project registry…" },
    { state: apps.length ? "ready" : "pending", title: apps.length ? `${apps.length} project apps found` : "Start a dev server", detail: "The server must run inside a registered project or workspace directory." },
    { state: peers.isError ? "error" : peers.data?.peers.length || peers.data?.grants.length ? "ready" : "pending", title: peers.data?.peers.length ? `${peers.data.peers.length} paired hosts saved` : peers.data?.grants.length ? "Pairing code created on this host" : "Pair your second computer", detail: "A saved pairing does not prove the other host is online. Open its service list to check the live connection." },
    ...(peers.data?.grants.length ? [{ state: peers.data.relayState === "connected" ? "ready" : "pending", title: "Incoming private relay", detail: `Current connection: ${peers.data.relayState}. Both plugins must stay running.` } satisfies SetupCheck] : []),
    { state: available ? "ready" : "optional", title: "Temporary browser links", detail: available ? "Tunnel helper is installed. Press Open beside a server." : "One-time setup for the Open button; optional if you only use private routes." },
  ];

  const visible = apps.filter((app) => `${app.project?.name} ${app.classification.label} ${app.ports.join(" ")}`.toLowerCase().includes(search.toLowerCase()));

  return <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
    <View style={{ padding: t.space.lg, gap: t.space.md, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ gap: 3, flexShrink: 1 }}><Text style={t.text.title}>Hosts</Text><Text style={t.text.label}>Selected host: {props.host.label}</Text></View>
        <StatusPill tone={links.isError ? "danger" : links.data ? "ok" : "neutral"} label={links.isError ? "Host unavailable" : links.data ? "Plugin connected" : "Connecting"} />
      </View>
      <Choice<Tab> items={TABS} selected={tab} onChange={setTab} label="Daemon Link sections" />
    </View>
    {tab === "health" ? <MonitorSurface {...props} /> : <ScrollView key={tab} contentContainerStyle={{ padding: t.space.lg, paddingTop: 4, gap: t.space.lg, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
      {links.isError && <Notice icon="WifiOff" tone="danger" action={<Button label="Retry connection" onPress={refresh} />}>{errorMessage(links.error)}</Notice>}
      {local.isError && <Notice icon="CircleAlert" tone="danger" action={<Button label="Refresh projects" onPress={refresh} />}>{errorMessage(local.error)}</Notice>}
      {local.data?.scope?.status === "unavailable" && <Notice icon="ShieldAlert" tone="warning" action={<Button label="Refresh project access" onPress={refresh} />}>{local.data.scope.message}</Notice>}
      {tab === "servers" && <>
        <Intro eyebrow="DEV SERVERS" title={`Running on ${props.host.label}`} description="Every verified dev server on the selected host, with one press to open it. Servers appear when their process runs inside a registered project or workspace." />
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <StatusPill tone={ready ? "ok" : "warning"} label={ready ? "Project access verified" : "Project access needs attention"} />
          <Facts items={[
            { value: `${ready ? apps.length : "—"} running apps` },
            { value: `${ready ? local.data?.scope?.projects.length || 0 : "—"} registered projects` },
            { value: `${tunnels.filter((tunnel) => tunnel.state === "connected").length} live links` },
            { value: `${peers.data?.forwards.length ?? 0} local forwards` },
          ]} />
          <Button label="Refresh" onPress={refresh} loading={local.isFetching && !local.data} />
        </View>
        <View style={{ gap: t.space.xs }}>
          <Segmented<Reach> label="How to reach a server" value={reach} onChange={setReach} options={[{ id: "browser", label: "Browser link" }, { id: "private", label: "Private forward" }]} />
          <Text style={[t.text.caption, { maxWidth: 760 }]}>{REACH_HINT[reach]}</Text>
        </View>
        {reach === "browser" && !available && links.data ? (
          <Notice icon="Globe" tone="warning" action={<Button label={opener.installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={opener.installing} disabled={opener.installing} onPress={() => opener.installLinks()} />}>
            One-time setup: install the tunnel helper on {props.host.label}. No Cloudflare account, domain, or SSH password is needed.
          </Notice>
        ) : null}
        {reach === "private" ? (
          <Notice icon="Laptop" action={<View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}><Button label="Pair hosts" variant="primary" onPress={() => navigate("relay", "private", true)} /><Button label="SSH forwards" onPress={() => navigate("relay", "ssh")} /></View>}>
            Private routes are set up on your own computer's daemon: switch Paseo's host picker to it, then pair it with {props.host.label} or save an SSH forward to the port shown on a card.
          </Notice>
        ) : null}
        {apps.length > 3 ? <TextInput accessibilityLabel="Search project services" placeholder="Search project, framework, or port" placeholderTextColor={t.color.muted} value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface1 }} /> : null}
        {local.isPending ? <Text style={t.text.body}>Checking Paseo projects and their dev servers…</Text> : !apps.length ? (
          <Card><Text style={t.text.heading}>No dev server is running here yet</Text><Text style={t.text.body}>Open a project in Paseo and run its dev command in that project's terminal. The app appears here automatically with an Open button.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label="Show the steps" variant="primary" onPress={openGuide} /><Button label="Connect another device" onPress={() => navigate("relay")} /></View></Card>
        ) : !visible.length ? <Notice icon="Search">No project apps match that search.</Notice> : (
          <Grid min={330}>
            {visible.map((app) => (
              <ServiceCard key={processKey(app)} process={app} actions={actions} footer={
                reach === "browser"
                  ? <OpenRow ports={app.ports} tunnels={tunnels} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} onPrivate={privateRoute} />
                  : <PrivateRow ports={app.ports} forwards={peers.data?.forwards ?? []} onSsh={privateRoute} onPair={() => navigate("relay", "private", true)} />
              } />
            ))}
          </Grid>
        )}
        {tunnels.length > 0 ? (
          <Section title="Browser links on this host" trailing={<Text style={t.text.caption}>Open extends a live link by {formatMinutes(minutes)}; change it under Settings → Hosts</Text>}>
            {tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)}
          </Section>
        ) : null}
        <Text style={t.text.caption}>Unrelated listeners, databases, system services, and browser-control ports are excluded. Stop controls are in Daemon Health and apply only to verified project dev servers.</Text>
        <SetupGuide host={props.host.label} checks={checks} expanded={guide.expanded} onToggle={guide.toggle} navigate={guideNav} onRefresh={refresh} shortcuts={props.shortcuts} />
      </>}
      {tab === "relay" && <>
        <Intro eyebrow="CONNECT" title="Choose how to reach a project app" description="Private localhost is the everyday route between two computers running Paseo. A browser link is the quick public route for any device. An SSH forward uses the keys you already have." />
        <Choice<Route> items={ROUTES} selected={route} onChange={setRoute} label="Connection method" />
        {route === "private" && <Peers initialView={pairingRequested ? "pair" : "apps"} hostId={props.host.id} hostLabel={props.host.label} onBrowserLink={() => setRoute("browser")} onGuide={openGuide} />}
        {route === "browser" && <>
          <Card><Text style={t.text.heading}>Open this host's app on a phone or another browser</Text><Text style={t.text.body}>Select the host running the app. Open creates a private-session HTTPS link through Cloudflare that lasts {formatMinutes(minutes)} and can be extended in place. The receiving device does not need Paseo. Closing a link leaves the dev server running.</Text></Card>
          {!available && <Card><Text style={t.text.heading}>One-time browser-link setup</Text><Text style={t.text.body}>Install the tunnel helper on {props.host.label}. No Cloudflare account, domain, or SSH password is needed.</Text><Button label={opener.installing ? "Installing helper…" : "Set up browser links"} loading={opener.installing} disabled={!links.data || opener.installing} onPress={() => opener.installLinks()} /></Card>}
          {!apps.length && <Notice icon="FolderCode" action={<Button label="Start a project app" onPress={openGuide} />}>No verified project dev servers are running on this host.</Notice>}
          <Grid min={300}>{apps.map((app) => <ServiceCard key={processKey(app)} process={app} actions={actions} footer={<OpenRow ports={app.ports} tunnels={tunnels} minutes={minutes} available={available} opener={opener} onSetup={() => opener.installLinks()} installing={opener.installing} />} />)}</Grid>
          {tunnels.length > 0 && <Section title="Browser links on this host">{tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} minutes={minutes} onExtend={opener.extendLink} onClose={opener.closeLink} busy={opener.extending || opener.closing} />)}</Section>}
        </>}
        {route === "ssh" && <><Notice icon="KeyRound">Use this route if you already connect to the remote host with SSH keys. Save a forward on your own computer's daemon: the app then answers at 127.0.0.1 on your laptop and nothing is published. Private localhost pairing is simpler when both hosts run Paseo.</Notice><Connections profiles={links.data?.profiles || []} states={links.data?.connections || []} refresh={() => { void links.refetch(); }} initialRemotePort={sshRemotePort} /></>}
      </>}
      {tab === "sync" && <Transfers hostId={props.host.id} openPairing={() => navigate("relay", "private", true)} />}
    </ScrollView>}
  </View>;
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

function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  const t = useTokens();
  return <View style={{ gap: 7 }}><Text style={[t.text.caption, { color: t.color.accent, letterSpacing: 1 }]}>{eyebrow}</Text><Text style={[t.text.title, { fontSize: t.compact ? 20 : 24, lineHeight: 30 }]}>{title}</Text><Text style={[t.text.body, { maxWidth: 760 }]}>{description}</Text></View>;
}
