import { setTimeout, clearTimeout } from "./node-timers";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { canUseCaptureDensity, captureDensitySchema } from "../../shared/managed-browser/capture-density";

import { captureDimensions, DEFAULT_JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { MAX_VIEWPORT } from "../../shared/managed-browser/viewport-limits";
import {
  attachToTarget,
  CdpConnection,
  type CdpEvent,
  type CdpSession,
  type CdpTarget,
  CdpUnavailableError,
  CdpUnknownOutcomeError,
  listPageTargets,
} from "./cdp";
import { readJpegFrameDimensions } from "./jpeg-frame";

export { readJpegFrameDimensions as jpegDimensions } from "./jpeg-frame";

import {
  type BrowserCursor,
  type BrowserGestureKeyEvent,
  browserCursorSchema,
  browserGestureKeySchema,
  MAX_HELD_BROWSER_KEYS,
} from "../../shared/managed-browser/browser";
import { resolveVideoEncoderSettings } from "../../shared/managed-browser/video-settings";
import { browserCursorExpression } from "./browser-cursor";
import { GESTURE_IDLE_MS, GESTURE_LIFETIME_MS } from "./browser-gesture";
import { CAPTURE_MAX_AGE_MS, createCaptureTransportPolicy } from "./capture-transport-policy";
import { formatRuntimeInputGeneration } from "./input-generation";
import { createJpegCaptureDemand } from "./jpeg-capture-demand";
import { heldKeyModifiers, nativeKeyEvent } from "./keyboard-input";
import {
  NativeVideoCapture,
  type NativeVideoQuality,
  type NativeVideoRead,
} from "./native-video-capture";
import { NATIVE_VIDEO_EXTENSION_ID, prepareNativeVideoExtension } from "./native-video-extension";
import {
  NAVIGATION_ACK_TIMEOUT_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_METADATA_TIMEOUT_MS,
} from "./navigation-budget";
import { waitForNavigationCommit } from "./navigation-commit";
import {
  type ProcessIdentity,
  probeProcess,
  processExists,
  RUNTIME_OWNER_VARIABLE,
} from "./process-identity";
import { createScreencastSourceTime } from "./screencast-source-time";
import { createVideoSourceRecovery } from "./video-source-recovery";

const execFileAsync = promisify(execFile);
export const AGENT_BROWSER_VERSION = "0.38.2";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_TIMEOUT_MS = 15_000;
const SCREENCAST_SETUP_RETRY_MS = 25;
/** Bound for the agent-browser session daemon to exit after close or SIGKILL. */
const DAEMON_EXIT_WAIT_MS = 5_000;
// Cursor decoration must not hold the serialized input/video fence while page
// scripts are busy. A missed sample leaves input and its cleanup unchanged.
const CURSOR_SAMPLE_TIMEOUT_MS = 250;

export class AgentBrowserUnavailableError extends Error {
  override readonly name = "AgentBrowserUnavailableError";
}

export class AgentBrowserIncompatibleError extends Error {
  override readonly name = "AgentBrowserIncompatibleError";
}

export { CdpUnknownOutcomeError as UnknownMutationOutcomeError };

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Capture density does not change the emulated layout or pointer coordinate system. */
  captureScale?: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
  platform?: string;
}

export interface RuntimeIdentity {
  agentBrowserVersion: string;
  browserProduct: string;
  browserRevision: string;
  userAgent: string;
  protocolVersion: string;
  processId: number | null;
  targetId: string;
}

export interface RuntimeHealth {
  ready: boolean;
  session: string;
  profilePath: string;
  targetCount: number;
  identity: RuntimeIdentity | null;
  error: string | null;
}

export interface RuntimeTarget extends CdpTarget {
  openerId?: string;
}

export interface RuntimePageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Process-local attachment/document revision, including same-URL reloads. */
  inputGeneration: string;
}

export interface RuntimeFrame {
  dataBase64: string;
  byteLength: number;
  width: number;
  height: number;
  transport: "cdp-screencast" | "screenshot";
  capturedAt: string;
}

export interface DeviceEmulation extends BrowserViewport {
  screenWidth?: number;
  screenHeight?: number;
}

export type MouseButton = "left" | "middle" | "right";

export interface AgentBrowserRuntimeOptions {
  binaryPath: string;
  executablePath: string;
  profilePath: string;
  ipcDirectory: string;
  session: string;
  initialUrl?: string;
  headed?: boolean;
  /** Trusted per-instance private X11 context, only DISPLAY/XAUTHORITY; never mutates host environment. */
  launchEnvironment?: Readonly<Record<string, string>>;
  /** Trusted daemon-side opt-in. Only then is the capture extension materialized and loaded. */
  nativeVideo?: boolean;
  timeoutMs?: number;
  /** Bound for the session daemon to exit after close or SIGKILL. */
  daemonExitWaitMs?: number;
}

interface VersionResult {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

interface ScreencastFrame {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
  sessionId: number;
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new AgentBrowserIncompatibleError(`${label} must be absolute`);
  return resolve(path);
}

function runtimeEnvironment(
  ipcDirectory: string,
  launchEnvironment: Readonly<Record<string, string>> | undefined,
  ownerNonce: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (launchEnvironment !== undefined) {
    const keys = Object.keys(launchEnvironment);
    const display = launchEnvironment.DISPLAY;
    const authority = launchEnvironment.XAUTHORITY;
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "DISPLAY" && key !== "XAUTHORITY") ||
      typeof display !== "string" ||
      !/^:[0-9]{1,5}(?:\.[0-9]{1,2})?$/.test(display) ||
      typeof authority !== "string" ||
      !isAbsolute(authority)
    ) {
      // Do not include display/authentication values in errors or child arguments.
      throw new AgentBrowserIncompatibleError("Private browser display environment is invalid");
    }
    environment.DISPLAY = display;
    environment.XAUTHORITY = authority;
    // A private X11 display must not inherit an unrelated host Wayland session.
    delete environment.WAYLAND_DISPLAY;
  }
  environment[RUNTIME_OWNER_VARIABLE] = ownerNonce;
  environment.AGENT_BROWSER_SOCKET_DIR = ipcDirectory;
  environment.AGENT_BROWSER_IDLE_TIMEOUT_MS = "0";
  environment.AGENT_BROWSER_STREAM_PORT = "0";
  environment.AGENT_BROWSER_NO_AUTO_DIALOG = "1";
  return environment;
}

function parseJsonOutput(stdout: string): unknown {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new AgentBrowserIncompatibleError("agent-browser returned invalid JSON");
}

function findString(value: unknown, keys: readonly string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return null;
}

