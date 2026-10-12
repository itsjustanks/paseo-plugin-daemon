// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { crossDaemonSettings, describeDaemon, shareDaemon, listPeers, type Peer, peerSchema, setPeers } from "../../shared/cross-daemon/cross-daemon.shared";
import { safeCrossDaemonText } from "../../shared/cross-daemon/privacy";
import { createCliLimiter } from "./cli-limiter.server";
import { acquireRuntimeOwner } from "./runtime-owner.server";
import { resolveToolProvider, withCrossDaemonTools } from "./agent-injection.server";
import type { PaseoCli } from "./paseo-cli.server";
import { createMessenger, startDeliveryWorker } from "./messenger.server";
import { createMessageQueue } from "./message-queue.server";
import { createPeerStore } from "./peer-store.server";
import { createWatchList } from "./watch-list.server";
import { isSwitchedOn, peersToStore, type CrossDaemonSettingsState } from "./switch-policy.server";
import { installToolProxy } from "./tool-proxy.server";
import { serveTools } from "./tool-socket.server";
import { createTools, type DaemonIdentity } from "./tools.server";

export interface CrossDaemonDependencies {
  readOwnPeer(relayEnabled: boolean): Promise<Peer | null>;
  stateDir: Promise<string> | (() => Promise<string>);
  cli: PaseoCli;
  ownDaemon(): Promise<DaemonIdentity>;
}

type SettingsHandle = { read(): Promise<CrossDaemonSettingsState>; subscribe(listener: () => Promise<void>): () => void };

