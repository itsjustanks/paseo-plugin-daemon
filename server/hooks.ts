import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookWorkspace, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import type { Snapshot, SnapshotInput } from "../shared/contracts";
import type { Tunnel } from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS, HostsSettingsSchema, type HostsSettings } from "../shared/settings";
import { filterWorkspaceProcesses, workspacePorts } from "../shared/workspace-filter";

/** The slice of the runtime the hooks need; tests hand in a fake. */
export interface HooksRuntime {
  monitor: { snapshot(input: SnapshotInput, context?: PluginHandlerContext): Promise<Snapshot> };
  links: { tunnels: { list(): Tunnel[]; stop(id: string): Promise<unknown> } };
}

/**
 * The daemon persists plugin settings as `{ version, values }` envelopes at
 * `$PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json` (see the daemon's
 * PluginSettingsStore). The server SDK exposes no read API yet, so the hooks
 * read that file directly. Anything unreadable fails closed: no tunnel is
 * touched unless the user has knowingly left the switch on.
 */
export const hostsSettingsFile = (paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo"), pluginId = "daemon-link") =>
  join(paseoHome, "plugin-settings", pluginId, "hosts.json");

const UNREADABLE: HostsSettings = { ...HOSTS_SETTINGS_DEFAULTS, closeTunnelsOnArchive: false };

export async function readHostsSettings(file = hostsSettingsFile()): Promise<HostsSettings> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    // A missing document means the user never saved; schema defaults apply (archive cleanup on).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return HOSTS_SETTINGS_DEFAULTS;
    return UNREADABLE;
  }
  try {
    const envelope = JSON.parse(raw) as { version?: unknown; values?: unknown };
    if (envelope.version !== 1) return UNREADABLE;
    return HostsSettingsSchema.parse(envelope.values ?? {});
  } catch { return UNREADABLE; }
}

/** Pure decision: which tunnels point at a port owned by a process under the workspace cwd. */
export function tunnelsForWorkspace(tunnels: readonly Tunnel[], snapshot: Pick<Snapshot, "services" | "processes">, cwd: string): Tunnel[] {
  const owned = filterWorkspaceProcesses([...snapshot.services, ...snapshot.processes], { directory: cwd });
  const ports = new Set(workspacePorts(owned));
  return tunnels.filter((tunnel) => ports.has(tunnel.port) && tunnel.state !== "stopped");
}

export interface ArchiveOutcome { skipped: "disabled" | "no-tunnels" | null; stopped: number[]; failed: number[] }

export async function closeWorkspaceTunnels(runtime: HooksRuntime, workspace: PluginHookWorkspace, settings: HostsSettings, context?: PluginHandlerContext): Promise<ArchiveOutcome> {
  if (!settings.closeTunnelsOnArchive) return { skipped: "disabled", stopped: [], failed: [] };
  const open = runtime.links.tunnels.list();
  if (open.length === 0) return { skipped: "no-tunnels", stopped: [], failed: [] };
  const snapshot = await runtime.monitor.snapshot({ query: "", sort: "pid", limit: 200 }, context);
  const targets = tunnelsForWorkspace(open, snapshot, workspace.cwd);
  if (targets.length === 0) return { skipped: "no-tunnels", stopped: [], failed: [] };
  const stopped: number[] = [], failed: number[] = [];
  for (const tunnel of targets) {
    try { await runtime.links.tunnels.stop(tunnel.id); stopped.push(tunnel.port); }
    catch { failed.push(tunnel.port); }
  }
  return { skipped: null, stopped, failed };
}

const label = (workspace: PluginHookWorkspace) => workspace.name ? `${workspace.name} (${workspace.id})` : workspace.id;

export function registerHooks(server: PluginLifecycleRegistration, runtime: HooksRuntime, readSettings: () => Promise<HostsSettings> = () => readHostsSettings()) {
  const removers = [
    server.on("workspace.created", (event) => {
      console.log(`daemon-link: workspace.created ${label(event.workspace)}`);
    }),
    server.on("workspace.archived", async (event, context) => {
      // Never throw: an archive must finish even if cleanup cannot.
      try {
        const settings = await readSettings();
        const outcome = await closeWorkspaceTunnels(runtime, event.workspace, settings, { paseo: context.paseo });
        if (outcome.skipped === "disabled") console.log(`daemon-link: workspace.archived ${label(event.workspace)}; tunnel cleanup is off`);
        else if (outcome.skipped === "no-tunnels") console.log(`daemon-link: workspace.archived ${label(event.workspace)}; no browser links pointed at it`);
        else console.log(`daemon-link: workspace.archived ${label(event.workspace)}; stopped browser links on ports ${outcome.stopped.join(", ") || "none"}${outcome.failed.length ? `; failed on ${outcome.failed.join(", ")}` : ""}`);
      } catch (error) {
        console.error("daemon-link: workspace.archived cleanup failed", error instanceof Error ? error.name : "unknown");
      }
    }),
  ];
  return () => { for (const remove of removers) remove(); };
}
