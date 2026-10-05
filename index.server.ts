import * as sync from "./shared/sync";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./shared/contracts";
import * as rpc from "./shared/link";
import * as peer from "./shared/peers";
import { createRuntime } from "./server/runtime";
import { installCloudflared } from "./server/binaries";
import { HOSTS_SETTINGS_DEFAULTS, HostsSettingsSchema, hostsSettings, type HostsSettings } from "./shared/settings";
import { hostHealth } from "./shared/health";
import { processLog, processPreview, processReport, processStop } from "./shared/processes";
import { hostSummary, summarize } from "./shared/summary";
import { watchSuggestions } from "./shared/watch";
import { readHostsSettings, registerHooks } from "./server/hooks";
import { HealthChecker } from "./server/health";
import { summaryWriter } from "./server/summary-file";
import { suggestions } from "./server/watch";

type SettingsHandle = { read?: () => Promise<{ status: string; values?: unknown }>; subscribe?: (listener: () => void) => () => void } | undefined;

/**
 * Settings straight from the daemon on Paseo 0.10+ (`registerSettings`
 * returns `{ read, subscribe }`); older daemons return nothing, so the
 * stored file is read instead, exactly as 0.9 did.
 */
function settingsReader(handle: SettingsHandle): () => Promise<HostsSettings> {
  if (typeof handle?.read !== "function") return () => readHostsSettings();
  return async () => {
    const state = await handle.read!();
    if (state.status !== "ready") return { ...HOSTS_SETTINGS_DEFAULTS, closeTunnelsOnArchive: false };
    const parsed = HostsSettingsSchema.safeParse(state.values);
    return parsed.success ? parsed.data : { ...HOSTS_SETTINGS_DEFAULTS, closeTunnelsOnArchive: false };
  };
}

export default function contribute(server: PluginServerContext) {
  const handle = server.registerSettings(hostsSettings) as SettingsHandle;
  const readSettings = settingsReader(handle);
  const runtime = createRuntime({ readSettings });
  const removeHooks = registerHooks(server, runtime, readSettings);
  // One cached verdict per host; pills and panels read it instead of probing.
  const health = new HealthChecker({ runtime, readSettings, onVerdict: summaryWriter() });
  // 0.10+: a settings change (say, a new watched service) is checked at once, not on the next tick.
  const unsubscribe = typeof handle?.subscribe === "function" ? handle.subscribe(() => { if (health.current()) void health.check(undefined, true).catch(() => undefined); }) : () => {};
  server.handle(hostHealth, (input, context) => runtime.withContext(context, () => health.read(context, input.refresh === true)));
  server.handle(hostSummary, async (_input, context) => summarize(await runtime.withContext(context, () => health.read(context))));
  server.handle(processReport, (input, context) => runtime.withContext(context, () => runtime.processes.report(input)));
  server.handle(processPreview, ({ tokens }, context) => runtime.withContext(context, () => runtime.processes.preview(tokens)));
  server.handle(processStop, ({ tokens }, context) => runtime.withContext(context, () => runtime.processes.stop(tokens)));
  server.handle(processLog, async ({ limit }) => ({ entries: await runtime.log.recent(limit) }));
  server.handle(watchSuggestions, async () => ({ suggestions: await suggestions((await readSettings().catch(() => HOSTS_SETTINGS_DEFAULTS)).watchedServices) }));
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
  return async () => { removeHooks(); unsubscribe(); health.close(); runtime.processes.close(); await Promise.all([runtime.links.close(), runtime.peers.close(), runtime.transfers.close()]); };
}
