import { resolveSupervisorPaths, type SupervisorPaths } from "./supervisor-paths";
export { resolveSupervisorPaths, type SupervisorPaths } from "./supervisor-paths";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";
import {
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  endBrowserGestureRpc,
  MAX_BROWSER_TABS,
  navigateBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "../../shared/managed-browser/browser";
import { readBrowserVideoRpc } from "../../shared/managed-browser/browser-video";
import { DEFAULT_CAPTURE_QUALITY } from "../../shared/managed-browser/capture-settings";
import { MAX_AGENT_VIEWPORT } from "../../shared/managed-browser/viewport-limits";
import { SessionManager } from "./browser-policy";
import { CdpUnknownOutcomeError } from "./cdp";
import {
  type BridgeLease,
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_ORPHAN_GRACE_MS,
  type JsonValue,
  parseRuntimeRequest,
  readRuntimeRequestId,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeDescriptor,
  RuntimeLostError,
  RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeResult,
} from "./runtime-protocol";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SOCKET_MODE = 0o600;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SUPERVISOR_WORKSPACES = 8;
const MAX_SOCKET_IN_FLIGHT = 16;
const MAX_GLOBAL_IN_FLIGHT = 64;
// Optional pixels must leave bounded headroom for ordered input and cleanup.
// JPEG fallback shares the media budget instead of filling those same slots.
const MAX_SOCKET_MEDIA_IN_FLIGHT = 12;
const MAX_GLOBAL_MEDIA_IN_FLIGHT = 48;
// The one active bridge needs maintenance capacity even when normal reads fill
// both limits. Duplicate maintenance remains bounded independently of work.
const MAX_HEARTBEATS_IN_FLIGHT = 1;
const AGENT_TICKET_TTL_MS = 10 * 60_000;
const MAX_UNBOUND_AGENT_TICKETS = 256;
type SupervisorTimer = NodeJS.Timeout;

export interface RuntimeInstance {
  runtimeId: string;
}

export interface RuntimeOwner<Runtime extends RuntimeInstance = RuntimeInstance> {
  create(workspaceId: string): Promise<Runtime>;
  request(runtime: Runtime, operation: string, input: JsonValue): Promise<JsonValue>;
  stop(runtime: Runtime): Promise<void>;
}

export interface RuntimeSupervisorOptions<Runtime extends RuntimeInstance> {
  owner: RuntimeOwner<Runtime>;
  now?: () => number;
  orphanGraceMs?: number;
  heartbeatIntervalMs?: number;
  bridgeTimeoutMs?: number;
  maxWorkspaces?: number;
  schedule?: (callback: () => void, delayMs: number) => SupervisorTimer;
  cancel?: (timer: SupervisorTimer) => void;
}

interface WorkspaceEntry<Runtime extends RuntimeInstance> {
  createdAt: number;
  lost?: boolean;
  runtime: Runtime;
}

interface ActiveBridge {
  bridgeId: string;
  epoch: number;
  expiresAt: number;
  ready: Promise<void>;
}

interface AgentBinding {
  issuedAt: number;
  ticket: string;
  agentId: string | null;
  workspaceId: string | null;
  tabId: string | null;
  selectionRevision: number;
  viewerToken: string | null;
  controlToken: string | null;
  lastState: BrowserState | null;
  lastFrame: BrowserFrame | null;
}

/** Pair cleanup with a down acknowledged in this exact request/runtime. */
interface AgentPublicationContext {
  binding: AgentBinding;
  selectionRevision: number;
  keys: Map<string, RuntimeInstance>;
  buttons: Map<string, RuntimeInstance>;
  channels: Map<string, RuntimeInstance>;
}

export class RuntimeSupervisor<Runtime extends RuntimeInstance = RuntimeInstance> {
  private readonly owner: RuntimeOwner<Runtime>;
  private readonly now: () => number;
  private readonly orphanGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly bridgeTimeoutMs: number;
  private readonly maxWorkspaces: number;
  private readonly schedule: (callback: () => void, delayMs: number) => SupervisorTimer;
  private readonly cancel: (timer: SupervisorTimer) => void;
  private readonly workspaces = new Map<string, WorkspaceEntry<Runtime>>();
  private readonly creations = new Map<string, Promise<WorkspaceEntry<Runtime>>>();
  private readonly workspaceOperations = new Map<string, Promise<void>>();
  private readonly archived = new Set<string>();
  private readonly browserPolicy: SessionManager;
  private readonly agentRequestContext = new AsyncLocalStorage<AgentPublicationContext>();
  private readonly agentBindings = new Map<string, AgentBinding>();
  private readonly agentTickets = new Map<string, Set<string>>();
  private activeBridge: ActiveBridge | null = null;
  private nextEpoch = 0;
  private bridgeTimer: SupervisorTimer | null = null;
  private orphanTimer: SupervisorTimer | null = null;
  private stopping: Promise<void> | null = null;

  constructor(options: RuntimeSupervisorOptions<Runtime>) {
    this.owner = options.owner;
    this.now = options.now ?? Date.now;
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_MS;
    this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    this.maxWorkspaces = options.maxWorkspaces ?? MAX_SUPERVISOR_WORKSPACES;
    if (!Number.isInteger(this.maxWorkspaces) || this.maxWorkspaces < 1)
      throw new Error("maxWorkspaces must be a positive integer");
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.browserPolicy = new SessionManager({
      validateWorkspace: async (workspaceId) => !this.archived.has(workspaceId),
      client: {
        connect: async () => ({ epoch: this.nextEpoch }),
        ensureWorkspace: (workspaceId, options) =>
          this.ensureWorkspaceLocal(workspaceId, options?.replaceLost === true),
        requestWorkspace: (workspaceId, operation, input) =>
          this.requestWorkspaceLocal(workspaceId, operation, input),
        archiveWorkspace: (workspaceId) => this.archiveWorkspaceLocal(workspaceId).then(() => {}),
        closeWorkspace: (workspaceId, runtimeId) =>
          this.closeWorkspaceLocal(workspaceId, runtimeId),
        disconnect: () => {},
      },
      now: this.now,
      // Each workspace owns one Chromium runtime but may have several
      // independent page sessions with separate viewers and control leases.
      maxSessions: this.maxWorkspaces * MAX_BROWSER_TABS,
    });
  }

  claimBridge(bridgeId: string, takeover = false): BridgeLease {
    const active = this.activeBridge;
    if (active && active.expiresAt > this.now() && active.bridgeId !== bridgeId && !takeover)
      throw new RuntimeProtocolError(
        "BRIDGE_FENCED",
        "A Shared Browser plugin bridge is already active; explicit administrative takeover is required",
      );
    this.nextEpoch += 1;
    const pending = [...this.workspaceOperations.values()];
    this.browserPolicy.setBridgeEpoch(this.nextEpoch);
    const bridge: ActiveBridge = {
      bridgeId,
      epoch: this.nextEpoch,
      expiresAt: this.now() + this.bridgeTimeoutMs,
      ready: Promise.allSettled(pending).then(() => undefined),
    };
    this.activeBridge = bridge;
    this.cancelOrphanStop();
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  heartbeat(bridgeId: string, epoch: number): BridgeLease {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    bridge.expiresAt = this.now() + this.bridgeTimeoutMs;
    this.armBridgeTimeout(bridge);
    return this.bridgeLease(bridge);
  }

  /** Read-only admission for the reserved lane; dispatch still verifies the lease again. */
  isCurrentBridgeLease(bridgeId: string, epoch: number): boolean {
    const bridge = this.activeBridge;
    return Boolean(
      bridge &&
        bridge.bridgeId === bridgeId &&
        bridge.epoch === epoch &&
        bridge.expiresAt > this.now(),
    );
  }

  bridgeDisconnected(bridgeId: string, epoch: number): void {
    if (this.activeBridge?.bridgeId !== bridgeId || this.activeBridge.epoch !== epoch) return;
    this.activeBridge = null;
    this.clearBridgeTimer();
    this.armOrphanStop();
  }

  async ensureWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<RuntimeDescriptor> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const descriptor = await this.ensureWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return descriptor;
  }

  async requestWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const result = await this.requestWorkspaceLocal(workspaceId, operation, input);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  async archiveWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
  ): Promise<{ archived: true }> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    this.archived.add(workspaceId);
    await bridge.ready;
    const result = await this.archiveWorkspaceLocal(workspaceId);
    this.assertActiveBridge(bridgeId, epoch);
    return result;
  }

  async closeWorkspace(
    bridgeId: string,
    epoch: number,
    workspaceId: string,
    runtimeId: string,
  ): Promise<void> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    await this.closeWorkspaceLocal(workspaceId, runtimeId);
    this.assertActiveBridge(bridgeId, epoch);
  }

  private ensureWorkspaceLocal(
    workspaceId: string,
    replaceLost = false,
  ): Promise<RuntimeDescriptor> {
    return this.runWorkspaceOperation(workspaceId, async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      let entry = this.workspaces.get(workspaceId);
      if (entry?.lost) {
        // Only the in-process explicit human attach carries this authority; protocol
        // workspace.ensure and implicit agent paths observe the loss instead.
        if (!replaceLost)
          throw new RuntimeProtocolError(
            "RUNTIME_LOST",
            "Workspace runtime was lost; reconnect explicitly to replace it",
          );
        // Fail closed: release the dead runtime before any replacement exists.
        // Stop first: if the daemon's exit cannot be confirmed the entry stays lost and
        // no replacement is created behind a possibly live session.
        await this.owner.stop(entry.runtime);
        this.workspaces.delete(workspaceId);
        entry = undefined;
      }
      if (!entry) {
        let creation = this.creations.get(workspaceId);
        if (!creation) {
          if (this.workspaces.size + this.creations.size >= this.maxWorkspaces) {
            throw new RuntimeProtocolError(
              "RUNTIME_FAILURE",
              `Runtime supervisor workspace limit (${this.maxWorkspaces}) reached`,
            );
          }
          creation = this.createWorkspace(workspaceId);
          this.creations.set(workspaceId, creation);
        }
        entry = await creation;
      }
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      return { workspaceId, runtimeId: entry.runtime.runtimeId, createdAt: entry.createdAt };
    });
  }

  private requestWorkspaceLocal(
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    // Capture the caller before entering the workspace tail. Revocation must
    // fence queued native publication, not only the initial ticket lookup.
    const agent = this.agentRequestContext.getStore();
    const execute = async () => {
      if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
      const entry = this.workspaces.get(workspaceId);
      if (!entry)
        throw new RuntimeProtocolError(
          "WORKSPACE_NOT_FOUND",
          `Workspace runtime not found: ${workspaceId}`,
        );
      const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const key = typeof data.key === "string" ? data.key : "";
      const button = typeof data.button === "string" ? data.button : "";
      const channelId = typeof data.gestureId === "string" ? data.gestureId : "";
      const pairedRelease =
        agent &&
        ((operation === "key.up" && agent.keys.get(key) === entry.runtime) ||
          (operation === "mouse.up" && agent.buttons.get(button) === entry.runtime) ||
          (operation === "input.end" && agent.channels.get(channelId) === entry.runtime));
      if (agent && !pairedRelease) {
        this.assertAgentBindingCurrent(agent.binding);
        if (agent.binding.selectionRevision !== agent.selectionRevision) {
          throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent tab selection changed");
        }
      }
      // A lost down/begin ACK still requires cleanup. Record intent only after
      // the current binding fence, immediately before native publication.
      if (agent) {
        if (operation === "key.down") agent.keys.set(key, entry.runtime);
        if (operation === "mouse.down") agent.buttons.set(button, entry.runtime);
        if (operation === "input.begin") agent.channels.set(channelId, entry.runtime);
      }
      try {
        const result = await this.owner.request(entry.runtime, operation, input);
        // Revocation blocks new publication, but never strands a possibly published press.
        // These records allow only its policy-generated paired release, on the
        // original runtime, before the outer request refuses its revoked result.
        if (agent) {
          if (operation === "key.up") agent.keys.delete(key);
          if (operation === "mouse.up") agent.buttons.delete(button);
        }
        if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
        if (this.workspaces.get(workspaceId) !== entry)
          throw new RuntimeProtocolError("RUNTIME_FAILURE", "Video runtime was replaced");
        return result;
      } catch (error) {
        if (error instanceof RuntimeProtocolError) throw error;
        if (error instanceof RuntimeLostError) {
          entry.lost = true;
          throw new RuntimeProtocolError("RUNTIME_LOST", error.message);
        }
        if (error instanceof CdpUnknownOutcomeError)
          throw new RuntimeProtocolError(
            "UNKNOWN_OUTCOME",
            "Browser mutation outcome is unknown; observe the browser before sending another mutation",
          );
        throw new RuntimeProtocolError(
          "RUNTIME_FAILURE",
          `Workspace runtime ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (agent && operation === "input.end") agent.channels.delete(channelId);
      }
    };
    return operation === "video.read"
      ? execute()
      : this.runWorkspaceOperation(workspaceId, execute);
  }

  private archiveWorkspaceLocal(workspaceId: string): Promise<{ archived: true }> {
    this.archived.add(workspaceId);
    return this.runWorkspaceOperation(workspaceId, async () => {
      const creation = this.creations.get(workspaceId);
      if (creation) await creation.catch(() => undefined);
      const entry = this.workspaces.get(workspaceId);
      if (entry) {
        this.workspaces.delete(workspaceId);
        await this.owner.stop(entry.runtime);
      }
      return { archived: true };
    });
  }

  /** Stop the exact runtime confirmed by the viewer while keeping the workspace reusable. */
  private closeWorkspaceLocal(workspaceId: string, runtimeId: string): Promise<void> {
    return this.runWorkspaceOperation(workspaceId, async () => {
      const entry = this.workspaces.get(workspaceId);
      if (!entry || entry.runtime.runtimeId !== runtimeId)
        throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser runtime was replaced");
      this.invalidateAgentObservations(workspaceId);
      this.revokeAgentControl(workspaceId);
      await this.owner.stop(entry.runtime);
      if (this.workspaces.get(workspaceId) === entry) this.workspaces.delete(workspaceId);
    });
  }

  private async requestBrowser(
    bridgeId: string,
    epoch: number,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const bridge = this.assertActiveBridge(bridgeId, epoch);
    await bridge.ready;
    this.assertActiveBridge(bridgeId, epoch);
    const data = asObject(input);
    let result: unknown;
    switch (operation) {
      case "attach":
        result = await this.browserPolicy.attach(
          requireText(data, "workspaceId"),
          requireText(data, "viewerLabel"),
          typeof data.tabId === "string" ? data.tabId : undefined,
          // Only this bridge-authorised human attach may replace a lost runtime.
          { replaceLost: data.create === true, createIfMissing: data.create === true },
        );
        break;
      case "detach":
        result = await this.browserPolicy.detach(requireText(data, "viewerToken"));
        break;
      case "status":
        result = await this.browserPolicy.status(requireText(data, "viewerToken"));
        break;
      case "video.read":
        result = await this.browserPolicy.readVideo(readBrowserVideoRpc.input.parse(data));
        break;
      case "capture": {
        const capture = captureBrowserRpc.input.parse(data);
        result = await this.browserPolicy.capture(
          capture.viewerToken,
          capture.quality,
          capture.knownFrameId,
        );
        break;
      }
      case "capture.density":
        result = await this.browserPolicy.setCaptureDensity(setCaptureDensityRpc.input.parse(data));
        break;
      case "acquire-control": {
        result = await this.browserPolicy.acquireControl(
          requireText(data, "viewerToken"),
          data.takeover === true,
        );
        const state = stateFromPolicyResult(result);
        if (data.takeover === true) this.revokeAgentControl(state.workspaceId, state.tabId);
        break;
      }
      case "release-control":
        result = await this.browserPolicy.releaseControl(
          requireText(data, "viewerToken"),
          requireText(data, "controlToken"),
        );
        break;
      case "navigate":
        result = await this.browserPolicy.navigate(data as never);
        this.invalidateAgentObservationsForState(result);
        break;
      case "viewport":
        result = await this.browserPolicy.resize(data as never);
        this.invalidateAgentObservationsForState(result);
        break;
      case "device":
        result = await this.browserPolicy.applyDevicePreset(data as never);
        this.invalidateAgentObservationsForState(result);
        break;
      case "input":
        result = await this.browserPolicy.sendInput(data as never);
        this.invalidateAgentObservationsForState(result);
        break;
      case "gesture.begin":
        result = await this.browserPolicy.beginGesture(beginBrowserGestureRpc.input.parse(data));
        break;
      case "gesture.update":
        result = await this.browserPolicy.updateGesture(updateBrowserGestureRpc.input.parse(data));
        this.invalidateAgentObservationsForState(result);
        break;
      case "gesture.end":
        result = await this.browserPolicy.endGesture(endBrowserGestureRpc.input.parse(data));
        this.invalidateAgentObservationsForState(result);
        break;
      case "list":
        result = { workspaceIds: await this.browserPolicy.listOpenWorkspaceIds() };
        break;
      case "tabs.list":
        result = await this.browserPolicy.listTabsForViewer(requireText(data, "viewerToken"));
        break;
      case "tabs.create":
        result = await this.browserPolicy.createTab(requireText(data, "viewerToken"));
        break;
      case "tabs.close":
        result = await this.browserPolicy.closeTab({
          viewerToken: requireText(data, "viewerToken"),
          controlToken: requireText(data, "controlToken"),
          tabId: requireText(data, "tabId"),
        });
        break;
      case "close":
        result = await this.browserPolicy.closeBrowser(closeBrowserRpc.input.parse(data));
        break;
      case "reopen":
        result = await this.browserPolicy.reopenBrowser(requireText(data, "workspaceId"));
        break;
      case "archive": {
        const workspaceId = requireText(data, "workspaceId");
        await this.revokeWorkspace(workspaceId);
        await this.browserPolicy.archiveWorkspace(workspaceId);
        result = { archived: true };
        break;
      }
      default:
        throw new RuntimeProtocolError(
          "INVALID_REQUEST",
          `Unknown browser operation: ${operation}`,
        );
    }
    this.assertActiveBridge(bridgeId, epoch);
    return result as JsonValue;
  }

  private issueAgentTicket(bridgeId: string, epoch: number, ticket: string): JsonValue {
    this.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    assertOpaqueToken(ticket, "ticket");
    if (this.agentBindings.has(ticket))
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent ticket is already registered");
    if (
      [...this.agentBindings.values()].filter((binding) => binding.agentId === null).length >=
      MAX_UNBOUND_AGENT_TICKETS
    )
      throw new RuntimeProtocolError(
        "RUNTIME_BUSY",
        "Shared Browser ticket capacity is temporarily full",
      );
    this.agentBindings.set(ticket, {
      ticket,
      issuedAt: this.now(),
      agentId: null,
      workspaceId: null,
      tabId: null,
      selectionRevision: 0,
      viewerToken: null,
      controlToken: null,
      lastState: null,
      lastFrame: null,
    });
    return { issued: true };
  }

  private bindAgentTicket(
    bridgeId: string,
    epoch: number,
    ticket: string,
    agentId: string,
    workspaceId: string,
  ): JsonValue {
    this.assertActiveBridge(bridgeId, epoch);
    this.expireUnboundTickets();
    const binding = this.agentBindings.get(ticket);
    if (!binding) throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Unknown agent ticket");
    if (this.archived.has(workspaceId)) this.workspaceArchived(workspaceId);
    if (binding.agentId && (binding.agentId !== agentId || binding.workspaceId !== workspaceId))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is already bound");
    binding.agentId = agentId;
    binding.workspaceId = workspaceId;
    let tickets = this.agentTickets.get(agentId);
    if (!tickets) {
      tickets = new Set();
      this.agentTickets.set(agentId, tickets);
    }
    tickets.add(ticket);
    return { bound: true };
  }

  private async revokeAgent(bridgeId: string, epoch: number, agentId: string): Promise<JsonValue> {
    this.assertActiveBridge(bridgeId, epoch);
    const tickets = this.agentTickets.get(agentId);
    if (!tickets) return { revoked: 0 };
    const viewers: string[] = [];
    let revoked = 0;
    // Remove every credential synchronously before waiting on viewer cleanup.
    for (const ticket of tickets) {
      const binding = this.agentBindings.get(ticket);
      if (!binding) continue;
      this.agentBindings.delete(ticket);
      revoked += 1;
      if (binding.viewerToken) viewers.push(binding.viewerToken);
    }
    this.agentTickets.delete(agentId);
    await Promise.allSettled(viewers.map((viewerToken) => this.browserPolicy.detach(viewerToken)));
    return { revoked };
  }

  /** Carry exact ticket identity through awaited policy and native publication. */
  private requestAgent(ticket: string, operation: string, input: JsonValue): Promise<JsonValue> {
    this.assertPluginAvailable();
    const binding = this.requireAgentBinding(ticket);
    const execute = () => this.executeAgentRequest(binding, operation, input);
    // Attachment constructs shared session state; its late viewer is removed
    // explicitly. Only actionable requests carry a native publication fence.
    if (
      operation === "status" ||
      operation === "capture" ||
      operation === "acquire-control" ||
      operation === "tabs.list"
    ) {
      return execute();
    }
    return this.agentRequestContext.run(
      {
        binding,
        selectionRevision: binding.selectionRevision,
        keys: new Map(),
        buttons: new Map(),
        channels: new Map(),
      },
      execute,
    );
  }

  private async executeAgentRequest(
    binding: AgentBinding,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    this.assertAgentBindingCurrent(binding);
    const data = asObject(input);
    if (operation === "status" || operation === "capture")
      return (await this.requestAgentObservation(binding, operation, data)) as unknown as JsonValue;
    if (operation === "tabs.list") {
      const listed = await this.browserPolicy.listTabs(binding.workspaceId!);
      return { ...listed, selectedTabId: binding.tabId };
    }
    if (operation === "tabs.select") {
      const tabId = requireText(data, "tabId");
      return { state: await this.selectAgentTab(binding, tabId) } as unknown as JsonValue;
    }
    if (operation === "tabs.create") {
      const create = async () =>
        this.browserPolicy.createTab(await this.ensureAgentViewer(binding));
      let created: { tabId: string };
      try {
        created = await create();
      } catch (error) {
        // Only a refusal before dispatch is recoverable: the lapsed agent viewer is replaced
        // once. A lease that ends after the page was created is a distinct, non-retried error.
        if (!isInvalidViewer(error)) throw error;
        binding.viewerToken = null;
        binding.controlToken = null;
        created = await create();
      }
      return {
        tabId: created.tabId,
        state: await this.selectAgentTab(binding, created.tabId),
      } as unknown as JsonValue;
    }
    if (operation === "tabs.close") {
      const viewerToken = binding.viewerToken;
      const controlToken = binding.controlToken;
      const tabId = binding.tabId;
      if (!viewerToken || !controlToken || !tabId) {
        throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent does not control a tab");
      }
      await this.browserPolicy.closeTab({ viewerToken, controlToken, tabId });
      binding.viewerToken = null;
      binding.tabId = null;
      binding.controlToken = null;
      binding.lastState = null;
      binding.lastFrame = null;
      const { tabs } = await this.browserPolicy.listTabs(binding.workspaceId!);
      const next = tabs[0];
      if (!next) throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser has no remaining tab");
      return { state: await this.selectAgentTab(binding, next.id) } as unknown as JsonValue;
    }
    try {
      if (operation === "acquire-control") {
        const selectionRevision = binding.selectionRevision;
        await this.requestAgentObservation(binding, "status", {});
        this.assertAgentBindingCurrent(binding);
        if (binding.selectionRevision !== selectionRevision) {
          throw new RuntimeProtocolError(
            "INVALID_REQUEST",
            "Agent tab changed during control acquisition",
          );
        }
        const viewerToken = binding.viewerToken!;
        const result = await this.browserPolicy.acquireControl(viewerToken, false);
        this.assertAgentBindingCurrent(binding);
        if (binding.selectionRevision !== selectionRevision) {
          await this.browserPolicy
            .releaseControl(viewerToken, result.controlToken)
            .catch(() => undefined);
          throw new RuntimeProtocolError(
            "INVALID_REQUEST",
            "Agent tab changed during control acquisition",
          );
        }
        binding.controlToken = result.controlToken;
        binding.lastState = result.state;
        return { state: result.state } as unknown as JsonValue;
      }
      const viewerToken = binding.viewerToken;
      const controlToken = binding.controlToken;
      if (!viewerToken || !controlToken)
        throw new RuntimeProtocolError(
          "AUTHENTICATION_FAILED",
          "Agent does not hold browser control",
        );
      if (operation === "release-control") {
        try {
          const result = await this.browserPolicy.releaseControl(viewerToken, controlToken);
          binding.lastState = result.state;
          return result as unknown as JsonValue;
        } finally {
          binding.controlToken = null;
        }
      }
      this.assertAgentBindingCurrent(binding);
      const selectionRevision = binding.selectionRevision;
      const expected = expectedState(binding);
      let result: { state: BrowserState };
      if (operation === "navigate") {
        result = await this.browserPolicy.navigate(
          parseAgentInput(navigateBrowserRpc.input, {
            viewerToken,
            controlToken,
            expected,
            action: data.action,
          }),
        );
      } else if (operation === "viewport") {
        const resize = parseAgentInput(resizeBrowserRpc.input, {
          viewerToken,
          controlToken,
          expected,
          viewport: data.viewport,
        });
        // The shared human schema allows MAX_VIEWPORT; an agent ticket keeps the
        // smaller original bound, enforced here before any mutation.
        if (
          resize.viewport.width > MAX_AGENT_VIEWPORT.width ||
          resize.viewport.height > MAX_AGENT_VIEWPORT.height
        ) {
          throw new RuntimeProtocolError("INVALID_REQUEST", "Invalid agent browser request");
        }
        result = await this.browserPolicy.resize(resize);
      } else if (operation === "input") {
        if (!binding.lastFrame)
          throw new RuntimeProtocolError("INVALID_REQUEST", "Capture a frame before sending input");
        result = await this.browserPolicy.sendInput(
          parseAgentInput(sendBrowserInputRpc.input, {
            viewerToken,
            controlToken,
            expected,
            target: binding.lastFrame,
            event: data.event,
          }),
        );
      } else {
        throw new RuntimeProtocolError("INVALID_REQUEST", `Unknown agent operation: ${operation}`);
      }
      this.assertAgentBindingCurrent(binding);
      if (binding.selectionRevision !== selectionRevision) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during action");
      }
      binding.lastState = result.state;
      binding.lastFrame = null;
      return result as unknown as JsonValue;
    } catch (error) {
      if (error instanceof RuntimeProtocolError && error.code === "UNKNOWN_OUTCOME")
        this.invalidateAgentObservations(binding.workspaceId!);
      throw error;
    }
  }

  private async requestAgentObservation(
    binding: AgentBinding,
    operation: "status" | "capture",
    input: Record<string, JsonValue>,
  ): Promise<{ state: BrowserState; frame?: BrowserFrame | null }> {
    const selectionRevision = binding.selectionRevision;
    const run = async (viewerToken: string) =>
      operation === "status"
        ? await this.browserPolicy.status(viewerToken)
        : await this.browserPolicy.capture(
            viewerToken,
            input.quality === "low" || input.quality === "medium" || input.quality === "high"
              ? input.quality
              : DEFAULT_CAPTURE_QUALITY,
            null,
          );
    let result: { state: BrowserState; frame?: BrowserFrame | null };
    try {
      result = await run(await this.ensureAgentViewer(binding));
    } catch (error) {
      if (!isInvalidViewer(error)) throw error;
      binding.viewerToken = null;
      binding.controlToken = null;
      result = await run(await this.ensureAgentViewer(binding));
    }
    this.assertAgentBindingCurrent(binding);
    if (binding.selectionRevision !== selectionRevision) {
      throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during observation");
    }
    binding.lastState = result.state;
    binding.tabId = result.state.tabId ?? null;
    if (operation === "capture") binding.lastFrame = result.frame ?? null;
    return result;
  }

  /** Move only this agent's viewer to a page, preserving every other viewer's selection. */
  private async selectAgentTab(binding: AgentBinding, tabId: string): Promise<BrowserState> {
    this.assertAgentBindingCurrent(binding);
    if (binding.tabId === tabId && binding.viewerToken) {
      // Same-tab selection needs the same expiry recovery as status/capture.
      const current = await this.requestAgentObservation(binding, "status", {});
      if (binding.tabId !== tabId) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during selection");
      }
      binding.lastState = current.state;
      return current.state;
    }
    const revision = ++binding.selectionRevision;
    const requestContext = this.agentRequestContext.getStore();
    if (requestContext?.binding === binding) requestContext.selectionRevision = revision;
    const previousViewer = binding.viewerToken;
    binding.controlToken = null;
    binding.lastState = null;
    binding.lastFrame = null;
    const attached = await this.browserPolicy.attach(
      binding.workspaceId!,
      `Agent ${binding.agentId!.slice(0, 48)}`,
      tabId,
    );
    try {
      this.assertAgentBindingCurrent(binding);
      if (binding.selectionRevision !== revision) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab selection was replaced");
      }
      if (previousViewer) await this.browserPolicy.detach(previousViewer);
      this.assertAgentBindingCurrent(binding);
      binding.viewerToken = attached.viewerToken;
      binding.tabId = attached.state.tabId ?? tabId;
      binding.controlToken = null;
      binding.lastState = attached.state;
      binding.lastFrame = null;
      return attached.state;
    } catch (error) {
      await this.browserPolicy.detach(attached.viewerToken).catch(() => undefined);
      throw error;
    }
  }

  /** Publish an attached viewer only while its original credential still exists. */
  private async ensureAgentViewer(binding: AgentBinding): Promise<string> {
    this.assertAgentBindingCurrent(binding);
    if (binding.viewerToken) return binding.viewerToken;
    const selectionRevision = binding.selectionRevision;
    const attached = await this.browserPolicy.attach(
      binding.workspaceId!,
      `Agent ${binding.agentId!.slice(0, 48)}`,
      binding.tabId ?? undefined,
    );
    try {
      this.assertAgentBindingCurrent(binding);
      if (binding.selectionRevision !== selectionRevision) {
        throw new RuntimeProtocolError("INVALID_REQUEST", "Agent tab changed during attachment");
      }
    } catch (error) {
      // Cleanup must run outside the revoked caller's publication fence.
      await this.agentRequestContext
        .exit(() => this.browserPolicy.detach(attached.viewerToken))
        .catch(() => undefined);
      throw error;
    }
    if (binding.viewerToken) {
      // Parallel observations may both attach. Keep the first published viewer.
      await this.agentRequestContext.exit(() => this.browserPolicy.detach(attached.viewerToken));
      this.assertAgentBindingCurrent(binding);
      return binding.viewerToken;
    }
    binding.viewerToken = attached.viewerToken;
    binding.lastState = attached.state;
    binding.tabId = attached.state.tabId ?? null;
    return attached.viewerToken;
  }

  /** A deleted or replaced ticket cannot regain authority after an awaited step. */
  private assertAgentBindingCurrent(binding: AgentBinding): void {
    this.assertPluginAvailable();
    if (this.agentBindings.get(binding.ticket) !== binding) {
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket was revoked");
    }
    if (this.archived.has(binding.workspaceId!)) this.workspaceArchived(binding.workspaceId!);
  }

  private requireAgentBinding(ticket: string): AgentBinding {
    const binding = this.agentBindings.get(ticket);
    if (!binding?.agentId || !binding.workspaceId)
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Agent ticket is invalid or unbound");
    if (this.archived.has(binding.workspaceId)) this.workspaceArchived(binding.workspaceId);
    return binding;
  }

  private assertPluginAvailable(): void {
    if (!this.activeBridge || this.activeBridge.expiresAt <= this.now())
      throw new RuntimeProtocolError("BRIDGE_FENCED", "Shared Browser plugin is unavailable");
  }

  private revokeAgentControl(workspaceId: string, tabId?: string): void {
    for (const binding of this.agentBindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (tabId && binding.tabId !== tabId) continue;
      binding.controlToken = null;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  private invalidateAgentObservationsForState(result: unknown): void {
    const state = stateFromPolicyResult(result);
    this.invalidateAgentObservations(state.workspaceId, state.tabId);
  }

  private invalidateAgentObservations(workspaceId: string, tabId?: string): void {
    for (const binding of this.agentBindings.values()) {
      if (binding.workspaceId !== workspaceId) continue;
      if (tabId && binding.tabId !== tabId) continue;
      binding.lastState = null;
      binding.lastFrame = null;
    }
  }

  private async revokeWorkspace(workspaceId: string): Promise<void> {
    const viewers: string[] = [];
    for (const [ticket, binding] of this.agentBindings) {
      if (binding.workspaceId !== workspaceId) continue;
      this.agentBindings.delete(ticket);
      if (binding.viewerToken) viewers.push(binding.viewerToken);
      if (binding.agentId) {
        const tickets = this.agentTickets.get(binding.agentId);
        tickets?.delete(ticket);
        if (tickets?.size === 0) this.agentTickets.delete(binding.agentId);
      }
    }
    await Promise.allSettled(viewers.map((viewerToken) => this.browserPolicy.detach(viewerToken)));
  }

  async stopAll(): Promise<void> {
    if (this.stopping) return this.stopping;
    const operation = (async () => {
      this.activeBridge = null;
      this.clearBridgeTimer();
      this.cancelOrphanStop();
      this.browserPolicy.reset();
      for (const binding of this.agentBindings.values()) {
        binding.viewerToken = null;
        binding.controlToken = null;
        binding.lastState = null;
        binding.lastFrame = null;
      }
      await Promise.allSettled(this.workspaceOperations.values());
      await Promise.allSettled(this.creations.values());
      const entries = [...this.workspaces.values()];
      this.workspaces.clear();
      const results = await Promise.allSettled(
        entries.map((entry) => this.owner.stop(entry.runtime)),
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "One or more workspace runtimes failed to stop",
        );
    })();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = null;
    }
  }

  async dispatch(request: RuntimeRequest): Promise<RuntimeResult> {
    switch (request.method) {
      case "bridge.claim":
        return this.claimBridge(request.bridgeId, request.takeover);
      case "bridge.heartbeat":
        return this.heartbeat(request.bridgeId, request.epoch);
      case "workspace.ensure":
        return this.ensureWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "workspace.request":
        return this.requestWorkspace(
          request.bridgeId,
          request.epoch,
          request.workspaceId,
          request.operation,
          request.input,
        );
      case "workspace.archive":
        return this.archiveWorkspace(request.bridgeId, request.epoch, request.workspaceId);
      case "workspace.close":
        return this.closeWorkspace(
          request.bridgeId,
          request.epoch,
          request.workspaceId,
          request.runtimeId,
        ).then(() => ({ closed: true }));
      case "browser.request":
        return this.requestBrowser(
          request.bridgeId,
          request.epoch,
          request.operation,
          request.input,
        );
      case "ticket.issue":
        return this.issueAgentTicket(request.bridgeId, request.epoch, request.ticket);
      case "ticket.bind":
        return this.bindAgentTicket(
          request.bridgeId,
          request.epoch,
          request.ticket,
          request.agentId,
          request.workspaceId,
        );
      case "agent.revoke":
        return this.revokeAgent(request.bridgeId, request.epoch, request.agentId);
      case "agent.request":
        return this.requestAgent(request.ticket, request.operation, request.input);
    }
  }

  private runWorkspaceOperation<Result>(
    workspaceId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.workspaceOperations.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspaceId, tail);
    void tail.finally(() => {
      if (this.workspaceOperations.get(workspaceId) === tail)
        this.workspaceOperations.delete(workspaceId);
    });
    return result;
  }

  private async createWorkspace(workspaceId: string): Promise<WorkspaceEntry<Runtime>> {
    try {
      const runtime = await this.owner.create(workspaceId);
      const entry = { runtime, createdAt: this.now() };
      if (this.archived.has(workspaceId)) {
        await this.owner.stop(runtime);
        this.workspaceArchived(workspaceId);
      }
      this.workspaces.set(workspaceId, entry);
      return entry;
    } finally {
      this.creations.delete(workspaceId);
    }
  }

  private assertActiveBridge(bridgeId: string, epoch: number): ActiveBridge {
    const bridge = this.activeBridge;
    if (
      !bridge ||
      bridge.bridgeId !== bridgeId ||
      bridge.epoch !== epoch ||
      bridge.expiresAt <= this.now()
    ) {
      throw new RuntimeProtocolError("BRIDGE_FENCED", "Plugin bridge lease is no longer active");
    }
    return bridge;
  }

  private bridgeLease(bridge: ActiveBridge): BridgeLease {
    return {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      expiresAt: bridge.expiresAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    };
  }

  private workspaceArchived(workspaceId: string): never {
    throw new RuntimeProtocolError("WORKSPACE_ARCHIVED", `Workspace is archived: ${workspaceId}`);
  }

  private expireUnboundTickets(): void {
    const deadline = this.now() - AGENT_TICKET_TTL_MS;
    for (const [ticket, binding] of this.agentBindings)
      if (binding.agentId === null && binding.issuedAt <= deadline)
        this.agentBindings.delete(ticket);
  }

  private armBridgeTimeout(bridge: ActiveBridge): void {
    this.clearBridgeTimer();
    const delay = Math.max(0, bridge.expiresAt - this.now());
    this.bridgeTimer = this.schedule(() => {
      if (this.activeBridge !== bridge) return;
      if (bridge.expiresAt > this.now()) {
        this.armBridgeTimeout(bridge);
        return;
      }
      this.activeBridge = null;
      this.bridgeTimer = null;
      this.armOrphanStop();
    }, delay);
  }

  private clearBridgeTimer(): void {
    if (!this.bridgeTimer) return;
    this.cancel(this.bridgeTimer);
    this.bridgeTimer = null;
  }

  private armOrphanStop(): void {
    this.cancelOrphanStop();
    this.orphanTimer = this.schedule(() => {
      this.orphanTimer = null;
      if (!this.activeBridge) void this.stopAll().catch(() => undefined);
    }, this.orphanGraceMs);
  }

  private cancelOrphanStop(): void {
    if (!this.orphanTimer) return;
    this.cancel(this.orphanTimer);
    this.orphanTimer = null;
  }
}

/** Raw agent sockets reuse the public mutation contract. Never expose parser
 * issues or submitted values in errors from this trusted-ticket boundary. */
function parseAgentInput<Value>(schema: ZodType<Value>, value: unknown): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeProtocolError("INVALID_REQUEST", "Invalid agent browser request");
  }
  return parsed.data;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", "Browser input must be an object");
  return value;
}

function requireText(value: Record<string, JsonValue>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.length === 0)
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be a non-empty string`);
  return text;
}

function assertOpaqueToken(value: string, label: string): void {
  if (value.length < 32 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", `${label} is invalid`);
}

function expectedState(binding: AgentBinding): {
  sessionId: string;
  navigationGeneration: number;
  viewportGeneration: number;
  runtimeId: string;
  bridgeEpoch: number;
} {
  const state = binding.lastState;
  if (!state)
    throw new RuntimeProtocolError("INVALID_REQUEST", "Observe the browser before mutating it");
  if (!state.runtimeId || state.bridgeEpoch === undefined)
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser observation lacks runtime identity");
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
    runtimeId: state.runtimeId,
    bridgeEpoch: state.bridgeEpoch,
  };
}

function stateFromPolicyResult(result: unknown): BrowserState {
  if (!result || typeof result !== "object" || !("state" in result))
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser policy returned no state");
  return result.state as BrowserState;
}

function isInvalidViewer(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Viewer token is invalid or expired");
}

async function removeSupervisorSocket(path: string): Promise<void> {
  if (process.platform !== "win32") await rm(path, { force: true });
}

export async function acquireStartupLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  await chmod(dirname(path), DIRECTORY_MODE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      await writeFile(join(path, "pid"), String(process.pid), { mode: FILE_MODE });
      return async () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(join(path, "pid"), "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(pid) && processIsRunning(pid)) {
        throw new Error(`Runtime supervisor already holds startup lock (${pid})`);
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire runtime supervisor startup lock");
}

export async function startSupervisorServer<Runtime extends RuntimeInstance>(
  owner: RuntimeOwner<Runtime>,
  paths = resolveSupervisorPaths(),
): Promise<{ close: () => Promise<void>; supervisor: RuntimeSupervisor<Runtime> }> {
  const releaseLock = await acquireStartupLock(paths.lock);
  const supervisor = new RuntimeSupervisor({ owner });
  const sockets = new Set<Socket>();
  let globalInFlight = 0;
  let globalMediaInFlight = 0;
  let globalHeartbeatsInFlight = 0;
  const token = randomBytes(32).toString("base64url");
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let claimed: { bridgeId: string; epoch: number } | null = null;
    let socketInFlight = 0;
    let socketMediaInFlight = 0;
    let socketHeartbeatsInFlight = 0;
    let processing = Promise.resolve();
    let busyResponsePending = false;
    socket.setEncoding("utf8");

    const rejectBusy = (line: string): boolean => {
      let id: string;
      try {
        const request = JSON.parse(line) as { id?: unknown };
        if (typeof request.id !== "string") throw new Error("Missing request id");
        id = request.id;
      } catch {
        socket.destroy();
        return false;
      }
      busyResponsePending = true;
      socket.pause();
      socket.write(
        `${JSON.stringify({
          id,
          ok: false,
          error: {
            code: "RUNTIME_BUSY",
            message: "Shared Browser supervisor is busy; retry the request",
          },
        })}\n`,
        (error) => {
          busyResponsePending = false;
          if (error) socket.destroy();
          else drainBufferedLines();
        },
      );
      return false;
    };

    const enqueue = (line: string): boolean => {
      const concurrent = classifyConcurrentRequest(line, token);
      const maintenance = concurrent === "heartbeat" && isCurrentHeartbeat(line, supervisor);
      const media = !maintenance && isMediaRequest(line, token);
      if (maintenance) {
        if (
          socketHeartbeatsInFlight >= MAX_HEARTBEATS_IN_FLIGHT ||
          globalHeartbeatsInFlight >= MAX_HEARTBEATS_IN_FLIGHT
        )
          return rejectBusy(line);
        socketHeartbeatsInFlight += 1;
        globalHeartbeatsInFlight += 1;
      } else {
        if (socketInFlight >= MAX_SOCKET_IN_FLIGHT || globalInFlight >= MAX_GLOBAL_IN_FLIGHT)
          return rejectBusy(line);
        if (
          media &&
          (socketMediaInFlight >= MAX_SOCKET_MEDIA_IN_FLIGHT ||
            globalMediaInFlight >= MAX_GLOBAL_MEDIA_IN_FLIGHT)
        )
          return rejectBusy(line);
        socketInFlight += 1;
        globalInFlight += 1;
        if (media) {
          socketMediaInFlight += 1;
          globalMediaInFlight += 1;
        }
      }
      // Video admission/result fencing already belongs to each workspace's
      // policy queue. Another workspace's teardown must not block that lane.
      const before = concurrent === null ? processing : Promise.resolve();
      const execution = before
        .then(async () => {
          const { response, lease } = await handleLine(line, token, supervisor);
          if (lease) claimed = lease;
          if (!socket.destroyed) {
            await new Promise<void>((resolve, reject) => {
              socket.write(`${boundedResponse(response)}\n`, (error) =>
                error ? reject(error) : resolve(),
              );
            });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (maintenance) {
            socketHeartbeatsInFlight -= 1;
            globalHeartbeatsInFlight -= 1;
          } else {
            socketInFlight -= 1;
            globalInFlight -= 1;
            if (media) {
              socketMediaInFlight -= 1;
              globalMediaInFlight -= 1;
            }
          }
          drainBufferedLines();
        });
      // Heartbeats must pass slow page operations, otherwise a healthy bridge
      // expires and its browser is stopped. Video waits also leave the command
      // tail. Only the authenticated current lease uses the separately bounded
      // maintenance lane. Auth, epoch checks and whole ID-keyed writes still apply.
      if (concurrent === null) processing = execution;
      return true;
    };

    // Pausing transport does not consume lines already delivered in its current
    // chunk. Drain those after each bounded busy response, without replaying a
    // refused line or creating an unbounded queue of busy-response writes.
    function drainBufferedLines(): void {
      if (socket.destroyed || busyResponsePending) return;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0 && !enqueue(line)) return;
        newline = buffer.indexOf("\n");
      }
      socket.resume();
    }

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      drainBufferedLines();
    });
    socket.once("close", () => {
      sockets.delete(socket);
      if (claimed) supervisor.bridgeDisconnected(claimed.bridgeId, claimed.epoch);
    });
  });

  try {
    await mkdir(paths.root, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(paths.root, DIRECTORY_MODE);
    const tokenHandle = await open(paths.token, "w", FILE_MODE);
    try {
      await tokenHandle.writeFile(token);
    } finally {
      await tokenHandle.close();
    }
    await chmod(paths.token, FILE_MODE);
    await removeSupervisorSocket(paths.socket);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(paths.socket, SOCKET_MODE);
    await writeFile(
      paths.endpoint,
      JSON.stringify({ version: RUNTIME_PROTOCOL_VERSION, socket: paths.socket }),
      { mode: FILE_MODE },
    );
    await chmod(paths.endpoint, FILE_MODE);
  } catch (error) {
    server.close();
    await Promise.allSettled([
      removeSupervisorSocket(paths.socket),
      rm(paths.endpoint, { force: true }),
      rm(paths.token, { force: true }),
      releaseLock(),
    ]);
    throw error;
  }

  let closed = false;
  return {
    supervisor,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        supervisor.stopAll(),
      ]);
      try {
        const shutdownFailures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (shutdownFailures.length > 0)
          throw new AggregateError(
            shutdownFailures.map((result) => result.reason),
            "Runtime supervisor shutdown failed",
          );
      } finally {
        await Promise.allSettled([
          removeSupervisorSocket(paths.socket),
          rm(paths.endpoint, { force: true }),
          rm(paths.token, { force: true }),
          releaseLock(),
        ]);
      }
    },
  };
}
/** Classification already verified the token; stale leases cannot consume reserved capacity. */
function isCurrentHeartbeat(line: string, supervisor: RuntimeSupervisor): boolean {
  const request = parseRuntimeRequest(JSON.parse(line));
  return (
    request.method === "bridge.heartbeat" &&
    supervisor.isCurrentBridgeLease(request.bridgeId, request.epoch)
  );
}
/** Capacity-only classification, never an authorization or command-tail bypass. */
function isMediaRequest(line: string, token: string): boolean {
  try {
    const request = parseRuntimeRequest(JSON.parse(line));
    if (request.method === "agent.request") return request.operation === "capture";
    if (!tokensEqual(request.token, token)) return false;
    if (request.method !== "browser.request" && request.method !== "workspace.request")
      return false;
    return (
      request.operation === "video.read" ||
      request.operation === (request.method === "browser.request" ? "capture" : "frame")
    );
  } catch {
    return false;
  }
}
/** Classify authenticated maintenance/media calls without weakening command ordering. */
function classifyConcurrentRequest(line: string, token: string): "heartbeat" | "video" | null {
  try {
    const request = parseRuntimeRequest(JSON.parse(line));
    if (request.method === "agent.request" || !tokensEqual(request.token, token)) return null;
    if (request.method === "bridge.heartbeat") return "heartbeat";
    if (request.method !== "browser.request" && request.method !== "workspace.request") return null;
    if (request.operation !== "video.read") return null;
    const schema =
      request.method === "browser.request"
        ? readBrowserVideoRpc.input
        : readBrowserVideoRpc.input.omit({ viewerToken: true });
    return schema.safeParse(request.input).success ? "video" : null;
  } catch {
    return null;
  }
}

