import { HostOverview } from "./overview";
import { Transfers } from "./transfers";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as rpc from "../shared/link";
import * as peerRpc from "../shared/peers";
import { useMonitorRpc, type Process, type Snapshot } from "./rpc";
import { MonitorSurface } from "./surface";
import { Button, Card, Grid, Notice, Section, StatusPill, TokensProvider, alpha, formatBytes, useTokens, useUi } from "./ui";
import { prepareExternal } from "./web";
import { Peers } from "./peers";
import { Connections } from "./ssh";

type Tab = "overview" | "local" | "relay" | "health" | "guide" | "sync";
type Route = "private" | "browser" | "ssh";
const TABS: { id: Tab; label: string; icon: string; description: string }[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", description: "Your next step" },
  { id: "local", label: "Local Projects", icon: "FolderCode", description: "Apps on this host" },
  { id: "relay", label: "Dev Relay", icon: "Network", description: "Access from another device" },
  { id: "sync", label: "Project Sync", icon: "FolderSync", description: "Receive projects and view history" },
  { id: "health", label: "Daemon Health", icon: "Activity", description: "Resources and project processes" },
  { id: "guide", label: "Guide & Setup", icon: "BookOpen", description: "Getting started and checks" },
];
const ROUTES: { id: Route; label: string; icon: string; description: string }[] = [
  { id: "private", label: "Private localhost", icon: "Laptop", description: "Recommended · Paseo on both computers" },
  { id: "browser", label: "Temporary browser link", icon: "Globe", description: "For phones, guests, or a blocked relay" },
  { id: "ssh", label: "Saved SSH forward", icon: "Terminal", description: "Optional · use existing SSH keys" },
];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";
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

