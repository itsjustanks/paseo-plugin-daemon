import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { hostHealth } from "./shared/health";
import { hostsAttachmentSearch } from "./shared/attachments";
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
    id: "open-heavy-processes", title: "Show heavy processes", icon: "Cpu", context: "global",
    keywords: ["processes", "cpu", "memory", "runaway", "kill", "stop", "slow", "build", "limit", "container", "hosts"],
    onSelect(command) { openMainScreen(command, MAIN_SCREEN, { tab: "processes" }); },
  });
  client.addCommandCenterItem({
    id: "check-host-now", title: "Check host now", icon: "RefreshCw", context: "global",
    keywords: ["hosts", "health", "check", "memory", "cpu", "status", "watched", "omniroute"],
    async onSelect(command) {
      await checkNow(command);
      openMainScreen(command, MAIN_SCREEN, { tab: "overview" });
    },
  });
  // Slash commands (feature-detected): the same common actions from a chat's message box.
  if (shortcuts) {
    client.addSlashCommand({
      name: "daemon-link", description: "Open Hosts for this workspace: its dev servers, links and problems",
      argumentHint: "", context: "workspace",
      onSubmit({ openPanel }) { openPanel("daemon-link"); },
    });
    client.addSlashCommand({
      name: "heavy-processes", description: "Show what is using this host's CPU and memory",
      argumentHint: "", context: "workspace",
      onSubmit(command) { openMainScreen(command, MAIN_SCREEN, { tab: "processes" }); },
    });
    client.addSlashCommand({
      name: "check-host", description: "Check this host's health now, then show this workspace's Hosts tab",
      argumentHint: "", context: "workspace",
      async onSubmit(command) {
        await checkNow(command);
        command.openPanel("daemon-link");
      },
    });
  }
  // 0.12.0: "Hosts" in the message box's attach menu (Paseo 0.8+, feature-detected).
  const removeAttachments = typeof client.addAttachmentSource === "function"
    ? client.addAttachmentSource({
      id: "hosts", title: "Hosts", icon: "Network", pickerTitle: "Attach from Hosts",
      searchPlaceholder: "Heavy processes, a dev server's output, a watched service…", search: hostsAttachmentSearch,
    })
    : () => {};
  // A chip only when a chat needs attention (0.11.0). Host health at a glance is the sidebar row's dot and
  // popover; no sidebar footer item, since on every app that has one the row already shows the same thing.
  const removePills = registerHealthPills(client);
  return () => { removePills(); void removeAttachments(); };
}

/** Asks the daemon for a fresh health check; the screen, panel and sidebar dot then read it. A failure just opens the page as it is. */
async function checkNow(command: { rpc?: unknown }): Promise<void> {
  if (typeof command.rpc !== "function") return;
  const rpc = command.rpc as (contract: typeof hostHealth, input: { refresh: boolean }) => Promise<unknown>;
  try { await rpc.call(command, hostHealth, { refresh: true }); } catch { /* Shown on the page instead. */ }
}
