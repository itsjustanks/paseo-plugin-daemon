import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, TextInput, View } from "react-native";
import * as rpc from "../shared/peers";
import { Button, Card, ConfirmButton, Grid, Notice, Section, StatusPill, useTokens } from "./ui";
import { openExternal, sharePairingCode } from "./web";

export function Peers({ hostId, hostLabel, initialView = "apps", onBrowserLink, onGuide }: { initialView?: "apps" | "pair"; hostId: string; hostLabel: string; onBrowserLink(): void; onGuide(): void }) {
  const t = useTokens(), toast = useToast();
  const status = useRpc(rpc.peerStatus), offer = useRpc(rpc.peerOffer), pair = useRpc(rpc.peerPair);
  const services = useRpc(rpc.peerServices), forward = useRpc(rpc.peerForward), disconnect = useRpc(rpc.peerDisconnect);
  const revoke = useRpc(rpc.peerRevoke), remove = useRpc(rpc.peerRemove);
  const [view, setView] = useState<"apps" | "pair" | "access">(initialView);
  const [invitation, setInvitation] = useState(""), [incoming, setIncoming] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<number | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const query = useQuery({ queryKey: ["daemon-link", hostId, "peers"], queryFn: () => status({}), refetchInterval: 3000, retry: 1 });
  const peerId = query.data?.peers.find((peer) => peer.id === selected)?.id || query.data?.peers[0]?.id;
  const selectedPeer = query.data?.peers.find((peer) => peer.id === peerId);
  const serviceQuery = useQuery({ queryKey: ["daemon-link", hostId, "peer-services", peerId], queryFn: () => services({ id: peerId! }), enabled: !!peerId && view === "apps", refetchInterval: 10_000, retry: 1 });
  const errorText = (error: unknown) => error instanceof Error ? error.message : "Connection failed. Please retry.";
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: () => { void query.refetch(); } });
  async function connect(port: number) {
    setForwarding(port); setConnectionError("");
    try {
      const result = await forward({ id: peerId!, port });
      await query.refetch();
      toast.show(`Local link ready on ${hostLabel}${result.localPort !== port ? ` · port ${result.localPort}` : ""}.`, { variant: "success" });
    } catch (error) { setConnectionError(errorText(error)); }
    finally { setForwarding(null); }
  }
  const copy = (text: string) => { void sharePairingCode(text).then(() => toast.show("Copied", { variant: "success" })).catch((error) => toast.error(errorText(error))); };
  const browser = (url: string) => { void openExternal(url).catch((error) => setConnectionError(errorText(error))); };
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{([ ["apps", "Remote apps"], ["pair", "Pair hosts"], ["access", "Manage access"] ] as const).map(([id, label]) => <Button key={id} label={label} variant={view === id ? "primary" : "secondary"} onPress={() => setView(id)} />)}</View>
    {query.isError && <Notice icon="CircleAlert" tone="danger" action={<Button label="Retry paired hosts" onPress={() => { void query.refetch(); }} />}>{errorText(query.error)}</Notice>}
    {mutation.isError && <Notice icon="CircleAlert" tone="danger">{errorText(mutation.error)}</Notice>}
    {!!connectionError && <Notice icon="WifiOff" tone="danger">{connectionError}</Notice>}
    {query.isPending && <Text style={t.text.body}>Loading paired hosts…</Text>}
    {view === "apps" && <>
      <Card><Text style={t.text.heading}>A local link on {hostLabel}</Text><Text style={t.text.body}>Choose where the app runs below. Its local link will belong to {hostLabel}. Open that link in a browser on the same computer.</Text><Text style={t.text.caption}>If you are browsing from a phone or a different computer, switch to the app's host and create a temporary browser link.</Text></Card>
      {!!query.data?.peers.length && <Section title="Where does the app run?" trailing={<Button label="Pair another host" onPress={() => setView("pair")} />}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{query.data.peers.map((peer) => <Button key={peer.id} label={peer.label} variant={peer.id === peerId ? "primary" : "secondary"} onPress={() => { setSelected(peer.id); setConnectionError(""); }} />)}</View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}><StatusPill tone={serviceQuery.isError ? "warning" : serviceQuery.data ? "ok" : "neutral"} label={serviceQuery.isError ? "Source unavailable" : serviceQuery.data ? "Source responded" : "Checking source"} /><Button label="Refresh remote apps" loading={serviceQuery.isFetching} onPress={() => { void serviceQuery.refetch(); }} /></View>
        {serviceQuery.isPending && <Text style={t.text.body}>Checking {selectedPeer?.label}'s project apps…</Text>}
        {serviceQuery.isError && <Notice icon="WifiOff" tone="warning" action={<Button label="Show connection help" onPress={onGuide} />}>{errorText(serviceQuery.error)} Keep both plugins enabled. Open Hosts on the source to refresh its project access.</Notice>}
        {serviceQuery.data && !serviceQuery.data.services.length && <Card><Text style={t.text.heading}>No running project apps on this source</Text><Text style={t.text.body}>Select {selectedPeer?.label} in Paseo, start a dev server in one of its projects, then return here and refresh.</Text></Card>}
        <Grid min={280}>{serviceQuery.data?.services.map((service) => {
          const active = query.data?.forwards.find((f) => f.peerId === peerId && f.remotePort === service.port);
          const url = active ? `http://localhost:${active.localPort}` : "";
          return <Card key={service.port}><Text style={t.text.heading}>{service.project || service.label}</Text><Text style={t.text.label}>{service.label} · source port {service.port}</Text>
            {active ? <><StatusPill tone="ok" label={`Local link on ${hostLabel}`} /><Text selectable style={t.text.bodyStrong}>{url}</Text><Text style={t.text.caption}>This address works on {hostLabel}. The remote app must stay running.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label="Copy local URL" variant="primary" onPress={() => copy(url)} /><Button label="Open in this browser" onPress={() => browser(url)} /><Button label="Close forward" disabled={mutation.isPending} onPress={() => mutation.mutate(() => disconnect({ id: active.id }))} /></View></> : <Button label={forwarding === service.port ? "Creating local link…" : "Create local link"} variant="primary" loading={forwarding === service.port} disabled={forwarding !== null || serviceQuery.isError} onPress={() => { void connect(service.port); }} />}
          </Card>;
        })}</Grid>
      </Section>}
      {!query.isPending && !query.data?.peers.length && <Card><Text style={t.text.heading}>Pair your first source host</Text><Text style={t.text.body}>Install Daemon Link on both computers. Create a code on the app's host, then paste it on the receiving host. No SSH password is needed.</Text><Button label="Set up host pairing" variant="primary" onPress={() => setView("pair")} /></Card>}
      {!!query.data?.forwards.filter((f) => f.peerId !== peerId || !serviceQuery.data?.services.some((s) => s.port === f.remotePort)).length && <Section title="Other active local links">{query.data.forwards.filter((f) => f.peerId !== peerId || !serviceQuery.data?.services.some((s) => s.port === f.remotePort)).map((f) => <Card key={f.id}><Text style={t.text.body}>{hostLabel}: localhost:{f.localPort} → source port {f.remotePort}</Text><Text style={t.text.caption}>If the source app has stopped, close this link and reconnect after starting it.</Text><Button label="Close forward" disabled={mutation.isPending} onPress={() => mutation.mutate(() => disconnect({ id: f.id }))} /></Card>)}</Section>}
      <Button label="Use a temporary browser link instead" onPress={onBrowserLink} />
    </>}
    {view === "pair" && <>
      <Notice icon="Network">Pairing is directional: create the code where the app runs, then paste it where you want the local link. Current host: {hostLabel}.</Notice>
      <Grid min={300}>
        <Card><Text style={t.text.heading}>1. Share apps from this host</Text><Text style={t.text.body}>Select the app's host in Paseo first. A code allows its holder to reach eligible project apps on that host. Project files need separate permission in Project Sync.</Text><Button label="Create pairing code" loading={mutation.isPending} disabled={mutation.isPending || !query.data} onPress={() => mutation.mutate(async () => { setInvitation((await offer({ label: hostLabel })).invitation); })} />{!!invitation && <><StatusPill tone="ok" label="Code ready · paste on the receiving host" /><Button label="Copy / share code" onPress={() => copy(invitation)} /><Text selectable numberOfLines={3} style={t.text.caption}>{invitation}</Text></>}</Card>
        <Card><Text style={t.text.heading}>2. Connect from this host</Text><Text style={t.text.body}>Select the receiving computer in Paseo, then paste the source's code here. The pairing is saved for future connections.</Text><TextInput accessibilityLabel="Daemon Link pairing code" placeholder="Paste the source host's pairing code" placeholderTextColor={t.color.muted} value={incoming} onChangeText={setIncoming} multiline autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: 12, backgroundColor: t.color.surface2, borderRadius: 6, minHeight: 80 }} /><Button label="Pair host" loading={mutation.isPending} disabled={!incoming.trim() || mutation.isPending} onPress={() => mutation.mutate(async () => { await pair({ invitation: incoming.trim() }); setIncoming(""); setView("apps"); toast.show("Host paired", { variant: "success" }); })} /></Card>
      </Grid><Button label="Show the complete walkthrough" onPress={onGuide} />
    </>}
    {view === "access" && <>
      <Card><Text style={t.text.heading}>Manage connections without stopping apps</Text><Text style={t.text.body}>Removing a source closes local forwards to it. Revoking a code closes its connections and removes access to this host, including project sharing. The source apps and agent sessions keep running.</Text></Card>
      <Section title="Codes granting access to this host"><StatusPill tone={query.data?.relayState === "connected" ? "ok" : "neutral"} label={query.data?.grants.length ? `Incoming relay: ${query.data.relayState}` : "No incoming access configured"} />{query.data?.grants.map((grant) => <Card key={grant.id}><Text style={t.text.bodyStrong}>{grant.label}</Text><Text style={t.text.caption}>Code identifier {grant.id.slice(0, 8)}</Text><ConfirmButton label="Revoke access…" confirmLabel="Revoke this code" target={grant.label} loading={mutation.isPending} onConfirm={() => mutation.mutate(async () => { await revoke({ id: grant.id }); setInvitation(""); })} /></Card>)}</Section>
      <Section title="Saved source hosts">{query.data?.peers.map((peer) => <Card key={peer.id}><Text style={t.text.bodyStrong}>{peer.label}</Text><ConfirmButton label="Remove pairing…" confirmLabel="Remove source host" target={peer.label} loading={mutation.isPending} onConfirm={() => mutation.mutate(async () => { await remove({ id: peer.id }); setSelected(null); })} /></Card>)}{!query.data?.peers.length && <Text style={t.text.body}>No saved sources. Add one under Pair hosts.</Text>}</Section>
    </>}
  </View>;
}
