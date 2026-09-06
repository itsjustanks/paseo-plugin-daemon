import * as sync from "./shared/sync";
import type { PluginContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import {
  createRuntime, installCloudflared,
} from "./server/legacy.server";
import { DaemonSurface } from "./client/legacy.client";

// Paseo 0.7 loads this entry; 0.8 selects the two runtime entries instead.
// The 0.7 compiler removes .server imports and handle() registrations from the
// client bundle. typeof keeps initialization and cleanup safe after that removal.
export default function contribute(plugin: PluginContext) {
  const runtime = typeof createRuntime === "function" ? createRuntime() : null;
  plugin.handle(sync.syncStatus, (_input, context) => runtime!.withContext(context, async () => {
    await runtime!.scope.refresh(); return { projects: runtime!.scope.status().projects.map((p) => ({ id: p.id, name: p.name })), history: await runtime!.transfers.history(), grants: await runtime!.peers.projectGrants() };
  }));
  plugin.handle(sync.syncShare, (input, context) => runtime!.withContext(context, () => runtime!.peers.shareProjects(input.grantId, input.projectIds)));
  plugin.handle(sync.syncProjects, (input, context) => runtime!.withContext(context, () => runtime!.peers.projectList(input.peerId)));
  plugin.handle(sync.syncPreview, (input, context) => runtime!.withContext(context, () => runtime!.transfers.inspect(runtime!.peers, input.peerId, input.projectId)));
  plugin.handle(sync.syncReceive, (input, context) => runtime!.withContext(context, () => runtime!.transfers.receive(runtime!.peers, input.peerId, input.token)));
  plugin.handle(monitorSnapshot, runtime!.monitor.snapshot);
  plugin.handle(monitorStop, runtime!.monitor.stop);
  plugin.handle(monitorForceStop, runtime!.monitor.forceStop);
  plugin.handle(rpc.linkStatus, (_input, context) => runtime!.withContext(context, () => runtime!.links.status()));
  plugin.handle(rpc.linkSave, (profile, context) => runtime!.withContext(context, () => runtime!.links.save(profile)));
  plugin.handle(rpc.linkRemove, ({ id }, context) => runtime!.withContext(context, () => runtime!.links.remove(id)));
  plugin.handle(rpc.linkConnect, ({ id }, context) => runtime!.withContext(context, () => runtime!.links.connect(id)));
  plugin.handle(rpc.linkDisconnect, ({ id }, context) => runtime!.withContext(context, () => runtime!.links.disconnect(id)));
  plugin.handle(rpc.tunnelStart, (input, context) => runtime!.withContext(context, () => runtime!.links.tunnels.start(input)));
  plugin.handle(rpc.tunnelStop, ({ id }, context) => runtime!.withContext(context, () => runtime!.links.tunnels.stop(id)));
  plugin.handle(rpc.tunnelOpen, ({ id }, context) => runtime!.withContext(context, () => runtime!.links.tunnels.open(id)));
  plugin.handle(rpc.tunnelInstall, (_input, context) => runtime!.withContext(context, () => installCloudflared()));
  plugin.handle(peer.peerStatus, (_input, context) => runtime!.withContext(context, () => runtime!.peers.status()));
  plugin.handle(peer.peerOffer, (input, context) => runtime!.withContext(context, () => runtime!.peers.offer(input)));
  plugin.handle(peer.peerPair, ({ invitation }, context) => runtime!.withContext(context, () => runtime!.peers.pair(invitation)));
  plugin.handle(peer.peerRevoke, ({ id }, context) => runtime!.withContext(context, () => runtime!.peers.revoke(id)));
  plugin.handle(peer.peerRemove, ({ id }, context) => runtime!.withContext(context, () => runtime!.peers.remove(id)));
  plugin.handle(peer.peerServices, ({ id }, context) => runtime!.withContext(context, () => runtime!.peers.services(id)));
  plugin.handle(peer.peerForward, ({ id, port }, context) => runtime!.withContext(context, () => runtime!.peers.forward(id, port)));
  plugin.handle(peer.peerDisconnect, ({ id }, context) => runtime!.withContext(context, () => runtime!.peers.disconnect(id)));
  plugin.addSurface("daemon-link", DaemonSurface);
  plugin.addSidebarItem({ id: "daemon-link", title: "Hosts", icon: "Network", surface: "daemon-link" });
  plugin.addWorkspacePanel({
    id: "daemon-link", title: "Hosts", icon: "Network", context: "workspace", Component: DaemonSurface,
  });
  plugin.addCommandCenterItem({
    id: "open-daemon-link", title: "Open Hosts", icon: "Network", context: "global",
    keywords: ["hosts", "sync", "daemon link", "monitor", "ports", "dev server", "tunnel", "ssh", "cpu", "memory"],
    onSelect({ openSurface }) { openSurface("daemon-link"); },
  });
  return async () => { if (runtime) await Promise.all([runtime.links.close(), runtime.peers.close(), runtime.transfers.close()]); };
}
