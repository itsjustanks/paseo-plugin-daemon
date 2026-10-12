// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createMessenger } from "../../server/cross-daemon/messenger.server";
import type { PaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { makeTempDir } from "./temp-dir.test-support";
import { createTools } from "../../server/cross-daemon/tools.server";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";

const mac: Peer = { serverId: "srv_mac", name: "mac", link: "https://app.paseo.sh/#offer=bWFj" };
const self = { name: "tower", serverId: "srv_tower" };

// A fake remote daemon: agents with a status, and a record of the prompts `paseo send` delivered.
function fakeRemote(statuses: Record<string, string | Error>) {
  const delivered: { agentId: string; text: string }[] = [];
  const cli: PaseoCli = {
    async run(_link, args, options) {
      const [command, agentId] = args;
      const status = statuses[agentId];
      if (status instanceof Error) throw status;
      if (status === undefined) throw new Error(`Agent not found: ${agentId}`);
      if (command === "inspect") return JSON.stringify({ Id: agentId, Status: status, UpdatedAt: "2020-01-01T00:00:00.000Z" });
      if (command === "send") {
        delivered.push({ agentId, text: options?.promptText ?? "" });
        statuses[agentId] = "running";
        return "{}";
      }
      throw new Error(`unexpected command ${command}`);
    },
    async runLocal() {
      throw new Error("no local calls expected");
    },
  };
  return { cli, delivered, statuses };
}

function setup(statuses: Record<string, string | Error>) {
  const remote = fakeRemote(statuses);
  const dir = makeTempDir("cd-queue-");
  const queue = createMessageQueue(dir);
  const watches = createWatchList(dir);
  const messenger = createMessenger({ queue, watches, readPeers: () => [mac], cli: remote.cli });
  const tools = createTools({ readPeers: () => [mac], cli: remote.cli, messenger, ownDaemon: async () => self });
  const send = (agentId: string, prompt: string) =>
    tools.call("send_agent_prompt", { daemon: "mac", agentId, prompt, notifyOnFinish: false }, { callerAgentId: "caller-1" });
  const deliver = () => messenger.runRound();
  return { ...remote, queue, send, deliver };
}

afterEach(() => vi.restoreAllMocks());

describe("send_agent_prompt", () => {
  it("sends at once to an idle agent, saying who sent it and how to reply", async () => {
    const { send, delivered } = setup({ a1: "idle" });
    const result = await send("a1", "Please rebase onto main.");
    expect(result).toEqual({ text: "Sent to agent a1 on mac." });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('from agent caller-1 on daemon "tower" (srv_tower)');
    expect(delivered[0].text).toContain("Please rebase onto main.");
    expect(delivered[0].text).toContain('daemon "srv_tower" and agentId "caller-1"');
  });

  it("queues for a working agent, and tells the sender it is working and the message is queued", async () => {
    const { send, delivered, queue } = setup({ a1: "running" });
    const result = await send("a1", "Please rebase onto main.");
    expect(result).toEqual({
      text: "Agent a1 on mac is working. Your message is queued and will be delivered when it is idle.",
    });
    expect(delivered).toEqual([]);
    expect(queue.list()).toHaveLength(1);
  });

  it("treats a starting agent as working", async () => {
    const { send, delivered } = setup({ a1: "initializing" });
    await send("a1", "hello");
    expect(delivered).toEqual([]);
  });

  it("queues behind earlier messages to the same agent even once it is idle, keeping their order", async () => {
    const { send, queue, statuses } = setup({ a1: "running" });
    await send("a1", "first");
    statuses.a1 = "idle";
    const result = await send("a1", "second");
    expect(result.text).toContain("queued");
    expect(queue.list().map((message) => message.text.includes("first"))).toEqual([true, false]);
  });

  it("reports an agent that does not exist instead of queueing for it", async () => {
    const { send, queue } = setup({});
    const result = await send("nope", "hello");
    expect(result).toEqual({ text: "paseo on mac failed: Agent not found: nope", isError: true });
    expect(queue.list()).toEqual([]);
  });
});

describe("queued message delivery", () => {
  it("delivers a queued message once the agent is idle", async () => {
    const { send, deliver, delivered, statuses, queue } = setup({ a1: "running" });
    await send("a1", "Please rebase onto main.");
    statuses.a1 = "idle";
    await deliver();
    expect(delivered.map((message) => message.text.includes("Please rebase onto main."))).toEqual([true]);
    expect(queue.list()).toEqual([]);
  });

  it("keeps the message while the agent is still working", async () => {
    const { send, deliver, delivered, queue } = setup({ a1: "running" });
    await send("a1", "hello");
    await deliver();
    expect(delivered).toEqual([]);
    expect(queue.list()).toHaveLength(1);
  });

  it("delivers one message per agent at a time, so the second waits for the first to be handled", async () => {
    const { send, deliver, delivered, statuses, queue } = setup({ a1: "running" });
    await send("a1", "first");
    await send("a1", "second");
    statuses.a1 = "idle";
    await deliver();
    expect(delivered).toHaveLength(1);
    expect(queue.list()).toHaveLength(1);
  });

  it("keeps the message and retries later when the daemon cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, deliver, statuses, queue } = setup({ a1: "running" });
    await send("a1", "hello");
    statuses.a1 = new Error("relay connection timed out");
    await deliver();
    expect(queue.list()).toHaveLength(1);
  });

  it("drops the message when the agent no longer exists", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, deliver, statuses, queue } = setup({ a1: "running" });
    await send("a1", "hello");
    delete statuses.a1;
    await deliver();
    expect(queue.list().filter((message) => message.agentId === "a1")).toEqual([]);
  });

  it("drops the message when the CLI reports the agent is gone in its own words", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, deliver, statuses, queue } = setup({ a1: "running" });
    await send("a1", "hello");
    statuses.a1 = new Error("Error: No agent found matching: a1\nUse `paseo ls` to list available agents");
    await deliver();
    expect(queue.list().filter((message) => message.agentId === "a1")).toEqual([]);
  });

  it("keeps queued messages across a plugin restart", async () => {
    const dir = makeTempDir("cd-queue-");
    createMessageQueue(dir).add({ peerServerId: "srv_mac", agentId: "a1", text: "hello", callerAgentId: null }, new Date());
    expect(createMessageQueue(dir).list()).toHaveLength(1);
  });
});
