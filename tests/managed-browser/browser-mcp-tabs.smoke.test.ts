import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it, vi } from "vitest";
import type { AgentBrowserOperation } from "../../server/managed-browser/runtime-protocol";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";
import { AgentSupervisorClient, SupervisorClient } from "../../server/managed-browser/supervisor-client";
import { resolveSupervisorPaths, startSupervisorServer } from "../../server/managed-browser/supervisor";

it("uses real private MCP tab tools and preserves human handoff and closed-tab refusal", async () => {
  const assets = process.env.HOSTS_BROWSER_MCP_RUNTIME_ROOT;
  if (!assets || !process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY || !process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE)
    throw new Error("MCP smoke requires explicit owned private runtime assets and binaries");
  const home = await mkdtemp(join(tmpdir(), "hosts-mcp-"));
  await writeFile(join(home, "OWNED"), home, { mode: 0o600 });
  vi.stubEnv("PASEO_HOME", home);
  const paths = resolveSupervisorPaths(home);
  const owner = await createRuntimeOwner({ runtimeRoot: assets });
  const server = await startSupervisorServer(owner, paths);
  const bridge = new SupervisorClient({ bridgeId: "owned-mcp-smoke", paths });
  const client = new Client({ name: "hosts-owned-mcp-smoke", version: "1" });
  const ticket = randomBytes(32).toString("base64url");
  const rawAgent = new AgentSupervisorClient({ ticket, paths });
  const transport = new StdioClientTransport({ command: join(assets, "node/bin/node"), args: [join(assets, "hosts-browser-mcp.cjs")],
    env: { HOME: home, PASEO_HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), PATH: `${join(assets, "node/bin")}:/usr/bin:/bin`, HOSTS_BROWSER_TICKET: ticket, NODE_OPTIONS: "", NODE_PATH: "" }, stderr: "pipe" });
  let identity: string | null = null;
  const processIdentity = () => execFileSync("ps", ["-p", String(transport.pid), "-o", "uid=,lstart=,args="], { encoding: "utf8" }).trim();
  async function tool(name: string, args = {}) {
    const result = await client.callTool({ name: `hosts_browser_${name}`, arguments: args }, undefined, { timeout: 10_000 });
    const content = result.content as { type: string; text?: string }[];
    const text = content.find((item) => item.type === "text")?.text ?? "null";
    return { error: result.isError === true, value: result.isError ? text : JSON.parse(text) };
  }
  try {
    await bridge.connect(); await bridge.issueAgentTicket(ticket); await bridge.bindAgentTicket(ticket, "owned-mcp-agent", "owned-mcp-workspace");
    await client.connect(transport); identity = processIdentity();
    await rawAgent.open();
    for (const [operation, input] of [["tabs.force", {}], ["tabs.select", {}]] as const) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Private parser refusal timed out")), 2_000); });
        await expect(Promise.race([rawAgent.request(operation as AgentBrowserOperation, input), deadline])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      } finally { clearTimeout(timer); }
    }
    const original = (await tool("status")).value.state.tabId;
    expect((await tool("tabs")).value.tabs).toHaveLength(1);
    const foreign = await bridge.requestBrowser<any>("attach", { workspaceId: "owned-foreign-workspace", viewerLabel: "Owned foreign viewer", create: true });
    expect((await tool("tab_select", { tabId: foreign.state.tabId })).error).toBe(true);
    expect((await tool("status")).value.state.tabId).toBe(original);
    expect((await tool("tab_select", { tabId: "../invalid" })).error).toBe(true);
    const opened = await tool("tab_open"); expect(opened.error).toBe(false);
    const second = opened.value.tabId; expect(second).not.toBe(original);
    expect((await tool("tabs")).value.tabs.map((tab: { id: string }) => tab.id)).toEqual([original, second]);
    expect((await tool("tab_select", { tabId: original })).value.state.tabId).toBe(original);
    expect((await tool("tab_select", { tabId: second })).value.state.tabId).toBe(second);
    expect((await tool("acquire_control")).value.state.controller).toBe("self");
    const human = await bridge.requestBrowser<any>("attach", { workspaceId: "owned-mcp-workspace", viewerLabel: "Owned human", tabId: second, create: false });
    const controlled = await bridge.requestBrowser<any>("acquire-control", { viewerToken: human.viewerToken, takeover: true });
    expect((await tool("tab_close")).error).toBe(true);
    expect((await tool("acquire_control")).error).toBe(true);
    await bridge.requestBrowser("release-control", { viewerToken: human.viewerToken, controlToken: controlled.controlToken });
    expect((await tool("acquire_control")).value.state.controller).toBe("self");
    expect((await tool("tab_close")).error).toBe(false);
    expect((await tool("tabs")).value.tabs.map((tab: { id: string }) => tab.id)).toEqual([original]);
    expect((await tool("tab_select", { tabId: second })).error).toBe(true);
    expect((await tool("status")).value.state.tabId).toBe(original);
    await bridge.requestBrowser("detach", { viewerToken: human.viewerToken });
  } finally {
    try {
      if (transport.pid && identity) expect(processIdentity()).toBe(identity);
      await client.close(); await bridge.archiveWorkspace("owned-mcp-workspace"); await bridge.archiveWorkspace("owned-foreign-workspace");
    } finally {
      rawAgent.disconnect(); bridge.disconnect(); await server.close(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}, 45_000);
