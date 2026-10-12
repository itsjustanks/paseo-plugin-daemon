// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.

import { describe, expect, it } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createMessenger } from "../../server/cross-daemon/messenger.server";
import type { PaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { makeTempDir } from "./temp-dir.test-support";
import { createTools } from "../../server/cross-daemon/tools.server";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";

const mac: Peer = { serverId: "srv_mac", name: "mac", link: "https://app.paseo.sh/#offer=bWFj" };

type Where = "mac" | "local";
interface FakeAgent {
  status: string;
  updatedAt: string;
  lastText: string;
}

// Agents on the remote daemon and on this one, driven through the same commands the CLI offers.
function fakeDaemons() {
  const agents = new Map<string, FakeAgent>();
  const delivered: { where: Where; agentId: string; text: string }[] = [];
  let startTurnOnSend = true;
  const handle = async (where: Where, args: readonly string[], promptText?: string) => {
    const [command, agentId] = args;
    const agent = agents.get(`${where}/${agentId}`);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (command === "inspect") return JSON.stringify({ Id: agentId, Status: agent.status, UpdatedAt: agent.updatedAt });
    if (command === "logs") return agent.lastText;
    if (command === "send") {
      delivered.push({ where, agentId, text: promptText ?? "" });
      if (startTurnOnSend) Object.assign(agent, { status: "running", updatedAt: new Date().toISOString() });
      return "{}";
    }
    throw new Error(`unexpected command ${command}`);
  };
  const cli: PaseoCli = {
    run: (link, args, options) => handle(link === mac.link ? "mac" : (() => { throw new Error("unknown link"); })(), args, options?.promptText),
    runLocal: (args, options) => handle("local", args, options?.promptText),
  };
  const put = (where: Where, agentId: string, status: string) =>
    agents.set(`${where}/${agentId}`, { status, updatedAt: "2020-01-01T00:00:00.000Z", lastText: "" });
  const finish = (where: Where, agentId: string, lastText: string) =>
    Object.assign(agents.get(`${where}/${agentId}`)!, { status: "idle", updatedAt: new Date().toISOString(), lastText });
  const setStatus = (where: Where, agentId: string, status: string) => Object.assign(agents.get(`${where}/${agentId}`)!, { status });
  return {
    cli,
    delivered,
    put,
    finish,
    setStatus,
    holdTurnsAfterSend: () => {
      startTurnOnSend = false;
    },
  };
}

function setup() {
  const daemons = fakeDaemons();
  const dir = makeTempDir("cd-notify-");
  const queue = createMessageQueue(dir);
  const watches = createWatchList(dir);
  const readPeers = () => [mac];
  const messenger = createMessenger({ queue, watches, readPeers, cli: daemons.cli });
  const tools = createTools({ readPeers, cli: daemons.cli, messenger, ownDaemon: async () => ({ name: "tower", serverId: "srv_tower" }) });
  const send = (agentId: string, input: object = {}, callerAgentId: string | null = "caller-1") =>
    tools.call("send_agent_prompt", { daemon: "mac", agentId, prompt: "Run the tests.", ...input }, { callerAgentId });
  const tick = () => messenger.runRound();
  const noticesTo = (agentId: string) => daemons.delivered.filter((entry) => entry.where === "local" && entry.agentId === agentId);
  return { ...daemons, queue, watches, send, tick, noticesTo };
}

describe("notify on finish", () => {
  it("tells the sender when the agent finishes, with its last message", async () => {
    const t = setup();
    t.put("mac", "a1", "idle");
    t.put("local", "caller-1", "idle");
    expect((await t.send("a1")).text).toBe("Sent to agent a1 on mac. You will be told when it finishes.");
    await t.tick();
    expect(t.noticesTo("caller-1")).toEqual([]);
    t.finish("mac", "a1", "All 42 tests pass.");
    await t.tick();
    expect(t.noticesTo("caller-1")).toHaveLength(1);
    expect(t.noticesTo("caller-1")[0].text).toContain('Agent a1 on daemon "mac" (srv_mac) finished');
    expect(t.noticesTo("caller-1")[0].text).toContain("All 42 tests pass.");
    expect(t.watches.list()).toEqual([]);
  });

  it("waits until the sender is idle before telling it, so the notice never interrupts the sender's work", async () => {
    const t = setup();
    t.put("mac", "a1", "idle");
    t.put("local", "caller-1", "running");
    await t.send("a1");
    t.finish("mac", "a1", "Done.");
    await t.tick();
    expect(t.noticesTo("caller-1")).toEqual([]);
    t.setStatus("local", "caller-1", "idle");
    await t.tick();
    expect(t.noticesTo("caller-1")).toHaveLength(1);
  });

  it("does not count an agent as finished before its turn has started", async () => {
    const t = setup();
    t.put("mac", "a1", "idle");
    t.put("local", "caller-1", "idle");
    t.holdTurnsAfterSend();
    await t.send("a1");
    await t.tick();
    expect(t.noticesTo("caller-1")).toEqual([]);
    expect(t.watches.list()).toHaveLength(1);
  });

  it("watches a queued message only once it is delivered", async () => {
    const t = setup();
    t.put("mac", "a1", "running");
    t.put("local", "caller-1", "idle");
    await t.send("a1");
    expect(t.watches.list()).toEqual([]);
    t.finish("mac", "a1", "Finished its own task.");
    await t.tick();
    expect(t.watches.list()).toHaveLength(1);
    expect(t.noticesTo("caller-1")).toEqual([]);
    t.finish("mac", "a1", "Ran the tests.");
    await t.tick();
    expect(t.noticesTo("caller-1")[0].text).toContain("Ran the tests.");
  });

  it("sends no notice when the sender asks for none", async () => {
    const t = setup();
    t.put("mac", "a1", "idle");
    expect((await t.send("a1", { notifyOnFinish: false })).text).toBe("Sent to agent a1 on mac.");
    expect(t.watches.list()).toEqual([]);
  });

  it("sends no notice when no agent sent the message", async () => {
    const t = setup();
    t.put("mac", "a1", "idle");
    await t.send("a1", {}, null);
    expect(t.watches.list()).toEqual([]);
  });
});
