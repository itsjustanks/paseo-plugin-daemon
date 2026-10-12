import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, Disclosure, ItemTitle, Meta, Note, Row, SectionTitle, SPACE, TYPE } from "../kit";
import { ResourceCells, ResourceTable, type ResourceColumn } from "../resource-table";
import { Confirm } from "../feedback";
import { safeCrossDaemonText } from "../../shared/cross-daemon/privacy";
import { buildDaemonRows, type DescribedDaemon } from "./daemon-rows.client";
import { useCrossDaemonHosts } from "./hosts.client";
import type { DaemonPort } from "./peer-sync.client";
import { listRegisteredDaemons, requestPeerSync } from "./sync-scheduler.client";

const KEY = ["hosts-cross-daemon", "daemons"];
type Daemon = DescribedDaemon & { port: DaemonPort };

async function describeAll() {
  const results = await Promise.allSettled(listRegisteredDaemons().map(async (port): Promise<Daemon> => {
    const [description, peers] = await Promise.all([port.status(), port.listPeers()]);
    // Only the status RPC is called here. No offer ever enters the query cache.
    return { serverId: description.serverId, switchedOn: description.switchedOn, available: description.available, peers, port };
  }));
  return { daemons: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []), failedCount: results.filter((result) => result.status === "rejected").length };
}

