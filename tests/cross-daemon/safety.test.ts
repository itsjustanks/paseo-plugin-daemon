import { createConnection } from "node:net";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCrossDaemon } from "../../server/cross-daemon/cross-daemon.server";
import { createMessageQueue } from "../../server/cross-daemon/message-queue.server";
import { createMessenger, MaybeDeliveredError } from "../../server/cross-daemon/messenger.server";
import { createWatchList } from "../../server/cross-daemon/watch-list.server";
import { readPrivateJson, writePrivateJson } from "../../server/cross-daemon/private-json.server";
import { crossDaemonSettings, peerSchema } from "../../shared/cross-daemon/cross-daemon.shared";
import { safeCrossDaemonText } from "../../shared/cross-daemon/privacy";
import { createPaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { createTools } from "../../server/cross-daemon/tools.server";
import { createDaemonPort, syncPeers } from "../../client/cross-daemon/peer-sync.client";
import { withCrossDaemonTools } from "../../server/cross-daemon/agent-injection.server";
import { z } from "zod";
import { makeTempDir } from "./temp-dir.test-support";

const peer = { serverId: "remote", name: "Remote", link: "https://example.invalid/#offer=" + "ZmFrZQ" };
const on = { status: "ready", revision: "r1", values: { enabled: true, fullAuthorityConfirmed: true } };
const off = { status: "ready", revision: "r2", values: { enabled: false, fullAuthorityConfirmed: false } };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); vi.restoreAllMocks(); });

function fixture(options: { missingBefore?: boolean; missingSettings?: boolean; initial?: typeof on; dir?: string; providers?: unknown; configGet?: () => Promise<any>; inspect?: () => Promise<string>; run?: (args: readonly string[]) => Promise<string> } = {}) {
  const dir = options.dir ?? join(makeTempDir("hcd-"), "private");
  let state = options.initial ?? on;
  let listener = async () => {};
  let hook: ((...args: any[]) => unknown) | undefined;
  const calls: { args: readonly string[]; signal?: AbortSignal; prompt?: string }[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const readOwnPeer = vi.fn(async () => peer);
  const stateDir = vi.fn(async () => dir);
  const server = {
    registerSettings: () => options.missingSettings ? undefined : { read: async () => state, subscribe: (fn: typeof listener) => { listener = fn; return () => {}; } },
    handle: (contract: { name: string }, fn: (...args: any[]) => Promise<any>) => handlers.set(contract.name, fn),
    ...options.missingBefore ? {} : { before: (_: string, fn: (...args: any[]) => unknown) => { hook = fn; return () => {}; } },
  } as unknown as PluginServerContext;
  const stop = registerCrossDaemon(server, {
    stateDir, readOwnPeer, ownDaemon: async () => ({ serverId: "local", name: "Local" }),
    cli: {
      async run(_link, args, opts) {
        calls.push({ args, signal: opts?.signal, prompt: opts?.promptText });
        if (options.run) return options.run(args);
        if (args[0] === "inspect") return options.inspect ? options.inspect() : JSON.stringify({ Id: "agent-1", Status: "idle", UpdatedAt: "2026-01-01T00:00:00Z" });
        return "{}";
      },
      runLocal: async () => { throw new Error("No local production agent calls permitted"); },
    },
  });
  cleanups.push(stop);
  const call = (name: string, input = {}) => handlers.get("hosts-cross-daemon." + name)!(input, { paseo: { config: { get: async () => ({ config: { relay: { enabled: true } } }) } } });
  const createAgent = (provider = "claude") => hook?.({ request: { config: { provider, cwd: "/fake" } } }, {
    signal: new AbortController().signal,
    paseo: { config: { get: options.configGet ?? (async () => ({ config: { providers: options.providers } })) } },
  });
  const ready = async () => { await createAgent(); await call("describe"); };
  const tool = (name: string, args: unknown = {}) => new Promise<any>((resolve, reject) => {
    const socket = createConnection(join(dir, "tools.sock"));
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => body += chunk);
    socket.on("error", reject);
    socket.on("end", () => { try { resolve(body ? JSON.parse(body) : null); } catch { reject(new Error("Malformed fake reply")); } });
    socket.end(JSON.stringify({ type: "call", name, arguments: args, callerAgentId: null }));
  });
  return { createAgent, dir, stateDir, calls, readOwnPeer, stop, call, ready, tool, async disable() { state = off; await listener(); } };
}

