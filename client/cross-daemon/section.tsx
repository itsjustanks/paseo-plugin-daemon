import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
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
  const [details, setDetails] = useState(false);
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
  const color = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 12, padding: layout.compact ? 16 : 24 }}>
    <Text style={{ ...color, fontSize: 20, fontWeight: "600" }}>Cross-daemon</Text>
    <Text style={muted}>Let agents find workspaces, read activity, and send prompts across selected hosts. Off by default; separate from Hosts app and file access.</Text>
    {!hosts ? <Text accessibilityRole="alert" style={muted}>Update Paseo to use connected-host discovery.</Text> : null}
    {daemons.isPending && hosts ? <Text style={muted}>Checking connected hosts…</Text> : null}
    {daemons.isError || (daemons.data?.failedCount ?? 0) > 0 ? <Text accessibilityRole="alert" style={muted}>Some hosts could not be checked. Reconnect them and check that Paseo and Hosts are up to date.</Text> : null}
    {hosts?.length === 0 ? <Text style={muted}>Connect at least two hosts with Hosts to share work between them.</Text> : null}
    {rows.map((row) => {
      const daemon = daemons.data?.daemons.find((candidate) => candidate.serverId === row.serverId);
      const disabled = row.state === "unavailable" || !daemon || toggle.isPending;
      return <View key={row.serverId} style={{ gap: 6, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <Text style={{ ...color, fontWeight: "600" }}>{safeCrossDaemonText(row.label)}</Text>
        <Text style={muted}>{safeCrossDaemonText(row.detail)}</Text>
        <Pressable accessibilityRole="switch" accessibilityLabel={`Cross-daemon for ${safeCrossDaemonText(row.label)}`} accessibilityState={{ checked: row.state === "on", disabled }} disabled={disabled}
          onPress={() => { if (!daemon) return; if (row.state === "on") toggle.mutate({ daemon, enabled: false }); else { toggle.reset(); setConfirm({ daemon, label: row.label }); } }} style={{ alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12, opacity: disabled ? 0.5 : 1 }}>
          <Text style={color}>{row.state === "on" ? "Turn off" : "Turn on…"}</Text>
        </Pressable>
      </View>;
    })}
    {toggle.isError ? <Text accessibilityRole="alert" style={muted}>The change could not be confirmed. Check the refreshed host status before trying again.</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh cross-daemon hosts" onPress={() => { requestPeerSync(); void daemons.refetch(); }}><Text style={color}>Refresh hosts</Text></Pressable>
    <Text style={muted}>Enabling shares full daemon authority with the other selected hosts. Turning off clears local peers and pending deliveries; links already shared are not revoked.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Cross-daemon details" accessibilityState={{ expanded: details }} onPress={() => setDetails((open) => !open)}><Text style={color}>{details ? "Hide details" : "Details"}</Text></Pressable>
    {details ? <View style={{ gap: 8 }}>
      <Text style={muted}>While this app is open, selected hosts sync once per minute. Sleeping hosts keep their last shared peers; other hosts drop a switched-off host after sync. Peers and agents running as the daemon owner can access full daemon authority. Rotate pairing credentials separately to revoke previously shared access.</Text>
      <Text style={muted}>Prompts wait for an idle check and expire after 24 hours. A turn starting between the check and send can still be interrupted. Uncertain sends are never retried automatically. Caller identity is best effort; some providers do not supply it.</Text>
    </View> : null}
    <Confirm theme={theme} open={confirm !== null} title={`Share full authority for ${safeCrossDaemonText(confirm?.label ?? "this host")}?`}
      text="To let agents work across hosts, this shares this daemon’s pairing link with the other opted-in daemons. A pairing link grants FULL CONTROL of this daemon, including its agents and files, beyond Hosts app and file grants. Links are stored owner-only, but agents running as that owner can read them. Turning off does not revoke links already shared. Only enable for hosts and agents you trust with full control."
      confirmLabel="Share full daemon authority" danger busy={toggle.isPending}
      onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm) toggle.mutate({ daemon: confirm.daemon, enabled: true }); }} />
  </View>;
}
