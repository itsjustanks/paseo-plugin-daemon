import * as sync from "./shared/sync";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import { createRuntime } from "./server/runtime";
import { installCloudflared } from "./server/binaries";
import { hostsSettings } from "./shared/settings";
import { hostHealth } from "./shared/health";
import { readHostsSettings, registerHooks } from "./server/hooks";
import { HealthChecker } from "./server/health";

export default function contribute(server: PluginServerContext) {
  const runtime = createRuntime();
  server.registerSettings(hostsSettings);
  const removeHooks = registerHooks(server, runtime);
  // One cached verdict per host; pills and panels read it instead of probing.
  const health = new HealthChecker({ runtime, readSettings: () => readHostsSettings() });
  server.handle(hostHealth, (_input, context) => runtime.withContext(context, () => health.read(context)));
  server.handle(sync.syncStatus, (_input, context) => runtime!.withContext(context, async () => {
    await runtime!.scope.refresh(); return { projects: runtime!.scope.status().projects.map((p) => ({ id: p.id, name: p.name })), history: await runtime!.transfers.history(), grants: await runtime!.peers.projectGrants() };
  }));
  server.handle(sync.syncShare, (input, context) => runtime!.withContext(context, () => runtime!.peers.shareProjects(input.grantId, input.projectIds)));
  server.handle(sync.syncProjects, (input, context) => runtime!.withContext(context, () => runtime!.peers.projectList(input.peerId)));
  server.handle(sync.syncPreview, (input, context) => runtime!.withContext(context, () => runtime!.transfers.inspect(runtime!.peers, input.peerId, input.projectId)));
  server.handle(sync.syncReceive, (input, context) => runtime!.withContext(context, () => runtime!.transfers.receive(runtime!.peers, input.peerId, input.token)));
  server.handle(monitorSnapshot, runtime.monitor.snapshot);
  server.handle(monitorStop, runtime.monitor.stop);
  server.handle(monitorForceStop, runtime.monitor.forceStop);
  server.handle(rpc.linkStatus, (_input, context) => runtime.withContext(context, () => runtime.links.status()));
  server.handle(rpc.linkSave, (profile, context) => runtime.withContext(context, () => runtime.links.save(profile)));
  server.handle(rpc.linkRemove, ({ id }, context) => runtime.withContext(context, () => runtime.links.remove(id)));
  server.handle(rpc.linkConnect, ({ id }, context) => runtime.withContext(context, () => runtime.links.connect(id)));
  server.handle(rpc.linkDisconnect, ({ id }, context) => runtime.withContext(context, () => runtime.links.disconnect(id)));
  server.handle(rpc.tunnelStart, (input, context) => runtime.withContext(context, () => runtime.links.tunnels.start(input)));
  server.handle(rpc.tunnelExtend, ({ id, minutes }, context) => runtime.withContext(context, () => runtime.links.tunnels.extend(id, minutes)));
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
  return async () => { removeHooks(); health.close(); await Promise.all([runtime.links.close(), runtime.peers.close(), runtime.transfers.close()]); };
}
