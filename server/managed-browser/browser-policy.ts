import { setTimeout, clearTimeout } from "./node-timers";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type applyDevicePresetRpc,
  type BrowserFrame,
  type BrowserGestureEvent,
  type BrowserInputEvent,
  type BrowserState,
  type BrowserTab,
  type beginBrowserGestureRpc,
  browserCursorSchema,
  browserGestureEventSchema,
  browserTabSchema,
  canUseCaptureDensity,
  type captureBrowserRpc,
  type closeBrowserRpc,
  DEFAULT_VIEWPORT,
  DEVICE_PRESETS,
  type DevicePresetId,
  type endBrowserGestureRpc,
  FRAME_MAX_BYTES,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  mapDisplayedPoint,
  type navigateBrowserRpc,
  type resizeBrowserRpc,
  type sendBrowserInputRpc,
  type setCaptureDensityRpc,
  type updateBrowserGestureRpc,
  type Viewport,
} from "../../shared/managed-browser/browser";
import {
  type BrowserFrameAuthority,
  type BrowserVideoReadInput,
  type BrowserVideoReadReply,
  readBrowserVideoRpc,
  VIDEO_MAX_BATCH_BYTES,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../../shared/managed-browser/browser-video";
import {
  type CaptureQuality,
  captureDimensions,
  DEFAULT_CAPTURE_QUALITY,
  JPEG_QUALITY,
} from "../../shared/managed-browser/capture-settings";
import { frameMatchesBrowserContext } from "./browser-frame-context";
import { createBrowserFrameRejection } from "./browser-frame-rejection";
import { BrowserGesture } from "./browser-gesture";
import { runWithInputCleanup } from "./input-cleanup";
import { sameRuntimeInputAttachment } from "./input-generation";
import { runtimeVideoPacketSchema } from "./native-video-packet";
import { NAVIGATION_METADATA_TIMEOUT_MS } from "./navigation-budget";
import { type JsonValue, RuntimeProtocolError } from "./runtime-protocol";
import { createViewerCaptureLifetime, type ViewerCaptureLifetime } from "./viewer-capture-lifetime";
export type WorkspaceValidator = (workspaceId: string) => Promise<void | boolean>;
type CaptureReply = Omit<RpcOutput<typeof captureBrowserRpc>, "state"> & { state: BrowserState };
type DensityInput = RpcInput<typeof setCaptureDensityRpc>;
type CloseInput = RpcInput<typeof closeBrowserRpc>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type BeginGestureInput = RpcInput<typeof beginBrowserGestureRpc>;
type UpdateGestureInput = RpcInput<typeof updateBrowserGestureRpc>;
type UpdateGestureReply = Omit<RpcOutput<typeof updateBrowserGestureRpc>, "state"> & {
  state: BrowserState;
};
type EndGestureInput = RpcInput<typeof endBrowserGestureRpc>;

const VIEWER_TTL_MS = 45_000;
const CONTROL_LEASE_MS = 30_000;
const FRAME_CACHE_MS = 100;
const FRAME_TOKEN_TTL_MS = 5_000;
const MAX_RECENT_FRAMES = 512;
const MAX_VIEWERS_PER_SESSION = 16;
const MAX_SESSIONS = 64;
const SCREENCAST_WAIT_MS = 500;

export interface BrowserRuntimeClient {
  connect(): Promise<{ epoch: number }>;
  /** `replaceLost` is internal authority; without it a lost runtime is reported, never replaced. */
  ensureWorkspace(
    workspaceId: string,
    options?: { replaceLost?: boolean },
  ): Promise<{
    workspaceId: string;
    runtimeId: string;
    createdAt: number;
  }>;
  requestWorkspace(workspaceId: string, operation: string, input: JsonValue): Promise<JsonValue>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  closeWorkspace(workspaceId: string, runtimeId: string): Promise<void>;
  disconnect(): void;
}

export interface SessionManagerOptions {
  validateWorkspace: WorkspaceValidator;
  client: BrowserRuntimeClient;
  now?: () => number;
  /** Same process-local elapsed clock as native capture, injectable for deterministic tests. */
  monotonicNow?: () => number;
  issueToken?: () => string;
  viewerTtlMs?: number;
  controlLeaseMs?: number;
  frameCacheMs?: number;
  maxSessions?: number;
}

interface Viewer {
  label: string;
  expiresAt: number;
}
interface Controller {
  viewerToken: string;
  controlToken: string;
  expiresAt: number;
}
interface BrowserSession {
  key: string;
  workspaceId: string;
  tabId: string | null;
  sessionId: string;
  runtimeId: string;
  runtimeCreatedAt: number;
  bridgeEpoch: number;
  viewport: Viewport;
  captureScale: number;
  navigationGeneration: number;
  viewportGeneration: number;
  devicePresetId: DevicePresetId | null;
  userAgent: string;
  defaultUserAgent: string;
  viewers: Map<string, Viewer>;
  controller: Controller | null;
  mutationTail: Promise<void>;
  frameCache: Map<
    CaptureQuality,
    {
      frame: BrowserFrame;
      cachedAt: number;
      /** Exact runtime receipt, distinct from its normalized public frame fields. */
      rawFrame: Record<string, JsonValue>;
    }
  >;
  recentFrames: Map<
    string,
    {
      navigationGeneration: number;
      viewportGeneration: number;
      expiresAt: number;
      expiresAtMonotonicMs?: number;
    }
  >;
  lastUrl: string;
  lastTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  notice: string | null;
  /** Set when the runtime reported it can never serve again; the next explicit attach replaces it. */
  runtimeLost: boolean;
  archived: boolean;
  gesture: BrowserGesture | null;
  inputGeneration: string | null;
  frameRevision: number;
  /** Playback and input fences use the native capture's Node elapsed clock. */
  videoNotBefore: number | null;
  /** Older native pixels may play, but cannot renew press authority after input. */
  videoInputNotBefore: number | null;
  videoReads: Set<string>;
  videoLifetime: ViewerCaptureLifetime | null;
  videoReceipts: Map<string, { frame: BrowserFrameAuthority; capturedAtMonotonicMs: number }>;
}

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function assertViewport(viewport: Viewport): void {
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < MIN_VIEWPORT.width ||
    viewport.width > MAX_VIEWPORT.width ||
    viewport.height < MIN_VIEWPORT.height ||
    viewport.height > MAX_VIEWPORT.height
  ) {
    throw new Error("Viewport is outside the supported bounds");
  }
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runtime returned an invalid response");
  return value;
}

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (value === "about:blank") return value;
  const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
  const looksLikeHostWithPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value);
  const candidate = hasScheme && !looksLikeHostWithPort ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Only HTTP, HTTPS, and about:blank URLs are supported");
  return parsed.href;
}

export class SessionManager {
  private readonly validateWorkspace: WorkspaceValidator;
  private readonly client: BrowserRuntimeClient;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly issueToken: () => string;
  private readonly viewerTtlMs: number;
  private readonly controlLeaseMs: number;
  private readonly frameCacheMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly viewerSessions = new Map<string, BrowserSession>();
  private readonly closedViewerWorkspaces = new Map<string, string>();
  private readonly closedViewerTabs = new Map<string, number>();
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>();
  private readonly sessionClosures = new Map<string, Promise<void>>();
  private readonly archived = new Set<string>();
  private readonly deliberatelyClosed = new Set<string>();
  private bridgeEpoch = 0;
  private lifecycleGeneration = 0;
  private closed = false;

  constructor(options: SessionManagerOptions) {
    this.validateWorkspace = options.validateWorkspace;
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.issueToken = options.issueToken ?? defaultToken;
    this.viewerTtlMs = options.viewerTtlMs ?? VIEWER_TTL_MS;
    this.controlLeaseMs = options.controlLeaseMs ?? CONTROL_LEASE_MS;
    this.frameCacheMs = options.frameCacheMs ?? FRAME_CACHE_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("maxSessions must be a positive integer");
  }

  async connect(): Promise<void> {
    const lease = await this.client.connect();
    this.bridgeEpoch = lease.epoch;
  }

  setBridgeEpoch(epoch: number): void {
    this.bridgeEpoch = epoch;
    for (const session of this.sessions.values()) {
      if (session.bridgeEpoch !== epoch) {
        void this.cancelGesture(session);
        // A new bridge cannot admit a token issued by the previous attachment.
        this.invalidateFrames(session);
      }
      session.bridgeEpoch = epoch;
    }
  }