describe("separate authority and capability boundaries", () => {
  it("defaults off and refuses enabled settings without explicit full-authority confirmation", () => {
    expect(crossDaemonSettings.id).toBe("hosts-cross-daemon");
    expect(crossDaemonSettings.schema.parse({})).toEqual({ enabled: false, fullAuthorityConfirmed: false });
    expect(crossDaemonSettings.schema.safeParse({ enabled: true }).success).toBe(false);
  });
  it.each([{ missingBefore: true }, { missingSettings: true }])("does not fake missing runtime APIs: %j", async (options) => {
    const t = fixture(options);
    expect(await t.call("describe")).toEqual({ serverId: "", switchedOn: false, available: false });
    await expect(t.call("sync-offer")).rejects.toThrow("requires settings");
    expect(t.stateDir).not.toHaveBeenCalled();
    expect(t.readOwnPeer).not.toHaveBeenCalled();
  });
  it("returns no links in normal status, peers, or tool output", async () => {
    const t = fixture();
    await t.ready();
    await t.call("set-peers", { peers: [peer], answeredServerIds: [peer.serverId] });
    const status = await t.call("describe");
    expect(status).toEqual({ serverId: "local", switchedOn: true, available: true });
    expect(t.readOwnPeer).not.toHaveBeenCalled();
    expect(JSON.stringify(await t.call("list-peers"))).not.toContain(peer.link);
    expect(JSON.stringify(await t.tool("list_daemons"))).not.toContain(peer.link);
    expect((await t.call("sync-offer")).member).toEqual(peer);
  });
  it("clears peers, queue and watches and denies retained tools when disabled", async () => {
    const t = fixture(); await t.ready();
    await t.call("set-peers", { peers: [peer], answeredServerIds: [] });
    const queue = createMessageQueue(t.dir); queue.add({ peerServerId: peer.serverId, agentId: "a", text: "private", callerAgentId: null }, new Date());
    const watches = createWatchList(t.dir); watches.add({ peerServerId: peer.serverId, agentId: "a", callerAgentId: "caller", updatedAtBeforeSend: "before" }, new Date());
    await t.disable();
    expect(queue.list()).toEqual([]); expect(watches.list()).toEqual([]);
    expect(await t.call("list-peers")).toEqual({ peers: [] });
    expect(await t.tool("list_daemons")).toMatchObject({ isError: true });
    expect(t.calls).toEqual([]);
  });
  it.each(["disable", "unload"])("blocks send after an awaited inspect on %s", async (action) => {
    let release!: (text: string) => void;
    const t = fixture({ inspect: () => new Promise<string>((resolve) => { release = resolve; }) });
    await t.ready(); await t.call("set-peers", { peers: [peer], answeredServerIds: [] });
    const pending = t.tool("send_agent_prompt", { daemon: peer.serverId, agentId: "agent-1", prompt: "hello", notifyOnFinish: false }).catch(() => null);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    if (action === "disable") await t.disable(); else await t.stop();
    expect(t.calls[0].signal?.aborted).toBe(true);
    release(JSON.stringify({ Id: "agent-1", Status: "idle", UpdatedAt: "2026-01-01T00:00:00Z" }));
    await pending;
    expect(t.calls.some((call) => call.args[0] === "send")).toBe(false);
  });
  it("does not replace an existing MCP server with the same ID", () => {
    const config = { provider: "claude", cwd: "/fake", mcpServers: { "hosts-cross-daemon": { type: "stdio" as const, command: "existing" } } };
    expect(withCrossDaemonTools(config, { command: "node", proxyPath: "/fake" }, ["list_daemons"])).toBe(config);
  });
});

