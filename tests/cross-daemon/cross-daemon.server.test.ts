// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import { registerCrossDaemon } from "../../server/cross-daemon/cross-daemon.server";
import { makeTempDir } from "./temp-dir.test-support";

const tower: Peer = { serverId: "srv_tower", name: "tower", link: "https://app.paseo.sh/#offer=dG93ZXI" };
const mac: Peer = { serverId: "srv_mac", name: "mac", link: "https://app.paseo.sh/#offer=bWFj" };

type State = { status: string; revision: string; values?: unknown; error?: string };
const on: State = { status: "ready", revision: "r1", values: { enabled: true, fullAuthorityConfirmed: true } };
const off: State = { status: "ready", revision: "r2", values: { enabled: false } };
const invalid: State = { status: "invalid", revision: "r3", error: "schema version 9 is newer" };

function startPlugin(initial: State, stored: Peer[] = [], stateDirOverride?: Promise<string>, relayEnabled = true) {
  const stateDir = join(makeTempDir("cd-"), "hosts-cross-daemon");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "peers.json"), JSON.stringify(stored));
  let state = initial;
  const listeners = new Set<(next: State) => void>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const hooks = new Map<string, (input: { request: unknown }, ctx: unknown) => unknown>();
  const context = { paseo: { config: { get: async () => ({ config: { relay: { enabled: relayEnabled } } }) } } as unknown as PaseoApi };
  const server = {
    registerSettings: () => ({
      read: async () => state,
      subscribe: (listener: (next: State) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    handle: (contract: { name: string }, handler: (input: unknown, ctx: unknown) => unknown) =>
      handlers.set(contract.name, (input) => handler(input, context)),
    registerProvider: () => {},
    on: () => () => {},
    before: (name: string, hook: (input: { request: unknown }, ctx: unknown) => unknown) => hooks.set(name, hook),
  } as unknown as PluginServerContext;
  const dispose = registerCrossDaemon(server, { readOwnPeer: async (relayOn: boolean) => (relayOn ? tower : null), stateDir: stateDirOverride ?? Promise.resolve(stateDir),
    cli: { run: async () => "[]", runLocal: async () => "[]" },
    ownDaemon: async () => ({ name: "tower", serverId: "srv_tower" }),
  });
  stops.push(async () => {
    await dispose().catch(() => {});
  });
  return {
    storedPeers: () => JSON.parse(readFileSync(join(stateDir, "peers.json"), "utf8")),
    call: async (name: string, input: unknown = {}) => handlers.get(name)!(input),
    switchTo: async (next: State) => {
      state = next;
      await Promise.all([...listeners].map((listener) => listener(next)));
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
    createAgent: async (config: object) => hooks.get("agent.create")!({ request: { config } }, { signal: new AbortController().signal }),
    stateDir,
  };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

describe("cross-daemon switch", () => {
  it("clears peers left from before a restart when the daemon starts switched off", async () => {
    const plugin = startPlugin(off, [mac]);
    await plugin.settle();
    expect(plugin.storedPeers()).toEqual([]);
  });

  it("treats unreadable settings as switched off and clears peers", async () => {
    const plugin = startPlugin(invalid, [mac]);
    await plugin.settle();
    expect(plugin.storedPeers()).toEqual([]);
  });

  it("keeps peers across a restart while switched on", async () => {
    const plugin = startPlugin(on, [mac]);
    await plugin.settle();
    expect(plugin.storedPeers()).toEqual([mac]);
  });

  it("clears peers the moment the daemon is switched off", async () => {
    const plugin = startPlugin(on, [mac]);
    await plugin.switchTo(off);
    await plugin.settle();
    expect(plugin.storedPeers()).toEqual([]);
  });

  it("shares this daemon's link only while switched on", async () => {
    const plugin = startPlugin(on);
    await expect(plugin.call("hosts-cross-daemon.sync-offer")).resolves.toEqual({ serverId: "srv_tower", switchedOn: true, member: tower });
    await plugin.switchTo(off);
    await expect(plugin.call("hosts-cross-daemon.sync-offer")).resolves.toEqual({ serverId: "srv_tower", switchedOn: false, member: null });
  });

  it("stores the other daemons it is given while switched on, but never itself", async () => {
    const plugin = startPlugin(on);
    await expect(
      plugin.call("hosts-cross-daemon.set-peers", { peers: [tower, mac], answeredServerIds: ["srv_tower", "srv_mac"] }),
    ).resolves.toEqual({ stored: 1 });
    expect(plugin.storedPeers()).toEqual([mac]);
  });

  it("keeps a stored peer that did not answer this sync, such as a sleeping Mac", async () => {
    const plugin = startPlugin(on, [mac]);
    await plugin.call("hosts-cross-daemon.set-peers", { peers: [], answeredServerIds: ["srv_tower"] });
    expect(plugin.storedPeers()).toEqual([mac]);
  });

  it("drops a stored peer that answered switched off", async () => {
    const plugin = startPlugin(on, [mac]);
    await plugin.call("hosts-cross-daemon.set-peers", { peers: [], answeredServerIds: ["srv_tower", "srv_mac"] });
    expect(plugin.storedPeers()).toEqual([]);
  });

  it("replaces a stored peer's link with the one it just gave", async () => {
    const renewed = { ...mac, link: "https://app.paseo.sh/#offer=bmV3" };
    const plugin = startPlugin(on, [mac]);
    await plugin.call("hosts-cross-daemon.set-peers", { peers: [renewed], answeredServerIds: ["srv_mac"] });
    expect(plugin.storedPeers()).toEqual([renewed]);
  });

  it("lists its peers by name and server ID, never by link", async () => {
    const plugin = startPlugin(on, [mac]);
    await expect(plugin.call("hosts-cross-daemon.list-peers")).resolves.toEqual({ peers: [{ serverId: "srv_mac", name: "mac" }] });
  });

  it("still reports its server ID when its relay is off, so the app can match it to a host", async () => {
    const plugin = startPlugin(on, [], undefined, false);
    await expect(plugin.call("hosts-cross-daemon.sync-offer")).resolves.toEqual({ serverId: "srv_tower", switchedOn: true, member: null });
  });

  it("stores no peers while switched off", async () => {
    const plugin = startPlugin(off);
    await expect(plugin.call("hosts-cross-daemon.set-peers", { peers: [mac], answeredServerIds: ["srv_mac"] })).resolves.toEqual({ stored: 0 });
    expect(plugin.storedPeers()).toEqual([]);
  });
});

describe("agent tools", () => {
  it("gives opted-in new agents the cross-daemon tool server, reaching this plugin's socket", async () => {
    const plugin = startPlugin(on);
    const created = await plugin.createAgent({ provider: "claude", cwd: "/repo" });
    expect(created).toMatchObject({
      config: {
        mcpServers: {
          "hosts-cross-daemon": {
            command: process.execPath,
            args: [join(plugin.stateDir, "tool-proxy.cjs")],
          },
        },
      },
    });
  });

  it("still creates agents, without the tools, when the tool server cannot start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = startPlugin(off, [], Promise.reject(new Error("disk full")));
    const request = { config: { provider: "claude", cwd: "/repo" } };
    await expect(plugin.createAgent(request.config)).resolves.toEqual(request);
  });
});