/** Embed within Hosts' existing screen. This component registers no sidebar or route. */
export function CrossDaemonSection({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const hosts = useCrossDaemonHosts();
  const queries = useQueryClient();
  const [confirm, setConfirm] = useState<{ daemon: Daemon; label: string } | null>(null);
  const daemons = useQuery({ queryKey: KEY, queryFn: describeAll, refetchInterval: 5_000, enabled: hosts !== null });
  const toggle = useMutation({
    mutationFn: async ({ daemon, enabled }: { daemon: Daemon; enabled: boolean }) => daemon.port.setSwitch(enabled, enabled),
    onSuccess: async () => { setConfirm(null); requestPeerSync(); await queries.invalidateQueries({ queryKey: KEY }); },
    onError: async () => {
      // A failed acknowledgement is not proof the setting stayed off. Close the spent single-use
      // confirmation and refresh the actual status; never display an optimistic success.
      setConfirm(null);
      await queries.invalidateQueries({ queryKey: KEY });
    },
  });
  const rows = buildDaemonRows(hosts ?? [], daemons.data ?? null);
  const optedIn = rows.filter((row) => row.state === "on");
  const recipients = optedIn.filter((row) => row.serverId !== confirm?.daemon.serverId).map((row) => safeCrossDaemonText(row.label));
  const nextStep = optedIn.length < 2
    ? "Choose at least two online computers below. Review and turn on agent access for each one."
    : optedIn.some((row) => (daemons.data?.daemons.find((daemon) => daemon.serverId === row.serverId)?.peers.length ?? 0) === 0)
      ? "Waiting for the selected computers to share access. Keep this app open and refresh if needed."
      : "Access is shared. Start a new agent on a selected computer to use the cross-computer tools.";
  const columns: readonly ResourceColumn[] = [{ id: "computer", label: "Computer", weight: 1.4 }, { id: "status", label: "Agent access", weight: 2 }, { id: "actions", label: "Permission", width: 176 }];
  return <View style={{ gap: SPACE.row, minWidth: 0 }}>
    <SectionTitle theme={theme} icon="Network">Agents across computers</SectionTitle>
    <Note theme={theme}>An agent on your laptop can find a workspace on your server, read another agent's progress, and ask that agent to do a task. Each computer keeps its own agents and files.</Note>
    {hosts ? <Note theme={theme}>{nextStep}</Note> : null}
    <ItemTitle theme={theme}>Your computers</ItemTitle>
    {!hosts ? <Text accessibilityRole="alert" style={{ ...TYPE.body, color: theme.colors.foregroundMuted }}>Update Paseo to use connected-host discovery.</Text> : null}
    {daemons.isPending && hosts ? <Meta theme={theme}>Checking connected hosts…</Meta> : null}
    {daemons.isError || (daemons.data?.failedCount ?? 0) > 0 ? <Note theme={theme} tone="warning">Some hosts could not be checked. Reconnect them and check that Paseo and Hosts are up to date.</Note> : null}
    {hosts?.length === 0 ? <Note theme={theme}>No computers are configured in this app. Add your computers with the pairing steps below, install Hosts on each, then refresh.</Note> : null}
    <ResourceTable compact={layout.compact}>{(narrow) => <>
      {rows.map((row) => {
        const daemon = daemons.data?.daemons.find((candidate) => candidate.serverId === row.serverId);
        const disabled = row.state === "unavailable" || !daemon || toggle.isPending;
        const connection = hosts?.find((host) => host.serverId === row.serverId)?.status;
        return <View key={row.serverId} style={{ paddingVertical: SPACE.row, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <ResourceCells theme={theme} columns={columns} compact={narrow} cells={{
            computer: <View><ItemTitle theme={theme}>{safeCrossDaemonText(row.label)}</ItemTitle><Meta theme={theme}>{connection === "online" ? "Connected to Paseo" : connection === "connecting" ? "Connecting to Paseo…" : "Not connected to Paseo"}</Meta></View>,
            status: <View><ItemTitle theme={theme}>{row.state === "on" ? "On" : row.state === "off" ? "Off" : "Unavailable"}</ItemTitle><Meta theme={theme}>{safeCrossDaemonText(row.detail)}</Meta></View>,
            actions: <Pressable accessibilityRole="switch" accessibilityLabel={`Cross-daemon for ${safeCrossDaemonText(row.label)}`} accessibilityState={{ checked: row.state === "on", disabled }} disabled={disabled}
              onPress={() => { if (!daemon) return; if (row.state === "on") toggle.mutate({ daemon, enabled: false }); else { toggle.reset(); setConfirm({ daemon, label: row.label }); } }}
              style={{ alignSelf: "flex-start", minHeight: 44, maxWidth: "100%", justifyContent: "center", paddingVertical: SPACE.sm, paddingHorizontal: SPACE.row, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, opacity: disabled ? 0.5 : 1 }}>
              <Text style={{ ...TYPE.secondary, color: theme.colors.foreground, flexShrink: 1 }}>{row.state === "on" ? "Turn off" : row.state === "unavailable" ? "Unavailable" : "Review and turn on…"}</Text>
            </Pressable>,
          }} />
        </View>;
      })}
    </>}</ResourceTable>
    {toggle.isError ? <Note theme={theme} tone="warning">The change could not be confirmed. Check the refreshed host status before trying again.</Note> : null}
    <Row><Button theme={theme} label="Refresh computers" accessibilityLabel="Refresh cross-daemon hosts" onPress={() => { requestPeerSync(); void daemons.refetch(); }} /></Row>
    <Meta theme={theme}>Turning off clears local peers and pending deliveries. It does not revoke full-control links already shared; rotate pairing credentials separately to revoke access.</Meta>
    <Disclosure theme={theme} label="Setup guide and example task" initiallyOpen={!hosts || hosts.length < 2} quiet>
    <View style={{ gap: SPACE.sm, padding: SPACE.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10 }}>
      <ItemTitle theme={theme}>1. Add your computers to Paseo</ItemTitle>
      <Meta theme={theme}>Already connected? Your computers are listed above. Otherwise, add the other computer using its Paseo pairing link.</Meta>
      <Disclosure theme={theme} label="Add a computer with a pairing link" quiet>
        <Note theme={theme}>On the computer you want to connect, open Paseo Settings → that host → Pair a device, then enable the relay and copy its pairing link. You can also run paseo daemon pair on that computer.</Note>
        <Note theme={theme}>In this Paseo app, use its add-host pairing flow and choose Paste pairing link. Paste there, review the computer, and connect. Use a recognisable name such as My Mac or Development server.</Note>
        <Meta theme={theme}>A Paseo pairing link grants full control of that computer's daemon. Keep it private. This page reads the computers configured in Paseo; it does not collect or display pairing links. Adding a computer does not send a prompt or move an agent.</Meta>
      </Disclosure>
      <ItemTitle theme={theme}>2. Review agent access on each computer</ItemTitle>
      <Meta theme={theme}>Agent access starts off. Only computers you explicitly turn on exchange full-control links with the other opted-in computers. Private app and file grants below are separate.</Meta>
      <ItemTitle theme={theme}>3. Start an agent and name the task</ItemTitle>
      <Meta theme={theme}>After access is shared, start a new supported agent. For example: “Find the Website workspace on Development server and read the build agent's latest progress.” Sending that agent a task is a separate action.</Meta>
    </View>
    </Disclosure>
    <Disclosure theme={theme} label="Connection limits and security" quiet>
      <Meta theme={theme}>While this app is open, opted-in computers sync once per minute. Offline or sleeping computers keep their last shared peers; other computers drop a switched-off peer after sync. Peers and agents running as the daemon owner can access full daemon authority.</Meta>
      <Meta theme={theme}>New Claude, Codex and OpenCode agents receive the cross-computer tools. Existing agents retain their saved configuration. Other providers are not configured automatically.</Meta>
      <Meta theme={theme}>Prompts wait for an idle check and expire after 24 hours. A turn starting between the check and send can still be interrupted. Uncertain sends are never retried automatically. Caller identity is best effort; some providers do not supply it. Connecting computers does not migrate chats, terminals or processes.</Meta>
    </Disclosure>
    <Confirm theme={theme} open={confirm !== null} title={`Share full authority for ${safeCrossDaemonText(confirm?.label ?? "this host")}?`}
      text={`Other computers currently opted in: ${recipients.length ? recipients.join(", ") : "none yet"}. Computers you later opt in will also receive access when the app syncs. To let agents work across hosts, this shares this daemon’s pairing link with the other opted-in daemons. A pairing link grants FULL CONTROL of this daemon, including its agents and files, beyond Hosts app and file grants. Links are stored owner-only, but agents running as that owner can read them. Turning off does not revoke links already shared. Only enable for hosts and agents you trust with full control.`}
      confirmLabel="Share full daemon authority" danger busy={toggle.isPending}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm) toggle.mutate({ daemon: confirm.daemon, enabled: true }); }} />
  </View>;
}
