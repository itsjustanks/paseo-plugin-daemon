import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpUnknownOutcomeError } from "../../server/managed-browser/cdp";
import {
  type AgentBrowserOperation,
  type BridgeLease,
  type JsonValue,
  RUNTIME_PROTOCOL_VERSION,
} from "../../server/managed-browser/runtime-protocol";
import {
  type RuntimeInstance,
  type RuntimeOwner,
  RuntimeSupervisor,
  resolveSupervisorPaths,
  startSupervisorServer,
} from "../../server/managed-browser/supervisor";
import { AgentSupervisorClient, SupervisorClient } from "../../server/managed-browser/supervisor-client";
import type { BrowserState } from "../../shared/managed-browser/browser";
import { DEFAULT_CAPTURE_QUALITY, JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";

interface AgentRuntime extends RuntimeInstance {
  workspaceId: string;
}

interface RuntimeState {
  url: string;
  viewport: { width: number; height: number };
}

class AgentRuntimeOwner implements RuntimeOwner<AgentRuntime> {
  readonly states = new Map<string, RuntimeState>();
  readonly stopped: AgentRuntime[] = [];
  readonly operations: string[] = [];
  failNextMutationUnknown = false;

  async create(workspaceId: string): Promise<AgentRuntime> {
    this.states.set(workspaceId, {
      url: `https://${workspaceId}.example/`,
      viewport: { width: 1280, height: 800 },
    });
    return { workspaceId, runtimeId: `runtime_${workspaceId}_${"r".repeat(32)}` };
  }

  async request(runtime: AgentRuntime, operation: string, input: JsonValue): Promise<JsonValue> {
    const state = this.states.get(runtime.workspaceId);
    if (!state) throw new Error(`Runtime is stopped: ${runtime.workspaceId}`);
    this.operations.push(operation);
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (this.failNextMutationUnknown && operation === "navigate") {
      this.failNextMutationUnknown = false;
      throw new CdpUnknownOutcomeError("mutation timed out");
    }
    switch (operation) {
      case "identity":
        return { userAgent: "Fake Chromium" };
      case "state":
        return {
          url: state.url,
          title: runtime.workspaceId,
          canGoBack: false,
          canGoForward: false,
          inputGeneration: "0:0",
        };
      case "navigate":
        state.url = String(data.url);
        return null;
      case "emulate":
        state.viewport = { width: Number(data.width), height: Number(data.height) };
        return null;
      case "frame": {
        const bytes = Buffer.from(`frame:${runtime.workspaceId}`);
        return {
          transport: "cdp-screencast",
          dataBase64: bytes.toString("base64"),
          byteLength: bytes.byteLength,
          width: state.viewport.width,
          height: state.viewport.height,
          capturedAt: "2026-09-12T00:00:00.000Z",
        };
      }
      case "reload":
      case "screencast.start":
      case "screencast.stop":
      case "mouse.move":
      case "mouse.down":
      case "mouse.up":
      case "mouse.wheel":
      case "text.insert":
      case "input.begin":
      case "input.end":
      case "key.down":
      case "key.up":
        return null;
      default:
        throw new Error(`Unexpected runtime operation: ${operation}`);
    }
  }

  async stop(runtime: AgentRuntime): Promise<void> {
    this.stopped.push(runtime);
    this.states.delete(runtime.workspaceId);
  }
}

const supervisors: RuntimeSupervisor<AgentRuntime>[] = [];
let requestId = 0;

function createHarness(now: () => number = Date.now) {
  const owner = new AgentRuntimeOwner();
  const supervisor = new RuntimeSupervisor({ owner, now });
  supervisors.push(supervisor);
  return { owner, supervisor, bridge: supervisor.claimBridge("plugin-bridge") };
}

async function browserRequest<Result>(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  operation: string,
  input: JsonValue,
): Promise<Result> {
  return (await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "browser.request",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    operation,
    input,
  })) as unknown as Result;
}

async function issueTicket(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  ticket: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "ticket.issue",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
  });
}

async function bindTicket(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  ticket: string,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "ticket.bind",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
    agentId,
    workspaceId,
  });
}

