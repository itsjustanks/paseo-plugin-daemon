import type { PluginServerContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import { PeerManager } from "./server/peers";
import { handleMonitorForceStop, handleMonitorSnapshot, handleMonitorStop } from "./server/handlers";
import { LinkManager } from "./server/links";
import { installCloudflared } from "./server/binaries";

export default function contribute(server: PluginServerContext) {
  const links = new LinkManager();
  const peers = new PeerManager();
  server.handle(monitorSnapshot, handleMonitorSnapshot);
  server.handle(monitorStop, handleMonitorStop);
  server.handle(monitorForceStop, handleMonitorForceStop);
  server.handle(rpc.linkStatus, () => links.status());
  server.handle(rpc.linkSave, (profile) => links.save(profile));
  server.handle(rpc.linkRemove, ({ id }) => links.remove(id));
  server.handle(rpc.linkConnect, ({ id }) => links.connect(id));
  server.handle(rpc.linkDisconnect, ({ id }) => links.disconnect(id));
  server.handle(rpc.tunnelStart, (input) => links.tunnels.start(input));
  server.handle(rpc.tunnelStop, ({ id }) => links.tunnels.stop(id));
  server.handle(rpc.tunnelOpen, ({ id }) => links.tunnels.open(id));
  server.handle(rpc.tunnelInstall, () => installCloudflared());
  server.handle(peer.peerStatus, () => peers.status());
  server.handle(peer.peerOffer, (input) => peers.offer(input));
  server.handle(peer.peerPair, ({ invitation }) => peers.pair(invitation));
  server.handle(peer.peerRevoke, ({ id }) => peers.revoke(id));
  server.handle(peer.peerRemove, ({ id }) => peers.remove(id));
  server.handle(peer.peerServices, ({ id }) => peers.services(id));
  server.handle(peer.peerForward, ({ id, port }) => peers.forward(id, port));
  server.handle(peer.peerDisconnect, ({ id }) => peers.disconnect(id));
  return async () => { await Promise.all([links.close(), peers.close()]); };
}