  /**
   * `replaceLost` is internal authority held only by the supervisor's explicit human attach
   * path. It lets this call replace a workspace runtime that reported it was lost (before or
   * while attaching) exactly once; every other caller observes the lost session without
   * restarting it.
   */
  async attach(
    workspaceId: string,
    viewerLabel: string,
    tabId?: string,
    options: { replaceLost?: boolean; createIfMissing?: boolean } = {},
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    this.assertOpen();
    const label = viewerLabel.trim();
    if (!label || label.length > 64) throw new Error("Viewer label is invalid");
    const validation = await this.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    this.assertOpen();
    const replaceLost = options.replaceLost === true;
    let session = await this.getOrCreateSession(workspaceId, tabId, replaceLost, options.createIfMissing !== false);
    let replaced = false;
    if (session.runtimeLost && replaceLost) {
      session = await this.replaceLostRuntime(session);
      replaced = true;
    }
    const attached = await this.attachViewer(session, label);
    if (session.runtimeLost && replaceLost && !replaced) {
      // The loss was first observed by this very attach. One fenced replacement, no input replay.
      session = await this.replaceLostRuntime(session);
      return this.attachViewer(session, label);
    }
    return attached;
  }

  /**
   * Discards every page session of the dead workspace runtime behind fresh session and
   * runtime ids; nothing is replayed. Page ids belong to the old browser, so the
   * replacement attaches to the new browser's launch page.
   */
  private async replaceLostRuntime(lost: BrowserSession): Promise<BrowserSession> {
    for (const candidate of [...this.sessions.values()]) {
      if (candidate.workspaceId !== lost.workspaceId) continue;
      candidate.archived = true;
      candidate.videoLifetime?.cancel();
      await this.cancelGesture(candidate);
      for (const token of candidate.viewers.keys()) this.viewerSessions.delete(token);
      candidate.viewers.clear();
      candidate.controller = null;
      this.sessions.delete(candidate.key);
    }
    return this.getOrCreateSession(lost.workspaceId, undefined, true);
  }

