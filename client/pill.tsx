import { type PluginClientContext, type PluginComposerPillProps, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { settingsRpc } from "@getpaseo/plugin";
import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import { hostHealth, pillText, workspaceHealth, type HealthStatus, type HealthVerdict } from "../shared/health";
import { canObserveAgents, supportsButtonPills } from "../shared/host-features";
import { createPillRegistry, type PillAgent } from "../shared/pills";
import { HOSTS_SETTINGS_DEFAULTS, HostsSettingsSchema, type HostsSettings } from "../shared/settings";
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

const OBSERVE_RETRY_MIN_MS = 2_000;
const OBSERVE_RETRY_MAX_MS = 60_000;

type PillButtonsClient = {
  addComposerPill(contribution: {
    id: string;
    workspaceId: string;
    agentId: string;
    button: { title: string; icon: string; label?: string; behavior: { kind: "action"; onPress(): void } };
  }): { update(patch: { label?: string; icon?: string }): void; remove(): void };
};
type AgentLike = { id?: string; workspaceId?: string | null };
type AgentListLike = { entries: Array<{ agent: AgentLike }> };
type AgentUpdateLike = { kind: string; agentId?: string; agent?: AgentLike };
type AgentObservation = {
  subscribe(observer: { snapshot(list: AgentListLike): void; update(message: { type: string; payload?: unknown }): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};
const pillAgent = (agent: AgentLike | undefined): PillAgent | null => (agent?.id && agent.workspaceId ? { id: agent.id, workspaceId: agent.workspaceId } : null);

/**
 * One Hosts chip per live agent whose workspace has something to report.
 * The registry (shared/pills.ts) decides which chips exist and what they
 * say; this wires it to the app.
 *
 * 0.10.0: Paseo 0.8.0 stable and later take a chip as a button, and the old
 * component shape threw on add, so the chip never showed on 0.9 or 0.11
 * apps. And since 0.9, `agents.subscribe()` only hears an observation the
 * plugin opened itself, so new agents got no chip either. Both are chosen at
 * runtime; a 0.8.0-beta.1 app keeps the old component and the old listener.
 */
export function registerHealthPills(client: PluginClientContext): () => void {
  const buttons = supportsButtonPills(client);
  const store = new VerdictStore();
  const HealthPill = createHealthPill(store);
  const targets = new Map<string, WorkspaceTarget>();
  const registry = createPillRegistry({
    addPill(agent, face) {
      // The workspace panel is the landing spot: it shows exactly the servers, links, and issues the chip counted.
      const onPress = () => client.openPanel("daemon-link", { workspaceId: agent.workspaceId });
      if (buttons) {
        const registration = (client as unknown as PillButtonsClient).addComposerPill({
          id: "host-health", workspaceId: agent.workspaceId, agentId: agent.id,
          button: { title: "Open Hosts for this workspace", icon: face.icon, label: face.label, behavior: { kind: "action", onPress } },
        });
        return { update: (next) => registration.update({ label: next.label, icon: next.icon }), remove: () => registration.remove() };
      }
      const remove = client.addComposerPill({ id: "host-health", title: "Open Hosts for this workspace", workspaceId: agent.workspaceId, agentId: agent.id, Component: HealthPill, onPress });
      return { update: () => undefined, remove };
    },
    readSettings: () => readSettings(client),
    readVerdict: () => client.rpc(hostHealth, {}),
    target: (workspaceId) => workspaceTarget(client, workspaceId, targets),
    publish: (verdict) => store.set(verdict),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  const onUpdate = (update: AgentUpdateLike) => {
    if (update.kind === "remove" && update.agentId) { registry.remove(update.agentId); return; }
    if (update.kind !== "upsert") return;
    const agent = pillAgent(update.agent);
    if (agent) registry.upsert(agent);
  };
  const stopFollowing = canObserveAgents(client.paseo)
    ? observeAgents(client, (agents) => registry.replaceAll(agents), onUpdate)
    : client.paseo.agents.subscribe((update) => onUpdate(update as unknown as AgentUpdateLike));
  registry.start();
  return () => {
    stopFollowing();
    registry.stop();
  };
}

/**
 * Paseo 0.9 and later: keep an agent observation open for the plugin's
 * lifetime. The snapshot replaces what is known (first, and after every
 * reconnect), updates apply in between, and an observation the app drops is
 * reopened with backoff. The approach of paseo-mcp 0.18.1.
 */
function observeAgents(client: PluginClientContext, replaceAll: (agents: PillAgent[]) => void, onUpdate: (update: AgentUpdateLike) => void): () => void {
  const lifetime = new AbortController();
  let observation: AgentObservation | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = OBSERVE_RETRY_MIN_MS;
  const fromList = (list: AgentListLike) => list.entries.map((entry) => pillAgent(entry.agent)).filter((agent): agent is PillAgent => agent !== null);
  const reopen = () => {
    observation = null;
    if (lifetime.signal.aborted || retry !== null) return;
    retry = setTimeout(() => { retry = null; open(); }, delay);
    delay = Math.min(delay * 2, OBSERVE_RETRY_MAX_MS);
  };
  const open = () => {
    (client.paseo.agents as unknown as { list(options: { subscribe: object; signal: AbortSignal }): Promise<AgentListLike & { subscription?: AgentObservation }> })
      .list({ subscribe: {}, signal: lifetime.signal })
      .then((result) => {
        if (lifetime.signal.aborted) { void result.subscription?.release().catch(() => undefined); return; }
        replaceAll(fromList(result));
        const subscription = result.subscription;
        if (!subscription) throw new Error("the app returned no agent observation");
        observation = subscription;
        subscription.subscribe({
          snapshot(list) { delay = OBSERVE_RETRY_MIN_MS; replaceAll(fromList(list)); },
          update(message) { if (message.type === "agent_update") onUpdate(message.payload as AgentUpdateLike); },
          error: reopen,
        });
      })
      .catch(reopen);
  };
  open();
  return () => {
    lifetime.abort();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    void observation?.release().catch(() => undefined);
    observation = null;
  };
}
