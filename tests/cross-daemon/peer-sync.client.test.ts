// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createDaemonPort, type DaemonDescription, type DaemonPort, type PeerUpdate, syncPeers } from "../../client/cross-daemon/peer-sync.client";

function fakeDaemon(description: DaemonDescription | Error) {
  const received: PeerUpdate[] = [];
  const port: DaemonPort = {
    async describe() {
      if (description instanceof Error) throw description;
      return description;
    },
    async setPeers(update) {
      received.push(update);
    },
    listPeers: async () => [],
    status: async () => { if (description instanceof Error) throw description; return { serverId: description.serverId, switchedOn: description.switchedOn, available: true }; },
    setSwitch: async () => {},
  };
  return { port, received };
}

const peer = (name: string): Peer => ({ serverId: `srv_${name}`, name, link: `https://app.paseo.sh/#offer=${name}` });
const on = (name: string): DaemonDescription => ({ serverId: `srv_${name}`, switchedOn: true, member: peer(name) });
const off = (name: string): DaemonDescription => ({ serverId: `srv_${name}`, switchedOn: false, member: null });

describe("syncPeers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gives each switched-on daemon the other switched-on daemons", async () => {
    const tower = fakeDaemon(on("tower"));
    const mac = fakeDaemon(on("mac"));
    const laptop = fakeDaemon(on("laptop"));
    await syncPeers([tower.port, mac.port, laptop.port]);
    expect(tower.received[0].peers).toEqual([peer("mac"), peer("laptop")]);
    expect(mac.received[0].peers).toEqual([peer("tower"), peer("laptop")]);
  });

  it("leaves a switched-off daemon out of every list, and says it answered so its old link is dropped", async () => {
    const tower = fakeDaemon(on("tower"));
    const lonely = fakeDaemon(off("lonely"));
    await syncPeers([tower.port, lonely.port]);
    expect(tower.received).toEqual([{ peers: [], answeredServerIds: ["srv_tower", "srv_lonely"] }]);
    expect(lonely.received).toEqual([{ peers: [], answeredServerIds: ["srv_tower", "srv_lonely"] }]);
    expect(JSON.stringify(lonely.received)).not.toContain(peer("tower").link);
  });

  it("leaves out a daemon with no link, such as one with the relay off", async () => {
    const tower = fakeDaemon(on("tower"));
    const noRelay = fakeDaemon({ serverId: "srv_norelay", switchedOn: true, member: null });
    await syncPeers([tower.port, noRelay.port]);
    expect(tower.received).toEqual([{ peers: [], answeredServerIds: ["srv_tower", "srv_norelay"] }]);
  });

  it("does not count a daemon that failed to answer, so its peers keep its link", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tower = fakeDaemon(on("tower"));
    const asleep = fakeDaemon(new Error("Plugin host is offline"));
    await syncPeers([tower.port, asleep.port]);
    expect(tower.received).toEqual([{ peers: [], answeredServerIds: ["srv_tower"] }]);
    expect(asleep.received).toEqual([]);
  });

  it("reports a daemon that failed to answer instead of dropping the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncPeers([fakeDaemon(new Error("Plugin host is offline")).port]);
    expect(warn).toHaveBeenCalledWith("cross-daemon: a host did not answer the peer sync; details withheld");
  });
});

describe("createDaemonPort", () => {
  it("reports a switch that could not be saved instead of treating it as saved", async () => {
    const rpc = (async (contract: { name: string }) =>
      contract.name.endsWith(".read")
        ? { status: "ready", revision: "r1", values: { enabled: false } }
        : { status: "conflict", error: "the settings changed elsewhere" }) as unknown as PluginClientContext["rpc"];
    await expect(createDaemonPort(rpc).setSwitch(true, true)).rejects.toThrow("Could not save cross-daemon settings");
  });
});

it.each(["off", "unavailable", "identity", "failure", "generation"])("never dispatches credentials after recipient eligibility changes: %s", async (change) => {
  const source = fakeDaemon(on("source"));
  const target = fakeDaemon(on("target"));
  let generation = 0;
  target.port.generation = () => generation;
  target.port.status = async () => {
    if (change === "failure") throw new Error("private failure");
    if (change === "generation") generation++;
    return { serverId: change === "identity" ? "other" : "srv_target", switchedOn: change !== "off", available: change !== "unavailable" };
  };
  await syncPeers([source.port, target.port]);
  expect(target.received.every((update) => update.peers.length === 0)).toBe(true);
  expect(JSON.stringify(target.received)).not.toContain(peer("source").link);
  expect(JSON.stringify(source.received)).not.toContain(peer("target").link);
});

it("invalidates a sync as soon as a local off save starts, including failed saves", async () => {
  let release!: () => void;
  let reading = false;
  const updates: unknown[] = [];
  const target = createDaemonPort((async (contract: { name: string }, input: unknown) => {
    if (contract.name.endsWith("sync-offer")) return on("target");
    if (contract.name.endsWith("describe")) {
      reading = true;
      await new Promise<void>((resolve) => release = resolve);
      return { serverId: "srv_target", switchedOn: true, available: true };
    }
    if (contract.name.endsWith(".read")) return { status: "ready", revision: "r" };
    if (contract.name.endsWith(".write")) return { status: "conflict" };
    updates.push(input); return { stored: 0 };
  }) as PluginClientContext["rpc"]);
  const source = fakeDaemon(on("source"));
  const sync = syncPeers([source.port, target]);
  await vi.waitFor(() => expect(reading).toBe(true));
  await expect(target.setSwitch(false)).rejects.toThrow("Could not save");
  release(); await sync;
  expect(updates).toEqual([]);
  expect(source.received[0].peers).toEqual([]);
});
