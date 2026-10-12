// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
// Structural view of documented 0.10+ settings handles; 0.9 returns void.
export type CrossDaemonSettingsState = { status: string; values?: unknown };
import { crossDaemonSettings, type Peer } from "../../shared/cross-daemon/cross-daemon.shared";

export function isSwitchedOn(state: CrossDaemonSettingsState): boolean {
  const result = crossDaemonSettings.schema.safeParse(state.values);
  return state.status === "ready" && result.success && result.data.enabled && result.data.fullAuthorityConfirmed;
}

interface StoredPeerUpdate {
  switchedOn: boolean;
  ownServerId: string;
  stored: readonly Peer[];
  peers: readonly Peer[];
  answeredServerIds: readonly string[];
}

// A daemon that did not answer this sync may be asleep or still connecting, so its stored link stays
// until it answers switched off.
export function peersToStore(update: StoredPeerUpdate): Peer[] {
  if (!update.switchedOn) return [];
  const answered = new Set([...update.answeredServerIds, ...update.peers.map((peer) => peer.serverId)]);
  const silent = update.stored.filter((peer) => !answered.has(peer.serverId));
  return [...new Map([...update.peers, ...silent].filter((peer) => peer.serverId !== update.ownServerId).map((peer) => [peer.serverId, peer])).values()].slice(0, 100);
}