describe("no retry after uncertain sends", () => {
  it.each(["ECONNRESET", "maxBuffer exceeded", "aborted", "paseo timed out"])("never replays %s", async (reason) => {
    const dir = makeTempDir("hcd-uncertain-"); const queue = createMessageQueue(dir); const watches = createWatchList(dir);
    let sends = 0;
    const messenger = createMessenger({ queue, watches, readPeers: () => [peer], cli: {
      async run(_link, args) { if (args[0] === "inspect") return JSON.stringify({ Id: "a", Status: "idle", UpdatedAt: "now" }); sends++; throw new Error(reason + " " + peer.link); },
      runLocal: async () => "{}",
    } });
    await expect(messenger.send({ peer, agentRef: "a", text: "secret", callerAgentId: null, notifyOnFinish: false })).rejects.toBeInstanceOf(MaybeDeliveredError);
    expect(queue.list()[0].inFlight).toBe(true);
    await messenger.runRound(); await messenger.runRound();
    expect(sends).toBe(1); expect(queue.list()).toEqual([]);
  });
  it("queues unknown agent states instead of treating them as idle", async () => {
    const dir = makeTempDir("hcd-status-"); let sends = 0;
    const messenger = createMessenger({ queue: createMessageQueue(dir), watches: createWatchList(dir), readPeers: () => [peer], cli: {
      run: async (_link, args) => { if (args[0] === "send") sends++; return JSON.stringify({ Id: "a", Status: "waiting_permission", UpdatedAt: "now" }); }, runLocal: async () => "{}",
    } });
    expect(await messenger.send({ peer, agentRef: "a", text: "hello", callerAgentId: null, notifyOnFinish: false })).toMatchObject({ kind: "queued" });
    expect(sends).toBe(0);
  });
});

describe("credential containment", () => {
  it("contains stderr and execFile failure messages even when they echo --host", async () => {
    const dir = makeTempDir("hcd-cli-"); const script = join(dir, "cli.mjs");
    writeFileSync(script, 'process.stderr.write(process.argv.join(" ")); process.exit(1);');
    for (const command of [process.execPath, join(dir, "missing-executable")]) {
      const cli = createPaseoCli({ command, args: [script], home: dir });
      const error = await cli.run(peer.link, ["send", "a"]).catch((error: Error) => error);
      expect(String(error)).not.toContain(peer.link); expect(String(error)).not.toContain("#offer=");
    }
  });
  it("scrubs short, unrelated pairing offers before presenting remote activity", async () => {
    const other = "https://other.invalid/#offer=" + "YWJj";
    expect(safeCrossDaemonText(peer.link + " " + other)).not.toContain("#offer=");
    const tools = createTools({ readPeers: () => [peer], cli: { run: async () => other + "x".repeat(100_000), runLocal: async () => "" }, messenger: {} as never, ownDaemon: async () => ({ name: "here", serverId: "local" }) });
    const result = await tools.call("get_agent_activity", { daemon: "remote", agentId: "a" }, { callerAgentId: null });
    expect(result.text).not.toContain("#offer="); expect(result.text.length).toBeLessThan(65_000);
  });
  it("hardens old file modes and refuses symlink storage", () => {
    const dir = makeTempDir("hcd-files-"); const file = join(dir, "peers.json");
    writeFileSync(file, JSON.stringify([peer]), { mode: 0o644 });
    expect(readPrivateJson(file, z.array(peerSchema), [])).toEqual([peer]);
    expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(dir).mode & 0o777).toBe(0o700);
    const link = join(dir, "link.json"); symlinkSync(file, link);
    expect(() => readPrivateJson(link, z.array(peerSchema), [])).toThrow("Unsafe");
    expect(() => writePrivateJson(link, [])).toThrow("Unsafe");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([peer]);
  });
  it("requires confirmation before writing enable settings", async () => {
    const rpc = vi.fn();
    await expect(createDaemonPort(rpc).setSwitch(true)).rejects.toThrow("Confirm full daemon authority");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not distribute credentials from an unloaded client during an in-flight sync", async () => {
    let current = true; let finish!: (description: any) => void;
    const source = { describe: () => new Promise<any>((resolve) => finish = resolve), status: async () => ({ serverId: "target", switchedOn: true, available: true }), setPeers: vi.fn(), listPeers: async () => [], setSwitch: async () => {} };
    const target = { ...source, describe: async () => ({ serverId: "target", switchedOn: true, member: { ...peer, serverId: "target" } }), setPeers: vi.fn() };
    const sync = syncPeers([source, target], (port) => port !== source || current);
    current = false; finish({ serverId: peer.serverId, switchedOn: true, member: peer }); await sync;
    expect(target.setPeers.mock.calls[0][0].peers).toEqual([]); expect(source.setPeers).not.toHaveBeenCalled();
  });
});

