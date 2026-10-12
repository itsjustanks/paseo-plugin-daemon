import { setTimeout } from "./node-timers";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserGestureKeySchema, MAX_BROWSER_TABS } from "../../shared/managed-browser/browser";
import { videoBitrateSchema, videoFrameRateSchema } from "../../shared/managed-browser/video-settings";
import {
  AgentBrowserRuntime,
  type AgentBrowserRuntimeOptions,
  type BrowserViewport,
  type RuntimeTarget,
} from "./agent-browser-runtime";
import { CdpUnknownOutcomeError } from "./cdp";
import { resolveBrowserRuntimeRoot } from "./runtime-path";
import type { JsonValue } from "./runtime-protocol";
import type { RuntimeOwner } from "./supervisor";
import {
  createPrivateVirtualDisplay,
  PrivateDisplayError,
  type PrivateVirtualDisplay,
} from "./virtual-display";

const DEFAULT_BROWSER_URL = "about:blank";

interface OwnedRuntime {
  runtimeId: string;
  runtime: AgentBrowserRuntime;
  rootTargetId: string;
  runtimeOptions: AgentBrowserRuntimeOptions;
  tabs: Map<string, Promise<AgentBrowserRuntime>>;
  tabOrder: string[];
  display: PrivateVirtualDisplay | null;
  /** Bounded, secret-free reason an opted-in private display is not in use. */
  displayNotice: string | null;
}
interface RuntimeOwnerOptions {
  /** Bundle directory supplied by the immutable supervisor entry. */
  runtimeRoot?: string;
  initialUrl?: string;
  headed?: boolean;
  /**
   * Trusted opt-in for a private Linux Xvfb display. When omitted, each runtime creation reads
   * HOSTS_BROWSER_XVFB from this process's environment and enables it only for "1".
   * Explicit false overrides the environment.
   */
  virtualDisplay?: boolean;
  /** Encoded video is opt-in; defaults to HOSTS_BROWSER_VIDEO=1 in the daemon environment. */
  nativeVideo?: boolean;
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

/** Retain omission for legacy/native held-key inference; reject malformed explicit masks. */
function optionalMouseModifiers(data: Record<string, JsonValue>): [] | [number] {
  return data.modifiers === undefined
    ? []
    : [browserGestureKeySchema.shape.modifiers.parse(data.modifiers)];
}

/** Retain known tab positions across unordered CDP snapshots; append newly discovered pages. */
async function orderedTargets(owned: OwnedRuntime): Promise<RuntimeTarget[]> {
  const targets = await owned.runtime.targets();
  const byId = new Map(targets.map((target) => [target.targetId, target]));
  const surviving = owned.tabOrder.filter((targetId) => byId.has(targetId));
  const known = new Set(surviving);
  for (const target of targets) {
    if (!known.has(target.targetId)) {
      surviving.push(target.targetId);
      known.add(target.targetId);
    }
  }
  owned.tabOrder = surviving;
  return surviving.map((targetId) => byId.get(targetId)!);
}

/** Give each page its own CDP attachment and media state within one Chromium profile. */
async function tabRuntime(owned: OwnedRuntime, targetId: string): Promise<AgentBrowserRuntime> {
  const existing = owned.tabs.get(targetId);
  if (existing) return existing;

  const attaching = (async () => {
    const targets = await owned.runtime.targets();
    if (!targets.some((target) => target.targetId === targetId)) {
      throw new Error("Browser tab is no longer available");
    }
    const runtime = new AgentBrowserRuntime(owned.runtimeOptions);
    try {
      await runtime.attachTarget(targetId);
      return runtime;
    } catch (error) {
      await runtime.shutdown().catch(() => undefined);
      throw error;
    }
  })();
  owned.tabs.set(targetId, attaching);
  try {
    return await attaching;
  } catch (error) {
    if (owned.tabs.get(targetId) === attaching) owned.tabs.delete(targetId);
    throw error;
  }
}

export async function createRuntimeOwner(
  options: RuntimeOwnerOptions = {},
): Promise<RuntimeOwner<OwnedRuntime>> {
  const home = paseoHome();
  const root = join(home, "plugin-data", "daemon-link", "browser");
  const runtimeRoot = options.runtimeRoot ?? resolveBrowserRuntimeRoot(home);
  const ipcDirectory =
    process.platform === "win32"
      ? join(root, "ipc")
      : join(
          "/tmp",
          `paseo-hosts-browser-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
        );
  const binaryPath =
    process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY ??
    join(
      runtimeRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
    );
  const executablePath =
    process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE ??
    join(runtimeRoot, "chromium", process.platform === "win32" ? "chrome.exe" : "chrome");
  return {
    async create(workspaceId) {
      const hash = createHash("sha256").update(workspaceId).digest("hex");
      // Explicit headed mode uses the caller's real display. An opted-in hidden Linux mode
      // gets a private virtual mouse so native pointer media survive emulation.
      let display: PrivateVirtualDisplay | null = null;
      let displayNotice: string | null = null;
      const wantsDisplay = false;
      if (!options.headed && wantsDisplay) {
        try {
          display = await createPrivateVirtualDisplay();
          if (!display) displayNotice = "Private display unavailable: Xvfb was not found.";
        } catch (error) {
          // The helper has finished cleanup and no Chromium was constructed yet.
          displayNotice = `Private display unavailable: ${
            error instanceof PrivateDisplayError ? error.message : "unexpected startup failure"
          }.`;
        }
        if (displayNotice) {
          // The detached supervisor discards stdio; the notice also reaches the viewer state.
          console.warn(`[hosts-browser] ${displayNotice} Using headless mode.`);
        }
      }
      let runtime: AgentBrowserRuntime | null = null;
      try {
        const runtimeOptions: AgentBrowserRuntimeOptions = {
          binaryPath,
          executablePath,
          profilePath: join(root, "profiles", hash),
          ipcDirectory,
          session: `ws-${hash.slice(0, 16)}`,
          initialUrl: options.initialUrl ?? DEFAULT_BROWSER_URL,
          headed: display ? true : (options.headed ?? false),
          nativeVideo: false,
          ...(display ? { launchEnvironment: display.launchEnvironment } : {}),
        };
        runtime = new AgentBrowserRuntime(runtimeOptions);
        await runtime.launch();
        display?.assertAvailable();
        const identity = await runtime.identity();
        return {
          runtimeId: randomUUID(),
          runtime,
          rootTargetId: identity.targetId,
          runtimeOptions,
          tabs: new Map(),
          tabOrder: [identity.targetId],
          display,
          displayNotice,
        };
      } catch (error) {
        let cleanupFailure: unknown = null;
        try {
          await runtime?.shutdown();
        } catch (failure) {
          cleanupFailure = failure;
        } finally {
          await display?.stop();
        }
        // An unconfirmed cleanup must not hide why creation failed.
        if (cleanupFailure)
          throw new AggregateError(
            [error, cleanupFailure],
            `Runtime creation failed (${error instanceof Error ? error.message : String(error)}) and its cleanup was not confirmed`,
          );
        throw error;
      }
    },
    async request(owned, operation, input) {
      owned.display?.assertAvailable();
      const data =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, JsonValue>)
          : {};
      if (operation === "tabs.list") {
        return (await orderedTargets(owned)).map(({ targetId, title, url }) => ({
          targetId,
          title,
          url,
        }));
      }
      if (operation === "tabs.create") {
        if ((await orderedTargets(owned)).length >= MAX_BROWSER_TABS)
          throw new Error("Browser tab limit reached");
        const targetId = await owned.runtime.createTarget();
        owned.tabOrder.push(targetId);
        return { targetId };
      }
      if (operation === "tabs.close") {
        const targetId = String(data.targetId);
        const targets = await orderedTargets(owned);
        if (!targets.some((target) => target.targetId === targetId)) {
          throw new Error("Browser tab is no longer available");
        }
        if (targets.length <= 1) {
          throw new Error("The last browser tab cannot be closed");
        }
        const controller = owned.tabs.get(targetId);
        if (controller) await (await controller).shutdown();
        if (owned.rootTargetId === targetId) {
          const successor = targets.find((target) => target.targetId !== targetId)!;
          await owned.runtime.selectTarget(successor.targetId, false);
          owned.rootTargetId = successor.targetId;
        }
        await owned.runtime.closeTarget(targetId);
        // Target.closeTarget can acknowledge before Chromium drops the page from
        // its target list. Success requires observing its absence; the close is
        // never replayed, and exhaustion is reported rather than assumed.
        let gone = false;
        for (let attempt = 0; attempt < 20 && !gone; attempt++) {
          gone = !(await owned.runtime.targets()).some((target) => target.targetId === targetId);
          if (gone) break;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 50);
          await promise;
        }
        owned.tabs.delete(targetId);
        if (!gone) throw new CdpUnknownOutcomeError("Browser tab close could not be confirmed");
        owned.tabOrder = owned.tabOrder.filter((id) => id !== targetId);
        return null;
      }
      const targetId = typeof data.targetId === "string" ? data.targetId : null;
      // Keep the launch page on its original CDP session. A second session on
      // the same target can reset emulation and interrupt its video source.
      const runtime =
        targetId && (targetId !== owned.rootTargetId || owned.tabs.has(targetId))
          ? await tabRuntime(owned, targetId)
          : owned.runtime;
      const gestureId = typeof data.gestureId === "string" ? data.gestureId : undefined;
      switch (operation) {
        case "identity": {
          const identity = await runtime.identity();
          return {
            ...identity,
            ...(owned.displayNotice ? { displayNotice: owned.displayNotice } : {}),
          } as unknown as JsonValue;
        }
        case "state":
          if (data.timeoutMs === undefined) return runtime.state() as unknown as JsonValue;
          if (typeof data.timeoutMs !== "number")
            throw new Error("Invalid browser metadata timeout");
          return runtime.state({ timeoutMs: data.timeoutMs }) as unknown as JsonValue;
        case "navigate":
          await runtime.navigate(String(data.url));
          return null;
        case "back":
          await runtime.back();
          return null;
        case "forward":
          await runtime.forward();
          return null;
        case "reload":
          await runtime.reload();
          return null;
        case "emulate":
          await runtime.emulate(data as unknown as BrowserViewport);
          return null;
        case "capture.density":
          await runtime.setCaptureDensity(Number(data.density), Number(data.deviceScaleFactor));
          return null;
        case "screencast.start":
          await runtime.startScreencast(Number(data.quality));
          return null;
        case "screencast.stop":
          await runtime.stopScreencast();
          return null;
        case "video.read":
          return (await runtime.readVideo({
            quality: data.quality === "low" || data.quality === "medium" ? data.quality : "high",
            streamId: typeof data.streamId === "string" ? data.streamId : null,
            requestKeyFrame: data.requestKeyFrame === true,
            ...(data.bitrate === undefined
              ? {}
              : { bitrate: videoBitrateSchema.parse(data.bitrate) }),
            ...(data.fps === undefined ? {} : { fps: videoFrameRateSchema.parse(data.fps) }),
            afterSequence: Number(data.afterSequence ?? 0),
            waitMs: Number(data.waitMs ?? 250),
          })) as unknown as JsonValue;
        case "video.stop":
          await runtime.stopVideo();
          return null;
        case "video.invalidate":
          runtime.invalidateQueuedVideoFrames();
          return null;
        case "frame":
          return (await runtime.frame(
            Number(data.maxBytes),
            Number(data.quality),
            Number(data.waitMs),
          )) as unknown as JsonValue;
        case "mouse.move":
          await runtime.mouseMove(
            Number(data.x),
            Number(data.y),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.down":
          await runtime.mouseDown(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.up":
          await runtime.mouseUp(
            Number(data.x),
            Number(data.y),
            String(data.button) as "left" | "middle" | "right",
            Number(data.clickCount),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.wheel":
          await runtime.wheel(
            Number(data.x),
            Number(data.y),
            Number(data.deltaX),
            Number(data.deltaY),
            gestureId,
            ...optionalMouseModifiers(data),
          );
          return null;
        case "mouse.leave":
          if (!gestureId) throw new Error("Gesture identity is required");
          await runtime.mouseLeave(gestureId);
          return null;
        case "input.begin":
          if (!gestureId) throw new Error("Gesture identity is required");
          if (typeof data.expectedInputGeneration !== "string") {
            throw new Error("Expected native input generation is required");
          }
          await runtime.beginLiveInput(gestureId, data.expectedInputGeneration);
          return null;
        case "input.check":
          if (!gestureId) throw new Error("Gesture identity is required");
          await runtime.assertLiveInput(gestureId);
          return null;
        case "input.end":
          if (!gestureId) throw new Error("Gesture identity is required");
          await runtime.endLiveInput(gestureId);
          return null;
        case "cursor":
          if (!gestureId) throw new Error("Gesture identity is required");
          return runtime.cursorAt(Number(data.x), Number(data.y), gestureId);
        case "touch": {
          if (!gestureId || !Array.isArray(data.points) || data.points.length > 5)
            throw new Error("Invalid touch input");
          const points = data.points.map((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Invalid touch point");
            const id = value.id;
            if (
              typeof id !== "number" ||
              typeof value.x !== "number" ||
              typeof value.y !== "number"
            )
              throw new Error("Invalid touch point numbers");
            if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647)
              throw new Error("Invalid touch identifier");
            return { x: Number(value.x), y: Number(value.y), id };
          });
          if (new Set(points.map((point) => point.id)).size !== points.length)
            throw new Error("Duplicate touch identifiers");
          const type = data.type;
          if (type !== "start" && type !== "move" && type !== "end" && type !== "cancel")
            throw new Error("Invalid touch phase");
          if ((type === "end" || type === "cancel") !== (points.length === 0))
            throw new Error("Invalid touch phase points");
          const nativeType =
            type === "start"
              ? "touchStart"
              : type === "move"
                ? "touchMove"
                : type === "end"
                  ? "touchEnd"
                  : "touchCancel";
          await runtime.touch(nativeType, points, gestureId);
          return null;
        }
        case "input.key":
          if (!gestureId) throw new Error("Gesture identity is required");
          await runtime.dispatchKey(browserGestureKeySchema.parse(data.event), gestureId);
          return null;
        case "input.text":
          if (
            !gestureId ||
            typeof data.text !== "string" ||
            data.text.length < 1 ||
            data.text.length > 16_000
          ) {
            throw new Error("Invalid committed text input");
          }
          await runtime.insertText(data.text, gestureId);
          return null;
        case "text.insert":
          await runtime.insertText(String(data.text), gestureId);
          return null;
        case "key.down":
          await runtime.keyDown(String(data.key), String(data.key), gestureId);
          return null;
        case "key.up":
          await runtime.keyUp(String(data.key), String(data.key), gestureId);
          return null;
        default:
          throw new Error(`Unknown browser runtime operation: ${operation}`);
      }
    },
    async stop(owned) {
      try {
        await Promise.allSettled(
          [...owned.tabs.values()].map(async (controller) =>
            (await controller).shutdown().catch(() => undefined),
          ),
        );
        await owned.runtime.shutdown();
      } finally {
        await owned.display?.stop();
      }
    },
  };
}