/** No dependency on Hosts peers, application grants, file grants, or Hosts settings. */
export function registerCrossDaemon(server: PluginServerContext, deps: CrossDaemonDependencies) {
  let stopped = false;
  let authority = false;
  let generation = 0;
  let effects = new AbortController();
  const candidate = server.registerSettings(crossDaemonSettings) as unknown as SettingsHandle | undefined;
  const settings = candidate && typeof candidate.read === "function" && typeof candidate.subscribe === "function" && typeof server.before === "function" ? candidate : null;
  if (!settings) {
    // 0.9.0 lacks the documented settings handle. A harness without before also lands here.
    // No hooks are invented, adapters loaded, files touched, or tool server started.
    server.handle(describeDaemon, async () => ({ serverId: "", switchedOn: false, available: false }));
    server.handle(shareDaemon, async () => { throw new Error("Cross-daemon requires settings read/subscribe and agent.create before hooks"); });
    server.handle(setPeers, async () => ({ stored: 0 }));
    server.handle(listPeers, async () => ({ peers: [] }));
    return async () => { stopped = true; };
  }
  const stateDir = typeof deps.stateDir === "function" ? deps.stateDir() : deps.stateDir;
  let releaseOwner: (() => void) | null = null;
  const ownedDir = stateDir.then((dir) => {
    if (stopped) return null;
    releaseOwner = acquireRuntimeOwner(dir);
    return releaseOwner ? dir : null;
  });
  const enabled = async () => {
    if (stopped || !settings) return false;
    try { if (!await ownedDir || stopped) return false; } catch { return false; }
    try {
      const epoch = generation;
      const state = await settings.read();
      if (epoch !== generation || stopped) return false;
      authority = isSwitchedOn(state);
      return authority;
    }
    catch { authority = false; return false; }
  };
  const peerStore = ownedDir.then((dir) => dir && !stopped ? createPeerStore(dir) : null);
  const transport = createCliLimiter(4);
  // Recheck authority for every effect, including queued notices and work already awaiting inspection.
  const requireEnabled = async () => { if (!await enabled()) throw new Error("Cross-daemon is off or unavailable"); };
  const cli: PaseoCli = {
    async run(link, args, options) {
      const signal = effects.signal;
      return transport.run(async () => {
        const peers = await peerStore;
        await requireEnabled();
        if (signal.aborted) throw new Error("Cross-daemon transport cancelled");
        if (!peers || !peers.read().some((peer) => peer.link === link)) throw new Error("Cross-daemon peer is no longer shared");
        return deps.cli.run(link, args, { ...options, signal });
      }, signal);
    },
    async runLocal(args, options) {
      const signal = effects.signal;
      return transport.run(async () => {
        await requireEnabled();
        if (signal.aborted) throw new Error("Cross-daemon transport cancelled");
        return deps.cli.runLocal(args, { ...options, signal });
      }, signal);
    },
  };
  let failedStartupCleanup = Promise.resolve();
  const toolServer = Promise.all([ownedDir, peerStore]).then(([dir, peers]) => {
    if (stopped || !settings || !dir || !peers) return null;
    const queue = createMessageQueue(dir);
    const watches = createWatchList(dir);
    const readPeers = () => peers.read();
    const messenger = createMessenger({ queue, watches, readPeers, cli, isActive: () => !stopped && authority });
    const tools = createTools({ readPeers, cli, messenger, ownDaemon: deps.ownDaemon });
    const gatedTools = { ...tools, async call(...args: Parameters<typeof tools.call>) {
      if (!await enabled()) return { text: "Cross-daemon is off or unavailable. No operation was performed.", isError: true };
      return tools.call(...args);
    } };
    const socketPath = join(dir, "tools.sock");
    const stopServing = serveTools(socketPath, gatedTools);
    const stopDelivering = startDeliveryWorker({ ...messenger, async runRound() { if (await enabled()) await messenger.runRound(); } }, 15_000);
    const stop = async () => { stopDelivering(); await stopServing(); };
    try {
      const proxyPath = installToolProxy(dir, { socketPath, tools: tools.definitions });
      return { ready: stopServing.ready, launch: { command: process.execPath, proxyPath }, toolNames: tools.definitions.map((tool) => tool.name), stop, clear() { peers.write([]); queue.clear(); watches.clear(); } };
    } catch { failedStartupCleanup = stop(); void failedStartupCleanup.catch(() => {}); throw new Error("Cross-daemon tools unavailable"); }
  });
  void toolServer.catch(() => { console.error("cross-daemon: tool server did not start; details withheld"); });

  const clearUnlessEnabled = async () => {
    if (await enabled()) return;
    const peers = await peerStore;
    const tools = await toolServer;
    if (stopped || !peers) return;
    peers.write([]);
    tools?.clear();
  };
  const removeHook = server.before("agent.create", async ({ request }, context) => {
    try {
      if (!await enabled() || context.signal.aborted) return request;
      const tools = await toolServer;
      if (!tools) return request;
      await tools.ready;
      if (!await enabled() || context.signal.aborted) return request;
      let rootProvider = resolveToolProvider(request.config.provider);
      if (!rootProvider) {
        const { config } = await context.paseo.config.get();
        rootProvider = resolveToolProvider(request.config.provider, config.providers);
        if (!await enabled() || context.signal.aborted) return request;
      }
      return { ...request, config: withCrossDaemonTools(request.config, tools.launch, tools.toolNames, rootProvider) };
    } catch { return request; }
  });

  server.handle(describeDaemon, async () => {
    try {
      if (!await ownedDir || stopped) return { serverId: "", switchedOn: false, available: false };
      const identity = await deps.ownDaemon().catch(() => { throw new Error("Cross-daemon identity unavailable"); });
      let available = false;
      try { const tools = await toolServer; if (tools) { await tools.ready; available = !stopped; } } catch { /* Truthful unavailable status. */ }
      return { serverId: safeCrossDaemonText(identity.serverId), switchedOn: await enabled(), available };
    } catch { throw new Error("Cross-daemon identity unavailable; details withheld"); }
  });
  server.handle(shareDaemon, async (_input, { paseo }) => {
    if (!await ownedDir || stopped) return { serverId: "", switchedOn: false, member: null };
    const identity = await deps.ownDaemon().catch(() => { throw new Error("Cross-daemon identity unavailable"); });
    if (!await enabled()) return { serverId: identity.serverId, switchedOn: false, member: null };
    const { config } = await paseo.config.get().catch(() => { throw new Error("Cross-daemon relay configuration unavailable"); });
    const own = config.relay?.enabled === true ? await deps.readOwnPeer(true).catch(() => { throw new Error("Cross-daemon pairing offer unavailable"); }) : null;
    const switchedOn = await enabled();
    return { serverId: safeCrossDaemonText(identity.serverId), switchedOn, member: switchedOn && own ? validatedOwnPeer(own) : null };
  });
  server.handle(setPeers, async (input) => {
    const peers = await peerStore;
    if (!peers || stopped) return { stored: 0 };
    const identity = await deps.ownDaemon().catch(() => { throw new Error("Cross-daemon identity unavailable"); });
    const switchedOn = await enabled();
    if (stopped) return { stored: 0 };
    const next = peersToStore({ switchedOn, ownServerId: identity.serverId, stored: peers.read(), ...input });
    peers.write(next);
    return { stored: next.length };
  });
  server.handle(listPeers, async () => ({ peers: await enabled() ? (await peerStore)?.read().map(({ serverId, name }) => ({ serverId: safeCrossDaemonText(serverId), name: safeCrossDaemonText(name) })) ?? [] : [] }));
  void clearUnlessEnabled().catch(() => console.error("cross-daemon: private state could not be cleared"));
  const unsubscribe = settings?.subscribe(async () => {
    // Abort children before awaiting any reads. A remote accepted send remains uncertain.
    generation++;
    authority = false;
    effects.abort();
    effects = new AbortController();
    await clearUnlessEnabled();
  });
  return async () => {
    // Synchronous tombstone first. Outstanding awaits must not issue new CLI calls after unload.
    if (stopped) return;
    stopped = true;
    generation++;
    authority = false;
    effects.abort();
    transport.close();
    removeHook?.();
    unsubscribe?.();
    // Keep the lock if cleanup fails: another runtime must not take over a live endpoint.
    try {
      const tools = await toolServer.catch(() => null);
      await tools?.stop();
      await failedStartupCleanup;
      await ownedDir;
      releaseOwner?.();
    } catch { /* Failed closed; ownership is deliberately retained. */ }
  };
}

function validatedOwnPeer(own: Peer): Peer {
  const parsed = peerSchema.safeParse(own);
  if (!parsed.success) throw new Error("Cross-daemon pairing offer unavailable");
  return { ...parsed.data, name: safeCrossDaemonText(parsed.data.name) };
}
