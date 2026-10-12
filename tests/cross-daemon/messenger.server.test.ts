// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createMessenger, startDeliveryWorker } from "../../server/cross-daemon/messenger.server";
import type { PaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { makeTempDir } from "./temp-dir.test-support";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";

const mac: Peer = { serverId: "srv_mac", name: "mac", link: "https://app.paseo.sh/#offer=bWFj" };
const FULL_ID = "a1b2c3d4-0000-4000-8000-000000000001";

interface FakeAgent {
  status: string;
  updatedAt: string;
  archived?: boolean;
}

// A remote daemon (and this one) that resolves ID prefixes like Paseo does, with hooks to fail or
// slow down a command.
function fakeDaemons() {
  const agents = new Map<string, FakeAgent>();
  const sends: { where: string; agentId: string; text: string }[] = [];
  let sendFailure: Error | null = null;
  let inspectDelayMs = 0;
  const inspectDelays: number[] = [];
  const resolve = (where: string, ref: string) => {
    const matches = [...agents.keys()].filter((key) => key.startsWith(`${where}/${ref}`));
    if (matches.length === 0) throw new Error(`Agent not found: ${ref}`);
    if (matches.length > 1) throw new Error(`Agent identifier ${ref} is ambiguous`);
    return matches[0].slice(where.length + 1);
  };
  const handle = async (where: string, args: readonly string[], promptText?: string) => {
    const [command, ref] = args;
    const id = resolve(where, ref);
    const agent = agents.get(`${where}/${id}`)!;
    if (command === "inspect") {
      // The daemon reads the agent when the call starts; the answer arrives after the delay.
      const answer = JSON.stringify({ Id: id, Status: agent.status, UpdatedAt: agent.updatedAt, Archived: agent.archived ?? false });
      await new Promise((done) => setTimeout(done, inspectDelays.shift() ?? inspectDelayMs));
      return answer;
    }
    if (command === "send") {
      if (sendFailure) throw sendFailure;
      sends.push({ where, agentId: id, text: promptText ?? "" });
      Object.assign(agent, { status: "running", updatedAt: new Date().toISOString() });
      return "{}";
    }
    if (command === "logs") return "";
    throw new Error(`unexpected command ${command}`);
  };
  const cli: PaseoCli = {
    run: (_link, args, options) => handle("mac", args, options?.promptText),
    runLocal: (args, options) => handle("local", args, options?.promptText),
  };
  return {
    cli,
    sends,
    put: (where: string, id: string, status: string, extra: Partial<FakeAgent> = {}) =>
      agents.set(`${where}/${id}`, { status, updatedAt: "2020-01-01T00:00:00.000Z", ...extra }),
    setStatus: (where: string, id: string, status: string) => Object.assign(agents.get(`${where}/${id}`)!, { status }),
    failSends: (error: Error | null) => {
      sendFailure = error;
    },
    slowInspect: (ms: number) => {
      inspectDelayMs = ms;
    },
    delayNextInspects: (...ms: number[]) => inspectDelays.push(...ms),
  };
}

function setup(options: { now?: () => number } = {}) {
  const daemons = fakeDaemons();
  const dir = makeTempDir("cd-messenger-");
  const queue = createMessageQueue(dir);
  const watches = createWatchList(dir);
  const messenger = createMessenger({ queue, watches, readPeers: () => [mac], cli: daemons.cli, now: options.now });
  const send = (agentRef: string, callerAgentId: string | null = "caller-1") =>
    messenger.send({ peer: mac, agentRef, text: "hello", callerAgentId, notifyOnFinish: false });
  const noticesTo = (id: string) => daemons.sends.filter((entry) => entry.where === "local" && entry.agentId === id);
  return { ...daemons, dir, queue, watches, messenger, send, noticesTo };
}

afterEach(() => vi.restoreAllMocks());

describe("never interrupting a working agent", () => {
  it("sends only one of two messages that race to the same idle agent, and queues the other", async () => {
    const t = setup();
    t.put("mac", FULL_ID, "idle");
    t.slowInspect(20);
    const outcomes = await Promise.all([t.send(FULL_ID), t.send(FULL_ID)]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["queued", "sent"]);
    expect(t.sends).toHaveLength(1);
  });

  it("does not send on a stale idle reading taken before another send finished", async () => {
    const t = setup();
    t.put("mac", FULL_ID, "idle");
    t.delayNextInspects(50, 0);
    const late = t.send(FULL_ID);
    const early = await t.send(FULL_ID);
    expect([early.kind, (await late).kind]).toEqual(["sent", "queued"]);
    expect(t.sends).toHaveLength(1);
  });

  it("treats an ID prefix and the full ID as the same agent", async () => {
    const t = setup();
    t.put("mac", FULL_ID, "running");
    await t.send("a1b2c3d");
    await t.send(FULL_ID);
    t.setStatus("mac", FULL_ID, "idle");
    await t.messenger.runRound();
    expect(t.sends).toHaveLength(1);
    expect(t.queue.list()).toHaveLength(1);
    expect(t.queue.list()[0].agentId).toBe(FULL_ID);
  });
});

describe("messages that cannot be delivered", () => {
  it("drops a message that waited too long, and tells the sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = Date.parse("2026-01-01T00:00:00Z");
    const t = setup({ now: () => now });
    t.put("mac", FULL_ID, "running");
    t.put("local", "caller-1", "idle");
    await t.send(FULL_ID);
    now += 25 * 60 * 60 * 1000;
    await t.messenger.runRound();
    await t.messenger.runRound();
    expect(t.queue.list()).toEqual([]);
    expect(t.noticesTo("caller-1")[0].text).toContain("Delivery report");
  });

  it("drops a message to an agent that became archived, and tells the sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.put("mac", FULL_ID, "running");
    t.put("local", "caller-1", "idle");
    await t.send(FULL_ID);
    t.put("mac", FULL_ID, "idle", { archived: true });
    await t.messenger.runRound();
    await t.messenger.runRound();
    expect(t.sends.filter((entry) => entry.where === "mac")).toEqual([]);
    expect(t.noticesTo("caller-1")[0].text).toContain("archived");
  });

  it("keeps a message whose daemon is switched off for a while, until it expires", async () => {
    const t = setup();
    t.put("mac", FULL_ID, "running");
    await t.send(FULL_ID);
    const offline = createMessenger({ queue: t.queue, watches: t.watches, readPeers: () => [], cli: t.cli });
    await offline.runRound();
    expect(t.queue.list()).toHaveLength(1);
  });

  it("refuses more than 20 waiting messages for one agent", async () => {
    const t = setup();
    t.put("mac", FULL_ID, "running");
    for (let i = 0; i < 20; i++) await t.send(FULL_ID);
    await expect(t.send(FULL_ID)).rejects.toThrow("20 messages are already waiting");
  });
});