function DaemonBody(props: DaemonProps) {
  const t = useTokens(), toast = useToast();
  const [tab, setTab] = useState<Tab>("overview"), [route, setRoute] = useState<Route>("private");
  const [search, setSearch] = useState("");
  const [pairingRequested, setPairingRequested] = useState(false);
  const status = useRpc(rpc.linkStatus), peerStatus = useRpc(peerRpc.peerStatus);
  const start = useRpc(rpc.tunnelStart), stop = useRpc(rpc.tunnelStop), open = useRpc(rpc.tunnelOpen), install = useRpc(rpc.tunnelInstall);
  const monitor = useMonitorRpc();
  const pending = useRef(new Map<number, ReturnType<typeof prepareExternal>>());
  const opening = useRef(new Set<number>());
  const links = useQuery({ queryKey: ["daemon-link", props.host.id, "status"], queryFn: () => status({}), refetchInterval: 3000, retry: 1 });
  const peers = useQuery({ queryKey: ["daemon-link", props.host.id, "peers"], queryFn: () => peerStatus({}), refetchInterval: 3000, retry: 1 });
  const local = useQuery({ queryKey: ["daemon-link", props.host.id, "services"], queryFn: () => monitor.snapshot({ query: "", sort: "name", limit: 25 }), refetchInterval: 5000, enabled: tab !== "health", retry: 1 });
  const apps = local.data?.services.filter((process) => process.project?.shareable && !process.protectedReason) || [];
  const available = links.data?.cloudflared === true;
  const installMutation = useMutation({ mutationFn: () => install({}), onSuccess: () => { void links.refetch(); toast.show("Browser links are ready", { variant: "success" }); } });
  const stopMutation = useMutation({ mutationFn: (id: string) => stop({ id }), onSuccess: () => { void links.refetch(); }, onError: (err) => toast.error(errorMessage(err)) });
  const navigate = (next: Tab, nextRoute: Route = "private", pairing = false) => { setTab(next); setRoute(nextRoute); setPairingRequested(pairing); };
  const refresh = () => { void local.refetch(); void links.refetch(); void peers.refetch(); };

  useEffect(() => () => { for (const popup of pending.current.values()) popup.close(); pending.current.clear(); }, []);
  useEffect(() => {
    if (links.isError) { for (const popup of pending.current.values()) popup.close(); pending.current.clear(); return; }
    for (const tunnel of links.data?.tunnels || []) {
      const popup = pending.current.get(tunnel.port);
      if (!popup || opening.current.has(tunnel.port)) continue;
      if (tunnel.state === "error") { popup.close(); pending.current.delete(tunnel.port); toast.error(tunnel.message); }
      if (tunnel.state === "connected") {
        opening.current.add(tunnel.port);
        void open({ id: tunnel.id }).then(({ url }) => popup.finish(url)).catch((err) => { popup.close(); toast.error(errorMessage(err)); })
          .finally(() => { pending.current.delete(tunnel.port); opening.current.delete(tunnel.port); });
      }
    }
  }, [links.data, links.isError, open, toast]);

  async function openService(port: number) {
    if (pending.current.has(port)) return;
    let popup: ReturnType<typeof prepareExternal> | undefined;
    try {
      popup = prepareExternal();
      const existing = links.data?.tunnels.find((tunnel) => tunnel.port === port && tunnel.state === "connected");
      if (existing) { await popup.finish((await open({ id: existing.id })).url); return; }
      pending.current.set(port, popup);
      for (const failed of links.data?.tunnels.filter((tunnel) => tunnel.port === port && tunnel.state === "error") || []) await stop({ id: failed.id });
      await start({ port, minutes: 30 }); await links.refetch();
    } catch (err) { popup?.close(); pending.current.delete(port); toast.error(errorMessage(err)); }
  }

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
      {tab === "overview" && <HostOverview host={props.host.label} apps={apps.length} projects={local.data?.scope?.projects.length || 0} paired={peers.data?.peers.length || 0} forwards={peers.data?.forwards.length || 0} ready={local.data?.scope?.status === "ready" && !local.isError} navigate={navigate} />}
      {tab === "local" && <>
        <Intro eyebrow="YOUR PROJECTS" title={`Development apps on ${props.host.label}`} description="Local means this selected Paseo host. Services appear when their process belongs to a registered project or workspace. Use Dev Relay to reach them from another device." />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><StatusPill tone="ok" label={`${apps.length} project apps`} /><StatusPill tone="neutral" label={`${local.data?.scope?.projects.length || 0} registered projects`} /><Button label="Refresh services" onPress={refresh} /></View>
        {!apps.length && <Card><Text style={t.text.heading}>New here? Start with one project.</Text><Text style={t.text.body}>Open a project in Paseo and run its dev command in that project's terminal. The app appears here automatically. To use it on your laptop, install Daemon Link there too and pair the two hosts.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label="Connect another device" variant="primary" onPress={() => navigate("relay")} /><Button label="Show the steps" onPress={() => navigate("guide")} /></View></Card>}
        <TextInput accessibilityLabel="Search project services" placeholder="Search project, framework, or port" placeholderTextColor={t.color.muted} value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface1 }} />
        {local.isPending ? <Text style={t.text.body}>Checking Paseo projects and their dev servers…</Text> : <ProjectApps apps={apps.filter((app) => `${app.project?.name} ${app.classification.label} ${app.ports.join(" ")}`.toLowerCase().includes(search.toLowerCase()))} onConnect={() => navigate("relay", "browser")} searching={!!search} />}
        <Text style={t.text.caption}>Unrelated listeners, databases, system services, and browser-control ports are excluded. Process stop controls are in Daemon Health and apply only to verified project dev servers.</Text>
      </>}
      {tab === "relay" && <>
        <Intro eyebrow="CONNECT YOUR DEVICES" title="Choose how to reach a project app" description="Private localhost is the everyday route between two computers running Paseo. If that route is unavailable, a temporary browser link or an existing SSH connection provides an alternative." />
        <Choice<Route> items={ROUTES} selected={route} onChange={setRoute} label="Connection method" />
        {route === "private" && <Peers initialView={pairingRequested ? "pair" : "apps"} hostId={props.host.id} hostLabel={props.host.label} onBrowserLink={() => setRoute("browser")} onGuide={() => navigate("guide")} />}
        {route === "browser" && <>
          <Card><Text style={t.text.heading}>Open this host's app on a phone or another browser</Text><Text style={t.text.body}>Select the host running the app above. Create a private browser link below; it uses Cloudflare and expires after 30 minutes. The receiving device does not need Paseo. Closing a link leaves the dev server running.</Text></Card>
          {!available && <Card><Text style={t.text.heading}>One-time browser-link setup</Text><Text style={t.text.body}>Install the tunnel helper on {props.host.label}. No Cloudflare account, domain, or SSH password is needed.</Text><Button label={installMutation.isPending ? "Installing helper…" : "Set up browser links"} loading={installMutation.isPending} disabled={!links.data || installMutation.isPending} onPress={() => installMutation.mutate()} />{installMutation.isError && <Notice icon="CircleAlert" tone="danger">{errorMessage(installMutation.error)}</Notice>}</Card>}
          {!apps.length && <Notice icon="FolderCode" action={<Button label="Start a project app" onPress={() => navigate("guide")} />}>No verified project dev servers are running on this host.</Notice>}
          <Grid min={300}>{apps.flatMap((app) => app.ports.map((port) => ({ app, port }))).filter((row, i, all) => all.findIndex((item) => item.port === row.port) === i).map(({ app, port }) => {
            const tunnel = links.data?.tunnels.find((item) => item.port === port);
            const starting = tunnel?.state === "starting";
            return <Card key={port}><Text style={t.text.heading}>{app.project?.name}</Text><Text style={t.text.body}>{app.classification.kind === "dev-server" ? app.classification.label : "Project service"} · port {port}</Text>{tunnel && <Text style={t.text.caption}>{tunnel.message}</Text>}<Button label={starting ? "Creating browser link…" : tunnel?.state === "connected" ? "Open browser link" : "Create 30-minute browser link"} variant="primary" disabled={!available || starting} loading={starting} onPress={() => { void openService(port); }} /></Card>;
          })}</Grid>
          {!!links.data?.tunnels.length && <Section title="Browser links on this host">{links.data.tunnels.map((tunnel) => <Card key={tunnel.id}><Text style={t.text.body}>Port {tunnel.port} · {tunnel.state}</Text><Text style={t.text.caption}>Expires {new Date(tunnel.expiresAt).toLocaleTimeString()} · {tunnel.message}</Text><Button label="Close browser link" disabled={stopMutation.isPending} onPress={() => { pending.current.get(tunnel.port)?.close(); pending.current.delete(tunnel.port); stopMutation.mutate(tunnel.id); }} /></Card>)}</Section>}
        </>}
        {route === "ssh" && <><Notice icon="KeyRound">Use this route if you already connect to the remote host with SSH keys. Save a forward on your own computer's daemon. Private localhost pairing above is simpler when both hosts run Paseo.</Notice><Connections profiles={links.data?.profiles || []} states={links.data?.connections || []} refresh={() => { void links.refetch(); }} /></>}
      </>}
      {tab === "sync" && <Transfers hostId={props.host.id} openPairing={() => navigate("relay", "private", true)} />}
      {tab === "guide" && <>
        <Intro eyebrow="GUIDE & SETUP" title="From a dev command to your own browser" description="Each computer keeps its own localhost. Daemon Link connects a chosen remote project port to a local port on your computer while both plugins are running." />
        <Grid min={270}>
          <Step number="1" title="Start the app on its host"><Text style={t.text.body}>Open the project in Paseo. In that project's terminal, run its normal dev command, such as:</Text><Text selectable style={t.text.mono}>npm run dev</Text><Text style={t.text.body}>Keep the terminal running. Next.js, Vite, and other recognized dev servers appear in Local Projects without editing their source files.</Text><Button label="Check local projects" onPress={() => navigate("local")} /></Step>
          <Step number="2" title="Install and pair both hosts"><Text style={t.text.body}>Install Daemon Link on the app's host and on your laptop or desktop. On the app's host, open Dev Relay → Private localhost → Pair hosts → Create pairing code. Switch Paseo's host picker to your computer and paste the code there.</Text><Button label="Open pairing" onPress={() => navigate("relay", "private", true)} /></Step>
          <Step number="3" title="Open the app from your computer"><Text style={t.text.body}>Keep your computer selected. Choose the paired host and press Create local link beside its app. Copy the displayed URL and open it on the receiving computer. If the same port is busy locally, Daemon Link chooses a free one.</Text><Text style={t.text.caption}>Close forward disconnects access; it does not stop the app. On phones, choose Temporary browser link instead.</Text></Step>
        </Grid>
        <Section title={`Setup checks for ${props.host.label}`} trailing={<Button label="Run checks again" onPress={refresh} />}>
          <Check state={links.isError ? "error" : links.data ? "ready" : "pending"} title="Daemon Link is reachable" detail="This checks the selected host's plugin connection." />
          <Check state={local.data?.scope?.status === "ready" ? "ready" : "pending"} title="Paseo projects verified" detail={local.data?.scope?.message || "Loading the selected host's project registry…"} />
          <Check state={apps.length ? "ready" : "pending"} title={apps.length ? `${apps.length} project apps found` : "Start a dev server"} detail="The server must run inside a registered project or workspace directory." />
          <Check state={peers.isError ? "error" : peers.data?.peers.length || peers.data?.grants.length ? "ready" : "pending"} title={peers.data?.peers.length ? `${peers.data.peers.length} paired hosts saved` : peers.data?.grants.length ? "Pairing code created on this host" : "Pair your second computer"} detail="A saved pairing does not prove the other host is online. Open its service list to check the live connection." />
          {!!peers.data?.grants.length && <Check state={peers.data.relayState === "connected" ? "ready" : "pending"} title="Incoming private relay" detail={`Current connection: ${peers.data.relayState}. Both plugins must stay running.`} />}
          <Check state={available ? "ready" : "optional"} title="Temporary browser links" detail={available ? "Tunnel helper is installed. Create a link in Dev Relay when needed." : "Optional setup for phones or when the private relay is blocked."} />
        </Section>
        <Card><Text style={t.text.heading}>The app does not appear</Text><Text style={t.text.body}>Check that the project is registered in Paseo, the terminal is inside its directory, and the dev command is still running. For a custom server, configure a Paseo service script with its port. Unidentified listeners remain unavailable for sharing and stopping.</Text><Text style={t.text.caption}>Register individual project directories. The home directory or filesystem root is too broad. After a daemon restart, open Hosts on that host once so it can verify its project registry again.</Text></Card>
        <Card><Text style={t.text.heading}>The connection does not work</Text><Text style={t.text.body}>Confirm both hosts are online and their plugins are enabled. Select your own computer before opening a localhost forward. If the private relay cannot connect, switch to the app's host and create a Temporary browser link, or use your existing SSH keys.</Text><Button label="Choose another connection method" onPress={() => navigate("relay", "browser")} /></Card>
        <Card><Text style={t.text.heading}>What can be stopped?</Text><Text style={t.text.body}>Only a verified project dev server, after confirmation in Daemon Health. Agent tools are read-only here; manage sessions in their Paseo agent tabs. Closing a relay link only closes access to the app.</Text></Card>
        {props.shortcuts && <Notice icon="Command">You can also type /daemon-link in a workspace composer to open this panel.</Notice>}
      </>}
    </ScrollView>}
  </View>;
}

