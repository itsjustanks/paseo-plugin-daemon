import { useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, TextInput, View } from "react-native";
import * as rpc from "../shared/peers";
import { Button, Card, Notice, Section, StatusPill, useTokens } from "./ui";
import { prepareExternal, sharePairingCode } from "./web";

export function Peers({ hostLabel, onBrowserLink, onGuide }: { hostLabel: string; onBrowserLink(): void; onGuide(): void }) {
  const t = useTokens(), toast = useToast();
  const status = useRpc(rpc.peerStatus), offer = useRpc(rpc.peerOffer), pair = useRpc(rpc.peerPair);
  const services = useRpc(rpc.peerServices), forward = useRpc(rpc.peerForward), disconnect = useRpc(rpc.peerDisconnect);
  const revoke = useRpc(rpc.peerRevoke), remove = useRpc(rpc.peerRemove);
  const [invitation, setInvitation] = useState("");
  const [incoming, setIncoming] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [forwarding, setForwarding] = useState<number | null>(null);
  const query = useQuery({ queryKey: ["daemon-link", "peers"], queryFn: () => status({}), refetchInterval: 2000, retry: 1 });
  const peerId = selected || query.data?.peers[0]?.id;
  const serviceQuery = useQuery({ queryKey: ["daemon-link", "peer-services", peerId], queryFn: () => services({ id: peerId! }), enabled: !!peerId, refetchInterval: 10_000, retry: 1 });
  const errorText = (error: unknown) => error instanceof Error ? error.message : "Connection failed. Please retry.";
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: () => { void query.refetch(); }, onError: (err) => toast.error(errorText(err)) });

  async function open(port: number) {
    let popup: ReturnType<typeof prepareExternal> | undefined;
    try {
      popup = prepareExternal(); setForwarding(port);
      const result = await forward({ id: peerId!, port });
      await popup.finish(result.url);
      if (result.localPort !== port) toast.show(`Port ${port} was busy. Opened localhost:${result.localPort}.`, { variant: "info" });
      void query.refetch();
    } catch (err) { popup?.close(); toast.error(errorText(err)); }
    finally { setForwarding(null); }
  }

  return <>
    <Card><Text style={t.text.heading}>Two hosts, one familiar localhost URL</Text><Text style={t.text.body}>The app runs on one host. Your browser runs on another. Install Daemon Link on both, create a pairing code on the app's host, then switch Paseo's host picker to your computer and paste the code.</Text><Button label="Show setup guide" onPress={onGuide} /></Card>
    <Notice icon="Laptop">Forwarded ports will be created on {hostLabel}. To use localhost in this browser, select the daemon running on this browser's computer.</Notice>
    {query.isError && <Notice icon="CircleAlert" tone="danger">{errorText(query.error)}</Notice>}
    {query.isPending && <Text style={t.text.body}>Loading paired hosts…</Text>}
    {!!query.data?.peers.length && <Section title="Paired hosts">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{query.data.peers.map((peer) => <Button key={peer.id} label={peer.label} variant={peer.id === peerId ? "primary" : "secondary"} onPress={() => setSelected(peer.id)} />)}</View>
      {serviceQuery.isPending && <Text style={t.text.body}>Finding the host's services…</Text>}
      {serviceQuery.isError && <Notice icon="WifiOff" tone="warning" action={<Button label="Check connection again" onPress={() => { void serviceQuery.refetch(); }} />}>{errorText(serviceQuery.error)} You can switch to the app's host and use a Temporary browser link.</Notice>}
      {serviceQuery.data && !serviceQuery.data.services.length && <Card><Text style={t.text.body}>No verified project apps are running on this host. Start a dev server inside one of its Paseo projects, then refresh.</Text></Card>}
      {serviceQuery.data?.services.map((service) => {
        const active = query.data?.forwards.find((f) => f.peerId === peerId && f.remotePort === service.port);
        return <Card key={service.port}>
          <Text style={t.text.heading}>{service.label} · {service.port}</Text>
          {!!service.project && <Text style={t.text.label}>{service.project}</Text>}
          {active && <Text selectable style={t.text.body}>http://localhost:{active.localPort}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label={forwarding === service.port ? "Connecting…" : "Open localhost"} variant="primary" loading={forwarding === service.port} disabled={forwarding !== null} onPress={() => { void open(service.port); }} />
            {active && <Button label="Close forward" onPress={() => mutation.mutate(() => disconnect({ id: active.id }))} />}
          </View>
        </Card>;
      })}
    </Section>}
    {!!query.data?.forwards.length && <Section title="Active localhost forwards">
      {query.data.forwards.map((f) => <Card key={f.id}><Text style={t.text.body}>{hostLabel}: localhost:{f.localPort} → remote port {f.remotePort}</Text><Button label="Close forward" onPress={() => mutation.mutate(() => disconnect({ id: f.id }))} /></Card>)}
    </Section>}
    {!query.data?.peers.length && <Card><Text style={t.text.heading}>Bring your remote apps to localhost</Text><Text style={t.text.body}>Pair Daemon Link once between your machines. After that, choose a remote service and press Open localhost. No SSH password, account, or browser helper is required.</Text></Card>}
    {!!query.data?.peers.length && <Button label={pairing ? "Hide pairing" : "Pair another host"} onPress={() => setPairing(!pairing)} />}
    {(pairing || !query.data?.peers.length) && <Section title="One-time pairing">
      <Card>
        <Text style={t.text.heading}>1. On the remote host</Text>
        <Text style={t.text.body}>With the app's host selected, create a code to allow your other computer to discover and connect to its verified project dev servers. Share it only with a device you trust.</Text>
        <Button label="Create pairing code" disabled={mutation.isPending || !query.data} onPress={() => mutation.mutate(async () => { setInvitation((await offer({ label: hostLabel })).invitation); })} />
        {!!invitation && <><Button label="Copy / share code" onPress={() => { void sharePairingCode(invitation).catch((err) => toast.error(errorText(err))); }} /><Text selectable style={t.text.caption}>{invitation}</Text></>}
      </Card>
      <Card>
        <Text style={t.text.heading}>2. On your computer's daemon</Text>
        <Text style={t.text.body}>Install Daemon Link on your computer too. Select that computer in Paseo's host picker, then paste the code here. Pairings are saved across restarts.</Text>
        <TextInput accessibilityLabel="Daemon Link pairing code" placeholder="Paste pairing code" placeholderTextColor={t.color.muted} value={incoming} onChangeText={setIncoming} multiline autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, padding: 12, backgroundColor: t.color.surface2, borderRadius: 6, minHeight: 64 }} />
        <Button label="Pair host" disabled={!incoming.trim() || mutation.isPending} onPress={() => mutation.mutate(async () => { await pair({ invitation: incoming.trim() }); setIncoming(""); setPairing(false); toast.show("Host paired", { variant: "success" }); })} />
      </Card>
    </Section>}
    <Text style={t.text.caption}>Close forward only disconnects browser access. It leaves the remote dev server running. Both hosts must stay online with Daemon Link enabled.</Text>
    <Button label="Need access on a phone? Use a browser link" onPress={onBrowserLink} />
    {!!query.data?.grants.length && <Section title="Access to this host">
      <StatusPill tone={query.data.relayState === "connected" ? "ok" : "warning"} label={`Relay ${query.data.relayState}`} />
      {query.data.grants.map((grant) => <Card key={grant.id}><Text style={t.text.body}>{grant.label} · {grant.id.slice(0, 8)}</Text><Button label="Revoke access" onPress={() => mutation.mutate(async () => { await revoke({ id: grant.id }); setInvitation(""); })} /></Card>)}
    </Section>}
    {!!query.data?.peers.length && <Section title="Manage paired hosts">{query.data.peers.map((peer) => <Card key={peer.id}><Text style={t.text.body}>{peer.label}</Text><Button label="Remove pairing" onPress={() => mutation.mutate(async () => { await remove({ id: peer.id }); setSelected(null); })} /></Card>)}</Section>}
  </>;
}
