// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { settingsRpc } from "@getpaseo/plugin";
import { crossDaemonSettings, describeDaemon, shareDaemon, listPeers, setPeers } from "../../shared/cross-daemon/cross-daemon.shared";
import { daemonRequest } from "./requests.client";

const switchSettings = settingsRpc(crossDaemonSettings.id);

export type DaemonDescription = z.output<typeof shareDaemon.output>;
export type PeerUpdate = z.input<typeof setPeers.input>;

export interface DaemonPort {
  generation?(): number;
  describe(): Promise<DaemonDescription>;
  status(): Promise<z.output<typeof describeDaemon.output>>;
  setPeers(update: PeerUpdate): Promise<void>;
  listPeers(): Promise<{ serverId: string; name: string }[]>;
  setSwitch(switchedOn: boolean, fullAuthorityConfirmed?: boolean): Promise<void>;
}

export function createDaemonPort(rpc: PluginClientContext["rpc"]): DaemonPort {
  let generation = 0;
  return {
    generation: () => generation,
    describe: () => rpc(shareDaemon, {}),
    status: () => rpc(describeDaemon, {}),
    setPeers: async (update) => {
      await rpc(setPeers, update);
    },
    listPeers: async () => (await rpc(listPeers, {})).peers,
    setSwitch: async (switchedOn, fullAuthorityConfirmed = false) => {
      if (switchedOn && !fullAuthorityConfirmed) throw new Error("Confirm full daemon authority before enabling cross-daemon");
      generation++; // Invalidate synchronizations before the settings write starts.
      const current = await rpc(switchSettings.read, {}).catch(() => { throw new Error("Could not read cross-daemon settings"); });
      if (current.status !== "ready") throw new Error("Could not read cross-daemon settings. Reload before changing them.");
      const values: z.input<typeof crossDaemonSettings.schema> = { enabled: switchedOn, fullAuthorityConfirmed: switchedOn && fullAuthorityConfirmed };
      const saved = await rpc(switchSettings.write, { values, revision: current.revision }).catch(() => { throw new Error("Could not save cross-daemon settings"); });
      if (saved.status !== "saved") throw new Error("Could not save cross-daemon settings. Reload and try again.");
    },
  };
}

export async function syncPeers(ports: readonly DaemonPort[], isCurrent: (port: DaemonPort) => boolean = () => true): Promise<void> {
  const epochs = new Map(ports.map((port) => [port, port.generation?.()]));
  const current = (port: DaemonPort) => isCurrent(port) && epochs.get(port) === port.generation?.();
  const results = await Promise.allSettled(ports.map((port) => daemonRequest(port, "describe", () => port.describe())));
  const answered = results.flatMap((result, index) => {
    if (!current(ports[index])) return [];
    if (result.status === "fulfilled") return [{ port: ports[index], daemon: result.value }];
    console.warn("cross-daemon: a host did not answer the peer sync; details withheld");
    return [];
  });
  // Recheck opt-in using the credential-free status RPC before preparing any delivery.
  const eligibility = await Promise.allSettled(answered.map(async ({ port, daemon }) => {
    if (!current(port)) return "unknown";
    if (!daemon.switchedOn) return "off";
    // Separate read lane from the UI: an ordinary refresh is not a refusal of authority.
    const status = await daemonRequest(port, "authority", () => port.status());
    if (!current(port) || !status.available || status.serverId !== daemon.serverId) return "unknown";
    return status.switchedOn ? "on" : "off";
  }));
  const state = (index: number) => {
    const result = eligibility[index];
    return result.status === "fulfilled" && current(answered[index].port) ? result.value : "unknown";
  };
  const eligible = (index: number) => state(index) === "on";
  // Unknown is not switched off: keep its stored links and do not write to that recipient.
  const answeredServerIds = answered.flatMap(({ daemon }, index) => state(index) === "unknown" ? [] : [daemon.serverId]);
  const deliveries = await Promise.allSettled(answered.map(({ port, daemon }, index) => {
    if (state(index) === "unknown") return Promise.resolve();
    // An off or unavailable recipient sees only an empty list, never another host's credential.
    const peers = eligible(index) ? answered.flatMap((source, sourceIndex) =>
      eligible(sourceIndex) && source.daemon.member && source.daemon.serverId !== daemon.serverId ? [source.daemon.member] : []) : [];
    return daemonRequest(port, "setPeers", () => port.setPeers({ peers, answeredServerIds }));
  }));
  for (const delivery of deliveries) {
    if (delivery.status === "rejected") console.warn("cross-daemon: a host rejected its peer list; details withheld");
  }
}