function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  const t = useTokens();
  return <View style={{ gap: 7 }}><Text style={[t.text.caption, { color: t.color.accent, letterSpacing: 1 }]}>{eyebrow}</Text><Text style={[t.text.title, { fontSize: t.compact ? 20 : 24, lineHeight: 30 }]}>{title}</Text><Text style={[t.text.body, { maxWidth: 760 }]}>{description}</Text></View>;
}
function Step({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  const t = useTokens();
  return <Card><View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: alpha(t.color.accent, 0.15) }}><Text style={[t.text.bodyStrong, { color: t.color.accent }]}>{number}</Text></View><Text style={t.text.heading}>{title}</Text>{children}</Card>;
}
function Check({ state, title, detail }: { state: "ready" | "pending" | "optional" | "error"; title: string; detail: string }) {
  const t = useTokens();
  return <View style={{ flexDirection: "row", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: t.color.border }}><Icon name={state === "ready" ? "CircleCheck" : state === "error" ? "CircleAlert" : "Circle"} size={18} color={state === "ready" ? t.color.success : state === "error" ? t.color.danger : t.color.muted} /><View style={{ flex: 1, gap: 3 }}><Text style={t.text.bodyStrong}>{title}{state === "optional" ? " · optional" : ""}</Text><Text style={t.text.caption}>{detail}</Text></View></View>;
}
function ProjectApps({ apps, onConnect, searching }: { apps: Process[]; onConnect(): void; searching: boolean }) {
  const t = useTokens();
  if (!apps.length) return <Notice icon="FolderCode">{searching ? "No project apps match that search." : "No project dev servers are running yet. Start your project's dev command, then refresh."}</Notice>;
  const groups = [...new Set(apps.map((app) => app.project!.id))];
  return <Grid min={330}>{groups.map((id) => {
    const rows = apps.filter((app) => app.project!.id === id), project = rows[0].project!;
    return <Card key={id}><View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}><Text style={[t.text.heading, { flexShrink: 1 }]}>{project.name}</Text><StatusPill tone="ok" label="Running" /></View><Text style={t.text.caption}>{project.path}</Text>
      {rows.map((app) => <View key={app.pid} style={{ gap: 4, borderTopWidth: 1, borderColor: t.color.border, paddingTop: 10 }}><Text style={t.text.bodyStrong}>{app.classification.kind === "dev-server" ? app.classification.label : "Project service"}</Text><Text style={t.text.body}>Port {app.ports.join(", ")}{app.project?.workspace ? ` · ${app.project.workspace}` : ""}</Text><Text style={t.text.caption}>{formatBytes(app.rssBytes)} memory · PID {app.pid}</Text></View>)}
      <Button label="Share with a browser link" onPress={onConnect} /></Card>;
  })}</Grid>;
}
