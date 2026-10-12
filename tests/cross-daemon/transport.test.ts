import { describe, expect, it } from "vitest";
import { createCliLimiter } from "../../server/cross-daemon/cli-limiter.server";
import { createMessenger } from "../../server/cross-daemon/messenger.server";
import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";
import type { PaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { makeTempDir } from "./temp-dir.test-support";

const peer = { serverId: "fake", name: "Fixture", link: "https://example.invalid/#offer=" + "ZmFrZQ" };

describe("shared CLI transport protection", () => {
  it("bounds a large round of prompts and finish watches to four CLI calls, with progress for every agent", async () => {
    const dir = makeTempDir("hcd-many-");
    const queue = createMessageQueue(dir); const watches = createWatchList(dir);
    const limiter = createCliLimiter(4);
    const delivered = new Set<string>(); let active = 0; let peak = 0; let calls = 0;
    const fake = async (args: readonly string[]) => {
      active++; peak = Math.max(peak, active); calls++;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (args[0] === "inspect") return JSON.stringify({ Id: args[1], Status: "idle", UpdatedAt: "after" });
        if (args[0] === "logs") return "Finished fake work";
        delivered.add(args[1]); return "{}";
      } finally { active--; }
    };
    const cli: PaseoCli = { run: (_link, args) => limiter.run(() => fake(args)), runLocal: (args) => limiter.run(() => fake(args)) };
    const messenger = createMessenger({ queue, watches, readPeers: () => [peer], cli });
    for (let i = 0; i < 80; i++) {
      queue.add({ peerServerId: peer.serverId, agentId: `target-${i}`, text: "fake prompt", callerAgentId: null }, new Date());
      watches.add({ peerServerId: peer.serverId, agentId: `watched-${i}`, callerAgentId: `caller-${i}`, updatedAtBeforeSend: "before" }, new Date());
    }
    for (let round = 0; round < 12; round++) await Promise.all([messenger.runRound(), messenger.runRound()]);
    expect(peak).toBe(4); expect(active).toBe(0); expect(calls).toBeGreaterThan(300);
    expect(delivered.size).toBe(160);
    expect(delivered.has("target-79")).toBe(true); expect(delivered.has("caller-79")).toBe(true);
    expect(queue.list()).toEqual([]); expect(watches.list()).toEqual([]);
    limiter.close();
  });

  it("cancels queued CLI effects on disable, without starving later generations", async () => {
    const limiter = createCliLimiter(4); const effects = new AbortController();
    const releases: (() => void)[] = []; const started: number[] = [];
    const tasks = Array.from({ length: 100 }, (_, i) => limiter.run(async () => {
      started.push(i); await new Promise<void>((resolve) => releases.push(resolve));
    }, effects.signal));
    const outcomes = Promise.allSettled(tasks);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]); effects.abort();
    releases.forEach((release) => release());
    const results = await outcomes;
    expect(started).toEqual([0, 1, 2, 3]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(96);
    const progressed: number[] = [];
    await Promise.all(Array.from({ length: 40 }, (_, i) => limiter.run(async () => { progressed.push(i); })));
    expect(progressed).toEqual(Array.from({ length: 40 }, (_, i) => i));
    limiter.close();
    await expect(limiter.run(async () => "must not start")).rejects.toThrow("cancelled");
  });
});

it("rotates past busy oldest agents so later pending agents make progress", async () => {
  const dir = makeTempDir("hcd-fair-"); const queue = createMessageQueue(dir);
  const limiter = createCliLimiter(4); const sent = new Set<string>();
  const messenger = createMessenger({ queue, watches: createWatchList(dir), readPeers: () => [peer], cli: {
    run: (_link, args) => limiter.run(async () => {
      if (args[0] === "inspect") return JSON.stringify({ Id: args[1], Status: Number(args[1].split("-")[1]) < 40 ? "running" : "idle", UpdatedAt: "now" });
      sent.add(args[1]); return "{}";
    }), runLocal: async () => "{}",
  } });
  for (let i = 0; i < 80; i++) queue.add({ peerServerId: peer.serverId, agentId: `agent-${i}`, text: "fake", callerAgentId: null }, new Date());
  await messenger.runRound();
  expect(sent.size).toBe(0);
  for (let round = 0; round < 8; round++) await messenger.runRound();
  expect(sent.size).toBe(40); expect(sent.has("agent-79")).toBe(true);
  expect(queue.list()).toHaveLength(40); limiter.close();
});
