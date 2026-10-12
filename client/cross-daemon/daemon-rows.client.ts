// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import type { CrossDaemonHostSummary as PluginHostSummary } from "./hosts.client";

export interface DescribedDaemon {
  serverId: string;
  switchedOn: boolean;
  available?: boolean;
  peers: readonly { serverId: string; name: string }[];
}

export interface DaemonRow {
  serverId: string;
  label: string;
  state: "on" | "off" | "unavailable";
  detail: string;
}

// What the page learned from the hosts' plugins; null until they first answer.
export interface DaemonReadings {
  daemons: readonly DescribedDaemon[];
  failedCount: number;
}

export function buildDaemonRows(hosts: readonly PluginHostSummary[], readings: DaemonReadings | null): DaemonRow[] {
  return hosts.map(({ serverId, label, status }) => {
    if (status !== "online") return { serverId, label, state: "unavailable", detail: "Offline." };
    if (!readings) return { serverId, label, state: "unavailable", detail: "Checking…" };
    const daemon = readings.daemons.find((candidate) => candidate.serverId === serverId);
    if (!daemon && readings.failedCount > 0) {
      return { serverId, label, state: "unavailable", detail: "Could not read this host. Reconnect it and check that Paseo and Hosts are up to date." };
    }
    if (!daemon) {
      return { serverId, label, state: "unavailable", detail: "Cross-daemon is unavailable. Check that Paseo and Hosts are up to date." };
    }
    if (daemon.available === false) return { serverId, label, state: "unavailable", detail: "Update Paseo on this host to use cross-daemon." };
    if (!daemon.switchedOn) return { serverId, label, state: "off", detail: "Off: no links are shared. Previously shared links are not revoked." };
    const peerLabels = daemon.peers.map((peer) => hosts.find((candidate) => candidate.serverId === peer.serverId)?.label ?? peer.name);
    const reach = peerLabels.length > 0 ? peerLabels.join(", ") : "none yet. Switch on at least one other daemon.";
    return { serverId, label, state: "on", detail: `Shared peers: ${reach}` };
  });
}