describe("finish watches", () => {
  it("gives up on an agent not seen to finish within 24 hours, and tells the sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = Date.parse("2026-01-01T00:00:00Z");
    const t = setup({ now: () => now });
    t.put("mac", FULL_ID, "idle");
    t.put("local", "caller-1", "idle");
    await t.messenger.send({ peer: mac, agentRef: FULL_ID, text: "hello", callerAgentId: "caller-1", notifyOnFinish: true });
    now += 25 * 60 * 60 * 1000;
    await t.messenger.runRound();
    await t.messenger.runRound();
    expect(t.watches.list()).toEqual([]);
    expect(t.noticesTo("caller-1")[0].text).toContain("did not see agent");
  });
});

describe("sends that may have gone through", () => {
  it("does not send again a message whose send was cut off by a restart, and tells the sender", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.put("mac", FULL_ID, "running");
    t.put("local", "caller-1", "idle");
    await t.send(FULL_ID);
    t.queue.setInFlight(t.queue.list()[0].id, true);
    t.setStatus("mac", FULL_ID, "idle");
    await t.messenger.runRound();
    await t.messenger.runRound();
    expect(t.sends.filter((entry) => entry.where === "mac")).toEqual([]);
    expect(t.noticesTo("caller-1")[0].text).toContain("may have been delivered");
  });

  it("reports a send that timed out as possibly delivered instead of retrying it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.put("mac", FULL_ID, "idle");
    t.failSends(new Error("paseo timed out after 90 s"));
    await expect(t.send(FULL_ID)).rejects.toThrow("may have been delivered");
  });
});

describe("delivery rounds", () => {
  it("survives an unreadable queue file, setting it aside instead of failing every round", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    writeFileSync(join(t.dir, "queue.json"), "{ not json");
    await expect(t.messenger.runRound()).resolves.toBeUndefined();
    expect(readdirSync(t.dir).some((name) => name.startsWith("queue.json.unreadable-"))).toBe(true);
  });
});

it("delivery timer never overlaps a slow round and stops future work on cleanup", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const runRound = vi.fn(() => new Promise<void>((resolve) => finish = resolve));
  const stop = startDeliveryWorker({ runRound, send: vi.fn() }, 100);
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(runRound).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(100);
    expect(runRound).toHaveBeenCalledTimes(2);
    stop(); finish(); await vi.advanceTimersByTimeAsync(1000);
    expect(runRound).toHaveBeenCalledTimes(2);
  } finally { stop(); vi.useRealTimers(); }
});