it("shares the four-call transport limit across actual registered MCP tool requests", async () => {
  let active = 0; let peak = 0; let calls = 0;
  const t = fixture({ run: async () => {
    active++; peak = Math.max(peak, active); calls++;
    try { await new Promise<void>((resolve) => setTimeout(resolve, 2)); return "[]"; }
    finally { active--; }
  } });
  await t.ready(); await t.call("set-peers", { peers: [peer], answeredServerIds: [] });
  const replies = await Promise.all(Array.from({ length: 50 }, () => t.tool("list_agents", { daemon: peer.serverId })));
  expect(peak).toBe(4); expect(calls).toBe(50); expect(active).toBe(0);
  expect(replies.every((reply) => !reply.isError)).toBe(true);
});

it("keeps an acknowledged immediate send intact while a worker round runs", async () => {
  const dir = makeTempDir("hcd-live-send-");
  const queue = createMessageQueue(dir);
  let acknowledge!: (reply: string) => void;
  let sends = 0;
  const messenger = createMessenger({ queue, watches: createWatchList(dir), readPeers: () => [peer], cli: {
    async run(_link, args) {
      if (args[0] === "inspect") return JSON.stringify({ Id: "a", Status: "idle", UpdatedAt: "now" });
      sends++; return new Promise<string>((resolve) => acknowledge = resolve);
    }, runLocal: async () => { throw new Error("No local notice expected"); },
  } });
  const send = messenger.send({ peer, agentRef: "a", text: "hello", callerAgentId: "caller", notifyOnFinish: false });
  await vi.waitFor(() => expect(sends).toBe(1));
  const persisted = queue.list()[0];
  expect(persisted.inFlight).toBe(true);
  await messenger.runRound();
  expect(queue.list()).toEqual([persisted]);
  acknowledge("{}");
  expect(await send).toEqual({ kind: "sent", agentId: "a" });
  await messenger.runRound();
  expect(queue.list()).toEqual([]); expect(sends).toBe(1);
});

