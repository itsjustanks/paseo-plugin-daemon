import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { DaemonSurface } from "./client/daemon";
import { HostsSettings } from "./client/settings";
import { WorkspacePanel } from "./client/workspace-panel";

export default function contribute(client: PluginClientContext) {
  const shortcuts = typeof client.addSlashCommand === "function";
  const Surface = (props: PluginSurfaceProps) => <DaemonSurface {...props} shortcuts={shortcuts} />;
  client.addSurface("daemon-link", Surface);
  client.addSidebarItem({ id: "daemon-link", title: "Hosts", icon: "Network", surface: "daemon-link" });
  client.addWorkspacePanel({
    id: "daemon-link", title: "Hosts", icon: "Network", context: "workspace",
    // `locations` defaults to ["workspace"] alone; without "explorer" the tab never shows in Projects.
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addSettingsScreen({ id: "hosts", title: "Hosts", icon: "Network", Component: HostsSettings });
  client.addCommandCenterItem({
    id: "configure-hosts", title: "Configure Hosts", icon: "Settings", context: "global",
    keywords: ["hosts", "settings", "daemon link", "panel", "tunnel", "archive", "interval"],
    onSelect({ openSettings }) { openSettings("hosts"); },
  });
  client.addCommandCenterItem({
    id: "open-daemon-link", title: "Open Hosts", icon: "Network", context: "global",
    keywords: ["hosts", "sync", "daemon link", "monitor", "ports", "dev server", "tunnel", "ssh", "cpu", "memory"],
    onSelect({ openSurface }) { openSurface("daemon-link"); },
  });
  if (shortcuts) client.addSlashCommand({
    name: "daemon-link", description: "Open services, localhost links, and host monitoring",
    argumentHint: "", context: "workspace",
    onSubmit({ openPanel }) { openPanel("daemon-link"); },
  });
  return () => {};
}
