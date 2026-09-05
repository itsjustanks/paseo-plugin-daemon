import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as rpc from "../shared/link";
import { useMonitorRpc } from "./rpc";
import { MonitorSurface } from "./surface";
import { Button, Card, Notice, Section, Segmented, StatusPill, TokensProvider, useTokens, useUi } from "./ui";
import { openExternal, prepareExternal } from "./web";
import { Peers } from "./peers";

type Tab = "links" | "services" | "monitor" | "connections" | "setup";
const TABS: { id: Tab; label: string }[] = [
  { id: "links", label: "Links" }, { id: "services", label: "Fallback" }, { id: "monitor", label: "Monitor" },
  { id: "connections", label: "SSH" }, { id: "setup", label: "Setup" },
];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";

type DaemonProps = PluginSurfaceProps & { shortcuts?: boolean };

export function DaemonSurface(props: DaemonProps) {
  return <TokensProvider value={useUi(props.theme, props.layout.compact)}><DaemonBody key={props.host.id} {...props} /></TokensProvider>;
}

function DaemonBody(props: DaemonProps) {
  const t = useTokens();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("links");
  const status = useRpc(rpc.linkStatus);
  const start = useRpc(rpc.tunnelStart);
  const stop = useRpc(rpc.tunnelStop);
  const open = useRpc(rpc.tunnelOpen);
  const install = useRpc(rpc.tunnelInstall);
  const monitor = useMonitorRpc();
  const pending = useRef(new Map<number, ReturnType<typeof prepareExternal>>());
  const opening = useRef(new Set<number>());
  const links = useQuery({ queryKey: ["daemon-link", "status"], queryFn: () => status({}), refetchInterval: 2000, retry: 1 });
  const services = useQuery({
    queryKey: ["daemon-link", "services"], queryFn: () => monitor.snapshot({ query: "", sort: "name", limit: 200 }),
    refetchInterval: 4000, enabled: tab === "services", retry: 1,
  });
  const installMutation = useMutation({ mutationFn: () => install({}), onSuccess: () => { void links.refetch(); toast.show("Ready to open services", { variant: "success" }); } });
  const stopMutation = useMutation({ mutationFn: (id: string) => stop({ id }), onSuccess: () => { void links.refetch(); }, onError: (err) => toast.error(errorMessage(err)) });

  useEffect(() => () => { for (const popup of pending.current.values()) popup.close(); pending.current.clear(); }, []);
  useEffect(() => {
    if (links.isError) {
      for (const popup of pending.current.values()) popup.close();
      pending.current.clear();
      return;
    }
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
      // Replace expired/failed records for this service, keeping the four-link limit useful.
      for (const failed of links.data?.tunnels.filter((tunnel) => tunnel.port === port && tunnel.state === "error") || []) await stop({ id: failed.id });
      await start({ port, minutes: 30 });
      await links.refetch();
    } catch (err) { popup?.close(); pending.current.delete(port); toast.error(errorMessage(err)); }
  }

  const available = links.data?.cloudflared === true;
  return <View style={{ flex: 1, backgroundColor: t.color.surface0 }}>
    <View style={{ padding: t.space.lg, gap: t.space.md, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
      <Text style={t.text.title}>Daemon Link</Text>
      <Text style={t.text.label}>{props.host.label} · Services and monitoring for this host</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}><Segmented value={tab} options={TABS} onChange={setTab} label="Daemon Link sections" /></ScrollView>
    </View>
    {tab === "monitor" ? <MonitorSurface {...props} /> : <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg, width: "100%", maxWidth: t.maxWidth, alignSelf: "center" }}>
      {links.isError && <Notice icon="CircleAlert" tone="danger">{errorMessage(links.error)}</Notice>}
      {tab === "links" && <Peers hostLabel={props.host.label} />}
      {tab === "services" && <>
        <Text style={t.text.body}>Open a service in your browser from any network. Temporary links use Cloudflare and expire after 30 minutes.</Text>
        {!available && <Card>
          <Text style={t.text.heading}>One-time tunnel setup</Text>
          <Text style={t.text.body}>Install the tunnel helper on this host. No SSH login, domain, or Cloudflare account is needed.</Text>
          <Button label={installMutation.isPending ? "Setting up…" : "Set up service access"} loading={installMutation.isPending} disabled={!links.data || installMutation.isPending} onPress={() => installMutation.mutate()} />
          {installMutation.isError && <Text style={t.text.body}>{errorMessage(installMutation.error)}</Text>}
        </Card>}
        {services.isPending && <Text style={t.text.body}>Finding services on {props.host.label}…</Text>}
        {services.isError && <Notice icon="CircleAlert" tone="danger">{errorMessage(services.error)}</Notice>}
        {services.data?.warnings.map((warning) => <Text key={warning} style={t.text.label}>{warning}</Text>)}
        {services.data && !services.data.services.some((p) => p.ports.length && !p.protectedReason) && <Card>
          <Text style={t.text.heading}>No web services found yet</Text>
          <Text style={t.text.body}>Start your project's dev server on this host. Listening ports appear here automatically.</Text>
        </Card>}
        {services.data?.services.filter((p) => !p.protectedReason).flatMap((p) => p.ports.map((port) => ({ p, port })))
          .filter((entry, i, rows) => rows.findIndex((row) => row.port === entry.port) === i)
          .map(({ p, port }) => {
            const tunnel = links.data?.tunnels.find((link) => link.port === port);
            const starting = tunnel?.state === "starting";
            return <Card key={port}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <Text style={t.text.heading}>{p.classification.label} · {port}</Text>
                {tunnel && <StatusPill tone={tunnel.state === "error" ? "danger" : tunnel.state === "connected" ? "ok" : "neutral"} label={tunnel.state} />}
              </View>
              <Text style={t.text.label}>{p.cwd || p.name}</Text>
              {tunnel && <Text style={t.text.label}>{tunnel.message}</Text>}
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Button label={starting ? "Connecting…" : tunnel?.state === "error" ? "Retry" : "Open"} loading={starting} disabled={!available || starting} onPress={() => { void openService(port); }} />
                {tunnel && <Button label="Disconnect" disabled={stopMutation.isPending} onPress={() => { pending.current.get(port)?.close(); pending.current.delete(port); stopMutation.mutate(tunnel.id); }} />}
              </View>
            </Card>;
          })}
        {!!links.data?.tunnels.length && <Section title="Temporary links">
          {links.data.tunnels.map((tunnel) => <Card key={tunnel.id}>
            <Text style={t.text.body}>Port {tunnel.port} · {tunnel.state} · expires {new Date(tunnel.expiresAt).toLocaleTimeString()}</Text>
            <Text style={t.text.label}>{tunnel.message}</Text>
            <Button label="Disconnect" onPress={() => stopMutation.mutate(tunnel.id)} />
          </Card>)}
        </Section>}
      </>}
      {tab === "connections" && <Connections profiles={links.data?.profiles || []} states={links.data?.connections || []} refresh={() => { void links.refetch(); }} />}
      {tab === "setup" && <>
        {props.shortcuts && <Card><StatusPill tone="ok" label="Composer shortcut ready" /><Text style={t.text.body}>Type /daemon-link in a workspace composer to open this panel. This shortcut is available on your connected host.</Text></Card>}
        <Card><StatusPill tone={links.data ? "ok" : "warning"} label={links.data ? `Connected to ${props.host.label}` : "Waiting for host"} /><Text style={t.text.body}>Choose any connected daemon using Paseo's host picker. Install Daemon Link on each host you want to use.</Text></Card>
        <Card><StatusPill tone="ok" label="Pair once, open localhost" /><Text style={t.text.body}>In Links, create a pairing code on the remote host. Select the daemon on your computer and paste the code. Its services can then open on your computer's localhost, without SSH. Pairing also works in the other direction.</Text></Card>
        <Card><StatusPill tone={available ? "ok" : "neutral"} label={available ? "Fallback ready" : "Optional fallback"} /><Text style={t.text.body}>If the private relay is unavailable, Fallback opens an authenticated temporary browser URL through Cloudflare. A browser URL is useful on a phone or a device without a local daemon.</Text></Card>
        <Card><StatusPill tone="ok" label="Your normal browser" /><Text style={t.text.body}>Agent-browser is optional. Open uses the browser on your current device with that browser's own login session.</Text></Card>
        <Card><StatusPill tone={links.data?.ssh ? "ok" : "neutral"} label="Optional private route" /><Text style={t.text.body}>Use SSH on a daemon running on your computer to save forwards. Existing keys, SSH agents, and SSH config aliases work without storing a password here.</Text></Card>
        <Card><Text style={t.text.heading}>When a connection is blocked</Text><Text style={t.text.body}>Temporary links use outbound TCP port 7844. If that route is blocked, use a saved SSH connection over a reachable SSH port or your own VPN. No tunnel can bypass every network restriction.</Text><Button label="Refresh checks" onPress={() => { void links.refetch(); }} /></Card>
      </>}
    </ScrollView>}
  </View>;
}

