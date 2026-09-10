import { type PluginClientContext, type PluginComposerPillProps, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { settingsRpc } from "@getpaseo/plugin";
import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { hostHealth, pillText, workspaceHealth, type HealthStatus, type HealthVerdict } from "../shared/health";
import { HOSTS_SETTINGS_DEFAULTS, HostsSettingsSchema, SNAPSHOT_INTERVAL_DEFAULT, type HostsSettings } from "../shared/settings";
import type { WorkspaceTarget } from "../shared/workspace-filter";

/**
 * Composer pills for host health, one per live agent.
 *
 * The client entry polls the cached host verdict once per interval and decides
 * for every agent whether its workspace has anything worth a chip: a verified
 * dev server running inside it, or an issue that touches it. Only then does
 * the pill exist; a quiet workspace gets no chip at all. The pill component
 * itself just renders the latest verdict from a shared store.
 */

const ICONS: Record<HealthStatus, string> = { ok: "Server", warning: "TriangleAlert", critical: "CircleAlert", unknown: "Server" };

/** Latest verdict plus a change signal; every pill subscribes instead of calling RPC. */
class VerdictStore {
  verdict: HealthVerdict | null = null;
  private listeners = new Set<() => void>();
  set(verdict: HealthVerdict) { this.verdict = verdict; for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

function useVerdict(store: VerdictStore): HealthVerdict | null {
  const [verdict, setVerdict] = useState(store.verdict);
  useEffect(() => { setVerdict(store.verdict); return store.subscribe(() => setVerdict(store.verdict)); }, [store]);
  return verdict;
}

export function createHealthPill(store: VerdictStore) {
  return function HealthPill({ theme, workspaceId }: PluginComposerPillProps) {
    const target = useWorkspace(workspaceId, ({ directory, projectRootPath, name }) => ({ directory, projectRootPath, name }));
    const verdict = useVerdict(store);
    const health = target && verdict ? workspaceHealth(verdict, target) : null;
    const text = health ? pillText(health) : null;
    const color = health?.status === "critical" ? theme.colors.statusDanger : health?.status === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
    return (
      <>
        <Icon name={ICONS[health?.status ?? "unknown"]} size={14} color={color} />
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>{text ?? "Hosts"}</Text>
      </>
    );
  };
}

const hostsRead = settingsRpc("hosts").read;

/** Settings through the client RPC; anything unreadable falls back to defaults. */
async function readSettings(client: PluginClientContext): Promise<HostsSettings> {
  try {
    const result = await client.rpc(hostsRead, {});
    if (result.status !== "ready") return HOSTS_SETTINGS_DEFAULTS;
    const parsed = HostsSettingsSchema.safeParse(result.values);
    return parsed.success ? parsed.data : HOSTS_SETTINGS_DEFAULTS;
  } catch { return HOSTS_SETTINGS_DEFAULTS; }
}

/** Workspace directory and name from the SDK cache, fetching once when the handle is cold. */
async function workspaceTarget(client: PluginClientContext, workspaceId: string, cache: Map<string, WorkspaceTarget>): Promise<WorkspaceTarget | null> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  try {
    const handle = client.paseo.workspaces.ref(workspaceId);
    const workspace = handle.current() ?? await handle.refresh();
    const directory = workspace?.workspaceDirectory ?? handle.directory;
    if (!workspace || !directory) return null;
    const target = { directory, projectRootPath: workspace.projectRootPath, name: workspace.name };
    cache.set(workspaceId, target);
    return target;
  } catch { return null; }
}

/**
 * Track live agents, poll the cached verdict, and add or remove each agent's
 * pill as its workspace gains or loses something to report. Returns a cleanup
 * that stops polling, unsubscribes, and removes every pill.
 */
export function registerHealthPills(client: PluginClientContext): () => void {
  const store = new VerdictStore();
  const HealthPill = createHealthPill(store);
  const agents = new Map<string, string>();
  const pills = new Map<string, () => void>();
  const targets = new Map<string, WorkspaceTarget>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let polling = false;

  const removePill = (agentId: string) => { pills.get(agentId)?.(); pills.delete(agentId); };

  const reconcile = async (settings: HostsSettings) => {
    if (!settings.showComposerPill || !store.verdict) { for (const agentId of [...pills.keys()]) removePill(agentId); return; }
    for (const [agentId, workspaceId] of agents) {
      const target = await workspaceTarget(client, workspaceId, targets);
      if (closed) return;
      const wanted = target !== null && pillText(workspaceHealth(store.verdict, target)) !== null;
      if (wanted && !pills.has(agentId)) {
        pills.set(agentId, client.addComposerPill({
          id: "host-health", title: "Open Hosts for this workspace", workspaceId, agentId, Component: HealthPill,
          // The workspace panel is the landing spot: it shows exactly the servers, links, and issues the pill counted.
          onPress() { client.openPanel("daemon-link", { workspaceId }); },
        }));
      } else if (!wanted && pills.has(agentId)) removePill(agentId);
    }
  };

  const poll = async () => {
    if (polling || closed) return;
    polling = true;
    let settings = HOSTS_SETTINGS_DEFAULTS;
    try {
      settings = await readSettings(client);
      if (settings.showComposerPill && agents.size > 0) {
        try { store.set(await client.rpc(hostHealth, {})); }
        catch { /* The host is unreachable from here; keep the last verdict until it answers again. */ }
      }
      if (!closed) await reconcile(settings);
    } finally {
      polling = false;
      if (!closed) timer = setTimeout(() => { void poll(); }, (settings.snapshotIntervalSeconds || SNAPSHOT_INTERVAL_DEFAULT) * 1000);
    }
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") { agents.delete(update.agentId); removePill(update.agentId); return; }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    if (agents.get(agentId) === workspaceId) return;
    agents.set(agentId, workspaceId);
    removePill(agentId);
    // A new agent should not wait a full interval for its chip.
    if (timer) { clearTimeout(timer); timer = null; }
    void poll();
  });
  void poll();

  return () => {
    closed = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    for (const remove of pills.values()) remove();
    pills.clear();
  };
}