it.each([off, on])("a second runtime with settings %j cannot affect the owner's state or socket", async (initial) => {
  const owner = fixture(); await owner.ready();
  await owner.call("set-peers", { peers: [peer], answeredServerIds: [] });
  const queue = createMessageQueue(owner.dir);
  queue.add({ peerServerId: peer.serverId, agentId: "pending", text: "private", callerAgentId: null }, new Date());
  const watches = createWatchList(owner.dir);
  watches.add({ peerServerId: peer.serverId, agentId: "pending", callerAgentId: "caller", updatedAtBeforeSend: "before" }, new Date());
  const files = ["peers.json", "queue.json", "watches.json"];
  const before = files.map((file) => readFileSync(join(owner.dir, file), "utf8"));
  const socketInode = statSync(join(owner.dir, "tools.sock")).ino;
  const secondary = fixture({ initial, dir: owner.dir }); await secondary.ready();
  expect(await secondary.call("describe")).toMatchObject({ available: false, switchedOn: false });
  expect(await secondary.call("sync-offer")).toMatchObject({ member: null, switchedOn: false });
  expect(await secondary.call("set-peers", { peers: [], answeredServerIds: [peer.serverId] })).toEqual({ stored: 0 });
  await secondary.disable(); await secondary.stop();
  expect(files.map((file) => readFileSync(join(owner.dir, file), "utf8"))).toEqual(before);
  expect(statSync(join(owner.dir, "tools.sock")).ino).toBe(socketInode);
  expect(await owner.tool("list_daemons")).not.toMatchObject({ isError: true });
  expect(await owner.call("describe")).toMatchObject({ available: true, switchedOn: true });
  expect(secondary.calls).toEqual([]);
});

it("looks up aliases through the opted-in hook config API and preserves the provider", async () => {
  const get = vi.fn(async () => ({ config: { providers: { routed: { extends: "claude", command: ["custom"], env: { PRIVATE: "not-output" } } } } }));
  const t = fixture({ configGet: get }); await t.ready();
  expect(get).not.toHaveBeenCalled();
  const request: any = await t.createAgent("routed");
  expect(request.config.provider).toBe("routed");
  expect(request.config.mcpServers["hosts-cross-daemon"]).toBeDefined();
  expect(request.config.toolPolicy.preapproved).toHaveLength(5);
  expect(JSON.stringify(request)).not.toContain("not-output");
  await t.disable();
  expect(await t.createAgent("routed")).toEqual({ config: { provider: "routed", cwd: "/fake" } });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each(["failure", "disable", "unload"])("leaves the alias request unchanged when config lookup encounters %s", async (action) => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const get = vi.fn(() => new Promise<any>((yes, no) => { resolve = yes; reject = no; }));
  const t = fixture({ configGet: get }); await t.ready();
  const creating = t.createAgent("routed");
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  if (action === "failure") reject(new Error(peer.link));
  else { if (action === "disable") await t.disable(); else await t.stop(); resolve({ config: { providers: { routed: { extends: "codex" } } } }); }
  expect(await creating).toEqual({ config: { provider: "routed", cwd: "/fake" } });
});

it("does not write queue state after unload when a transport ignores cancellation and later acknowledges", async () => {
  const dir = makeTempDir("hcd-late-ack-"); const queue = createMessageQueue(dir);
  let active = true; let acknowledge!: (reply: string) => void;
  const messenger = createMessenger({ queue, watches: createWatchList(dir), readPeers: () => [peer], isActive: () => active, cli: {
    async run(_link, args) {
      if (args[0] === "inspect") return JSON.stringify({ Id: "a", Status: "idle", UpdatedAt: "now" });
      return new Promise<string>((resolve) => acknowledge = resolve);
    }, runLocal: async () => { throw new Error("No local effects permitted"); },
  } });
  const pending = messenger.send({ peer, agentRef: "a", text: "hello", callerAgentId: "caller", notifyOnFinish: true });
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
  active = false;
  // Represents the next runtime's state after the old runtime has relinquished ownership.
  queue.clear(); queue.add({ peerServerId: peer.serverId, agentId: "new", text: "new state", callerAgentId: null }, new Date());
  const file = join(dir, "queue.json"); const before = readFileSync(file, "utf8"); const inode = statSync(file).ino;
  acknowledge("{}"); expect(await pending).toMatchObject({ kind: "sent" });
  expect(readFileSync(file, "utf8")).toBe(before); expect(statSync(file).ino).toBe(inode);
  expect(createWatchList(dir).list()).toEqual([]);
});
