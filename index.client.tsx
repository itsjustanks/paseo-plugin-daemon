import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin";
import { DaemonSurface } from "./client/daemon";

export default function contribute(client: PluginClientContext) {
  const shortcuts = typeof client.addSlashCommand === "function";
  const Surface = (props: PluginSurfaceProps) => <DaemonSurface {...props} shortcuts={shortcuts} />;
  client.addSurface("daemon-link", Surface);
  client.addSidebarItem({ id: "daemon-link", title: "Hosts", icon: "Network", surface: "daemon-link" });
  client.addWorkspacePanel({
    id: "daemon-link", title: "Hosts", icon: "Network", context: "workspace", Component: Surface,
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