async function handleLine<Runtime extends RuntimeInstance>(
  line: string,
  token: string,
  supervisor: RuntimeSupervisor<Runtime>,
): Promise<{ response: RuntimeResponse; lease: { bridgeId: string; epoch: number } | null }> {
  let id = "unknown";
  try {
    const raw: unknown = JSON.parse(line);
    id = readRuntimeRequestId(raw) ?? "unknown";
    const request = parseRuntimeRequest(raw);
    id = request.id;
    if (request.method !== "agent.request" && !tokensEqual(request.token, token))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Invalid supervisor token");
    const result = await supervisor.dispatch(request);
    let lease: { bridgeId: string; epoch: number } | null = null;
    if (request.method === "bridge.claim") {
      if (!result || typeof result !== "object" || !("epoch" in result))
        throw new RuntimeProtocolError("RUNTIME_FAILURE", "Bridge claim returned no epoch");
      lease = { bridgeId: request.bridgeId, epoch: Number(result.epoch) };
    }
    return { response: { id, ok: true, result }, lease };
  } catch (error) {
    const protocolError =
      error instanceof RuntimeProtocolError
        ? error
        : new RuntimeProtocolError(
            "RUNTIME_FAILURE",
            error instanceof Error ? error.message : "Runtime operation failed",
          );
    return {
      response: {
        id,
        ok: false,
        error: { code: protocolError.code, message: protocolError.message },
      },
      lease: null,
    };
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

export async function runStandaloneSupervisor(owner: RuntimeOwner): Promise<void> {
  const running = await startSupervisorServer(owner);
  const shutdown = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/** Frame payloads are bounded separately; cap the complete private IPC envelope too. */
function boundedResponse(response: RuntimeResponse): string {
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) <= MAX_MESSAGE_BYTES) return encoded;
  return JSON.stringify({ id: response.id, ok: false, error: {
    code: "RUNTIME_BUSY", message: "Browser reply exceeded the private transport limit",
  } });
}
