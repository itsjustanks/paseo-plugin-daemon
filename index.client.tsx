import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin";
import { DaemonSurface } from "./client/daemon";

export default function contribute(client: PluginClientContext) {
  const shortcuts = typeof client.addSlashCommand === "function";
  const Surface = (props: PluginSurfaceProps) => <DaemonSurface {...props} shortcuts={shortcuts} />;
  client.addSurface("daemon-link", Surface);
  client.addSidebarItem({ id: "daemon-link", title: "Daemon Link", icon: "Network", surface: "daemon-link" });
  client.addWorkspacePanel({
    id: "daemon-link", title: "Daemon Link", icon: "Network", context: "workspace", Component: Surface,
  });
  client.addCommandCenterItem({
    id: "open-daemon-link", title: "Open Daemon Link", icon: "Network", context: "global",
    keywords: ["monitor", "ports", "dev server", "tunnel", "ssh", "cpu", "memory"],
    onSelect({ openSurface }) { openSurface("daemon-link"); },
  });
  if (shortcuts) client.addSlashCommand({
    name: "daemon-link", description: "Open services, localhost links, and host monitoring",
    argumentHint: "", context: "workspace",
    onSubmit({ openPanel }) { openPanel("daemon-link"); },
  });
  return () => {};
}