  private attachViewer(
    session: BrowserSession,
    label: string,
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    return this.serialize(session, async () => {
      if (session.archived) throw new Error("Browser session is closed");
      this.pruneExpired(session);
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION)
        throw new Error(`Shared browser viewer limit (${MAX_VIEWERS_PER_SESSION}) reached`);
      const viewerToken = this.issueUniqueToken();
      session.viewers.set(viewerToken, { label, expiresAt: this.now() + this.viewerTtlMs });
      this.viewerSessions.set(viewerToken, session);
      // Actual image reads lazily own JPEG capture. Attaching a desktop video
      // viewer or an agent doing status-only work does not start a second stream.
      try {
        return { viewerToken, state: await this.snapshotState(session, viewerToken) };
      } catch (error) {
        session.viewers.delete(viewerToken);
        this.viewerSessions.delete(viewerToken);
        throw error;
      }
    });
  }

  async detach(viewerToken: string): Promise<{ detached: boolean }> {
    const session = this.viewerSessions.get(viewerToken);
    if (!session) return { detached: false };
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      const detached = session.viewers.delete(viewerToken);
      this.viewerSessions.delete(viewerToken);
      if (session.controller?.viewerToken === viewerToken) {
        await this.cancelGesture(session);
        session.controller = null;
      }
      if (session.viewers.size === 0) {
        await this.request(session, "screencast.stop", null).catch(() => undefined);
        await this.stopUnusedVideo(session);
      }
      return { detached };
    });
  }

  /** Enumerate pages in this viewer's workspace without changing any selected page. */
  async listTabs(workspaceId: string): Promise<{ tabs: BrowserTab[] }> {
    if (this.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
    const targets = await this.client.requestWorkspace(workspaceId, "tabs.list", null);
    if (!Array.isArray(targets)) throw new Error("Browser returned an invalid tab list");
    const tabs = await Promise.all(
      targets.map(async (target) => {
        const value = asRecord(target);
        const tabId = browserTabSchema.shape.id.parse(value.targetId);
        const session = [...this.sessions.values()].find(
          (candidate) => candidate.workspaceId === workspaceId && candidate.tabId === tabId,
        );
        const presence = session
          ? await this.serialize(session, async () => {
              this.pruneExpired(session);
              const controllerToken = session.controller?.viewerToken;
              return {
                viewerCount: session.viewers.size,
                controllerLabel: controllerToken
                  ? (session.viewers.get(controllerToken)?.label ?? null)
                  : null,
              };
            })
          : { viewerCount: 0, controllerLabel: null };
        return browserTabSchema.parse({
          id: tabId,
          title: boundedText(String(value.title ?? ""), 1_024),
          url: boundedText(String(value.url ?? ""), 8_192),
          ...presence,
        });
      }),
    );
    return { tabs };
  }

  /** Expose tab metadata to a client only through its active viewer lease. */
  async listTabsForViewer(viewerToken: string): Promise<{ tabs: BrowserTab[] }> {
    const session = this.requireViewer(viewerToken);
    const listed = await this.listTabs(session.workspaceId);
    // The lease may have lapsed while the runtime answered; never return metadata then.
    let current = false;
    try {
      current = this.requireViewer(viewerToken) === session && !session.archived;
    } catch {
      current = false;
    }
    if (!current) throw new Error("Browser viewer attachment changed while listing tabs");
    return listed;
  }

  /** A new page shares the workspace profile but does not change any viewer's selection. */
  async createTab(viewerToken: string): Promise<{ tabId: string }> {
    const session = this.requireViewer(viewerToken);
    const value = asRecord(
      await this.client.requestWorkspace(session.workspaceId, "tabs.create", null),
    );
    // The page now exists. A viewer lease that ended meanwhile must not read as a
    // pre-dispatch refusal, or a caller recovering from an expired viewer would create twice.
    let current = false;
    try {
      current = this.requireViewer(viewerToken) === session && !session.archived;
    } catch {
      current = false;
    }
    if (!current) throw new Error("Browser viewer attachment changed during tab creation");
    const tabId = browserTabSchema.shape.id.parse(value.targetId);
    return { tabId };
  }

  /** Close only the page controlled by this viewer, leaving other pages and viewers alive. */
  async closeTab(input: {
    viewerToken: string;
    controlToken: string;
    tabId: string;
  }): Promise<{ closed: true }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireController(session, input.viewerToken, input.controlToken);
      if (session.tabId !== input.tabId) throw new Error("Browser tab selection is stale");
      await this.cancelGesture(session);
      await this.request(session, "tabs.close", { targetId: input.tabId });
      session.archived = true;
      session.videoLifetime?.cancel();
      for (const [token, expiresAt] of this.closedViewerTabs) {
        if (expiresAt <= this.now()) this.closedViewerTabs.delete(token);
      }
      for (const token of session.viewers.keys()) {
        this.viewerSessions.delete(token);
        this.closedViewerTabs.set(token, this.now() + this.viewerTtlMs);
      }
      session.viewers.clear();
      session.controller = null;
      this.sessions.delete(session.key);
      return { closed: true };
    });
  }

  /** Stop one runtime and invalidate every viewer without archiving its workspace or profile. */
  async closeBrowser(input: CloseInput): Promise<{ closed: true }> {
    const session = this.requireViewer(input.viewerToken);
    const closing = this.serialize(session, async () => {
      this.requireController(session, input.viewerToken, input.controlToken);
      if (session.sessionId !== input.sessionId || session.runtimeId !== input.runtimeId)
        throw new Error("Browser session is stale");

      this.deliberatelyClosed.add(session.workspaceId);
      const workspaceSessions = [...this.sessions.values()].filter(
        (candidate) => candidate.workspaceId === session.workspaceId,
      );
      for (const candidate of workspaceSessions) {
        candidate.videoLifetime?.cancel();
        await this.cancelGesture(candidate);
        candidate.archived = true;
        for (const token of candidate.viewers.keys()) {
          this.viewerSessions.delete(token);
          this.closedViewerWorkspaces.set(token, session.workspaceId);
        }
        candidate.viewers.clear();
        candidate.controller = null;
      }
      try {
        await this.client.closeWorkspace(session.workspaceId, session.runtimeId);
      } finally {
        for (const candidate of workspaceSessions) this.sessions.delete(candidate.key);
      }
    });
    this.sessionClosures.set(session.workspaceId, closing);
    try {
      await closing;
      return { closed: true };
    } finally {
      if (this.sessionClosures.get(session.workspaceId) === closing)
        this.sessionClosures.delete(session.workspaceId);
    }
  }

  /** Only an explicit human reopen removes the close fence used by viewer and agent attach. */
  async reopenBrowser(workspaceId: string): Promise<{ opened: true }> {
    this.assertOpen();
    const validation = await this.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    const closing = this.sessionClosures.get(workspaceId);
    if (closing) await closing.catch(() => undefined);
    this.deliberatelyClosed.delete(workspaceId);
    try {
      await this.getOrCreateSession(workspaceId);
    } catch (error) {
      this.deliberatelyClosed.add(workspaceId);
      throw error;
    }
    for (const [token, closedWorkspaceId] of this.closedViewerWorkspaces)
      if (closedWorkspaceId === workspaceId) this.closedViewerWorkspaces.delete(token);
    return { opened: true };
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.assertOpen();
    this.archived.add(workspaceId);
    await this.client.archiveWorkspace(workspaceId);
    const pending = [...this.sessionCreations.entries()]
      .filter(([key]) => key === workspaceId || key.startsWith(`${workspaceId}/`))
      .map(([, creation]) => creation);
    await Promise.allSettled(pending);
    for (const session of this.sessions.values()) {
      if (session.workspaceId !== workspaceId) continue;
      session.archived = true;
      session.videoLifetime?.cancel();
      await this.cancelGesture(session);
      for (const token of session.viewers.keys()) this.viewerSessions.delete(token);
      session.viewers.clear();
      session.controller = null;
      this.sessions.delete(session.key);
    }
  }

  /** List retained browser sessions even after their last viewer leaves or expires. */
  async listOpenWorkspaceIds(): Promise<string[]> {
    this.assertOpen();
    const result = new Set<string>();
    for (const session of this.sessions.values()) {
      await this.serialize(session, async () => {
        this.pruneExpired(session);
        // Viewer leases control access and capture, not the lifetime of the browser.
        // Keep an idle browser discoverable so another device can reattach to it.
        if (!session.archived) result.add(session.workspaceId);
      });
    }
    return [...result];
  }
  async status(viewerToken: string): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      if (session.archived) throw new Error("Browser session is closed");
      this.pruneExpired(session);
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.snapshotState(session, viewerToken) };
    });
  }

  /** A lost runtime keeps its typed code so observers can tell it from a transient failure. */
  private metadataFailure(session: BrowserSession, error: string): Error {
    const message = `Browser capture metadata failed: ${error}`;
    return session.runtimeLost
      ? new RuntimeProtocolError("RUNTIME_LOST", message)
      : new Error(message);
  }

  async capture(
    viewerToken: string,
    quality: CaptureQuality = DEFAULT_CAPTURE_QUALITY,
    knownFrameId: string | null = null,
  ): Promise<CaptureReply> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.pruneExpired(session);
      this.heartbeatViewer(session, viewerToken);
      // Reconcile native document identity before capturing and again before
      // issuing authority. A same-URL reload can invalidate the captured pixels.
      const before = await this.snapshotState(session, viewerToken);
      if (before.error) throw this.metadataFailure(session, before.error);
      const inputGeneration = session.inputGeneration;
      const revision = session.frameRevision;
      const frame = await this.frameForQuality(session, quality);
      const observedAt = this.now();
      const state = await this.snapshotState(session, viewerToken);
      if (state.error) throw this.metadataFailure(session, state.error);
      if (
        inputGeneration !== session.inputGeneration ||
        revision !== session.frameRevision ||
        !frameMatchesBrowserContext(frame, before) ||
        !frameMatchesBrowserContext(frame, state)
      ) {
        throw new Error("Browser changed during capture; request another frame");
      }
      if (observedAt + FRAME_TOKEN_TTL_MS <= this.now()) {
        throw new Error("Browser capture expired during validation; request another frame");
      }
      this.rememberFrame(session, frame, undefined, observedAt);
      return { state, frame: knownFrameId === frame.frameId ? null : frame };
    });
  }

  /** Change physical density without navigating, switching input mode, or resizing CSS layout. */
  async setCaptureDensity(input: DensityInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      if (!canUseCaptureDensity(session.viewport, input.density))
        throw new RangeError("Capture density exceeds the supported image bounds");
      if (session.captureScale !== input.density) {
        await this.cancelGesture(session);
        const preset = DEVICE_PRESETS.find(({ id }) => id === session.devicePresetId);
        await this.request(session, "capture.density", {
          density: input.density,
          deviceScaleFactor: preset?.deviceScaleFactor ?? 1,
        });
        session.captureScale = input.density;
        session.viewportGeneration += 1;
        this.invalidateFrames(session);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  /**
   * Wait outside mutation serialization. Normal media reads use cached policy
   * state and native generation fences. A newly observed native document needs
   * one bounded reconciliation because video viewers may not request JPEG/status.
   * The transition read never admits packets, even after reconciliation succeeds.
   */
  async readVideo(input: BrowserVideoReadInput): Promise<BrowserVideoReadReply> {
    input = readBrowserVideoRpc.input.parse(input);
    const session = this.requireViewer(input.viewerToken);
    const before = await this.serialize(session, async () => {
      this.pruneExpired(session);
      this.heartbeatViewer(session, input.viewerToken);
      if (session.videoReads.has(input.viewerToken)) {
        throw new Error("A video read is already pending for this viewer");
      }
      const state = this.projectState(session, input.viewerToken);
      session.videoReads.add(input.viewerToken);
      this.armVideoLifetime(session);
      return {
        state,
        inputGeneration: session.inputGeneration,
        frameRevision: session.frameRevision,
      };
    });

    try {
      const raw = asRecord(
        await this.request(session, "video.read", {
          quality: input.quality,
          ...(input.bitrate === undefined ? {} : { bitrate: input.bitrate }),
          ...(input.fps === undefined ? {} : { fps: input.fps }),
          streamId: input.streamId,
          afterSequence: input.afterSequence,
          waitMs: input.waitMs,
          requestKeyFrame: input.requestKeyFrame,
        }),
      );
      return await this.serialize(session, async () => {
        if (this.requireViewer(input.viewerToken) !== session || session.archived) {
          throw new Error("Video viewer attachment changed");
        }
        if (raw.inputGeneration !== session.inputGeneration) {
          // External/script navigation must not depend on visual fallback to
          // reconcile policy state. Revoke old receipts first, and discard this
          // entire read: neither pre-transition nor mixed-document pixels qualify.
          this.invalidateFrames(session);
          const state = await this.snapshotState(
            session,
            input.viewerToken,
            NAVIGATION_METADATA_TIMEOUT_MS,
          );
          if (this.requireViewer(input.viewerToken) !== session || session.archived) {
            throw new Error("Video viewer attachment changed");
          }
          return { state, status: "reset", streamId: null, packets: [] };
        }
        const state = this.projectState(session, input.viewerToken);
        const changed =
          session.frameRevision !== before.frameRevision ||
          state.sessionId !== before.state.sessionId ||
          state.runtimeId !== before.state.runtimeId ||
          state.bridgeEpoch !== before.state.bridgeEpoch ||
          state.navigationGeneration !== before.state.navigationGeneration ||
          state.viewportGeneration !== before.state.viewportGeneration ||
          session.inputGeneration !== before.inputGeneration ||
          raw.inputGeneration !== session.inputGeneration;
        if (changed || state.status !== "ready") {
          return { state, status: "reset", streamId: null, packets: [] };
        }
        const dimensions = captureDimensions(session.viewport, session.captureScale);
        const packets: BrowserVideoReadReply["packets"] = [];
        let bytes = 0;
        if (Array.isArray(raw.packets)) {
          for (const value of raw.packets.slice(0, 32)) {
            const parsed = runtimeVideoPacketSchema.safeParse(value);
            if (!parsed.success) throw new Error("Runtime returned an invalid video packet");
            // Private source time cannot be supplied or changed by a remote viewer.
            const { capturedAtMonotonicMs, ...packet } = parsed.data;
            const age = this.monotonicNow() - capturedAtMonotonicMs;
            if (
              (session.videoNotBefore !== null && capturedAtMonotonicMs < session.videoNotBefore) ||
              age < -VIDEO_SOURCE_CLOCK_TOLERANCE_MS ||
              age > 1000 ||
              packet.width !== dimensions.width ||
              packet.height !== dimensions.height
            ) {
              return { state, status: "reset", streamId: null, packets: [] };
            }
            bytes += Buffer.byteLength(packet.dataBase64, "base64");
            if (bytes > VIDEO_MAX_BATCH_BYTES)
              throw new Error("Runtime returned an oversized video batch");
            if (packet.streamId !== raw.streamId)
              throw new Error("Video stream identity changed within a batch");
            const receipt = JSON.stringify([
              packet.streamId,
              packet.captureGeneration,
              packet.sequence,
              packet.timestampUs,
            ]);
            const remembered = session.videoReceipts.get(receipt);
            if (remembered && remembered.capturedAtMonotonicMs !== capturedAtMonotonicMs) {
              throw new Error("Runtime changed an existing video receipt timestamp");
            }
            let frame = remembered?.frame;
            if (!frame) {
              frame = {
                frameId: this.issueUniqueToken(),
                sessionId: session.sessionId,
                runtimeId: session.runtimeId,
                captureEpoch: session.bridgeEpoch,
                navigationGeneration: session.navigationGeneration,
                viewportGeneration: session.viewportGeneration,
                width: packet.width,
                height: packet.height,
                capturedAt: packet.capturedAt,
              };
              session.videoReceipts.set(receipt, { frame, capturedAtMonotonicMs });
            }
            // False when input revoked this capture's time: it may still be painted,
            // but it can never authorize a press, and the viewer must not try.
            const actionable = this.rememberFrame(session, frame, capturedAtMonotonicMs);
            packets.push({ ...packet, frame, actionable });
          }
        }
        while (session.videoReceipts.size > MAX_RECENT_FRAMES) {
          const oldest = session.videoReceipts.keys().next().value;
          if (oldest === undefined) break;
          session.videoReceipts.delete(oldest);
        }
        return readBrowserVideoRpc.output.parse({
          state,
          status: raw.status,
          streamId: raw.streamId,
          packets,
          ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
          ...(raw.reasonCode === "encoder-capacity" || raw.reasonCode === "video-disabled"
            ? { reasonCode: raw.reasonCode }
            : {}),
        });
      });
    } finally {
      session.videoReads.delete(input.viewerToken);
    }
  }

  async acquireControl(
    viewerToken: string,
    takeover = false,
  ): Promise<{ controlToken: string; state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.heartbeat(session, viewerToken);
      const current = session.controller;
      if (current && current.viewerToken !== viewerToken && !takeover)
        throw new Error("Browser control is held by another viewer");
      if (current?.viewerToken !== viewerToken) {
        await this.cancelGesture(session);
      }
      const controller =
        current?.viewerToken === viewerToken
          ? current
          : { viewerToken, controlToken: this.issueUniqueToken(), expiresAt: 0 };
      controller.expiresAt = this.now() + this.controlLeaseMs;
      session.controller = controller;
      return {
        controlToken: controller.controlToken,
        state: await this.snapshotState(session, viewerToken),
      };
    });
  }

  async releaseControl(
    viewerToken: string,
    controlToken: string,
  ): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.serialize(session, async () => {
      this.requireController(session, viewerToken, controlToken);
      await this.cancelGesture(session);
      session.controller = null;
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.snapshotState(session, viewerToken) };
    });
  }

  async navigate(input: NavigateInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.cancelGesture(session);
      const navigationGeneration = session.navigationGeneration;
      if (input.action.kind === "goto")
        await this.request(session, "navigate", { url: normalizeBrowserUrl(input.action.url) });
      else if (input.action.kind === "back") {
        await this.refreshPageMetadata(session, NAVIGATION_METADATA_TIMEOUT_MS);
        if (!session.canGoBack) throw new Error("Browser cannot go back");
        await this.request(session, "back", null);
      } else if (input.action.kind === "forward") {
        await this.refreshPageMetadata(session, NAVIGATION_METADATA_TIMEOUT_MS);
        if (!session.canGoForward) throw new Error("Browser cannot go forward");
        await this.request(session, "forward", null);
      } else await this.request(session, "reload", null);
      // One authoritative post-navigation read. Loading is browser-native; an
      // unavailable observation remains an explicit error state, not cached-ready.
      await this.snapshotState(session, input.viewerToken, NAVIGATION_METADATA_TIMEOUT_MS);
      if (session.navigationGeneration === navigationGeneration) session.navigationGeneration += 1;
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: this.projectState(session, input.viewerToken) };
    });
  }

  /** Resize CSS layout under the control lease; panel following preserves device behavior and density. */
  async resize(input: ResizeInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.cancelGesture(session);
      assertViewport(input.viewport);
      const preserveEmulation = input.preserveEmulation === true;
      const captureScale = input.captureDensity ?? (preserveEmulation ? session.captureScale : 1);
      if (
        input.viewport.width * captureScale > MAX_VIEWPORT.width ||
        input.viewport.height * captureScale > MAX_VIEWPORT.height
      ) {
        throw new RangeError(
          "Viewport at the current capture density exceeds supported image bounds",
        );
      }
      if (
        session.viewport.width !== input.viewport.width ||
        session.viewport.height !== input.viewport.height ||
        session.captureScale !== captureScale ||
        (!preserveEmulation && session.devicePresetId !== null)
      ) {
        const preset = preserveEmulation
          ? DEVICE_PRESETS.find(({ id }) => id === session.devicePresetId)
          : undefined;
        await this.request(session, "emulate", {
          ...input.viewport,
          deviceScaleFactor: Math.max(preset?.deviceScaleFactor ?? 1, captureScale),
          captureScale,
          mobile: preset?.isMobile ?? false,
          touch: preset?.hasTouch ?? false,
          userAgent: preserveEmulation ? session.userAgent : session.defaultUserAgent,
          platform: preset?.platform ?? "",
        });
        session.viewport = { ...input.viewport };
        session.captureScale = captureScale;
        if (!preserveEmulation) {
          session.devicePresetId = null;
          session.userAgent = session.defaultUserAgent;
        }
        session.viewportGeneration += 1;
        this.invalidateFrames(session);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async applyDevicePreset(input: ApplyDevicePresetInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.cancelGesture(session);
      const preset = DEVICE_PRESETS.find(({ id }) => id === input.presetId);
      if (!preset) throw new Error("Unknown device preset");
      // Resolve the display under the session lock. A mode toggle must neither
      // replay remembered dimensions nor change the capture's pixel resolution.
      const viewport = input.preserveDisplay ? session.viewport : preset.viewport;
      const captureScale = input.preserveDisplay ? session.captureScale : preset.captureScale;
      await this.request(session, "emulate", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: Math.max(preset.deviceScaleFactor, captureScale),
        captureScale,
        mobile: preset.isMobile,
        touch: preset.hasTouch,
        userAgent: preset.userAgent,
        platform: preset.platform,
      });
      session.viewport = { ...viewport };
      session.devicePresetId = preset.id;
      session.captureScale = captureScale;
      session.userAgent = preset.userAgent;
      session.viewportGeneration += 1;
      // Emulation invalidates input geometry even when display dimensions stay
      // fixed. UA-sniffing sites can use Reload; never discard a draft automatically.
      this.invalidateFrames(session);
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  async sendInput(input: SendInput): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      this.requireRecentFrame(session, input.target);
      const assertTargetCurrent = this.discreteInputGuard(session, input);
      try {
        await this.cancelGesture(session);
        await this.dispatchDiscreteInput(session, input.event, assertTargetCurrent);
      } finally {
        const hadVideo = session.videoReceipts.size > 0 || session.videoReads.size > 0;
        // Revoke authority even if auxiliary capture fails. Source-age fencing
        // rejects buffered pre-action video and never overwrites the input outcome.
        this.invalidateFrames(session);
        if (hadVideo) await this.request(session, "video.invalidate", null).catch(() => undefined);
      }
      this.renewController(session, input.viewerToken);
      return { state: await this.snapshotState(session, input.viewerToken) };
    });
  }

  /**
   * Admit one human channel from a decoded frame receipt that is still fresh.
   * A receipt is bounded by its TTL and cleared by acknowledged input; an idle
   * reopen therefore needs new pixels, never a retained earlier admission. Native
   * begin pins the attachment/document. This never admits agent input.
   */
  async beginGesture(input: BeginGestureInput) {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      this.requireMutationAccess(session, input);
      await this.refreshPageMetadata(session);
      session.error = null;
      this.requireMutationAccess(session, input);
      if (!this.isRecentFrame(session, input.target)) {
        // A pre-input capture can decode after scroll revoked its token. Report
        // known non-publication, not an uncertain runtime failure. The client
        // may obtain another decoded frame before admitting its still-unsent input.
        const state = await this.snapshotState(session, input.viewerToken);
        this.requireMutationAccess(session, input);
        if (state.status !== "ready")
          throw new Error(state.error ?? "Browser runtime is unavailable");
        return { state, admission: "stale-frame" as const };
      }
      if (session.inputGeneration === null)
        throw new Error("Browser input identity is unavailable");
      await this.cancelGesture(session);
      const gesture = new BrowserGesture(
        this.issueUniqueToken(),
        input.viewerToken,
        input.controlToken,
        input.pointerKind,
        { ...input.expected },
        { ...session.viewport },
        this.now(),
        session.inputGeneration,
      );
      session.gesture = gesture;
      try {
        await this.request(session, "input.begin", {
          gestureId: gesture.id,
          expectedInputGeneration: gesture.runtimeInputGeneration,
        });
        await this.assertGestureCurrent(session, gesture);
        this.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const state = this.projectState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence };
      } catch (error) {
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /**
   * Continue an admitted human channel independently of decoded-frame catchup.
   * Exact control/document/geometry/native checks fence every ordered packet, and
   * every new press (mouse down or first touch contact) needs its own fresh decoded
   * receipt. Held motion and releases reuse the channel. Uncertain publication
   * revokes observations and is never replayed.
   */
  async updateGesture(input: UpdateGestureInput): Promise<UpdateGestureReply> {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      const gesture = this.requireGesture(session, input);
      let publishedEvent: BrowserGestureEvent | null = null;
      let eventAcknowledged = false;
      try {
        this.assertGesturePacketContext(gesture, input.expected);
        const event = browserGestureEventSchema.parse(input.event);
        gesture.assertSequence(input.sequence, this.now());
        await this.assertGestureCurrent(session, gesture);
        gesture.validate(event);
        const hover = gesture.isHover(event);
        if (
          event.kind === "down" ||
          (event.kind === "touch" && event.type === "start" && gesture.touches.size === 0)
        ) {
          if (!input.target) throw new Error("A current frame is required for a new press");
          this.requireRecentFrame(session, input.target);
        }
        // Revoke agent observations before an outcome can become unknown.
        this.invalidateGestureObservations(session, hover);
        if (event.kind === "key") {
          await this.request(session, "input.key", {
            gestureId: gesture.id,
            event: {
              kind: event.kind,
              type: event.type,
              key: event.key,
              code: event.code,
              modifiers: event.modifiers,
              repeat: event.repeat,
              ...(event.text !== undefined ? { text: event.text } : {}),
            },
          });
        } else if (event.kind === "text") {
          await this.request(session, "input.text", { gestureId: gesture.id, text: event.text });
        } else if (event.kind === "leave") {
          await this.request(session, "mouse.leave", { gestureId: gesture.id });
          gesture.lastPoint = null;
        } else if (event.kind === "touch") {
          const points = event.points.map((point) => ({
            ...gesture.mapPoint(point),
            id: point.id,
          }));
          await this.request(session, "touch", { gestureId: gesture.id, type: event.type, points });
        } else {
          const point = gesture.mapPoint(event.point);
          const operation =
            event.kind === "move"
              ? "mouse.move"
              : event.kind === "down"
                ? "mouse.down"
                : event.kind === "up"
                  ? "mouse.up"
                  : "mouse.wheel";
          await this.request(session, operation, {
            ...point,
            gestureId: gesture.id,
            ...(event.modifiers === undefined ? {} : { modifiers: event.modifiers }),
            ...(event.kind === "down" || event.kind === "up"
              ? { button: event.button, clickCount: event.clickCount }
              : {}),
            ...(event.kind === "scroll" ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
          });
        }
        publishedEvent = event;
        await this.assertGestureCurrent(session, gesture);
        gesture.acknowledge(event, this.now());
        eventAcknowledged = true;
        // Fence captures received during publication as well as earlier ones.
        this.invalidateGestureObservations(session, hover);
        this.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const cursor = await this.gestureCursor(session, gesture);
        // An ordinary held-input acknowledgement must not block video behind a
        // page metadata RPC. Native attachment/document checks remain mandatory;
        // their navigation failure uses the qualified completion path below.
        const state = this.projectState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence, cursor };
      } catch (error) {
        if (publishedEvent) {
          const completion = await this.completeNavigatingInput(
            session,
            gesture,
            publishedEvent,
            eventAcknowledged,
          ).catch(() => null);
          if (completion) return completion;
        }
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /** Revoke observation authority without resetting the continuous video codec. */
  private invalidateGestureObservations(session: BrowserSession, hover: boolean): void {
    session.frameCache.clear();
    if (!hover) {
      session.recentFrames.clear();
      session.videoInputNotBefore = this.monotonicNow();
    }
  }

  /** Return a fresh viewing state after acknowledged input navigated, without admitting another input. */
  private async completeNavigatingInput(
    session: BrowserSession,
    gesture: BrowserGesture,
    event: BrowserGestureEvent,
    eventAcknowledged: boolean,
  ) {
    const state = await this.snapshotState(session, gesture.viewerToken);
    if (state.navigationGeneration === gesture.expected.navigationGeneration) return null;
    // Runtime inputGeneration is the private native attachment:document tuple.
    // A target replacement can also bump policy navigationGeneration, but must
    // never be accepted as same-attachment navigation after an acknowledged input.
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;

    // Only the old document constraint may change after successful publication.
    // Takeover, viewport changes and runtime/bridge fences are still refused.
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: state.navigationGeneration },
    });
    if (!eventAcknowledged) gesture.acknowledge(event, this.now());
    await this.cancelGesture(session, gesture);
    const finalState = await this.snapshotState(session, gesture.viewerToken);
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: finalState.navigationGeneration },
    });
    this.invalidateFrames(session);
    this.renewController(session, gesture.viewerToken);
    return {
      state: finalState,
      gestureId: gesture.id,
      nextSequence: gesture.nextSequence,
      cursor: null,
      completion: "navigation" as const,
    };
  }

  /** Cancellation releases only this channel, even after a lost update reply or navigation drift. */
  async endGesture(input: EndGestureInput) {
    const session = this.requireViewer(input.viewerToken);
    return this.serialize(session, async () => {
      const gesture = session.gesture;
      if (!gesture && input.cancel) {
        this.requireController(session, input.viewerToken, input.controlToken);
        return { state: this.projectState(session, input.viewerToken), cursor: null };
      }
      const owned = this.requireGesture(session, input);
      try {
        if (!input.cancel) {
          this.assertGesturePacketContext(owned, input.expected);
          owned.assertSequence(input.sequence, this.now());
          await this.assertGestureCurrent(session, owned);
        }
      } finally {
        await this.cancelGesture(session, owned);
      }
      return { state: this.projectState(session, input.viewerToken), cursor: null };
    });
  }

  private requireGesture(
    session: BrowserSession,
    input: UpdateGestureInput | EndGestureInput,
  ): BrowserGesture {
    const gesture = session.gesture;
    if (
      !gesture ||
      gesture.id !== input.gestureId ||
      gesture.viewerToken !== input.viewerToken ||
      gesture.controlToken !== input.controlToken
    )
      throw new Error("Browser gesture is unavailable");
    return gesture;
  }

  private assertGesturePacketContext(
    gesture: BrowserGesture,
    expected: BeginGestureInput["expected"],
  ): void {
    // JSON member order is irrelevant; identity fields must match individually.
    for (const key of [
      "sessionId",
      "runtimeId",
      "bridgeEpoch",
      "navigationGeneration",
      "viewportGeneration",
    ] as const) {
      if (gesture.expected[key] !== expected[key])
        throw new Error("Browser gesture context changed");
    }
  }

  private async assertGestureCurrent(
    session: BrowserSession,
    gesture: BrowserGesture,
  ): Promise<void> {
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (
      session.gesture !== gesture ||
      this.now() >= gesture.idleUntil ||
      this.now() >= gesture.expiresAt
    )
      throw new Error("Browser gesture expired");
    // Runtime check pins the CDP document/attachment without repeating a full
    // metadata read for every drag point. Status or a media-generation mismatch
    // reconciles metadata; acknowledged navigation uses its explicit completion.
    await this.request(session, "input.check", { gestureId: gesture.id });
    this.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (session.gesture !== gesture) throw new Error("Browser gesture was cancelled");
  }

  private async gestureCursor(session: BrowserSession, gesture: BrowserGesture) {
    if (!gesture.lastPoint || gesture.pointerKind !== "mouse") return null;
    try {
      const raw = await this.request(session, "cursor", {
        ...gesture.lastPoint,
        gestureId: gesture.id,
      });
      const parsed = browserCursorSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private scheduleGestureTimeout(session: BrowserSession, gesture: BrowserGesture): void {
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = setTimeout(
      () => {
        void this.serialize(session, async () => {
          if (
            session.gesture === gesture &&
            this.now() >= Math.min(gesture.idleUntil, gesture.expiresAt)
          ) {
            await this.cancelGesture(session, gesture);
          }
        }).catch(() => undefined);
      },
      Math.max(1, Math.min(gesture.idleUntil, gesture.expiresAt) - this.now()),
    );
    gesture.timer.unref?.();
  }

  private async cancelGesture(session: BrowserSession, expected?: BrowserGesture): Promise<void> {
    const gesture = session.gesture;
    if (!gesture || (expected && gesture !== expected)) return;
    session.gesture = null;
    if (gesture.timer) clearTimeout(gesture.timer);
    // Cleanup targets the runtime's original attachment, never a newly navigated
    // or replaced page. Failure is best-effort and cannot replay the input.
    try {
      await this.request(session, "input.end", { gestureId: gesture.id });
    } catch {
      /* Best-effort old-attachment cleanup must not escape teardown. */
    }
  }

  reset(): void {
    this.lifecycleGeneration += 1;
    for (const session of this.sessions.values()) {
      session.videoLifetime?.cancel();
      void this.cancelGesture(session);
    }
    this.sessions.clear();
    this.sessionCreations.clear();
    this.viewerSessions.clear();
    this.closedViewerWorkspaces.clear();
    this.closedViewerTabs.clear();
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.disconnect();
    this.reset();
  }

  private async getOrCreateSession(
    workspaceId: string,
    tabId?: string,
    replaceLost = false,
    createIfMissing = true,
  ): Promise<BrowserSession> {
    if (this.archived.has(workspaceId)) throw new Error("Workspace was archived");
    const closing = this.sessionClosures.get(workspaceId);
    if (closing) await closing.catch(() => undefined);
    if (this.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
    const existing = [...this.sessions.values()].find(
      (session) => session.workspaceId === workspaceId && (!tabId || session.tabId === tabId),
    );
    if (existing) return existing;

    // The launch page has no known target ID until identity returns. Wait for
    // another first attachment before deciding whether this target needs a
    // second policy session, so control and presence cannot split in two.
    const workspaceCreation = [...this.sessionCreations.entries()].find(
      ([pendingKey]) => pendingKey === workspaceId || pendingKey.startsWith(`${workspaceId}/`),
    )?.[1];
    if (workspaceCreation) {
      await workspaceCreation.catch(() => undefined);
      return this.getOrCreateSession(workspaceId, tabId, replaceLost, createIfMissing);
    }
    if (!createIfMissing && ![...this.sessions.values()].some((session) => session.workspaceId === workspaceId))
      throw new Error("Browser is closed");
    const key = tabId ? `${workspaceId}/${tabId}` : workspaceId;
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions)
      throw new Error(`Shared browser session limit (${this.maxSessions}) reached`);
    const lifecycleGeneration = this.lifecycleGeneration;
    const creation = this.createSession(workspaceId, key, tabId, replaceLost);
    this.sessionCreations.set(key, creation);
    try {
      const session = await creation;
      if (this.closed) throw new Error("Shared browser manager is closed");
      if (this.archived.has(workspaceId)) throw new Error("Workspace was archived");
      if (this.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw new Error("Shared browser manager was reset");
      }
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      if (this.archived.has(workspaceId)) throw new Error("Workspace was archived");
      throw error;
    } finally {
      if (this.sessionCreations.get(key) === creation) this.sessionCreations.delete(key);
    }
  }

  private async createSession(
    workspaceId: string,
    key: string,
    requestedTabId?: string,
    replaceLost = false,
  ): Promise<BrowserSession> {
    let runtimeId: string | null = null;
    try {
      const descriptor = await this.client.ensureWorkspace(workspaceId, { replaceLost });
      runtimeId = descriptor.runtimeId;
      const initialTarget = requestedTabId ? { targetId: requestedTabId } : null;
      const identity = asRecord(
        await this.client.requestWorkspace(workspaceId, "identity", initialTarget),
      );
      const tabId =
        requestedTabId ?? (typeof identity.targetId === "string" ? identity.targetId : null);
      const userAgent = boundedText(String(identity.userAgent ?? "Chromium"), 512);
      await this.client.requestWorkspace(workspaceId, "emulate", {
        ...DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
        userAgent,
        platform: "",
        ...(tabId ? { targetId: tabId } : {}),
      });
      const state = asRecord(
        await this.client.requestWorkspace(
          workspaceId,
          "state",
          tabId ? { targetId: tabId } : null,
        ),
      );
      return {
        key,
        workspaceId,
        tabId,
        sessionId: this.issueUniqueToken(),
        runtimeId: descriptor.runtimeId,
        runtimeCreatedAt: descriptor.createdAt,
        bridgeEpoch: this.bridgeEpoch,
        viewport: { ...DEFAULT_VIEWPORT },
        captureScale: 1,
        navigationGeneration: 0,
        viewportGeneration: 0,
        devicePresetId: null,
        userAgent,
        defaultUserAgent: userAgent,
        viewers: new Map(),
        controller: null,
        mutationTail: Promise.resolve(),
        frameCache: new Map(),
        recentFrames: new Map(),
        frameRevision: 0,
        videoNotBefore: null,
        videoInputNotBefore: null,
        videoReads: new Set(),
        videoLifetime: null,
        videoReceipts: new Map(),
        lastUrl: boundedText(String(state.url ?? ""), 8192),
        lastTitle: boundedText(String(state.title ?? ""), 1024),
        canGoBack: Boolean(state.canGoBack),
        canGoForward: Boolean(state.canGoForward),
        error: null,
        notice:
          typeof identity.displayNotice === "string"
            ? boundedText(identity.displayNotice, 256)
            : null,
        runtimeLost: false,
        archived: false,
        gesture: null,
        inputGeneration: typeof state.inputGeneration === "string" ? state.inputGeneration : null,
      };
    } catch (error) {
      const hasOtherSession = [...this.sessions.values()].some(
        (session) => session.workspaceId === workspaceId && session.key !== key,
      );
      const hasOtherCreation = [...this.sessionCreations.keys()].some(
        (pendingKey) =>
          pendingKey !== key &&
          (pendingKey === workspaceId || pendingKey.startsWith(`${workspaceId}/`)),
      );
      // An invalid explicit tab must never tear down a workspace runtime that
      // another participant may already be using without a policy session.
      if (runtimeId && !requestedTabId && !hasOtherSession && !hasOtherCreation) {
        await this.client.closeWorkspace(workspaceId, runtimeId).catch(() => undefined);
      }
      throw error;
    }
  }

  private request(
    session: BrowserSession,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    if (session.archived) throw new Error("Workspace was archived");
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return this.client
      .requestWorkspace(
        session.workspaceId,
        operation,
        session.tabId ? { ...data, targetId: session.tabId } : input,
      )
      .catch((error) => {
        if (error instanceof RuntimeProtocolError && error.code === "RUNTIME_LOST") {
          // The workspace's single browser is gone, so every page session of it is gone.
          session.runtimeLost = true;
          for (const candidate of this.sessions.values())
            if (candidate.workspaceId === session.workspaceId) candidate.runtimeLost = true;
        }
        throw error;
      });
  }

  /** Cleanup depends on viewer ownership, never on whether capture produced pixels. */
  private async stopUnusedVideo(session: BrowserSession): Promise<void> {
    if (session.viewers.size !== 0) return;
    session.videoLifetime?.cancel();
    await this.request(session, "video.stop", null).catch(() => undefined);
    this.invalidateFrames(session);
  }

  /** Recheck leases under the same session queue before stopping optional capture. */
  private armVideoLifetime(session: BrowserSession): void {
    session.videoLifetime ??= createViewerCaptureLifetime({
      now: this.now,
      latestExpiry: () =>
        session.viewers.size > 0
          ? Math.max(...[...session.viewers.values()].map((viewer) => viewer.expiresAt))
          : null,
      onExpired: () =>
        this.serialize(session, async () => {
          if (this.sessions.get(session.key) !== session || session.archived) return;
          this.pruneExpired(session);
          await this.stopUnusedVideo(session);
        }),
    });
    session.videoLifetime.arm();
  }

  private requireViewer(token: string): BrowserSession {
    if (this.closedViewerWorkspaces.has(token)) throw new Error("Browser is closed");
    const closedTabExpiry = this.closedViewerTabs.get(token);
    if (closedTabExpiry !== undefined) {
      if (closedTabExpiry > this.now()) throw new Error("Browser tab is closed");
      this.closedViewerTabs.delete(token);
    }
    const session = this.viewerSessions.get(token);
    const viewer = session?.viewers.get(token);
    // Expiry is enforced at the authentication boundary itself: an unpruned lapsed lease
    // never authorizes an entrypoint that does not run pruneExpired first.
    if (!session || !viewer || viewer.expiresAt <= this.now())
      throw new Error("Viewer token is invalid or expired");
    return session;
  }
  private heartbeat(session: BrowserSession, token: string): void {
    this.pruneExpired(session);
    this.heartbeatViewer(session, token);
    if (session.controller?.viewerToken === token)
      session.controller.expiresAt = this.now() + this.controlLeaseMs;
  }
  private heartbeatViewer(session: BrowserSession, token: string): void {
    const viewer = session.viewers.get(token);
    if (!viewer) throw new Error("Viewer token is invalid or expired");
    viewer.expiresAt = this.now() + this.viewerTtlMs;
  }
  private pruneExpired(session: BrowserSession): void {
    const now = this.now();
    for (const [token, viewer] of session.viewers)
      if (viewer.expiresAt <= now) {
        session.viewers.delete(token);
        this.viewerSessions.delete(token);
      }
    if (
      session.controller &&
      (session.controller.expiresAt <= now || !session.viewers.has(session.controller.viewerToken))
    ) {
      session.controller = null;
      void this.serialize(session, () => this.cancelGesture(session)).catch(() => undefined);
    }
  }
  private requireController(
    session: BrowserSession,
    viewerToken: string,
    controlToken: string,
  ): Controller {
    this.pruneExpired(session);
    const value = session.controller;
    if (!value || value.viewerToken !== viewerToken || value.controlToken !== controlToken)
      throw new Error("Browser control lease is invalid or expired");
    return value;
  }
  private requireMutationAccess(
    session: BrowserSession,
    input: {
      viewerToken: string;
      controlToken: string;
      expected: {
        sessionId: string;
        navigationGeneration: number;
        viewportGeneration: number;
        runtimeId?: string | undefined;
        bridgeEpoch?: number | undefined;
      };
    },
  ): void {
    this.requireController(session, input.viewerToken, input.controlToken);
    if (input.expected.sessionId !== session.sessionId) throw new Error("Browser session is stale");
    if (input.expected.navigationGeneration !== session.navigationGeneration)
      throw new Error("Browser navigation state is stale");
    if (input.expected.viewportGeneration !== session.viewportGeneration)
      throw new Error("Browser viewport state is stale");
    if (input.expected.runtimeId && input.expected.runtimeId !== session.runtimeId)
      throw new Error("Browser runtime is stale");
    if (
      input.expected.bridgeEpoch !== undefined &&
      input.expected.bridgeEpoch !== session.bridgeEpoch
    )
      throw new Error("Browser bridge state is stale");
  }
  private requireRecentFrame(
    session: BrowserSession,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): void {
    // Retain diagnostic evidence before validation prunes expired receipts.
    // An absent receipt cannot distinguish expiry from an earlier revocation.
    const frame = session.recentFrames.get(target.frameId);
    if (this.isRecentFrame(session, target)) return;
    if (!frame) throw createBrowserFrameRejection("admission", "missing-or-revoked");

    const expiresAt = frame.expiresAtMonotonicMs ?? frame.expiresAt;
    const now = frame.expiresAtMonotonicMs === undefined ? this.now() : this.monotonicNow();
    const ageMs = now - (expiresAt - FRAME_TOKEN_TTL_MS);
    const reason = expiresAt <= now ? "expired" : "context-changed";
    throw createBrowserFrameRejection("admission", reason, ageMs);
  }

  /** Check issued frame authority without admitting or cancelling a live channel. */
  private isRecentFrame(
    session: BrowserSession,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): boolean {
    this.pruneRecentFrames(session);
    const frame = session.recentFrames.get(target.frameId);
    return Boolean(
      frame &&
        target.navigationGeneration === session.navigationGeneration &&
        target.viewportGeneration === session.viewportGeneration &&
        frame.navigationGeneration === session.navigationGeneration &&
        frame.viewportGeneration === session.viewportGeneration,
    );
  }
  private renewController(session: BrowserSession, token: string): void {
    this.heartbeatViewer(session, token);
    const controller = session.controller;
    if (!controller || controller.viewerToken !== token)
      throw new Error("Browser control lease is invalid or expired");
    controller.expiresAt = this.now() + this.controlLeaseMs;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Shared browser manager is closed");
  }
  private issueUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.issueToken();
      if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Token issuer returned an invalid opaque token");
      if (
        !this.viewerSessions.has(token) &&
        ![...this.sessions.values()].some(
          (session) =>
            session.sessionId === token ||
            session.controller?.controlToken === token ||
            session.recentFrames.has(token),
        )
      )
        return token;
    }
    throw new Error("Could not issue a unique opaque token");
  }
  private pruneRecentFrames(session: BrowserSession): void {
    const now = this.now();
    const monotonicNow = this.monotonicNow();
    for (const [id, frame] of session.recentFrames) {
      const expired =
        frame.expiresAtMonotonicMs === undefined
          ? frame.expiresAt <= now
          : frame.expiresAtMonotonicMs <= monotonicNow;
      if (expired) session.recentFrames.delete(id);
    }
  }
  private serialize<T>(session: BrowserSession, operation: () => Promise<T>): Promise<T> {
    const result = session.mutationTail.then(operation, operation);
    session.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private invalidateFrames(session: BrowserSession): void {
    session.frameRevision += 1;
    session.videoNotBefore = this.monotonicNow();
    session.videoInputNotBefore = session.videoNotBefore;
    session.frameCache.clear();
    session.recentFrames.clear();
    session.videoReceipts.clear();
  }

  private async frameForQuality(
    session: BrowserSession,
    quality: CaptureQuality,
  ): Promise<BrowserFrame> {
    const cached = session.frameCache.get(quality);
    if (
      cached &&
      frameMatchesBrowserContext(cached.frame, session) &&
      this.now() - cached.cachedAt <= this.frameCacheMs
    )
      return cached.frame;
    const generation = {
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      captureEpoch: session.bridgeEpoch,
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
    };
    const raw = asRecord(
      await this.request(session, "frame", {
        maxBytes: FRAME_MAX_BYTES,
        quality: JPEG_QUALITY[quality],
        waitMs: SCREENCAST_WAIT_MS,
      }),
    );
    if (!frameMatchesBrowserContext(generation, session))
      throw new Error("Browser changed during capture; request another frame");
    const byteLength = Number(raw.byteLength);
    const dataBase64 = String(raw.dataBase64 ?? "");
    if (
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > FRAME_MAX_BYTES ||
      Buffer.byteLength(dataBase64, "base64") !== byteLength
    )
      throw new Error("Browser returned an invalid frame");
    const expectedPixels = captureDimensions(session.viewport, session.captureScale);
    if (Number(raw.width) !== expectedPixels.width || Number(raw.height) !== expectedPixels.height)
      throw new Error("Browser returned a frame for a stale viewport");

    // Runtime fallback receipts remain fresh for at most one second. A 100ms
    // policy-cache expiry must not create a new token and resend the same large
    // JPEG at every poll. Reuse only its exact receipt, not merely equal pixels.
    if (
      cached &&
      typeof raw.capturedAt === "string" &&
      Number.isFinite(Date.parse(raw.capturedAt)) &&
      (raw.transport === "screenshot" || raw.transport === "cdp-screencast") &&
      session.frameCache.get(quality) === cached &&
      cached.frame.sessionId === generation.sessionId &&
      cached.frame.runtimeId === generation.runtimeId &&
      cached.frame.captureEpoch === generation.captureEpoch &&
      cached.frame.navigationGeneration === generation.navigationGeneration &&
      cached.frame.viewportGeneration === generation.viewportGeneration &&
      (["dataBase64", "byteLength", "width", "height", "capturedAt", "transport"] as const).every(
        (key) => cached.rawFrame[key] === raw[key],
      )
    ) {
      cached.cachedAt = this.now();
      return cached.frame;
    }

    const frame: BrowserFrame = {
      frameId: this.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: raw.transport === "cdp-screencast" ? "cdp-screencast" : "screenshot",
      dataBase64,
      byteLength,
      width: Number(raw.width),
      height: Number(raw.height),
      ...generation,
      capturedAt: String(raw.capturedAt),
    };
    session.frameCache.set(quality, { frame, cachedAt: this.now(), rawFrame: { ...raw } });
    return frame;
  }

  /** Native source clocks have bounded uncertainty. Displaying a late packet
   * must never resurrect the press token revoked by acknowledged live input.
   * JPEG receipts retain the runtime's existing post-input capture-generation fence. */
  private rememberFrame(
    session: BrowserSession,
    frame: BrowserFrameAuthority,
    capturedAtMonotonicMs?: number,
    observedAt = this.now(),
  ): boolean {
    if (capturedAtMonotonicMs !== undefined && session.videoInputNotBefore !== null) {
      const exclusiveFloor = session.videoInputNotBefore + VIDEO_SOURCE_CLOCK_TOLERANCE_MS;
      if (!Number.isFinite(capturedAtMonotonicMs) || capturedAtMonotonicMs <= exclusiveFloor) {
        session.recentFrames.delete(frame.frameId);
        return false;
      }
    }
    this.pruneRecentFrames(session);
    session.recentFrames.set(frame.frameId, {
      navigationGeneration: frame.navigationGeneration,
      viewportGeneration: frame.viewportGeneration,
      expiresAt: observedAt + FRAME_TOKEN_TTL_MS,
      ...(capturedAtMonotonicMs === undefined
        ? {}
        : {
            expiresAtMonotonicMs: this.monotonicNow() + FRAME_TOKEN_TTL_MS,
          }),
    });
    while (session.recentFrames.size > MAX_RECENT_FRAMES) {
      const oldest = session.recentFrames.keys().next().value;
      if (!oldest) break;
      session.recentFrames.delete(oldest);
    }
    return session.recentFrames.has(frame.frameId);
  }

  /**
   * Retain one freshly admitted observation for this operation only. Runtime
   * latency cannot expire it after publication; control, native document and
   * every attachment/display fence still revoke it. No continuation is exposed.
   */
  private discreteInputGuard(session: BrowserSession, input: SendInput): () => Promise<void> {
    const context = {
      viewerToken: input.viewerToken,
      controlToken: input.controlToken,
      expected: {
        sessionId: session.sessionId,
        runtimeId: session.runtimeId,
        bridgeEpoch: session.bridgeEpoch,
        navigationGeneration: session.navigationGeneration,
        viewportGeneration: session.viewportGeneration,
      },
    };
    const inputGeneration = session.inputGeneration;
    const revision = session.frameRevision;
    return async () => {
      await this.refreshPageMetadata(session);
      if (
        inputGeneration !== session.inputGeneration ||
        revision !== session.frameRevision ||
        context.expected.navigationGeneration !== session.navigationGeneration ||
        context.expected.viewportGeneration !== session.viewportGeneration
      ) {
        throw createBrowserFrameRejection("admitted-input", "context-changed");
      }
      this.requireMutationAccess(session, context);
    };
  }

  /** Every discrete native primitive (text, key, press, hover, wheel) runs on one private
   * channel pinned to the original attachment and document, which the runtime re-checks
   * before each publication. The ID is never returned to callers and grants no agent
   * continuation. Native end uses the original page even after navigation, revocation
   * or a lost down ACK. */
  private async dispatchDiscreteInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    assertTargetCurrent: () => Promise<void>,
  ): Promise<void> {
    // Reconcile the captured document before anything is published, hover included, so a
    // stalled or failed metadata read holds back every native primitive.
    await assertTargetCurrent();
    if (session.inputGeneration === null) {
      throw new Error("Browser input identity is unavailable");
    }
    const gestureId = this.issueUniqueToken();
    await runWithInputCleanup(
      async () => {
        await this.request(session, "input.begin", {
          gestureId,
          expectedInputGeneration: session.inputGeneration,
        });
        await this.dispatchInput(session, event, assertTargetCurrent, gestureId);
      },
      () => this.request(session, "input.end", { gestureId }),
    );
  }

  private async dispatchInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    assertTargetCurrent: () => Promise<void>,
    gestureId: string,
  ): Promise<void> {
    // The document was reconciled and pinned by dispatchDiscreteInput; the runtime refuses
    // every primitive below once its attachment or document differs from that pin.
    if (event.kind === "move") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.request(session, "mouse.move", { x: point.x, y: point.y, gestureId });
      return;
    }
    if (event.kind === "type") {
      await this.request(session, "text.insert", {
        text: event.text,
        gestureId,
      });
      return;
    }
    if (event.kind === "key") {
      await this.request(session, "key.down", {
        key: event.key,
        gestureId,
      });
      await runWithInputCleanup(assertTargetCurrent, () =>
        this.request(session, "key.up", {
          key: event.key,
          gestureId,
        }),
      );
      return;
    }
    if (event.kind === "scroll") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.request(session, "mouse.move", { x: point.x, y: point.y, gestureId });
      await assertTargetCurrent();
      await this.request(session, "mouse.wheel", {
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        gestureId,
      });
      return;
    }
    const start = mapDisplayedPoint(
      event.kind === "drag" ? event.start : event.point,
      session.viewport,
    );
    await this.request(session, "mouse.move", {
      x: start.x,
      y: start.y,
      gestureId,
    });
    await assertTargetCurrent();
    const count = event.kind === "click" ? event.clickCount : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.request(session, "mouse.down", {
        x: start.x,
        y: start.y,
        button: event.button,
        clickCount,
        gestureId,
      });
      await runWithInputCleanup(
        async () => {
          await assertTargetCurrent();
          if (event.kind === "drag") {
            const end = mapDisplayedPoint(event.end, session.viewport);
            await this.request(session, "mouse.move", {
              x: end.x,
              y: end.y,
              gestureId,
            });
            await assertTargetCurrent();
          }
        },
        async () => {
          const end =
            event.kind === "drag" ? mapDisplayedPoint(event.end, session.viewport) : start;
          await this.request(session, "mouse.up", {
            x: end.x,
            y: end.y,
            button: event.button,
            clickCount,
            gestureId,
          });
        },
      );
    }
  }

  private async refreshPageMetadata(session: BrowserSession, timeoutMs?: number): Promise<void> {
    const raw = asRecord(
      await this.request(session, "state", timeoutMs === undefined ? null : { timeoutMs }),
    );
    const url = boundedText(String(raw.url ?? ""), 8192);
    const inputGeneration = typeof raw.inputGeneration === "string" ? raw.inputGeneration : null;
    const documentChanged =
      session.inputGeneration !== null && inputGeneration !== session.inputGeneration;
    if ((session.lastUrl && session.lastUrl !== url) || documentChanged) {
      await this.cancelGesture(session);
      session.navigationGeneration += 1;
      this.invalidateFrames(session);
    }
    session.inputGeneration = inputGeneration;
    session.lastUrl = url;
    session.lastTitle = boundedText(String(raw.title ?? ""), 1024);
    session.canGoBack = Boolean(raw.canGoBack);
    session.canGoForward = Boolean(raw.canGoForward);
  }

  private async snapshotState(
    session: BrowserSession,
    viewerToken: string,
    timeoutMs?: number,
  ): Promise<BrowserState> {
    this.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    try {
      await this.refreshPageMetadata(session, timeoutMs);
      session.error = null;
    } catch (error) {
      session.error = boundedText(error instanceof Error ? error.message : String(error), 2048);
    }
    return this.projectState(session, viewerToken);
  }

  /** Project the last reconciled state without a page RPC. Media generations independently fence late pixels. */
  private projectState(session: BrowserSession, viewerToken: string): BrowserState {
    this.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    const controller = session.controller;
    const controllerViewer = controller ? session.viewers.get(controller.viewerToken) : null;
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      ...(session.tabId ? { tabId: session.tabId } : {}),
      runtimeCreatedAt: session.runtimeCreatedAt,
      bridgeEpoch: session.bridgeEpoch,
      status: session.error ? "error" : "ready",
      url: session.lastUrl,
      title: session.lastTitle,
      canGoBack: session.canGoBack,
      canGoForward: session.canGoForward,
      viewport: { ...session.viewport },
      captureScale: session.captureScale,
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
      devicePresetId: session.devicePresetId,
      userAgent: session.userAgent,
      controller: !controller ? "none" : controller.viewerToken === viewerToken ? "self" : "other",
      controllerLabel: controllerViewer?.label ?? null,
      controllerExpiresAt: controller ? new Date(controller.expiresAt).toISOString() : null,
      viewerCount: session.viewers.size,
      error: session.error,
      ...(session.notice ? { notice: session.notice } : {}),
    };
  }
}