async function revokeAgent(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  bridge: BridgeLease,
  agentId: string,
): Promise<void> {
  await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    token: "unused-by-direct-dispatch",
    method: "agent.revoke",
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    agentId,
  });
}

async function agentRequest<Result>(
  supervisor: RuntimeSupervisor<AgentRuntime>,
  ticket: string,
  operation: AgentBrowserOperation,
  input: JsonValue = {},
): Promise<Result> {
  return (await supervisor.dispatch({
    id: `request-${++requestId}`,
    version: RUNTIME_PROTOCOL_VERSION,
    method: "agent.request",
    ticket,
    operation,
    input,
  })) as unknown as Result;
}

function ticket(label: string): string {
  return `${label}_${"x".repeat(40)}`;
}

function stateOf(result: { state: BrowserState }): BrowserState {
  return result.state;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
});

/** Pause a real policy metadata read without introducing sockets or a browser. */
function holdNextMetadata(owner: AgentRuntimeOwner) {
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = owner.request.bind(owner);
  let hold = true;
  owner.request = async (runtime, operation, input) => {
    if (operation === "state" && hold) {
      hold = false;
      entered();
      await gate;
    }
    return original(runtime, operation, input);
  };
  return { pending, release };
}

describe("agent hosts-browser authorization", () => {
  it("refuses revoked acquisition during attachment and removes the late viewer", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("revoked-attach");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    const hold = holdNextMetadata(owner);
    const acquiring = agentRequest(supervisor, agentTicket, "acquire-control");
    const refused = expect(acquiring).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await hold.pending;
    await revokeAgent(supervisor, bridge, "agent-one");
    hold.release();
    await refused;
    const human = await browserRequest<{ state: BrowserState }>(supervisor, bridge, "attach", { create: true,
      workspaceId: "workspace-one",
      viewerLabel: "Human",
    });
    expect(human.state.viewerCount).toBe(1);
    expect(human.state.controller).toBe("none");
  });

  it("refuses revoked queued native publication without replaying the mutation", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("revoked-mutation");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    const hold = holdNextMetadata(owner);
    const reading = supervisor.requestWorkspace(
      bridge.bridgeId,
      bridge.epoch,
      "workspace-one",
      "state",
      null,
    );
    await hold.pending;
    const navigating = agentRequest(supervisor, agentTicket, "navigate", {
      action: { kind: "goto", url: "https://must-not-publish.example/" },
    });
    const refused = expect(navigating).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const revoking = revokeAgent(supervisor, bridge, "agent-one");
    hold.release();
    await reading;
    await refused;
    await revoking;
    expect(owner.states.get("workspace-one")?.url).toBe("https://workspace-one.example/");
  });

  for (const heldCase of [
    { name: "key", down: "key.down", up: "key.up", event: { kind: "key", key: "Enter" } },
    {
      name: "button",
      down: "mouse.down",
      up: "mouse.up",
      event: {
        kind: "click",
        button: "left",
        clickCount: 1,
        point: { x: 30, y: 30, width: 1280, height: 800 },
      },
    },
  ]) {
    it(`releases an acknowledged ${heldCase.name} after revocation without admitting another press`, async () => {
      const { owner, supervisor, bridge } = createHarness();
      const agentTicket = ticket("revoked-held-key");
      await issueTicket(supervisor, bridge, agentTicket);
      await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
      await agentRequest(supervisor, agentTicket, "acquire-control");
      await agentRequest(supervisor, agentTicket, "capture");
      let entered!: () => void;
      let release!: () => void;
      const pressed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events: string[] = [];
      const original = owner.request.bind(owner);
      owner.request = async (runtime, operation, input) => {
        if (operation === heldCase.down) {
          events.push("down");
          entered();
          await gate;
        }
        if (operation === heldCase.up) events.push("up");
        return original(runtime, operation, input);
      };
      const input = agentRequest(supervisor, agentTicket, "input", {
        event: heldCase.event,
      } as JsonValue);
      const refused = expect(input).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      await pressed;
      const revoking = revokeAgent(supervisor, bridge, "agent-one");
      release();
      await refused;
      await revoking;
      expect(events).toEqual(["down", "up"]);
    });
  }

  it("cleans revoked uncertain-down intent on its original runtime without replay", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("revoked-uncertain-down");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    await agentRequest(supervisor, agentTicket, "capture");
    let entered!: () => void;
    let release!: () => void;
    const pressed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const original = owner.request.bind(owner);
    owner.request = async (runtime, operation, input) => {
      if (operation === "key.down") {
        events.push("down");
        entered();
        await gate;
        throw new CdpUnknownOutcomeError("Original down outcome unknown");
      }
      if (operation === "input.end") events.push("cleanup");
      return original(runtime, operation, input);
    };
    const input = agentRequest(supervisor, agentTicket, "input", {
      event: { kind: "key", key: "Enter" },
    });
    const refused = expect(input).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    await pressed;
    const revoking = revokeAgent(supervisor, bridge, "agent-one");
    release();
    await refused;
    await revoking;
    expect(events).toEqual(["down", "cleanup"]);
  });

  it("validates raw agent mutation fields before any native action", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("validated-input");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    await agentRequest(supervisor, agentTicket, "capture");
    const published: string[] = [];
    const original = owner.request.bind(owner);
    owner.request = async (runtime, operation, input) => {
      published.push(operation);
      return original(runtime, operation, input);
    };
    const invalid: { operation: AgentBrowserOperation; input: JsonValue }[] = [
      { operation: "input", input: { event: { kind: "type", text: "x".repeat(16001) } } },
      { operation: "input", input: { event: { kind: "key", key: "Control" } } },
      {
        operation: "input",
        input: { event: { kind: "click", point: { x: -1, y: 5, width: 100, height: 100 } } },
      },
      { operation: "navigate", input: { action: { kind: "invalid" } } },
      { operation: "viewport", input: { viewport: { width: 0, height: 800 } } },
    ];
    for (const request of invalid) {
      await expect(
        agentRequest(supervisor, agentTicket, request.operation, request.input),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "Invalid agent browser request",
      });
    }
    expect(published).toEqual([]);
    await agentRequest(supervisor, agentTicket, "input", {
      event: { kind: "type", text: "Valid committed text" },
    });
    expect(published.filter((operation) => operation === "text.insert")).toEqual(["text.insert"]);
  });

  it("enforces the 1600x1200 agent viewport at the raw ticket boundary, before any mutation", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("viewport-cap");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    const published: string[] = [];
    const original = owner.request.bind(owner);
    owner.request = async (runtime, operation, input) => {
      published.push(operation);
      return original(runtime, operation, input);
    };
    for (const viewport of [
      { width: 1601, height: 1200 },
      { width: 1600, height: 1201 },
      { width: 2560, height: 2560 },
    ]) {
      await expect(
        agentRequest(supervisor, agentTicket, "viewport", { viewport }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "Invalid agent browser request",
      });
    }
    expect(published.filter((operation) => operation === "emulate")).toEqual([]);
    await agentRequest(supervisor, agentTicket, "viewport", {
      viewport: { width: 1600, height: 1200 },
    });
    expect(published.filter((operation) => operation === "emulate")).toEqual(["emulate"]);
  });

  it("keeps every explicit agent capture quality and defaults only when omitted", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("capture-quality");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    const qualities: unknown[] = [];
    const original = owner.request.bind(owner);
    owner.request = async (runtime, operation, input) => {
      if (operation === "frame") qualities.push((input as { quality?: unknown }).quality);
      return original(runtime, operation, input);
    };
    await agentRequest(supervisor, agentTicket, "capture", {});
    await agentRequest(supervisor, agentTicket, "capture", { quality: "high" });
    await agentRequest(supervisor, agentTicket, "capture", { quality: "low" });
    expect(qualities).toEqual([JPEG_QUALITY.medium, JPEG_QUALITY.high, JPEG_QUALITY.low]);
    expect(DEFAULT_CAPTURE_QUALITY).toBe("medium");
  });

  it("uses an opaque agent ticket without claiming or fencing the admin bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-browser-agent-client-"));
    const paths = resolveSupervisorPaths(root);
    const owner = new AgentRuntimeOwner();
    const server = await startSupervisorServer(owner, paths);
    const admin = new SupervisorClient({ bridgeId: "plugin-bridge", paths });
    const agentTicket = ticket("opaque");
    const agent = new AgentSupervisorClient({ ticket: agentTicket, paths });
    try {
      await admin.connect();
      await admin.issueAgentTicket(agentTicket);
      await admin.bindAgentTicket(agentTicket, "agent-one", "workspace-one");
      await agent.open();

      const observed = await agent.request("status", {});
      expect(stateOf(observed as unknown as { state: BrowserState })).toMatchObject({
        workspaceId: "workspace-one",
        bridgeEpoch: 1,
      });
      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });

      agent.disconnect();
      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });
      expect(owner.stopped).toEqual([]);
    } finally {
      agent.disconnect();
      admin.disconnect();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const rejection of ["expired", "context-changed"] as const) {
    it(`redacts ${rejection} diagnostics through the actual agent socket and retains native cleanup`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hosts-browser-frame-rejection-"));
      const paths = resolveSupervisorPaths(root);
      let clock = 1_000;
      const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const owner = new AgentRuntimeOwner();
      const calls: string[] = [];
      let generation = "0:0";
      const original = owner.request.bind(owner);
      owner.request = async (runtime, operation, input) => {
        calls.push(operation);
        const result = await original(runtime, operation, input);
        if (operation === "key.down" && rejection === "context-changed") generation = "0:1";
        if (operation === "state")
          return { ...(result as Record<string, JsonValue>), inputGeneration: generation };
        return result;
      };
      const server = await startSupervisorServer(owner, paths);
      const admin = new SupervisorClient({ bridgeId: "private-plugin-bridge", paths });
      const agentTicket = ticket("private-agent-ticket");
      const agent = new AgentSupervisorClient({ ticket: agentTicket, paths });
      try {
        await admin.connect();
        await admin.issueAgentTicket(agentTicket);
        await admin.bindAgentTicket(agentTicket, "private-agent", "private-workspace");
        await agent.open();
        await agent.request("acquire-control", {});
        const captured = await agent.request("capture", {});
        if (rejection === "expired") clock += 5_000;
        let failure: unknown;
        try {
          await agent.request("input", { event: { kind: "key", key: "End" } });
        } catch (error) {
          failure = error;
        }
        const message =
          rejection === "expired"
            ? "Browser frame is stale (stage=admission; reason=expired; ageMs=5000)"
            : "Browser frame is stale (stage=admitted-input; reason=context-changed)";
        expect(failure).toMatchObject({ code: "RUNTIME_FAILURE", message });
        const serialized = JSON.stringify(failure);
        expect(serialized).not.toMatch(
          /private-|https:|runtime_|viewerToken|controlToken|frameId|sessionId/,
        );
        expect(serialized).not.toContain(agentTicket);
        const authority = captured as unknown as {
          state: BrowserState;
          frame: { frameId: string };
        };
        for (const value of [
          authority.state.sessionId,
          authority.state.runtimeId,
          authority.frame.frameId,
        ]) {
          expect(serialized).not.toContain(value);
        }
        const publications = calls.filter((operation) =>
          /^(?:mouse\.|key\.|text\.|input\.)/.test(operation),
        );
        expect(publications).toEqual(
          rejection === "expired" ? [] : ["input.begin", "key.down", "key.up", "input.end"],
        );
      } finally {
        agent.disconnect();
        admin.disconnect();
        await server.close();
        clockSpy.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("reclaims the cached plugin bridge after its socket closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-browser-reconnect-"));
    const paths = resolveSupervisorPaths(root);
    const owner = new AgentRuntimeOwner();
    const server = await startSupervisorServer(owner, paths);
    const admin = new SupervisorClient({ bridgeId: "plugin-bridge", paths });
    try {
      await admin.connect();
      await admin.requestBrowser("attach", { create: true, workspaceId: "workspace-one", viewerLabel: "Human" });
      admin.disconnect();

      await expect(admin.requestBrowser("list", {})).resolves.toEqual({
        workspaceIds: ["workspace-one"],
      });
    } finally {
      admin.disconnect();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a ticket bound to its assigned agent and workspace", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("bound");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");

    await expect(
      bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-two"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(
      bindTicket(supervisor, bridge, agentTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    await browserRequest(supervisor, bridge, "attach", { create: true,
      workspaceId: "workspace-two",
      viewerLabel: "Human",
    });
    const observed = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "status",
      {
        workspaceId: "workspace-two",
      },
    );
    expect(observed.state.workspaceId).toBe("workspace-one");

    await agentRequest(supervisor, agentTicket, "acquire-control");
    await agentRequest(supervisor, agentTicket, "navigate", {
      workspaceId: "workspace-two",
      action: { kind: "goto", url: "https://agent.example/" },
    });
    expect(owner.states.get("workspace-one")?.url).toBe("https://agent.example/");
    expect(owner.states.get("workspace-two")?.url).toBe("https://workspace-two.example/");
  });

  it("keeps an agent's selected tab and control when a human changes another tab", async () => {
    const owner = new AgentRuntimeOwner();
    const originalRequest = owner.request.bind(owner);
    let secondUrl = "https://second.example/";
    let hasSecondTab = false;
    owner.request = async (runtime, operation, input) => {
      const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      if (operation === "tabs.create") {
        hasSecondTab = true;
        return { targetId: "page-two" };
      }
      if (operation === "tabs.close") {
        hasSecondTab = false;
        return null;
      }
      if (operation === "tabs.list") {
        return [
          { targetId: "page-one", title: "First", url: "https://first.example/" },
          ...(hasSecondTab ? [{ targetId: "page-two", title: "Second", url: secondUrl }] : []),
        ];
      }
      if (operation === "identity") {
        return { userAgent: "Fake Chromium", targetId: data.targetId ?? "page-one" };
      }
      if (data.targetId === "page-two") {
        if (operation === "state") {
          return {
            url: secondUrl,
            title: "Second",
            canGoBack: false,
            canGoForward: false,
            inputGeneration: "0:0",
          };
        }
        if (operation === "navigate") {
          secondUrl = String(data.url);
          return null;
        }
        if (operation === "emulate") return null;
      }
      return originalRequest(runtime, operation, input);
    };
    const supervisor = new RuntimeSupervisor({ owner, maxWorkspaces: 1 });
    supervisors.push(supervisor);
    const bridge = supervisor.claimBridge("plugin-bridge");
    const agentTicket = ticket("independent-tab");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");
    await agentRequest(supervisor, agentTicket, "acquire-control");

    const human = await browserRequest<{ viewerToken: string }>(supervisor, bridge, "attach", { create: true,
      workspaceId: "workspace-one",
      viewerLabel: "Human",
    });
    const created = await browserRequest<{ tabId: string }>(supervisor, bridge, "tabs.create", {
      viewerToken: human.viewerToken,
    });
    const humanTab = await browserRequest<{ viewerToken: string }>(supervisor, bridge, "attach", { create: true,
      workspaceId: "workspace-one",
      viewerLabel: "Human second tab",
      tabId: created.tabId,
    });
    const humanControl = await browserRequest<{ controlToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "acquire-control",
      { viewerToken: humanTab.viewerToken, takeover: false },
    );
    await browserRequest(supervisor, bridge, "navigate", {
      viewerToken: humanTab.viewerToken,
      controlToken: humanControl.controlToken,
      expected: {
        sessionId: humanControl.state.sessionId,
        navigationGeneration: humanControl.state.navigationGeneration,
        viewportGeneration: humanControl.state.viewportGeneration,
      },
      action: { kind: "goto", url: "https://changed-second.example/" },
    });

    await expect(
      agentRequest<{ state: BrowserState }>(supervisor, agentTicket, "navigate", {
        action: { kind: "goto", url: "https://agent-first.example/" },
      }),
    ).resolves.toMatchObject({ state: { tabId: "page-one", controller: "self" } });
    expect(owner.states.get("workspace-one")?.url).toBe("https://agent-first.example/");
    expect(secondUrl).toBe("https://changed-second.example/");

    await browserRequest(supervisor, bridge, "release-control", {
      viewerToken: humanTab.viewerToken,
      controlToken: humanControl.controlToken,
    });
    const selected = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "tabs.select",
      { tabId: created.tabId },
    );
    expect(selected.state.tabId).toBe("page-two");
    const agentControl = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "acquire-control",
    );
    expect(agentControl.state.controller).toBe("self");
    const humanFirstControl = await browserRequest<{ state: BrowserState }>(
      supervisor,
      bridge,
      "acquire-control",
      { viewerToken: human.viewerToken, takeover: false },
    );
    expect(humanFirstControl.state.controller).toBe("self");

    await agentRequest(supervisor, agentTicket, "navigate", {
      action: { kind: "goto", url: "https://agent-second.example/" },
    });
    expect(secondUrl).toBe("https://agent-second.example/");
    expect(owner.states.get("workspace-one")?.url).toBe("https://agent-first.example/");
    expect(
      (await agentRequest<{ selectedTabId: string }>(supervisor, agentTicket, "tabs.list"))
        .selectedTabId,
    ).toBe("page-two");

    const closed = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "tabs.close",
    );
    expect(closed.state.tabId).toBe("page-one");
    expect(
      (
        await browserRequest<{ state: BrowserState }>(supervisor, bridge, "status", {
          viewerToken: human.viewerToken,
        })
      ).state.controller,
    ).toBe("self");
  });

  it("keeps an agent ticket bound across human close and explicit reopen", async () => {
    const { supervisor, bridge } = createHarness();
    const agentTicket = ticket("closed-and-reopened");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");

    const human = await browserRequest<{ viewerToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "attach",
      { create: true, workspaceId: "workspace-one", viewerLabel: "Human" },
    );
    const control = await browserRequest<{ controlToken: string }>(
      supervisor,
      bridge,
      "acquire-control",
      { viewerToken: human.viewerToken, takeover: false },
    );
    const runtimeId = human.state.runtimeId;
    if (!runtimeId) throw new Error("Attached browser has no runtime identity");
    await browserRequest(supervisor, bridge, "close", {
      viewerToken: human.viewerToken,
      controlToken: control.controlToken,
      sessionId: human.state.sessionId,
      runtimeId,
    });

    await expect(agentRequest(supervisor, agentTicket, "status")).rejects.toThrow(
      "Browser is closed",
    );
    await browserRequest(supervisor, bridge, "reopen", { workspaceId: "workspace-one" });
    await expect(agentRequest(supervisor, agentTicket, "status")).resolves.toMatchObject({
      state: { workspaceId: "workspace-one" },
    });
  });

  it("fails closed for null, unknown, history-only, unbound, and revoked credentials", async () => {
    const { supervisor, bridge } = createHarness();
    const historyOnlyTicket = ticket("history");
    const revokedTicket = ticket("revoked");
    await issueTicket(supervisor, bridge, historyOnlyTicket);
    await issueTicket(supervisor, bridge, revokedTicket);

    await expect(
      agentRequest(supervisor, null as unknown as string, "status"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(agentRequest(supervisor, ticket("unknown"), "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(agentRequest(supervisor, historyOnlyTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });

    await bindTicket(supervisor, bridge, revokedTicket, "agent-revoked", "workspace-one");
    await expect(agentRequest(supervisor, revokedTicket, "status")).resolves.toBeDefined();
    await revokeAgent(supervisor, bridge, "agent-revoked");
    await expect(agentRequest(supervisor, revokedTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("expires unbound tickets while retaining bound credentials", async () => {
    let now = 1_000;
    const owner = new AgentRuntimeOwner();
    const supervisor = new RuntimeSupervisor({ owner, now: () => now });
    supervisors.push(supervisor);
    const bridge = supervisor.claimBridge("plugin-bridge");
    const expiredTicket = ticket("expired");
    const boundTicket = ticket("bound-retained");
    await issueTicket(supervisor, bridge, expiredTicket);
    await issueTicket(supervisor, bridge, boundTicket);
    await bindTicket(supervisor, bridge, boundTicket, "agent-one", "workspace-one");
    while (now < 581_000) {
      now += 29_000;
      supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    }
    now = 601_000;

    await expect(
      bindTicket(supervisor, bridge, expiredTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(agentRequest(supervisor, boundTicket, "status")).resolves.toBeDefined();
  });

  it("fails closed for status and capture while the plugin bridge is unavailable", async () => {
    const { supervisor, bridge } = createHarness();
    const agentTicket = ticket("bridge-unavailable");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    supervisor.bridgeDisconnected(bridge.bridgeId, bridge.epoch);

    await expect(agentRequest(supervisor, agentTicket, "status")).rejects.toMatchObject({
      code: "BRIDGE_FENCED",
    });
    await expect(agentRequest(supervisor, agentTicket, "capture")).rejects.toMatchObject({
      code: "BRIDGE_FENCED",
    });
  });

  it("returns UNKNOWN_OUTCOME and invalidates an agent mutation observation", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("unknown-outcome");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    owner.failNextMutationUnknown = true;

    await expect(
      agentRequest(supervisor, agentTicket, "navigate", {
        action: { kind: "goto", url: "https://unknown-outcome.example/" },
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    await expect(
      agentRequest(supervisor, agentTicket, "navigate", {
        action: { kind: "goto", url: "https://unknown-outcome.example/" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("denies agent takeover and revokes agent mutation authority after human takeover", async () => {
    const { supervisor, bridge } = createHarness();
    const agentTicket = ticket("control");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    const human = await browserRequest<{ viewerToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "attach",
      { create: true, workspaceId: "workspace-one", viewerLabel: "Human" },
    );
    const humanControl = await browserRequest<{ controlToken: string; state: BrowserState }>(
      supervisor,
      bridge,
      "acquire-control",
      { viewerToken: human.viewerToken, takeover: false },
    );

    await expect(
      agentRequest(supervisor, agentTicket, "acquire-control", { takeover: true }),
    ).rejects.toThrow("held by another viewer");

    await browserRequest(supervisor, bridge, "release-control", {
      viewerToken: human.viewerToken,
      controlToken: humanControl.controlToken,
    });
    await agentRequest(supervisor, agentTicket, "acquire-control");
    await browserRequest(supervisor, bridge, "acquire-control", {
      viewerToken: human.viewerToken,
      takeover: true,
    });

    await expect(
      agentRequest(supervisor, agentTicket, "navigate", { action: { kind: "reload" } }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("does not extend agent control through observation or capture", async () => {
    let now = 1_000;
    const { supervisor, bridge } = createHarness(() => now);
    const agentTicket = ticket("expiry");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");
    const acquired = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "acquire-control",
    );
    expect(acquired.state.controller).toBe("self");

    now = 30_000;
    expect(
      stateOf(await agentRequest(supervisor, agentTicket, "capture", { quality: "medium" }))
        .controller,
    ).toBe("self");
    supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    now = 31_001;
    expect(stateOf(await agentRequest(supervisor, agentTicket, "status")).controller).toBe("none");
    await expect(
      agentRequest(supervisor, agentTicket, "navigate", { action: { kind: "reload" } }),
    ).rejects.toThrow("lease is invalid or expired");
  });

  it("reselects the same tab and reacquires control after its viewer expires", async () => {
    let now = 1_000;
    const { owner, supervisor, bridge } = createHarness(() => now);
    const original = owner.request.bind(owner);
    owner.request = async (runtime, operation, input) => {
      if (operation === "identity") {
        return { targetId: "page-one", userAgent: "Fake Chromium" };
      }
      return original(runtime, operation, input);
    };
    const agentTicket = ticket("idle-tab-select");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "acquire-control");
    now = 30_000;
    supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    now = 46_001;
    await expect(
      agentRequest(supervisor, agentTicket, "tabs.select", { tabId: "page-one" }),
    ).resolves.toMatchObject({ state: { tabId: "page-one", controller: "none" } });
    await expect(agentRequest(supervisor, agentTicket, "acquire-control")).resolves.toMatchObject({
      state: { tabId: "page-one", controller: "self" },
    });
  });

  it("archives the runtime and permanently fences every ticket bound to its workspace", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("archive");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");

    await browserRequest(supervisor, bridge, "archive", { workspaceId: "workspace-one" });

    expect(owner.stopped.map(({ workspaceId }) => workspaceId)).toEqual(["workspace-one"]);
    await expect(agentRequest(supervisor, agentTicket, "status")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(
      supervisor.ensureWorkspace(bridge.bridgeId, bridge.epoch, "workspace-one"),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    const lateTicket = ticket("late");
    await issueTicket(supervisor, bridge, lateTicket);
    await expect(
      bindTicket(supervisor, bridge, lateTicket, "agent-two", "workspace-one"),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
  });

  it("dispatches agent input only with control and a freshly captured frame", async () => {
    const { owner, supervisor, bridge } = createHarness();
    const agentTicket = ticket("input");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    const click = {
      event: {
        kind: "click",
        point: { x: 10, y: 20, width: 1280, height: 800 },
        button: "left",
        clickCount: 1,
      },
    } as JsonValue;

    await agentRequest(supervisor, agentTicket, "status");
    await expect(agentRequest(supervisor, agentTicket, "input", click)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expect(owner.operations).not.toContain("mouse.down");

    await agentRequest(supervisor, agentTicket, "acquire-control");
    await expect(agentRequest(supervisor, agentTicket, "input", click)).rejects.toThrow(
      "Capture a frame before sending input",
    );
    await agentRequest(supervisor, agentTicket, "capture", { quality: "medium" });
    const result = await agentRequest<{ state: BrowserState }>(
      supervisor,
      agentTicket,
      "input",
      click,
    );
    expect(result.state.controller).toBe("self");
    expect(owner.operations.filter((op) => op.startsWith("mouse."))).toEqual([
      "mouse.move",
      "mouse.down",
      "mouse.up",
    ]);

    await expect(agentRequest(supervisor, agentTicket, "input", click)).rejects.toThrow(
      "Capture a frame before sending input",
    );
  });

  it("replaces a lapsed agent viewer before creating a tab, creating exactly one page", async () => {
    let clock = 1_000;
    const { owner, supervisor, bridge } = createHarness(() => clock);
    const originalRequest = owner.request.bind(owner);
    let creates = 0;
    owner.request = async (runtime, operation, input) => {
      const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      if (operation === "tabs.create") {
        creates += 1;
        return { targetId: "page-two" };
      }
      if (operation === "tabs.list") {
        return [
          { targetId: "page-one", title: "First", url: "https://first.example/" },
          ...(creates
            ? [{ targetId: "page-two", title: "Second", url: "https://second.example/" }]
            : []),
        ];
      }
      if (operation === "identity") {
        return { userAgent: "Fake Chromium", targetId: data.targetId ?? "page-one" };
      }
      if (data.targetId === "page-two") {
        if (operation === "state") {
          return {
            url: "https://second.example/",
            title: "Second",
            canGoBack: false,
            canGoForward: false,
            inputGeneration: "0:0",
          };
        }
        if (operation === "emulate") return null;
      }
      return originalRequest(runtime, operation, input);
    };
    const agentTicket = ticket("lapsed-viewer-tab");
    await issueTicket(supervisor, bridge, agentTicket);
    await bindTicket(supervisor, bridge, agentTicket, "agent-one", "workspace-one");
    await agentRequest(supervisor, agentTicket, "status");

    // Beyond the 45 s viewer lease, within each bridge lease.
    for (let step = 0; step < 3; step += 1) {
      clock += 20_000;
      supervisor.heartbeat(bridge.bridgeId, bridge.epoch);
    }
    const result = await agentRequest<{ tabId: string; state: BrowserState }>(
      supervisor,
      agentTicket,
      "tabs.create",
    );
    expect(result.tabId).toBe("page-two");
    expect(result.state.tabId).toBe("page-two");
    expect(creates).toBe(1);
  });
});
