import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { DaemonSurface } from "./client/daemon";
import { openMainScreen, registerMainScreen } from "./client/native";
import { registerHealthPills } from "./client/pill";
import { makeQuickHealth, makeStatusTrailing } from "./client/quick";
import { HostsSettings } from "./client/settings";
import { WorkspacePanel } from "./client/workspace-panel";

const MAIN_SCREEN = "daemon-link";

export default function contribute(client: PluginClientContext) {
  const shortcuts = typeof client.addSlashCommand === "function";
  const Surface = (props: PluginSurfaceProps & { params?: Record<string, string> }) => <DaemonSurface {...props} shortcuts={shortcuts} />;
  // A screen and the app's own sidebar row on Paseo 0.11 apps; the surface and sidebar item before.
  // On 0.11 the row also carries a status dot; pressing it opens a quick health check.
  registerMainScreen(client, { id: MAIN_SCREEN, title: "Hosts", icon: "Network", Component: Surface, Trailing: makeStatusTrailing(makeQuickHealth(MAIN_SCREEN)) });
  client.addWorkspacePanel({
    id: "daemon-link", title: "Hosts", icon: "Network", context: "workspace",
    // `locations` defaults to ["workspace"] alone; without "explorer" the tab never shows in Projects.
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addSettingsScreen({ id: "hosts", title: "Hosts", icon: "Network", Component: HostsSettings });
  client.addCommandCenterItem({
    id: "configure-hosts", title: "Configure Hosts", icon: "Settings", context: "global",
    keywords: ["hosts", "settings", "daemon link", "panel", "tunnel", "archive", "interval", "watch", "health url", "heavy jobs"],
    onSelect({ openSettings }) { openSettings("hosts"); },
  });
  client.addCommandCenterItem({
    id: "open-daemon-link", title: "Open Hosts", icon: "Network", context: "global",
    keywords: ["hosts", "sync", "daemon link", "monitor", "ports", "dev server", "tunnel", "ssh"],
    onSelect(command) { openMainScreen(command, MAIN_SCREEN); },
  });
  client.addCommandCenterItem({
    id: "open-heavy-processes", title: "Heavy processes on this host", icon: "Cpu", context: "global",
    keywords: ["processes", "cpu", "memory", "runaway", "kill", "stop", "slow", "build", "limit", "container"],
    onSelect(command) { openMainScreen(command, MAIN_SCREEN, { tab: "processes" }); },
  });
  if (shortcuts) client.addSlashCommand({
    name: "daemon-link", description: "Open services, localhost links, and host monitoring",
    argumentHint: "", context: "workspace",
    onSubmit({ openPanel }) { openPanel("daemon-link"); },
  });
  // One chip per live agent, present only while its workspace has a dev server or an issue to report.
  const removePills = registerHealthPills(client);
  return () => { removePills(); };
}
