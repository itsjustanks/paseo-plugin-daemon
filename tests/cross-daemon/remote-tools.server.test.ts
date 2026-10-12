// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { describe, expect, it } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";

import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createMessenger } from "../../server/cross-daemon/messenger.server";
import { makeTempDir } from "./temp-dir.test-support";
import { createTools } from "../../server/cross-daemon/tools.server";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";

const ownDaemon = async () => ({ name: "tower", serverId: "srv_tower" });

const mac: Peer = { serverId: "srv_mac", name: "mac", link: "https://app.paseo.sh/#offer=bWFj" };
const laptopA: Peer = { serverId: "srv_a", name: "laptop", link: "https://app.paseo.sh/#offer=YQ" };
const laptopB: Peer = { serverId: "srv_b", name: "laptop", link: "https://app.paseo.sh/#offer=Yg" };
const caller = { callerAgentId: "agent-1" };

function toolsWith(peers: Peer[], reply: (link: string, args: readonly string[]) => string | Error = () => "[]") {
  const calls: { link: string; args: string[] }[] = [];
  const tools = createTools({
    readPeers: () => peers,
    messenger: createMessenger({
      queue: createMessageQueue(makeTempDir("cd-queue-")),
      watches: createWatchList(makeTempDir("cd-watch-")),
      readPeers: () => peers,
      cli: { run: async () => "", runLocal: async () => "" },
    }),
    ownDaemon,
    cli: {
      async runLocal() {
        throw new Error("no local calls expected");
      },
      async run(link, args) {
        calls.push({ link, args: [...args] });
        const result = reply(link, args);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  });
  return { tools, calls };
}

describe("tools that reach another daemon", () => {
  it("lists another daemon's workspaces through its link", async () => {
    const { tools, calls } = toolsWith([mac], () => '[{"workspaceId":"wks_1","name":"Checkout"}]');
    const result = await tools.call("list_workspaces", { daemon: "mac" }, caller);
    expect(calls).toEqual([{ link: mac.link, args: ["workspace", "ls", "--json"] }]);
    expect(JSON.parse(result.text)).toEqual([{ workspaceId: "wks_1", name: "Checkout" }]);
  });

  it("lists every agent on another daemon, not only those in one folder", async () => {
    const { tools, calls } = toolsWith([mac]);
    await tools.call("list_agents", { daemon: "mac" }, caller);
    expect(calls[0].args).toEqual(["ls", "--global", "--json"]);
  });

  it("reads an agent's recent activity on another daemon", async () => {
    const { tools, calls } = toolsWith([mac], () => "[User] hi");
    const result = await tools.call("get_agent_activity", { daemon: "mac", agentId: "44c0eee", tail: 5 }, caller);
    expect(calls[0].args).toEqual(["logs", "44c0eee", "--tail", "5"]);
    expect(result.text).toBe("[User] hi");
  });

  it("finds a daemon by server ID as well as by name", async () => {
    const { tools, calls } = toolsWith([mac]);
    await tools.call("list_agents", { daemon: "srv_mac" }, caller);
    expect(calls[0].link).toBe(mac.link);
  });

  it("asks for a server ID when two daemons share a name", async () => {
    const { tools, calls } = toolsWith([laptopA, laptopB]);
    const result = await tools.call("list_agents", { daemon: "laptop" }, caller);
    expect(result).toEqual({ text: 'Two or more daemons are named "laptop". Use a server ID: srv_a, srv_b.', isError: true });
    expect(calls).toEqual([]);
  });

  it("refuses a daemon that is not a switched-on peer", async () => {
    const { tools, calls } = toolsWith([mac]);
    const result = await tools.call("list_agents", { daemon: "tower" }, caller);
    expect(result).toEqual({ text: 'No reachable daemon has the name or ID "tower". Reachable: mac (srv_mac).', isError: true });
    expect(calls).toEqual([]);
  });

  it("rejects an agent ID that the CLI could read as an option", async () => {
    const { tools, calls } = toolsWith([mac]);
    for (const agentId of ["--help", "-f"]) {
      const result = await tools.call("get_agent_activity", { daemon: "mac", agentId }, caller);
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("reports an unreachable daemon without revealing its link", async () => {
    const { tools } = toolsWith([mac], (link) => new Error(`Cannot connect to daemon at ${link}: Connection timed out`));
    const result = await tools.call("list_agents", { daemon: "mac" }, caller);
    expect(result).toEqual({
      text: "Could not reach mac: Cannot connect to daemon at [pairing link redacted]: Connection timed out",
      isError: true,
    });
  });

  it("does not blame the connection when the daemon answered with an error", async () => {
    const { tools } = toolsWith([mac], () => new Error("No agent found matching: abc"));
    const result = await tools.call("get_agent_activity", { daemon: "mac", agentId: "abc" }, caller);
    expect(result).toEqual({ text: "paseo on mac failed: No agent found matching: abc", isError: true });
  });
});
