import type { PluginServerContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import { createRuntime } from "./server/runtime";
import { installCloudflared } from "./server/binaries";

export default function contribute(server: PluginServerContext) {
  const runtime = createRuntime();
  server.handle(monitorSnapshot, runtime.monitor.snapshot);
  server.handle(monitorStop, runtime.monitor.stop);
  server.handle(monitorForceStop, runtime.monitor.forceStop);
  server.handle(rpc.linkStatus, (_input, context) => runtime.withContext(context, () => runtime.links.status()));
  server.handle(rpc.linkSave, (profile, context) => runtime.withContext(context, () => runtime.links.save(profile)));
  server.handle(rpc.linkRemove, ({ id }, context) => runtime.withContext(context, () => runtime.links.remove(id)));
  server.handle(rpc.linkConnect, ({ id }, context) => runtime.withContext(context, () => runtime.links.connect(id)));
  server.handle(rpc.linkDisconnect, ({ id }, context) => runtime.withContext(context, () => runtime.links.disconnect(id)));
  server.handle(rpc.tunnelStart, (input, context) => runtime.withContext(context, () => runtime.links.tunnels.start(input)));
  server.handle(rpc.tunnelStop, ({ id }, context) => runtime.withContext(context, () => runtime.links.tunnels.stop(id)));
  server.handle(rpc.tunnelOpen, ({ id }, context) => runtime.withContext(context, () => runtime.links.tunnels.open(id)));
  server.handle(rpc.tunnelInstall, (_input, context) => runtime.withContext(context, () => installCloudflared()));
  server.handle(peer.peerStatus, (_input, context) => runtime.withContext(context, () => runtime.peers.status()));
  server.handle(peer.peerOffer, (input, context) => runtime.withContext(context, () => runtime.peers.offer(input)));
  server.handle(peer.peerPair, ({ invitation }, context) => runtime.withContext(context, () => runtime.peers.pair(invitation)));
  server.handle(peer.peerRevoke, ({ id }, context) => runtime.withContext(context, () => runtime.peers.revoke(id)));
  server.handle(peer.peerRemove, ({ id }, context) => runtime.withContext(context, () => runtime.peers.remove(id)));
  server.handle(peer.peerServices, ({ id }, context) => runtime.withContext(context, () => runtime.peers.services(id)));
  server.handle(peer.peerForward, ({ id, port }, context) => runtime.withContext(context, () => runtime.peers.forward(id, port)));
  server.handle(peer.peerDisconnect, ({ id }, context) => runtime.withContext(context, () => runtime.peers.disconnect(id)));
  return async () => { await Promise.all([runtime.links.close(), runtime.peers.close()]); };
}