export class AgentBrowserRuntime {
  readonly binaryPath: string;
  readonly executablePath: string;
  readonly profilePath: string;
  readonly ipcDirectory: string;
  readonly session: string;
  private readonly initialUrl: string;
  private readonly headed: boolean;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private daemon: { pid: number; identity: ProcessIdentity | null } | null = null;
  private readonly ownerNonce = randomUUID();
  private readonly daemonExitWaitMs: number;
  private connection: CdpConnection | null = null;
  private page: CdpSession | null = null;
  private targetId: string | null = null;
  private viewport: DeviceEmulation | null = null;
  private emulationAppliedPage: CdpSession | null = null;
  private attachmentGeneration = 0;
  private readonly capturePolicy = createCaptureTransportPolicy();
  private readonly screencastSourceTime = createScreencastSourceTime();
  private screencastFrame: RuntimeFrame | null = null;
  private screencastFrameReceivedAt: number | null = null;
  private screencastWaiters = new Set<(frame: RuntimeFrame | null) => void>();
  private screencastActive = false;
  private screencastQuality: number = DEFAULT_JPEG_QUALITY;
  private screencastStartFailed = false;
  private readonly jpegDemand = createJpegCaptureDemand({
    now: () => performance.now(),
    retire: () => this.stopScreencastSession(),
    onError: () => console.warn("Shared Browser could not retire unused JPEG capture"),
  });
  private heldButtons = new Set<MouseButton>();
  /** Last native pointer position sent, so cancelled drags release where they were. */
  private lastMousePoint = { x: 0, y: 0 };
  private heldKeys = new Map<string, { key: string; code: string }>();
  private heldTouches = false;
  /** Attachment on which the current held state was published; cleanup never targets another. */
  private heldOwner: CdpSession | null = null;
  private activeTouches = new Map<number, { x: number; y: number; id: number }>();
  private documentGeneration = 0;
  private liveInput: {
    id: string;
    page: CdpSession;
    generation: number;
    documentGeneration: number;
    idleUntil: number;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private stopping = false;
  private shutdownInFlight: Promise<void> | null = null;
  private shutDown = false;
  /** A daemon was launched for this session, so absence of evidence is not proof of exit. */
  private daemonLaunched = false;
  private readonly nativeVideo: boolean;
  private video: NativeVideoCapture | null = null;
  private videoRetirement: Promise<void> | null = null;
  private ownsBrowser = true;
  private readonly videoRecovery = createVideoSourceRecovery();
  private videoTransitionDepth = 0;
  private videoTransitionEpoch = 0;

  constructor(options: AgentBrowserRuntimeOptions) {
    this.binaryPath = requireAbsolute(options.binaryPath, "agent-browser binary path");
    this.executablePath = requireAbsolute(options.executablePath, "Chromium executable path");
    this.profilePath = requireAbsolute(options.profilePath, "profile path");
    this.ipcDirectory = requireAbsolute(options.ipcDirectory, "IPC directory");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.session)) {
      throw new AgentBrowserIncompatibleError("agent-browser session name is invalid");
    }
    this.session = options.session;
    this.headed = options.headed ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.daemonExitWaitMs = options.daemonExitWaitMs ?? DAEMON_EXIT_WAIT_MS;
    this.environment = runtimeEnvironment(
      this.ipcDirectory,
      options.launchEnvironment,
      this.ownerNonce,
    );
    // An explicit owned config suppresses user/project auto-connect, extensions and plugins.
    this.environment.AGENT_BROWSER_CONFIG = resolve(this.profilePath, "hosts-cli-config.json");
    this.initialUrl = options.initialUrl ?? "about:blank";
    this.nativeVideo = false;
  }

  async launch(): Promise<void> {
    this.assertRuntimeOpen();
    if (this.connection?.isOpen) return;
    this.invalidateScreencastFrame();
    await mkdir(this.profilePath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await mkdir(this.ipcDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await writeFile(this.environment.AGENT_BROWSER_CONFIG!, "{}\n", { mode: 0o600 });
    await chmod(this.environment.AGENT_BROWSER_CONFIG!, 0o600);
    await Promise.all([
      chmod(this.profilePath, PRIVATE_DIRECTORY_MODE),
      chmod(this.ipcDirectory, PRIVATE_DIRECTORY_MODE),
    ]);
    this.assertRuntimeOpen();
    await this.assertVersion();
    this.assertRuntimeOpen();
    // Image-only sessions never materialize, load or allowlist the capture
    // extension, so its tabCapture/debugger permissions do not exist in them.
    const videoExtension = this.nativeVideo
      ? await prepareNativeVideoExtension(this.ipcDirectory)
      : null;
    this.assertRuntimeOpen();
    const existingArguments = process.env.HOSTS_BROWSER_CHROMIUM_ARGS;
    const chromiumArguments = [
      existingArguments,
      // agent-browser creates the launch page itself. Chromium's default
      // startup window otherwise leaves an additional chrome://newtab page.
      "--no-startup-window",
      videoExtension ? `--allowlisted-extension-id=${NATIVE_VIDEO_EXTENSION_ID}` : undefined,
    ]
      .filter(Boolean)
      .join(",");
    this.ownsBrowser = true;
    // From here a nonce-owned daemon may exist even if open rejects (e.g. navigation failure).
    this.daemonLaunched = true;
    this.daemon = null;
    const opened = await this.invoke([
      "--session",
      this.session,
      "--profile",
      this.profilePath,
      "--executable-path",
      this.executablePath,
      ...(videoExtension ? ["--extension", videoExtension] : []),
      "--hide-scrollbars",
      "false",
      ...(this.headed ? ["--headed"] : []),
      ...(chromiumArguments ? ["--args", chromiumArguments] : []),
      "--json",
      "open",
      this.initialUrl,
    ]);
    this.assertRuntimeOpen();
    const targetId = findString(opened, ["targetId", "target_id"]);
    await this.protectIpcMetadata();
    await this.captureDaemon();
    this.assertRuntimeOpen();
    await this.connectCdp(targetId);
  }

  /** Attach an independent page controller to an existing browser session. */
  async attachTarget(targetId: string): Promise<void> {
    this.assertRuntimeOpen();
    this.ownsBrowser = false;
    await this.connectCdp(targetId, false);
  }

  /** Create a page in the existing profile without changing another controller's selected page. */
  async createTarget(url = "about:blank"): Promise<string> {
    const result = await this.requireConnection().send<{ targetId: string }>(
      "Target.createTarget",
      { url },
      { mutation: true },
    );
    return result.targetId;
  }

  /** Close only the named page. The caller must keep another page in the browser. */
  async closeTarget(targetId: string): Promise<void> {
    const result = await this.requireConnection().send<{ success: boolean }>(
      "Target.closeTarget",
      { targetId },
      { mutation: true },
    );
    if (!result.success) throw new CdpUnavailableError("Browser tab could not be closed");
  }

  async reconnect(): Promise<void> {
    this.assertRuntimeOpen();
    await this.withVideoTransition(async () => {
      const targetId = this.targetId;
      this.attachmentGeneration += 1;
      this.invalidateScreencastFrame();
      this.connection?.close();
      this.connection = null;
      this.page = null;
      await this.assertVersion();
      this.assertRuntimeOpen();
      await this.connectCdp(targetId);
    });
  }

  async health(): Promise<RuntimeHealth> {
    try {
      if (!this.connection?.isOpen) await this.reconnect();
      const targets = await this.targets();
      return {
        ready: true,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: targets.length,
        identity: await this.identity(),
        error: null,
      };
    } catch (error) {
      return {
        ready: false,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: 0,
        identity: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async identity(): Promise<RuntimeIdentity> {
    const connection = this.requireConnection();
    const version = await connection.send<VersionResult>("Browser.getVersion");
    const processId = await this.daemonPid();
    const page = await this.requirePage();
    return {
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      browserProduct: version.product,
      browserRevision: version.revision,
      userAgent: version.userAgent,
      protocolVersion: version.protocolVersion,
      processId,
      targetId: page.targetId,
    };
  }

  async targets(): Promise<RuntimeTarget[]> {
    return (await listPageTargets(this.requireConnection())).filter(
      (target) => !target.url.startsWith(`chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/`),
    );
  }

  async selectTarget(targetId: string, activate = true): Promise<void> {
    await this.withVideoTransition(async () => {
      const attachmentGeneration = ++this.attachmentGeneration;
      const connection = this.requireConnection();
      const target = (await this.targets()).find((candidate) => candidate.targetId === targetId);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      if (!target) throw new CdpUnavailableError(`Unknown page target: ${targetId}`);
      this.invalidateScreencastFrame();
      const previous = this.page;
      if (previous) {
        if (this.screencastActive) {
          await previous.send("Page.stopScreencast", {}, { mutation: true });
          this.assertAttachmentCurrent(connection, attachmentGeneration);
        }
        await previous.detach();
        this.assertAttachmentCurrent(connection, attachmentGeneration);
      }
      this.invalidateScreencastFrame();
      if (activate) {
        await connection.send("Target.activateTarget", { targetId }, { mutation: true });
        this.assertAttachmentCurrent(connection, attachmentGeneration);
      }
      // CDP emulation is session-owned: detaching the former session restores native
      // window metrics. Publish a replacement only after its retained settings succeed.
      this.page = null;
      this.emulationAppliedPage = null;
      const replacement = await attachToTarget(connection, targetId);
      try {
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.bindPageEvents(replacement);
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.restoreConfiguredEmulation(replacement);
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        this.page = replacement;
        this.targetId = targetId;
      } catch (error) {
        await replacement.detach().catch(() => undefined);
        // Detaching a partial emulation can clear target metrics even if a newer
        // attachment won. Its next access must restore intent before admitting pixels.
        this.emulationAppliedPage = null;
        this.invalidateScreencastFrame();
        throw error;
      }
      if (this.screencastActive) await this.startScreencastSession(replacement);
    });
  }

  private async navigationHistory(
    page: CdpSession,
    timeoutMs = this.timeoutMs,
  ): Promise<NavigationHistory> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new CdpUnavailableError("Browser navigation history observation timed out");
      try {
        return await page.send<NavigationHistory>(
          "Page.getNavigationHistory",
          {},
          { timeoutMs: remaining },
        );
      } catch (error) {
        if (!String(error).includes("Not attached to an active page") || Date.now() >= deadline) {
          throw error;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
  }
  /** Read fresh metadata concurrently, discarding both replies if the document changes.
   * One same-attachment reread shares the original monotonic timeout budget in
   * milliseconds. Failed reads, replacement attachments and repeated document
   * changes reject; this read-only recovery never repeats a native mutation. */
  async state(options: { timeoutMs?: number } = {}): Promise<RuntimePageState> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > DEFAULT_TIMEOUT_MS)
    ) {
      throw new RangeError("Browser metadata timeout must be an integer from 1 to 15000ms");
    }
    const timeoutMs = Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const page = await this.requirePage();
    const attachmentGeneration = this.attachmentGeneration;
    const deadline = performance.now() + timeoutMs;

    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertRuntimeOpen();
      const remaining = attempt === 0 ? timeoutMs : deadline - performance.now();
      if (remaining <= 0) {
        throw new CdpUnavailableError("Browser metadata observation timed out");
      }
      const documentGeneration = this.documentGeneration;
      // Both observations must describe the same document. A navigation discards
      // the entire pair; neither native history nor DOM metadata is cached.
      const [history, evaluated] = await Promise.all([
        this.navigationHistory(page, remaining),
        page.send<{
          result: { value?: { url?: string; title?: string } };
        }>(
          "Runtime.evaluate",
          {
            expression: "({url: location.href, title: document.title})",
            returnByValue: true,
          },
          { timeoutMs: remaining },
        ),
      ]);
      this.assertRuntimeOpen();
      if (page !== this.page || attachmentGeneration !== this.attachmentGeneration) {
        throw new CdpUnavailableError("Browser metadata changed while being read");
      }
      // Successful replies can beat an overdue CDP timer in the event queue.
      // Their metadata still cannot outlive the original shared phase budget.
      if (performance.now() >= deadline) {
        throw new CdpUnavailableError("Browser metadata observation timed out");
      }
      if (documentGeneration !== this.documentGeneration) {
        if (attempt === 0) continue;
        throw new CdpUnavailableError("Browser metadata changed while being read");
      }
      return {
        url: evaluated.result.value?.url ?? history.entries[history.currentIndex]?.url ?? "",
        title: evaluated.result.value?.title ?? history.entries[history.currentIndex]?.title ?? "",
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
        inputGeneration: formatRuntimeInputGeneration(attachmentGeneration, documentGeneration),
      };
    }
    throw new CdpUnavailableError("Browser metadata changed while being read");
  }

  /** Await native ACK and its main-frame commit, without waiting for scripts or
   * DOMContentLoaded. A missing commit remains uncertain and is never replayed. */
  async navigate(url: string): Promise<void> {
    await this.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        await waitForNavigationCommit(
          page,
          async () => {
            const result = await page.send<{
              frameId: string;
              errorText?: string;
              loaderId?: string;
              isDownload?: boolean;
            }>(
              "Page.navigate",
              { url },
              { mutation: true, timeoutMs: Math.min(this.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS) },
            );
            // Chromium can abort document navigation because the accepted
            // response is a download. This does not replace the current page.
            if (result.errorText && !result.isDownload) {
              throw new Error(`Navigation failed: ${result.errorText}`);
            }
            return {
              frameId: result.frameId,
              ...(result.loaderId ? { loaderId: result.loaderId } : {}),
              url,
              ...(result.isDownload ? { download: true } : {}),
            };
          },
          assertCurrent,
          Math.min(this.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  async back(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async forward(): Promise<void> {
    await this.navigateHistory(1);
  }

  /** History's ACK has no loader receipt. Capture its root loader and target URL
   * in one parallel bounded preflight, then admit only the matching new commit. */
  private async navigateHistory(direction: -1 | 1): Promise<void> {
    await this.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        const [history, root] = await Promise.all([
          this.navigationHistory(page, Math.min(this.timeoutMs, NAVIGATION_METADATA_TIMEOUT_MS)),
          this.navigationRoot(page),
        ]);
        assertCurrent();
        const entry = history.entries[history.currentIndex + direction];
        if (!entry)
          throw new Error(
            direction === -1 ? "Browser cannot go back" : "Browser cannot go forward",
          );
        await waitForNavigationCommit(
          page,
          async () => {
            await page.send(
              "Page.navigateToHistoryEntry",
              { entryId: entry.id },
              {
                mutation: true,
                timeoutMs: Math.min(this.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS),
              },
            );
            return { frameId: root.id, previousLoaderId: root.loaderId, url: entry.url };
          },
          assertCurrent,
          Math.min(this.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  async reload(ignoreCache = false): Promise<void> {
    await this.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        const root = await this.navigationRoot(page);
        assertCurrent();
        await waitForNavigationCommit(
          page,
          async () => {
            await page.send(
              "Page.reload",
              { ignoreCache },
              {
                mutation: true,
                timeoutMs: Math.min(this.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS),
              },
            );
            return { frameId: root.id, previousLoaderId: root.loaderId };
          },
          assertCurrent,
          Math.min(this.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  /** A root snapshot is observation only, bounded before mutation publication. */
  private async navigationRoot(page: CdpSession): Promise<{ id: string; loaderId: string }> {
    const result = await page.send<{ frameTree: { frame: { id: string; loaderId: string } } }>(
      "Page.getFrameTree",
      {},
      { timeoutMs: Math.min(this.timeoutMs, NAVIGATION_METADATA_TIMEOUT_MS) },
    );
    const root = result.frameTree.frame;
    if (!root.id || !root.loaderId)
      throw new CdpUnavailableError("Browser main frame is unavailable");
    return root;
  }

  /** Keep commit observation on the original attachment, including shutdown. */
  private navigationAttachmentGuard(page: CdpSession): () => void {
    const attachmentGeneration = this.attachmentGeneration;
    return () => {
      this.assertAttachmentCurrent(page.connection, attachmentGeneration);
      if (this.page !== page)
        throw new CdpUnavailableError("Browser page changed during navigation");
    };
  }

  async emulate(device: DeviceEmulation): Promise<void> {
    this.assertViewport(device);
    await this.withVideoTransition(async () => {
      await this.withInvalidatedScreencast(async (page) => {
        const attachmentGeneration = this.attachmentGeneration;
        this.emulationAppliedPage = null;
        await this.applyEmulation(page, device);
        this.assertAttachmentCurrent(page.connection, attachmentGeneration);
        if (this.page !== page)
          throw new CdpUnavailableError("Browser page changed during emulation");
        this.viewport = { ...device };
        this.emulationAppliedPage = page;
      });
    });
  }

  /** Retain the full mode/UA/screen intent while rendering enough real source pixels for the chosen density. */
  async setCaptureDensity(density: number, baseDeviceScaleFactor: number): Promise<void> {
    const scale = captureDensitySchema.parse(density);
    const viewport = this.requireViewport();
    if (!canUseCaptureDensity(viewport, scale))
      throw new RangeError("Capture density exceeds the supported image bounds");
    if (
      !Number.isFinite(baseDeviceScaleFactor) ||
      baseDeviceScaleFactor < 1 ||
      baseDeviceScaleFactor > 4
    )
      throw new RangeError("Invalid device pixel ratio");
    await this.emulate({
      ...viewport,
      captureScale: scale,
      deviceScaleFactor: Math.max(baseDeviceScaleFactor, scale),
    });
  }

  /** Apply the entire device contract to one CDP session without changing saved intent. */
  private async applyEmulation(page: CdpSession, device: DeviceEmulation): Promise<void> {
    await page.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile: device.mobile,
        screenWidth: device.screenWidth ?? device.width,
        screenHeight: device.screenHeight ?? device.height,
        screenOrientation: {
          type: device.width > device.height ? "landscapePrimary" : "portraitPrimary",
          angle: device.width > device.height ? 90 : 0,
        },
      },
      { mutation: true },
    );
    await page.send(
      "Emulation.setTouchEmulationEnabled",
      { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 },
      { mutation: true },
    );
    // A page controlled through its own session may sit behind another tab in the shared
    // browser. Chromium holds a hidden page's mouseMoved acknowledgement for ~5 s (equal to the
    // input idle bound), so every press there failed. Target-scoped focus emulation makes only
    // this page report visible/focused: no tab is raised and no viewer's selection changes.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { mutation: true });
    if (device.userAgent) {
      await page.send(
        "Emulation.setUserAgentOverride",
        { userAgent: device.userAgent, platform: device.platform ?? "" },
        { mutation: true },
      );
    }
  }

  /** No frame/input may use a session whose emulated viewport has not been restored. */
  private async restoreConfiguredEmulation(page: CdpSession): Promise<void> {
    const device = this.viewport;
    if (!device || this.emulationAppliedPage === page) return;
    await this.withVideoTransition(async () => {
      const attachmentGeneration = this.attachmentGeneration;
      this.invalidateScreencastFrame();
      this.emulationAppliedPage = null;
      await this.applyEmulation(page, device);
      this.assertAttachmentCurrent(page.connection, attachmentGeneration);
      if (device !== this.viewport) {
        throw new CdpUnavailableError("Browser device settings changed during restoration");
      }
      this.emulationAppliedPage = page;
      this.invalidateScreencastFrame();
    });
  }

  /** Reject late configuration completions after a disconnect or newer target selection. */
  private assertAttachmentCurrent(connection: CdpConnection, generation: number): void {
    this.assertRuntimeOpen();
    if (
      connection !== this.connection ||
      !connection.isOpen ||
      generation !== this.attachmentGeneration
    ) {
      throw new CdpUnavailableError("Browser attachment changed during emulation restoration");
    }
  }

  /** Starts only exact restored native tab capture, lazily adding this viewer's quality encoder. */
  async startVideo(quality: NativeVideoQuality = "high"): Promise<NativeVideoRead> {
    return this.readVideo({ quality, waitMs: 0 });
  }

  /** Long-poll outside the input queue. The caller must fence returned inputGeneration before publication. */
  async readVideo(input: {
    quality: NativeVideoQuality;
    bitrate?: number;
    fps?: number;
    streamId?: string | null;
    afterSequence?: number;
    waitMs?: number;
    requestKeyFrame?: boolean;
  }): Promise<NativeVideoRead & { inputGeneration: string }> {
    if (!this.nativeVideo) {
      return {
        ...this.videoReset(),
        status: "unsupported",
        reasonCode: "video-disabled",
        reason: "Encoded video is not enabled on this host",
      };
    }
    const settings = resolveVideoEncoderSettings(input);
    const transitionEpoch = this.videoTransitionEpoch;
    if (!this.videoMayStart(transitionEpoch)) return this.videoReset();

    // Retirement uses the same stop barrier as viewport changes. The next read
    // resumes from current configuration instead of treating idle expiry as a
    // permanent codec failure or creating a replacement while the old track closes.
    if (this.video?.idleExpired) {
      this.retireVideoForRead();
      return this.videoReset();
    }

    const page = await this.requirePage();
    // requirePage can itself restore or reconnect. Retry on the next read rather
    // than creating a helper from a configuration that changed across its await.
    if (!this.videoMayStart(transitionEpoch)) return this.videoReset();
    const connection = this.requireConnection();
    const generation = this.attachmentGeneration;
    const viewport = this.requireViewport();
    const recoveryContext = { connection, page, viewport, attachmentGeneration: generation };
    const blocked = this.videoRecovery.blocked(recoveryContext);
    if (blocked === "source-dimensions") {
      return {
        ...this.videoReset(),
        status: "unsupported",
        reason: "Native video dimensions do not match the configured viewport",
      };
    }
    if (blocked) {
      return this.videoReset();
    }
    if (!this.video) {
      const pixels = captureDimensions(viewport, viewport.captureScale ?? 1);
      this.video = new NativeVideoCapture({
        connection,
        targetId: page.targetId,
        width: pixels.width,
        height: pixels.height,
        isCurrent: () =>
          this.videoMayStart(transitionEpoch) &&
          connection === this.connection &&
          page === this.page &&
          viewport === this.viewport &&
          generation === this.attachmentGeneration &&
          this.emulationAppliedPage === page,
      });
    }
    const video = this.video;
    const documentGeneration = this.documentGeneration;
    const result = await video.read({ ...input, ...settings });
    if (
      !this.videoMayStart(transitionEpoch) ||
      video.idleExpired ||
      video !== this.video ||
      connection !== this.connection ||
      page !== this.page ||
      viewport !== this.viewport ||
      generation !== this.attachmentGeneration ||
      documentGeneration !== this.documentGeneration
    ) {
      return this.videoReset();
    }
    if (video.sourceFailure) {
      // Store failure admission before opening the existing stop barrier. A
      // concurrent read sees either that barrier or the cooldown, never a second
      // track while the failed source/helper is still being retired.
      this.videoRecovery.failed(recoveryContext, video.sourceFailure);
      const permanent = video.sourceFailure === "source-dimensions";
      this.retireVideoForRead();
      if (
        this.stopping ||
        connection !== this.connection ||
        page !== this.page ||
        viewport !== this.viewport ||
        generation !== this.attachmentGeneration
      ) {
        return this.videoReset();
      }
      if (permanent) {
        return {
          ...this.videoReset(),
          status: "unsupported",
          reason: "Native video dimensions do not match the configured viewport",
        };
      }
      return this.videoReset();
    }
    return {
      ...result,
      inputGeneration: formatRuntimeInputGeneration(
        this.attachmentGeneration,
        this.documentGeneration,
      ),
    };
  }

  /** Explicit action barrier; pointer samples preserve the native track and encoder continuity. */
  invalidateQueuedVideoFrames(): void {
    this.video?.invalidateQueuedFrames();
  }

  /** Establish the stop barrier now, but do not hold a viewing RPC across slow
   * helper teardown. stopVideo owns barrier release; no replacement can start
   * until it settles. Explicit stop callers still await their cleanup. */
  private retireVideoForRead(): void {
    const retirement = this.stopVideo();
    this.videoRetirement = retirement;
    const complete = () => {
      if (this.videoRetirement === retirement) this.videoRetirement = null;
    };
    void retirement.then(complete, () => {
      complete();
      console.warn("[hosts-browser] Video retirement failed");
    });
  }

  /** Stop admission too: a concurrent reader cannot replace a source still closing. */
  async stopVideo(): Promise<void> {
    if (this.videoRetirement) {
      await this.videoRetirement;
      return;
    }
    await this.withVideoTransition(async () => {});
  }

  /** Nested device/attachment phases keep one continuous barrier until all phases finish. */
  private async withVideoTransition<T>(transition: () => Promise<T>): Promise<T> {
    const releaseJpeg = this.stopping ? () => {} : this.jpegDemand.pin(false);
    this.videoTransitionDepth += 1;
    this.videoTransitionEpoch += 1;
    const video = this.video;
    this.video = null;
    try {
      if (video) await video.stop();
      return await transition();
    } finally {
      this.videoTransitionDepth -= 1;
      releaseJpeg();
    }
  }

  private videoMayStart(epoch: number): boolean {
    return !this.stopping && this.videoTransitionDepth === 0 && epoch === this.videoTransitionEpoch;
  }

  private videoReset(): NativeVideoRead & { inputGeneration: string } {
    return {
      status: "reset",
      streamId: null,
      packets: [],
      inputGeneration: formatRuntimeInputGeneration(
        this.attachmentGeneration,
        this.documentGeneration,
      ),
    };
  }

  /** Explicit viewing start remains supported, but does not keep unused JPEG work alive. */
  async startScreencast(quality: number = DEFAULT_JPEG_QUALITY): Promise<void> {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new RangeError("Screencast quality must be an integer from 1 to 100");
    }
    const release = this.jpegDemand.pin();
    try {
      await this.jpegDemand.serialize(async () => {
        const page = await this.requirePage();
        if (this.screencastActive && this.screencastQuality === quality) return;
        this.screencastQuality = quality;
        this.screencastStartFailed = false;
        this.screencastActive = true;
        try {
          await this.startScreencastSession(page);
        } catch (error) {
          this.screencastActive = false;
          this.screencastStartFailed = true;
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  /** Explicit detach cleanup and idle retirement use the same native transition FIFO. */
  async stopScreencast(): Promise<void> {
    this.jpegDemand.cancel();
    await this.jpegDemand.serialize(() => this.stopScreencastSession());
  }

  private async stopScreencastSession(): Promise<void> {
    const wasActive = this.screencastActive;
    this.screencastActive = false;
    this.screencastStartFailed = false;
    this.invalidateScreencastFrame();
    if (!wasActive || !this.page) return;
    try {
      await this.page.send("Page.stopScreencast", {}, { mutation: true });
    } finally {
      this.invalidateScreencastFrame();
    }
  }

  /** Return truthful fresh stream/fallback pixels; mutation/session changes revoke pending captures. */
  async frame(
    maxBytes: number,
    quality: number = DEFAULT_JPEG_QUALITY,
    waitMs = 500,
  ): Promise<RuntimeFrame> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be positive");
    }
    if (!Number.isFinite(quality)) throw new RangeError("JPEG quality must be finite");
    const requestedQuality = Math.max(1, Math.min(100, Math.round(quality)));
    // All reads protect in-flight pixels, but screenshot-only qualities do not
    // renew the shared JPEG stream when a viewer changes their preference.
    const release = this.jpegDemand.pin(requestedQuality === this.screencastQuality);
    try {
      await this.jpegDemand.serialize(async () => {
        const page = await this.requirePage();
        // Nonmatching quality keeps the existing screenshot-only path. A video
        // viewer choosing JPEG100 must not start an unused JPEG95 stream.
        if (
          requestedQuality !== this.screencastQuality ||
          this.screencastActive ||
          this.screencastStartFailed
        ) {
          return;
        }
        this.screencastActive = true;
        try {
          await this.startScreencastSession(page);
        } catch {
          // Shutdown is terminal, not an optional stream failure to fall back from.
          this.assertRuntimeOpen();
          // Stream support is optional. Preserve fresh screenshots, and avoid
          // retrying a failed setup at every 250ms poll in the same demand period.
          console.warn("Shared Browser JPEG screencast is unavailable; using screenshot fallback");
          this.screencastActive = false;
          this.screencastStartFailed = true;
        }
      });
      this.assertRuntimeOpen();
      if (requestedQuality !== this.screencastQuality) {
        // Viewers choose their own quality; never restart the shared stream or
        // classify its health from another viewer's screenshot preference.
        const cached = this.capturePolicy.readScreenshot(
          performance.now(),
          requestedQuality,
          maxBytes,
        );
        return cached ?? (await this.captureScreenshot(maxBytes, requestedQuality, true));
      }
      // Expiry discards pixels without resetting fallback dwell/recovery evidence.
      // Mutations and connection changes use the stronger invalidation below.
      const generation = this.capturePolicy.currentGeneration();
      const receivedAt = this.screencastFrameReceivedAt;
      if (receivedAt === null || performance.now() - receivedAt > CAPTURE_MAX_AGE_MS) {
        this.screencastFrame = null;
        this.screencastFrameReceivedAt = null;
      }
      if (this.screencastActive && this.capturePolicy.canUseStream(performance.now())) {
        const streamed = this.screencastFrame ?? (await this.waitForFrame(waitMs));
        this.assertRuntimeOpen();
        if (!this.capturePolicy.isCurrent(generation)) {
          throw new CdpUnavailableError(
            "Browser capture was invalidated while waiting for a frame",
          );
        }
        if (streamed && streamed.byteLength <= maxBytes) {
          return streamed;
        }
      }

      this.capturePolicy.enterFallback(performance.now());
      const cached = this.capturePolicy.readScreenshot(
        performance.now(),
        requestedQuality,
        maxBytes,
      );
      if (cached) {
        return cached;
      }
      return await this.captureScreenshot(maxBytes, requestedQuality);
    } finally {
      release();
    }
  }

  /** Capture the configured viewport and cache only an unchanged-session/mutation completion. */
  private async captureScreenshot(
    maxBytes: number,
    requestedQuality: number,
    preserveStreamRecovery = false,
  ): Promise<RuntimeFrame> {
    const page = await this.requirePage();
    const screenshotGeneration = this.capturePolicy.beginScreenshot({
      preserveRecovery: preserveStreamRecovery,
    });
    try {
      const viewport = this.requireViewport();
      const expectedPixels = captureDimensions(viewport, viewport.captureScale);
      const readClip = async () => {
        const metrics = await page.send<{ cssVisualViewport: { pageX: number; pageY: number } }>(
          "Page.getLayoutMetrics",
        );
        this.assertCaptureCurrent(page, screenshotGeneration);
        return {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: viewport.width,
          height: viewport.height,
          scale: (viewport.captureScale ?? 1) / viewport.deviceScaleFactor,
        };
      };
      // Explicitly capture the visible CSS viewport, independent of the native window size.
      // Preserve scroll position and normalize device pixel ratio to the frame/input contract.
      let clip = await readClip();
      let resynced = false;
      // Reduce quality gradually only when a detailed frame exceeds the byte budget.
      const initialQuality = requestedQuality;
      const candidates = [...new Set([initialQuality, 90, 85, 75, 65, 50, 35, 20, 10, 1])].filter(
        (candidate) => candidate <= initialQuality,
      );
      const capture = async (quality: number) => {
        this.assertCaptureCurrent(page, screenshotGeneration);
        const result = await page.send<{ data: string }>("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          fromSurface: true,
          // Beyond-viewport capture replaces emulation and resets enabled touch.
          captureBeyondViewport: false,
          clip,
        });
        this.assertCaptureCurrent(page, screenshotGeneration);
        const dimensions = readJpegFrameDimensions(result.data);
        if (!dimensions) throw new Error("Chromium returned a malformed JPEG screenshot");
        return {
          data: result.data,
          dimensions,
          byteLength: Buffer.byteLength(result.data, "base64"),
        };
      };
      const matchesViewport = (dimensions: { width: number; height: number }) =>
        dimensions.width === expectedPixels.width && dimensions.height === expectedPixels.height;

      for (const candidate of candidates) {
        const boundedQuality = Math.max(1, Math.min(100, Math.round(candidate)));
        let pixels = await capture(boundedQuality);
        if (!matchesViewport(pixels.dimensions) && !resynced) {
          // Retain upstream viewport recovery, with captureScale rather than DPR:
          // mobile CSS emulation and image density are independently configured.
          // Recapture pixels only; uncertain input is never replayed.
          resynced = true;
          const attachmentGeneration = this.attachmentGeneration;
          await this.applyEmulation(page, viewport);
          this.assertAttachmentCurrent(page.connection, attachmentGeneration);
          this.assertCaptureCurrent(page, screenshotGeneration);
          if (viewport !== this.viewport)
            throw new CdpUnavailableError("Browser viewport changed during resync");
          this.emulationAppliedPage = page;
          clip = await readClip();
          pixels = await capture(boundedQuality);
        }
        if (!matchesViewport(pixels.dimensions)) {
          throw new Error(
            `Chromium returned a ${pixels.dimensions.width}x${pixels.dimensions.height} JPEG instead of ${expectedPixels.width}x${expectedPixels.height}`,
          );
        }
        if (pixels.byteLength > maxBytes) continue;

        const frame: RuntimeFrame = {
          dataBase64: pixels.data,
          byteLength: pixels.byteLength,
          width: pixels.dimensions.width,
          height: pixels.dimensions.height,
          transport: "screenshot",
          capturedAt: new Date().toISOString(),
        };
        this.capturePolicy.rememberScreenshot(
          screenshotGeneration,
          frame,
          performance.now(),
          requestedQuality,
          maxBytes,
        );
        return frame;
      }
      throw new Error(`JPEG screenshot exceeds ${maxBytes} bytes at minimum quality`);
    } finally {
      this.capturePolicy.endScreenshot(screenshotGeneration, performance.now());
    }
  }

  /** Refuse async pixels from a superseded session or mutation, without silently replaying capture. */
  private assertCaptureCurrent(page: CdpSession, generation: number): void {
    this.assertRuntimeOpen();
    if (page !== this.page || !this.capturePolicy.isCurrent(generation)) {
      throw new CdpUnavailableError("Browser capture was invalidated while taking a screenshot");
    }
  }

  /** Invalidate pre-input pixels even if Chromium cannot confirm the mutation. */
  private async dispatchInput(
    method: string,
    params: Record<string, unknown>,
    gestureId?: string,
    mouseModifiers?: number,
    track?: () => void,
  ): Promise<void> {
    try {
      const page = await this.requirePage();
      if (gestureId) await this.assertLiveInput(gestureId);
      // Authority is validated. Record cleanup intent only now, immediately before
      // native publication, so rejected unsent packets never alter it while an
      // uncertain acknowledgement still leaves it in place.
      if (track) {
        if (this.heldOwner && this.heldOwner !== page) this.discardHeldState();
        track();
        if (this.holdsInput()) this.heldOwner ??= page;
      }
      const originalInput = gestureId ? this.liveInput : null;
      // A physical DOM mouse event may arrive after Control/Shift was pressed
      // outside this canvas. Explicit zero also overrides a prior held-key mask.
      const modifiers = mouseModifiers ?? heldKeyModifiers(this.heldKeys.values());
      const nativeParams =
        method === "Input.dispatchMouseEvent" && (mouseModifiers !== undefined || modifiers !== 0)
          ? { ...params, modifiers }
          : params;
      await page.send(method, nativeParams, { mutation: true });
      if (gestureId) {
        // An input can synchronously activate a link or submit a form. Its CDP
        // acknowledgment succeeds even when navigation ends the old channel.
        // Attachment replacement and uncertain sends retain their failure path.
        if (
          originalInput &&
          page === this.page &&
          originalInput.generation === this.attachmentGeneration &&
          originalInput.documentGeneration !== this.documentGeneration
        ) {
          await this.endLiveInput(gestureId);
          return;
        }
        await this.assertLiveInput(gestureId);
        this.renewLiveInput(gestureId);
      }
    } finally {
      this.invalidateScreencastFrame();
    }
  }

  async mouseMove(x: number, y: number, gestureId?: string, modifiers?: number): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
        // Native scrollbar dragging needs the held button as well as its mask.
        button: this.heldMoveButton(),
        buttons: this.buttonMask(),
      },
      gestureId,
      modifiers,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
  }

  /** Fixed native mouse departure; never maps an outside point to a page control. */
  async mouseLeave(gestureId: string): Promise<void> {
    if (this.heldButtons.size > 0) throw new Error("Release held mouse buttons before leaving");
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: -1,
        y: -1,
        button: "none",
        buttons: 0,
      },
      gestureId,
    );
  }

  async mouseDown(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: this.buttonMask(button),
        clickCount,
      },
      gestureId,
      modifiers,
      () => {
        // Publication may succeed before an acknowledgement is lost, so a
        // possibly held button is tracked from the send boundary.
        this.heldButtons.add(button);
        this.lastMousePoint = { x, y };
      },
    );
  }

  async mouseUp(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: this.buttonMask(undefined, button),
        clickCount,
      },
      gestureId,
      modifiers,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
    this.heldButtons.delete(button);
  }

  async wheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        button: "none",
        buttons: this.buttonMask(),
      },
      gestureId,
      modifiers,
    );
  }

  /** Insert a committed paste/IME value on the original guarded attachment. */
  async insertText(text: string, gestureId?: string): Promise<void> {
    await this.dispatchInput("Input.insertText", { text }, gestureId);
  }

  /** Track cleanup intent before publication, including an uncertain key-down reply. */
  async dispatchKey(event: BrowserGestureKeyEvent, gestureId: string): Promise<void> {
    const parsed = browserGestureKeySchema.parse(event);
    await this.assertLiveInput(gestureId);
    const held = this.heldKeys.has(parsed.code);
    if (parsed.type === "down" && held !== parsed.repeat) {
      throw new Error(
        parsed.repeat ? "Key repeat has no matching press" : "Key is already pressed",
      );
    }
    if (parsed.type === "up" && !held) throw new Error("Key release has no matching press");
    if (parsed.type === "down") this.assertHeldKeyCapacity(parsed.code);
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      nativeKeyEvent(parsed),
      gestureId,
      undefined,
      parsed.type === "down"
        ? () => this.heldKeys.set(parsed.code, { key: parsed.key, code: parsed.code })
        : undefined,
    );
    if (parsed.type === "up") this.heldKeys.delete(parsed.code);
  }

  /** Track intent before publication. Internal discrete presses can use the
   * same opaque channel as live input so a lost ACK retains original-page cleanup. */
  async keyDown(key: string, code = key, gestureId?: string): Promise<void> {
    if (gestureId) await this.assertLiveInput(gestureId);
    this.assertHeldKeyCapacity(code);
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key,
        code,
        text: key.length === 1 ? key : undefined,
      },
      gestureId,
      undefined,
      () => this.heldKeys.set(code, { key, code }),
    );
  }

  /** Release on a current channel; its end cleanup still owns the original
   * page if navigation or attachment loss prevents this ordinary key-up. */
  async keyUp(key: string, code = key, gestureId?: string): Promise<void> {
    await this.dispatchInput("Input.dispatchKeyEvent", { type: "keyUp", key, code }, gestureId);
    this.heldKeys.delete(code);
  }

  /**
   * The caller supplies the complete active contact set. CDP touchMove does not
   * release omitted contacts, so publish explicit contact ends before moving the
   * survivors. Any uncertain publication retains cleanup intent until cancel.
   */
  async touch(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: Array<{ x: number; y: number; id?: number }>,
    gestureId?: string,
  ): Promise<void> {
    for (const point of points) this.assertPoint(point.x, point.y);
    if (gestureId) await this.assertLiveInput(gestureId);
    const contacts = points.map((point, index) => ({ ...point, id: point.id ?? index }));
    const activeIds = new Set(contacts.map((point) => point.id));
    const removed =
      type === "touchMove"
        ? [...this.activeTouches.values()].filter((point) => !activeIds.has(point.id))
        : [];
    const hold = () => {
      this.heldTouches = true;
    };
    if (removed.length > 0) {
      await this.dispatchInput(
        "Input.dispatchTouchEvent",
        { type: "touchEnd", touchPoints: removed },
        gestureId,
        undefined,
        hold,
      );
    }
    await this.dispatchInput(
      "Input.dispatchTouchEvent",
      { type, touchPoints: contacts },
      gestureId,
      undefined,
      hold,
    );
    // Navigation cleanup already discarded this channel's contacts. Do not
    // recreate held-touch state after its acknowledged start caused navigation.
    if (gestureId && this.liveInput?.id !== gestureId) return;
    this.activeTouches.clear();
    if (type === "touchStart" || type === "touchMove") {
      for (const point of contacts) this.activeTouches.set(point.id, point);
    }
    this.heldTouches = this.activeTouches.size > 0;
  }

  /**
   * Bind decoded geometry to its exact native attachment and document. Compare
   * after cleanup/reattach awaits so a same-URL reload cannot silently admit a
   * press against a replacement page. A mismatch publishes no physical input.
   */
  async beginLiveInput(id: string, expectedInputGeneration: string): Promise<void> {
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
    const page = await this.requirePage();
    const actualInputGeneration = formatRuntimeInputGeneration(
      this.attachmentGeneration,
      this.documentGeneration,
    );
    if (expectedInputGeneration !== actualInputGeneration) {
      throw new CdpUnavailableError("Live browser input attachment changed before admission");
    }
    // No asynchronous boundary may separate this comparison from the binding.
    const now = Date.now();
    this.liveInput = {
      id,
      page,
      generation: this.attachmentGeneration,
      documentGeneration: this.documentGeneration,
      idleUntil: now + GESTURE_IDLE_MS,
      expiresAt: now + GESTURE_LIFETIME_MS,
      timer: null,
    };
    this.scheduleLiveInputExpiry();
  }

  /** Compare after every asynchronous transport boundary, including automatic reconnect/reattach. */
  async assertLiveInput(id: string): Promise<void> {
    const page = await this.requirePage();
    if (
      this.liveInput?.id === id &&
      (Date.now() >= this.liveInput.idleUntil || Date.now() >= this.liveInput.expiresAt)
    ) {
      await this.endLiveInput(id);
    }
    if (
      !this.liveInput ||
      this.liveInput.id !== id ||
      this.liveInput.page !== page ||
      this.liveInput.generation !== this.attachmentGeneration ||
      this.liveInput.documentGeneration !== this.documentGeneration
    ) {
      throw new CdpUnavailableError("Live browser input attachment changed");
    }
  }

  /** Cleanup is idempotent and targets the original attachment, never whatever is currently active. */
  async endLiveInput(id: string): Promise<void> {
    const current = this.liveInput;
    if (!current || current.id !== id) return;
    this.liveInput = null;
    if (current.timer) clearTimeout(current.timer);
    await this.releaseHeldInput(current.page);
  }

  /** Only acknowledged input extends idle time; metadata/checks cannot keep a stranded press alive. */
  private renewLiveInput(id: string): void {
    if (this.liveInput?.id !== id) return;
    this.liveInput.idleUntil = Date.now() + GESTURE_IDLE_MS;
    this.scheduleLiveInputExpiry();
  }

  /** Runtime-owned expiry survives plugin disconnect or a fenced supervisor IPC client. */
  private scheduleLiveInputExpiry(): void {
    const current = this.liveInput;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    const delay = Math.max(0, Math.min(current.idleUntil, current.expiresAt) - Date.now());
    current.timer = setTimeout(() => {
      if (this.liveInput !== current) return;
      void this.endLiveInput(current.id).catch(() => undefined);
    }, delay);
    current.timer.unref?.();
  }

  /** Fixed hit-test, safe cursor names only. Cursor failures cannot fail an acknowledged input. */
  async cursorAt(x: number, y: number, gestureId: string): Promise<BrowserCursor | null> {
    try {
      this.assertPoint(x, y);
      await this.assertLiveInput(gestureId);
      const page = this.liveInput!.page;
      const result = await page.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: browserCursorExpression(x, y),
          returnByValue: true,
        },
        { timeoutMs: Math.min(this.timeoutMs, CURSOR_SAMPLE_TIMEOUT_MS) },
      );
      await this.assertLiveInput(gestureId);
      const parsed = browserCursorSchema.safeParse(result.result.value);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private holdsInput(): boolean {
    return this.heldButtons.size > 0 || this.heldKeys.size > 0 || this.heldTouches;
  }

  /** Forget held state whose attachment is gone; it is never replayed on a replacement. */
  private discardHeldState(): void {
    this.heldButtons.clear();
    this.heldKeys.clear();
    this.heldTouches = false;
    this.activeTouches.clear();
    this.heldOwner = null;
  }

  /**
   * Release only what `page` itself holds. State published on another attachment
   * is left to that attachment's own cleanup, never retargeted here.
   */
  async releaseHeldInput(page = this.page): Promise<void> {
    if (!page) {
      this.discardHeldState();
      return;
    }
    if (this.heldOwner && this.heldOwner !== page) return;
    this.heldOwner = null;
    const buttons = [...this.heldButtons];
    const { x, y } = this.lastMousePoint;
    const keys = [...this.heldKeys.values()];
    this.heldButtons.clear();
    this.heldKeys.clear();
    const touchHeld = this.heldTouches;
    this.heldTouches = false;
    this.activeTouches.clear();
    await Promise.allSettled([
      ...(touchHeld
        ? [
            page.send(
              "Input.dispatchTouchEvent",
              { type: "touchCancel", touchPoints: [] },
              { mutation: true },
            ),
          ]
        : []),
      ...buttons.map((button) =>
        page.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: 0,
            clickCount: 1,
          },
          { mutation: true },
        ),
      ),
      ...keys.map(({ key, code }) =>
        page.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key,
            code,
          },
          { mutation: true },
        ),
      ),
    ]);
  }

  /**
   * Concurrent callers share one in-flight shutdown; a failed one is not remembered as
   * success, so a later call retries and reports the same unconfirmed state.
   */
  async shutdown(force = false): Promise<void> {
    if (this.shutDown) return;
    if (this.shutdownInFlight) return this.shutdownInFlight;
    const operation = this.performShutdown(force);
    this.shutdownInFlight = operation;
    try {
      await operation;
      this.shutDown = true;
    } finally {
      if (this.shutdownInFlight === operation) this.shutdownInFlight = null;
    }
  }

  private async performShutdown(force: boolean): Promise<void> {
    this.stopping = true;
    this.jpegDemand.close();
    this.screencastActive = false;
    this.invalidateScreencastFrame();
    await this.withVideoTransition(async () => {
      if (this.liveInput) await this.endLiveInput(this.liveInput.id);
      await this.releaseHeldInput();
      this.invalidateScreencastFrame();
      // Only the controller that launched the browser owns its session daemon.
      if (this.ownsBrowser) await this.stopDaemon(force);
      this.connection?.close();
      this.connection = null;
      this.page = null;
      this.targetId = null;
      this.invalidateScreencastFrame();
    });
  }

  /** Close, then require observed exit; escalate to a verified-owned SIGKILL and observe that too. */
  private async stopDaemon(force: boolean): Promise<void> {
    let forced = force;
    if (!forced) {
      try {
        await this.invoke(["--session", this.session, "--json", "close"]);
      } catch {
        forced = true;
      }
      // close returns before the session daemon exits. A same-session relaunch would reach
      // that daemon with its original launch environment (e.g. a stopped private display).
      if (!forced && !(await this.daemonExited())) forced = true;
    }
    if (forced) await this.terminateDaemon();
    if (forced || this.daemonLaunched) await this.removeIpcMetadata();
    this.daemonLaunched = false;
    this.daemon = null;
  }

  /**
   * Records the PID-file daemon. Only a PID whose environment carries this runtime's own
   * nonce gets a verified identity; anything else is observable but never signalled.
   */
  private async captureDaemon(): Promise<void> {
    const pid = await this.daemonPid();
    if (pid === null) return;
    const probe = await probeProcess(pid, this.ownerNonce);
    this.daemon = { pid, identity: probe.status === "owned" ? probe.identity : null };
  }

  /**
   * Observes the daemon this runtime launched. Only `gone` is a positive exit; `unknown`
   * (no PID record, unreadable identity) is never success and never authorises a signal.
   */
  private async daemonState(): Promise<"gone" | "owned" | "alive" | "unknown"> {
    if (!this.daemonLaunched) return "gone";
    if (!this.daemon) {
      await this.captureDaemon();
      if (!this.daemon) return "unknown";
    }
    const { pid, identity } = this.daemon;
    if (!identity) return processExists(pid) ? "alive" : "gone";
    const probe = await probeProcess(pid, this.ownerNonce);
    if (probe.status === "absent" || probe.status === "foreign") return "gone";
    if (probe.status === "owned")
      return probe.identity.startTicks === identity.startTicks ? "owned" : "gone";
    return processExists(pid) ? "unknown" : "gone";
  }

  /** True only after positive observation of exit, within the bound. */
  private async daemonExited(): Promise<boolean> {
    for (const deadline = Date.now() + this.daemonExitWaitMs; Date.now() < deadline; ) {
      if ((await this.daemonState()) === "gone") return true;
      await new Promise((resolve) => setTimeout(resolve, SCREENCAST_SETUP_RETRY_MS));
    }
    return (await this.daemonState()) === "gone";
  }

  /** Signals only a daemon freshly re-verified as owned, then confirms its exit. */
  private async terminateDaemon(): Promise<void> {
    if ((await this.daemonState()) === "owned" && this.daemon) {
      try {
        process.kill(this.daemon.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // Unverified or unknown daemons are never signalled, but exit must still be observed.
    if (!(await this.daemonExited()))
      throw new AgentBrowserUnavailableError("agent-browser daemon exit was not confirmed");
  }

  private async assertVersion(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, ["--version"], {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
      });
      const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
      if (version !== AGENT_BROWSER_VERSION) {
        throw new AgentBrowserIncompatibleError(
          `Expected agent-browser ${AGENT_BROWSER_VERSION}, received ${version ?? "unknown"}`,
        );
      }
    } catch (error) {
      if (error instanceof AgentBrowserIncompatibleError) throw error;
      throw new AgentBrowserUnavailableError(
        `agent-browser is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async invoke(arguments_: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, arguments_, {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & {
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };
      if (typed.killed) {
        throw new CdpUnknownOutcomeError("agent-browser command timed out; outcome is unknown");
      }
      console.error(
        "Shared Browser agent-browser command failed:",
        "Browser runtime command failed; private command output omitted",
      );
      throw new AgentBrowserUnavailableError("agent-browser command failed");
    }
  }

  private async connectCdp(
    preferredTargetId: string | null = null,
    activate = this.ownsBrowser,
  ): Promise<void> {
    this.assertRuntimeOpen();
    // A launch-selected page remains the intended target even if its first
    // attachment fails. Otherwise a retry could silently adopt another tab.
    if (this.targetId === null && preferredTargetId !== null) {
      this.targetId = preferredTargetId;
    }
    const response = await this.invoke(["--session", this.session, "--json", "get", "cdp-url"]);
    this.assertRuntimeOpen();
    const url = findString(response, ["cdpUrl", "cdp_url", "url"]);
    if (!url) throw new AgentBrowserIncompatibleError("agent-browser did not return a CDP URL");
    const endpoint = new URL(url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
      throw new AgentBrowserIncompatibleError("agent-browser exposed a non-loopback CDP endpoint");
    }
    const connection = await CdpConnection.connect(url, {
      commandTimeoutMs: this.timeoutMs,
      connectTimeoutMs: this.timeoutMs,
    });
    if (this.stopping) {
      connection.close();
      this.assertRuntimeOpen();
    }
    this.connection = connection;
    connection.once("disconnect", () => {
      if (this.connection !== connection) return;
      this.page = null;
      // Keep the selected page identity. A transport loss does not authorize
      // adopting another tab, even when the original page still exists.
      this.emulationAppliedPage = null;
      this.attachmentGeneration += 1;
      this.invalidateScreencastFrame();
    });
    const targets = await listPageTargets(this.connection);
    this.assertRuntimeOpen();
    const expectedTargetId = preferredTargetId ?? this.targetId;
    const target =
      expectedTargetId === null
        ? targets[0]
        : targets.find((candidate) => candidate.targetId === expectedTargetId);
    if (expectedTargetId !== null && !target) {
      throw new CdpUnavailableError("The selected browser page is no longer available");
    }
    if (!target) throw new CdpUnavailableError("Chromium has no page target");
    await this.selectTarget(target.targetId, activate);
  }

  private async requirePage(): Promise<CdpSession> {
    this.assertRuntimeOpen();
    if (this.page && this.connection?.isOpen) {
      const page = this.page;
      await this.restoreConfiguredEmulation(page);
      this.assertRuntimeOpen();
      if (this.page !== page || !this.connection?.isOpen) {
        throw new CdpUnavailableError("Browser page changed during emulation restoration");
      }
      return page;
    }
    await this.reconnect();
    this.assertRuntimeOpen();
    if (!this.page) throw new CdpUnavailableError("No page target is attached");
    return this.page;
  }

  private requireConnection(): CdpConnection {
    this.assertRuntimeOpen();
    if (!this.connection?.isOpen) throw new CdpUnavailableError("Browser runtime is disconnected");
    return this.connection;
  }

  /** Shutdown cleanup uses captured attachments directly; acquisition cannot revive them. */
  private assertRuntimeOpen(): void {
    if (this.stopping) throw new CdpUnavailableError("Browser runtime is shutting down");
  }

  private requireViewport(): BrowserViewport {
    if (!this.viewport) throw new AgentBrowserIncompatibleError("Viewport has not been configured");
    return this.viewport;
  }

  private async bindPageEvents(page: CdpSession): Promise<void> {
    // URL equality is insufficient for reload. Main-document and same-document
    // navigation revoke the channel without treating child-frame loads as a reset.
    let rootFrameId: string | undefined;
    page.on("Page.frameNavigated", (event: { frame: { id: string; parentId?: string } }) => {
      if (page !== this.page || event.frame.parentId) return;
      rootFrameId = event.frame.id;
      this.documentGeneration += 1;
      this.invalidateScreencastFrame();
      this.video?.invalidateQueuedFrames();
      void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
    });
    page.on("Page.navigatedWithinDocument", (event: { frameId: string }) => {
      if (page !== this.page || event.frameId !== rootFrameId) return;
      this.documentGeneration += 1;
      this.invalidateScreencastFrame();
      this.video?.invalidateQueuedFrames();
      void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
    });
    page.on("Page.screencastFrame", (event: ScreencastFrame) =>
      this.onScreencastFrame(page, event),
    );
    page.on("event", (event: CdpEvent) => {
      if (event.method === "Inspector.targetCrashed" && this.page === page) {
        this.documentGeneration += 1;
        void this.stopVideo();
        void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
        this.emulationAppliedPage = null;
        this.invalidateScreencastFrame();
      }
    });
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
    const tree = await page.send<{ frameTree?: { frame: { id: string } } }>("Page.getFrameTree");
    rootFrameId = tree.frameTree?.frame.id ?? rootFrameId;
    await this.navigationHistory(page);
  }

  private async startScreencastSession(page: CdpSession): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let candidate = page;
    for (;;) {
      try {
        this.assertRuntimeOpen();
        await Promise.all([candidate.send("Page.enable"), candidate.send("Runtime.enable")]);
        this.assertRuntimeOpen();
        await this.navigationHistory(candidate);
        this.assertRuntimeOpen();
        if (this.page !== candidate) {
          candidate = await this.requirePage();
          continue;
        }
        await this.restoreConfiguredEmulation(candidate);
        this.assertRuntimeOpen();
        if (this.page !== candidate) {
          throw new CdpUnavailableError("Browser page changed before screencast start");
        }
        await candidate.send(
          "Page.startScreencast",
          { format: "jpeg", quality: this.screencastQuality, everyNthFrame: 1 },
          { mutation: true },
        );
        this.assertRuntimeOpen();
        return;
      } catch (error) {
        this.assertRuntimeOpen();
        if (Date.now() >= deadline) throw error;
        try {
          candidate = await this.reattachPageForScreencast(candidate);
        } catch (reattachError) {
          this.assertRuntimeOpen();
          if (Date.now() >= deadline) throw reattachError;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, SCREENCAST_SETUP_RETRY_MS);
        await promise;
      }
    }
  }

  private async reattachPageForScreencast(previous: CdpSession): Promise<CdpSession> {
    this.assertRuntimeOpen();
    if (this.page !== previous) {
      if (!this.page) throw new CdpUnavailableError("Browser page changed during reattachment");
      return this.page;
    }
    return this.withVideoTransition(async () => {
      const attachmentGeneration = ++this.attachmentGeneration;
      const connection = this.requireConnection();
      const targets = await listPageTargets(connection);
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      const target = targets.find((candidate) => candidate.targetId === previous.targetId);
      if (!target)
        throw new CdpUnavailableError("The selected browser page is no longer available");
      await connection.send(
        "Target.activateTarget",
        { targetId: target.targetId },
        { mutation: true },
      );
      this.assertAttachmentCurrent(connection, attachmentGeneration);
      const replacement = await attachToTarget(connection, target.targetId);
      if (this.page !== previous || attachmentGeneration !== this.attachmentGeneration) {
        await replacement.detach().catch(() => undefined);
        // The losing controller's detach may clear target overrides. Repair the
        // current controller on its next access rather than trust earlier pixels.
        this.emulationAppliedPage = null;
        this.invalidateScreencastFrame();
        if (!this.page) throw new CdpUnavailableError("Browser page changed during reattachment");
        return this.page;
      }
      this.assertAttachmentCurrent(connection, attachmentGeneration);

      this.invalidateScreencastFrame();
      // Detaching drops the session that holds any pressed button; release there first.
      if (this.liveInput) await this.endLiveInput(this.liveInput.id);
      await this.releaseHeldInput(previous);
      this.page = null;
      this.emulationAppliedPage = null;
      // Detach first: the former session can otherwise clear the newly applied override.
      try {
        await previous.detach();
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.bindPageEvents(replacement);
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.restoreConfiguredEmulation(replacement);
        this.assertAttachmentCurrent(connection, attachmentGeneration);
        this.page = replacement;
        this.targetId = target.targetId;
        return replacement;
      } catch (error) {
        await replacement.detach().catch(() => undefined);
        // Detaching a partial emulation can clear target metrics even if a newer
        // attachment won. Its next access must restore intent before admitting pixels.
        this.emulationAppliedPage = null;
        this.invalidateScreencastFrame();
        throw error;
      }
    });
  }

  private async withInvalidatedScreencast(
    mutation: (page: CdpSession) => Promise<unknown>,
    options: { preserveStream?: boolean } = {},
  ): Promise<void> {
    const releaseJpeg = this.jpegDemand.pin(false);
    try {
      const page = await this.requirePage();
      // Ordinary navigation is observed by the same native stream. Optional
      // capture teardown/setup must not consume the navigation ACK budget.
      const restart = this.screencastActive && !options.preserveStream;
      this.invalidateScreencastFrame();
      if (restart) await page.send("Page.stopScreencast", {}, { mutation: true });
      this.assertRuntimeOpen();
      try {
        await mutation(page);
        this.invalidateQueuedVideoFrames();
      } finally {
        this.invalidateScreencastFrame();
        if (restart && this.page === page) {
          this.assertRuntimeOpen();
          await this.restoreConfiguredEmulation(page);
          await this.startScreencastSession(page);
        }
      }
    } finally {
      releaseJpeg();
    }
  }

  /** Clear JPEG stream/screenshot receipts after input or transport changes. */
  private invalidateScreencastFrame(): void {
    this.capturePolicy.invalidate();
    this.screencastSourceTime.invalidate(Date.now());
    this.screencastFrame = null;
    this.screencastFrameReceivedAt = null;
    this.resolveFrameWaiters(null);
  }

  private onScreencastFrame(page: CdpSession, event: ScreencastFrame): void {
    // A late frame belongs to its emitting session, even after page reattachment.
    void page
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
    if (
      this.stopping ||
      page !== this.page ||
      !this.screencastActive ||
      this.emulationAppliedPage !== page
    )
      return;
    const dimensions = readJpegFrameDimensions(event.data);
    const viewport = this.viewport;
    // Chromium can report the new device dimensions while emitting a clipped transition image.
    // Reject those pixels and use the bounded screenshot fallback rather than mislabeling them.
    if (!viewport || !dimensions) return;
    const expectedPixels = captureDimensions(viewport, viewport.captureScale);
    if (dimensions.width !== expectedPixels.width || dimensions.height !== expectedPixels.height)
      return;
    const now = performance.now();
    const source = this.screencastSourceTime.accept(event.metadata.timestamp, Date.now(), now);
    if (!source) return;
    const { width, height } = dimensions;
    const frame: RuntimeFrame = {
      dataBase64: event.data,
      byteLength: Buffer.byteLength(event.data, "base64"),
      width,
      height,
      transport: "cdp-screencast",
      capturedAt: source.capturedAt,
    };
    this.capturePolicy.observeStream(`provider:${event.metadata.timestamp}`, now);
    this.screencastFrame = frame;
    this.screencastFrameReceivedAt = source.receivedAt;
    this.resolveFrameWaiters(frame);
  }

  private waitForFrame(waitMs: number): Promise<RuntimeFrame | null> {
    const { promise, resolve } = Promise.withResolvers<RuntimeFrame | null>();
    const timer = setTimeout(() => {
      this.screencastWaiters.delete(done);
      resolve(null);
    }, waitMs);
    const done = (frame: RuntimeFrame | null): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    this.screencastWaiters.add(done);
    return promise;
  }

  private resolveFrameWaiters(frame: RuntimeFrame | null): void {
    const waiters = [...this.screencastWaiters];
    this.screencastWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter(frame);
  }

  private assertViewport(viewport: BrowserViewport): void {
    const captureScale = viewport.captureScale ?? 1;
    const pixels = captureDimensions(viewport, captureScale);
    if (
      !Number.isFinite(captureScale) ||
      captureScale < 1 ||
      captureScale > 2 ||
      pixels.width > MAX_VIEWPORT.width ||
      pixels.height > MAX_VIEWPORT.height
    ) {
      throw new RangeError("Capture density exceeds the supported image bounds");
    }
    if (
      !Number.isInteger(viewport.width) ||
      viewport.width < 1 ||
      viewport.width > 16_384 ||
      !Number.isInteger(viewport.height) ||
      viewport.height < 1 ||
      viewport.height > 16_384 ||
      !Number.isFinite(viewport.deviceScaleFactor) ||
      viewport.deviceScaleFactor <= 0 ||
      viewport.deviceScaleFactor > 10
    )
      throw new RangeError("Invalid viewport emulation values");
  }

  private assertPoint(x: number, y: number): void {
    const viewport = this.requireViewport();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > viewport.width ||
      y > viewport.height
    ) {
      throw new RangeError("Input coordinates are outside the CSS viewport");
    }
  }

  /** CDP/Puppeteer priority for supported held buttons, independent of press order.
   * https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Input.ts
   */
  private heldMoveButton(): MouseButton | "none" {
    for (const button of ["left", "right", "middle"] as const) {
      if (this.heldButtons.has(button)) {
        return button;
      }
    }
    return "none";
  }

  /** Validate before recording held-button intent or sending a native packet. */
  private assertMouseModifiers(modifiers: number | undefined): void {
    if (
      modifiers !== undefined &&
      (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15)
    ) {
      throw new RangeError("Mouse modifiers must be an integer from 0 to 15");
    }
  }

  /** Both live and discrete keyboard paths must bound release fanout before sending. */
  private assertHeldKeyCapacity(code: string): void {
    if (!this.heldKeys.has(code) && this.heldKeys.size >= MAX_HELD_BROWSER_KEYS) {
      throw new Error("Too many simultaneously held browser keys");
    }
  }

  private buttonMask(add?: MouseButton, remove?: MouseButton): number {
    const active = new Set(this.heldButtons);
    if (add) active.add(add);
    if (remove) active.delete(remove);
    return (
      (active.has("left") ? 1 : 0) | (active.has("right") ? 2 : 0) | (active.has("middle") ? 4 : 0)
    );
  }

  private async daemonPid(): Promise<number | null> {
    try {
      const value = await readFile(resolve(this.ipcDirectory, `${this.session}.pid`), "utf8");
      const pid = Number.parseInt(value.trim(), 10);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async protectIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => chmod(path, PRIVATE_FILE_MODE).catch(() => undefined)),
    );
  }

  private async removeIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream", "engine", "provider", "extensions"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => rm(path, { force: true }).catch(() => undefined)),
    );
  }
}
