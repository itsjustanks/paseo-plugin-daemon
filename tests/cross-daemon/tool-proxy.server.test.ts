// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { spawn } from "node:child_process";

import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./temp-dir.test-support";
import { installToolProxy } from "../../server/cross-daemon/tool-proxy.server";
import { serveTools } from "../../server/cross-daemon/tool-socket.server";
import type { Tools } from "../../server/cross-daemon/tools.server";

const echoTools: Tools = {
  definitions: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
  async call(name, args, caller) {
    return { text: JSON.stringify({ name, args, caller }) };
  },
};

function startProxy(proxyPath: string, agentId: string) {
  const child = spawn(process.execPath, [proxyPath], { env: { ...process.env, PASEO_AGENT_ID: agentId } });
  const replies = createInterface({ input: child.stdout });
  const pending = new Map<number, (reply: any) => void>();
  replies.on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  let nextId = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<{ result?: any; error?: { code: number; message: string } }>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const sendRaw = (line: string) =>
    new Promise<any>((resolve) => {
      pending.set(-1, resolve);
      replies.once("line", (reply) => resolve(JSON.parse(reply)));
      child.stdin.write(`${line}\n`);
    });
  return { child, request, sendRaw };
}

describe("tool proxy started by an agent", () => {
  const stops: (() => unknown)[] = [];
  afterEach(async () => { await Promise.all(stops.splice(0).map((stop) => stop())); });

  it("lists its tools and forwards calls to the plugin, naming the calling agent", async () => {
    const dir = makeTempDir("cd-");
    const socketPath = join(dir, "tools.sock");
    stops.push(serveTools(socketPath, echoTools));
    const proxy = startProxy(installToolProxy(dir, { socketPath, tools: echoTools.definitions }), "agent-7");
    stops.push(() => proxy.child.kill());

    const init = await proxy.request("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = await proxy.request("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
    const call = await proxy.request("tools/call", { name: "echo", arguments: { daemon: "mac" } });
    expect(JSON.parse(call.result.content[0].text)).toEqual({
      name: "echo",
      args: { daemon: "mac" },
      caller: { callerAgentId: "agent-7" },
    });
  });

  it("reports an error to the agent when the plugin is not running", async () => {
    const dir = makeTempDir("cd-");
    const proxy = startProxy(installToolProxy(dir, { socketPath: join(dir, "missing.sock"), tools: echoTools.definitions }), "agent-7");
    stops.push(() => proxy.child.kill());
    const list = await proxy.request("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
    const call = await proxy.request("tools/call", { name: "echo", arguments: {} });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("cross-daemon plugin is unavailable");
  });

  it("answers a line that is not JSON with a parse error instead of dying", async () => {
    const dir = makeTempDir("cd-");
    const proxy = startProxy(installToolProxy(dir, { socketPath: join(dir, "missing.sock"), tools: [] }), "agent-7");
    stops.push(() => proxy.child.kill());
    expect(await proxy.sendRaw("not json")).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await proxy.sendRaw("null")).toMatchObject({ id: null, error: { code: -32600 } });
    const ping = await proxy.request("ping");
    expect(ping.result).toEqual({});
  });
});
