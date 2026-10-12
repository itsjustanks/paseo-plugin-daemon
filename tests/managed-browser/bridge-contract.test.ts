import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startSupervisorServer, resolveSupervisorPaths } from "../../server/managed-browser/supervisor";
import { AgentSupervisorClient, SupervisorClient } from "../../server/managed-browser/supervisor-client";
import type { JsonValue } from "../../server/managed-browser/runtime-protocol";
import { DEVICE_PRESETS } from "../../shared/managed-browser/browser";

it("registers real bridge contracts, preserves agent configuration, enforces human priority, and closes owned state", async () => {
  const home = await mkdtemp(join(tmpdir(), "hosts-bridge-contract-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.resetModules();
  const { contributeManagedBrowser } = await import("../../server/managed-browser/register");
  const handlers = new Map<string, any>(); const hooks = new Map<string, any>(); const events = new Map<string, any>();
  let created = 0; let stopped = 0; let tabCount = 1;
  const pages = new Map<string, { url: string; width: number; height: number }>();
  const owner = {
    async create(workspaceId: string) { created++; pages.set(workspaceId, { url: "about:blank", width: 1280, height: 800 }); return { runtimeId: randomUUID(), workspaceId }; },
    async request(runtime: { workspaceId: string }, operation: string, input: JsonValue): Promise<JsonValue> {
      const state = pages.get(runtime.workspaceId)!; const data = (input ?? {}) as Record<string, JsonValue>;
      if (operation === "identity") return { userAgent: "Fixture Chromium", targetId: "tab-one" };
      if (operation === "state") return { url: state.url, title: "Fixture", canGoBack: false, canGoForward: false, inputGeneration: "0:0" };
      if (operation === "emulate") { state.width = Number(data.width); state.height = Number(data.height); }
      if (operation === "navigate") state.url = String(data.url);
      if (operation === "tabs.list") return [{ targetId: "tab-one", title: "One", url: state.url }, ...(tabCount > 1 ? [{ targetId: "tab-two", title: "Two", url: "about:blank" }] : [])];
      if (operation === "tabs.create") { tabCount = 2; return { targetId: "tab-two" }; }
      if (operation === "tabs.close") tabCount = 1;
      if (operation === "frame") { const bytes = Buffer.from("fixture-frame"); return { transport: "cdp-screencast", dataBase64: bytes.toString("base64"), byteLength: bytes.length, width: state.width, height: state.height, capturedAt: new Date().toISOString() }; }
      if (operation === "cursor") return "default";
      return null;
    },
    async stop() { stopped++; },
  };
  const running = await startSupervisorServer<Awaited<ReturnType<typeof owner.create>>>(owner, resolveSupervisorPaths(home));
  const close = contributeManagedBrowser({ registerSettings() {}, handle(contract: any, handler: any) { handlers.set(contract.name, { contract, handler }); },
    before(name: string, hook: any) { hooks.set(name, hook); }, on(name: string, hook: any) { events.set(name, hook); } } as any);
  const context = { signal: new AbortController().signal, paseo: { workspaces: { ref: (id: string) => ({ refresh: async () => id === "workspace" ? { id } : null }) }, config: { get: async () => ({ config: { providers: { alias: { extends: "codex" } } } }) } } };
  const rpc = async (name: string, input: any = {}) => { const entry = handlers.get(`daemon-link.browser.managed.${name}`); return entry.contract.output.parse(await entry.handler(entry.contract.input.parse(input), context)); };
  let agent: AgentSupervisorClient | undefined;
  try {
    const request = { config: { provider: "codex", mcpServers: { existing: { type: "stdio", command: "existing" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: "existing", tool: "read" }] } }, env: { RETAIN: "yes" } };
    expect(await hooks.get("agent.create")({ request }, context)).toBe(request); // Missing assets fail open for ordinary creation.
    expect((await rpc("presence")).workspaceIds).toEqual([]); expect(created).toBe(0);
    await expect(rpc("attach", { workspaceId: "missing", viewerLabel: "Human", create: true })).rejects.toThrow("Workspace not found");
    await expect(rpc("attach", { workspaceId: "workspace", viewerLabel: "Human" })).rejects.toThrow("Browser is closed");
    expect(created).toBe(0);
    const assets = join(home, "plugin-data/daemon-link/browser/.runtime-123e4567-e89b-42d3-a456-426614174000");
    await mkdir(join(assets, "node/bin"), { recursive: true });
    await writeFile(join(assets, "node/bin/node"), "owned test executable"); await chmod(join(assets, "node/bin/node"), 0o700);
    await writeFile(join(assets, "supervisor.cjs"), "fixture"); await writeFile(join(assets, "hosts-browser-mcp.cjs"), "fixture");
    await writeFile(join(assets, "../runtime-current"), ".runtime-123e4567-e89b-42d3-a456-426614174000");
    const unsupported = { ...request, config: { provider: "unsupported" } };
    expect(await hooks.get("agent.create")({ request: unsupported }, context)).toBe(unsupported);
    const collision = { ...request, config: { ...request.config, mcpServers: { "hosts-browser": { type: "stdio", command: "retained" } } } };
    expect(await hooks.get("agent.create")({ request: collision }, context)).toBe(collision);
    const injected = await hooks.get("agent.create")({ request }, context);
    expect(injected.config.mcpServers.existing).toEqual(request.config.mcpServers.existing);
    expect(injected.config.toolPolicy).toEqual(request.config.toolPolicy);
    expect(injected.config.mcpServers["hosts-browser"].command).toBe(join(assets, "node/bin/node"));
    expect(injected.config.mcpServers["hosts-browser"].args).toEqual([join(assets, "hosts-browser-mcp.cjs")]);
    expect(created).toBe(0); // Issuing a ticket starts no Chromium.
    const opened = await hooks.get("agent.session_open")({ request: { reason: "create", purpose: "interactive", workspaceId: "workspace", agentId: "agent", env: injected.env } }, context);
    expect(opened.env).toEqual({ RETAIN: "yes" });
    agent = new AgentSupervisorClient({ ticket: injected.env.HOSTS_BROWSER_TICKET, paths: resolveSupervisorPaths(home) }); await agent.open();
    await agent.request("status", {}); await agent.request("acquire-control", {}); expect(created).toBe(1);
    const attached = await rpc("attach", { workspaceId: "workspace", viewerLabel: "Human" });
    const viewerToken = attached.viewerToken;
    const controlled = await rpc("control.acquire", { viewerToken, takeover: true });
    const controlToken = controlled.controlToken;
    await expect(agent.request("navigate", { action: { kind: "goto", url: "https://fixture.invalid/" } })).rejects.toThrow();
    let state = controlled.state;
    const expected = () => ({ sessionId: state.sessionId, navigationGeneration: state.navigationGeneration, viewportGeneration: state.viewportGeneration });
    state = (await rpc("navigate", { viewerToken, controlToken, expected: expected(), action: { kind: "goto", url: "http://127.0.0.1:12345/fixture" } })).state;
    let captured = await rpc("capture", { viewerToken });
    const target = () => ({ frameId: captured.frame.frameId, navigationGeneration: captured.frame.navigationGeneration, viewportGeneration: captured.frame.viewportGeneration });
    state = (await rpc("input", { viewerToken, controlToken, expected: expected(), target: target(), event: { kind: "click", point: { x: 10, y: 10, width: captured.frame.width, height: captured.frame.height }, button: "left", clickCount: 1 } })).state;
    state = (await rpc("viewport.resize", { viewerToken, controlToken, expected: expected(), viewport: { width: 800, height: 600 } })).state;
    state = (await rpc("device.apply", { viewerToken, controlToken, expected: expected(), presetId: DEVICE_PRESETS[0]!.id })).state;
    state = (await rpc("capture.density", { viewerToken, controlToken, expected: expected(), density: 1 })).state;
    captured = await rpc("capture", { viewerToken }); state = captured.state;
    const gestureExpected = { ...expected(), runtimeId: state.runtimeId, bridgeEpoch: state.bridgeEpoch };
    const gesture = await rpc("gesture.begin", { viewerToken, controlToken, expected: gestureExpected, target: target(), pointerKind: "mouse" });
    const continued = await rpc("gesture.update", { viewerToken, controlToken, expected: gestureExpected, gestureId: gesture.gestureId, sequence: gesture.nextSequence, event: { kind: "move", point: { x: 20, y: 20, width: captured.frame.width, height: captured.frame.height } } });
    await rpc("gesture.end", { viewerToken, controlToken, expected: gestureExpected, gestureId: gesture.gestureId, sequence: continued.nextSequence, cancel: true });
    await rpc("tabs.create", { viewerToken }); expect((await rpc("tabs.list", { viewerToken })).tabs).toHaveLength(2);
    await rpc("control.release", { viewerToken, controlToken });
    await agent.request("status", {}); await agent.request("acquire-control", {});
    await events.get("agent.archived")({ agent: { id: "agent" } });
    await expect(agent.request("status", {})).rejects.toThrow();
    const reacquired = await rpc("control.acquire", { viewerToken, takeover: true }); state = reacquired.state;
    await rpc("close", { viewerToken, controlToken: reacquired.controlToken, sessionId: state.sessionId, runtimeId: state.runtimeId });
    expect(stopped).toBe(1); expect((await rpc("presence")).workspaceIds).toEqual([]);
    await rpc("reopen", { workspaceId: "workspace" });
    const reopened = await rpc("attach", { workspaceId: "workspace", viewerLabel: "Human", create: true });
    await rpc("detach", { viewerToken: reopened.viewerToken }); expect(created).toBe(2);
    await events.get("workspace.archived")({ workspace: { id: "workspace" } }); expect(stopped).toBe(2);
  } finally { agent?.disconnect(); close(); await running.close(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});

it.each(["bridge", "agent"])("bounds fragmented, coalesced and oversized %s replies without retaining bytes after disconnect", (kind) => {
  const client: any = kind === "bridge" ? new SupervisorClient({ bridgeId: "fixture" }) : new AgentSupervisorClient({ ticket: "fixture" });
  const a = vi.fn(); const b = vi.fn(); const rejected = vi.fn();
  client.pending.set("a", { resolve: a, reject: rejected }); client.pending.set("b", { resolve: b, reject: rejected });
  const first = JSON.stringify({ id: "a", ok: true, result: "x".repeat(600_000) });
  const second = JSON.stringify({ id: "b", ok: true, result: "y".repeat(600_000) });
  client.consume(first.slice(0, 10)); expect(a).not.toHaveBeenCalled();
  client.consume(first.slice(10) + "\n" + second + "\n"); expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
  client.pending.set("c", { resolve: vi.fn(), reject: rejected });
  client.consume("é".repeat(524_289)); expect(rejected).toHaveBeenCalledOnce(); expect(client.receiveBuffer).toBe("");
  client.disconnect?.(); client.close?.();
});
