import type { PluginContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import {
  createRuntime, handleMonitorForceStop, handleMonitorSnapshot, handleMonitorStop, installCloudflared,
} from "./server/legacy.server";
import { DaemonSurface } from "./client/legacy.client";

// Paseo 0.7 loads this entry; 0.8 selects the two runtime entries instead.
// The 0.7 compiler removes .server imports and handle() registrations from the
// client bundle. typeof keeps initialization and cleanup safe after that removal.
export default function contribute(plugin: PluginContext) {
  const runtime = typeof createRuntime === "function" ? createRuntime() : null;
  plugin.handle(monitorSnapshot, handleMonitorSnapshot);
  plugin.handle(monitorStop, handleMonitorStop);
  plugin.handle(monitorForceStop, handleMonitorForceStop);
  plugin.handle(rpc.linkStatus, () => runtime!.links.status());
  plugin.handle(rpc.linkSave, (profile) => runtime!.links.save(profile));
  plugin.handle(rpc.linkRemove, ({ id }) => runtime!.links.remove(id));
  plugin.handle(rpc.linkConnect, ({ id }) => runtime!.links.connect(id));
  plugin.handle(rpc.linkDisconnect, ({ id }) => runtime!.links.disconnect(id));
  plugin.handle(rpc.tunnelStart, (input) => runtime!.links.tunnels.start(input));
  plugin.handle(rpc.tunnelStop, ({ id }) => runtime!.links.tunnels.stop(id));
  plugin.handle(rpc.tunnelOpen, ({ id }) => runtime!.links.tunnels.open(id));
  plugin.handle(rpc.tunnelInstall, () => installCloudflared());
  plugin.handle(peer.peerStatus, () => runtime!.peers.status());
  plugin.handle(peer.peerOffer, (input) => runtime!.peers.offer(input));
  plugin.handle(peer.peerPair, ({ invitation }) => runtime!.peers.pair(invitation));
  plugin.handle(peer.peerRevoke, ({ id }) => runtime!.peers.revoke(id));
  plugin.handle(peer.peerRemove, ({ id }) => runtime!.peers.remove(id));
  plugin.handle(peer.peerServices, ({ id }) => runtime!.peers.services(id));
  plugin.handle(peer.peerForward, ({ id, port }) => runtime!.peers.forward(id, port));
  plugin.handle(peer.peerDisconnect, ({ id }) => runtime!.peers.disconnect(id));
  plugin.addSurface("daemon-link", DaemonSurface);
  plugin.addSidebarItem({ id: "daemon-link", title: "Daemon Link", icon: "Network", surface: "daemon-link" });
  plugin.addWorkspacePanel({
    id: "daemon-link", title: "Daemon Link", icon: "Network", context: "workspace", Component: DaemonSurface,
  });
  plugin.addCommandCenterItem({
    id: "open-daemon-link", title: "Open Daemon Link", icon: "Network", context: "global",
    keywords: ["monitor", "ports", "dev server", "tunnel", "ssh", "cpu", "memory"],
    onSelect({ openSurface }) { openSurface("daemon-link"); },
  });
  return async () => { if (runtime) await Promise.all([runtime.links.close(), runtime.peers.close()]); };
}