function Field({ label, value, onChange, numeric = false }: { label: string; value: string; onChange(value: string): void; numeric?: boolean }) {
  const t = useTokens();
  return <View style={{ gap: 4 }}><Text style={t.text.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} keyboardType={numeric ? "number-pad" : "default"} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, backgroundColor: t.color.surface2, borderRadius: 6, padding: 10, borderColor: t.color.border, borderWidth: 1 }} /></View>;
}

function Connections({ profiles, states, refresh }: { profiles: rpc.Profile[]; states: rpc.LinkState[]; refresh(): void }) {
  const t = useTokens();
  const toast = useToast();
  const save = useRpc(rpc.linkSave), connect = useRpc(rpc.linkConnect), disconnect = useRpc(rpc.linkDisconnect), remove = useRpc(rpc.linkRemove);
  const [editing, setEditing] = useState<string | undefined>();
  const [name, setName] = useState(""), [destination, setDestination] = useState("");
  const [sshPort, setSshPort] = useState("22"), [remotePort, setRemotePort] = useState("3000"), [localPort, setLocalPort] = useState("3000");
  const [autoConnect, setAutoConnect] = useState(false);
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh, onError: (err) => toast.error(errorMessage(err)) });
  return <>
    <Notice icon="Laptop">Select the daemon running on your own computer for SSH forwards. These local ports belong to that daemon's machine.</Notice>
    {profiles.map((profile) => {
      const state = states.find((s) => s.id === profile.id);
      return <Card key={profile.id}>
        <Text style={t.text.heading}>{profile.name}</Text><Text style={t.text.label}>{profile.destination}:{profile.remotePort} → localhost:{profile.localPort}</Text>
        <Text style={t.text.body}>{state?.message || "Disconnected"}</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button label={state ? "Disconnect" : "Connect"} disabled={mutation.isPending} onPress={() => mutation.mutate(() => state ? disconnect({ id: profile.id }) : connect({ id: profile.id }))} />
          {state?.state === "connected" && <Button label="Open on this computer" onPress={() => { void openExternal(`http://127.0.0.1:${profile.localPort}`).catch((err) => toast.error(errorMessage(err))); }} />}
          <Button label="Edit" onPress={() => { setEditing(profile.id); setName(profile.name); setDestination(profile.destination); setSshPort(String(profile.sshPort)); setRemotePort(String(profile.remotePort)); setLocalPort(String(profile.localPort)); setAutoConnect(profile.autoConnect); }} />
          <Button label="Remove" disabled={mutation.isPending} onPress={() => mutation.mutate(() => remove({ id: profile.id }))} />
        </View>
      </Card>;
    })}
    <Section title={editing ? "Edit connection" : "Save a private connection"}><Card>
      <Field label="Connection name" value={name} onChange={setName} />
      <Field label="SSH config alias or user@hostname" value={destination} onChange={setDestination} />
      <Field label="SSH port" value={sshPort} onChange={setSshPort} numeric />
      <Field label="Remote service port" value={remotePort} onChange={setRemotePort} numeric />
      <Field label="Local port on this daemon" value={localPort} onChange={setLocalPort} numeric />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Switch accessibilityLabel="Reconnect when plugin starts" value={autoConnect} onValueChange={setAutoConnect} /><Text style={t.text.body}>Reconnect when plugin starts</Text></View>
      <Button label={mutation.isPending ? "Saving…" : "Save connection"} disabled={mutation.isPending || !name.trim() || !destination.trim()} onPress={() => mutation.mutate(async () => {
        await save({ id: editing, name, destination, sshPort: Number(sshPort), remotePort: Number(remotePort), localPort: Number(localPort), autoConnect });
        setEditing(undefined); setName(""); setDestination(""); toast.show("Connection saved", { variant: "success" });
      })} />
      <Text style={t.text.caption}>SSH uses the keys and known hosts on this daemon. Verify a new host's fingerprint once before using Connect. Password prompts are never hidden in the background.</Text>
    </Card></Section>
  </>;
}
