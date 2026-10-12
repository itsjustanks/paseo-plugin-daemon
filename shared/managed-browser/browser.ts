import { captureDensitySchema } from "./capture-density";

export { type CaptureDensity, canUseCaptureDensity, captureDensitySchema } from "./capture-density";

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DEFAULT_CAPTURE_QUALITY,
  FRAME_MAX_BASE64_CHARS,
  FRAME_MAX_BYTES,
} from "./capture-settings";
import { DEVICE_PRESET_IDS } from "./device-presets";
import { MAX_VIEWPORT, MIN_VIEWPORT } from "./viewport-limits";

export {
  DEFAULT_CAPTURE_QUALITY,
  FRAME_MAX_BASE64_CHARS,
  FRAME_MAX_BYTES,
} from "./capture-settings";
export { DEVICE_PRESET_IDS, DEVICE_PRESETS, type DevicePresetId } from "./device-presets";

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const MAX_BROWSER_TABS = 8;
export { MAX_VIEWPORT, MIN_VIEWPORT } from "./viewport-limits";

const devicePresetIdSchema = z.enum(DEVICE_PRESET_IDS);

const workspaceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid workspace ID");
const opaqueTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid token");
const generationSchema = z.number().int().nonnegative();
const epochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtimeIdSchema = opaqueTokenSchema;
export const browserTabIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const browserTabSchema = z.object({
  id: browserTabIdSchema,
  title: z.string().max(1_024),
  url: z.string().max(8_192),
  viewerCount: z.number().int().nonnegative(),
  controllerLabel: z.string().max(64).nullable(),
});
export type BrowserTab = z.output<typeof browserTabSchema>;

export const browserRecoveryStateSchema = z.enum([
  "available",
  "runtime-unavailable",
  "browser-restarted",
]);

export const viewportSchema = z.object({
  width: z.number().int().min(MIN_VIEWPORT.width).max(MAX_VIEWPORT.width),
  height: z.number().int().min(MIN_VIEWPORT.height).max(MAX_VIEWPORT.height),
});

export const browserStateSchema = z.object({
  sessionId: opaqueTokenSchema,
  workspaceId: workspaceIdSchema,
  status: z.enum(["starting", "ready", "error"]),
  url: z.string().max(8_192),
  title: z.string().max(1_024),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: viewportSchema,
  captureScale: z.number().min(1).max(2).default(1),
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
  devicePresetId: devicePresetIdSchema.nullable(),
  userAgent: z.string().min(1).max(512),
  controller: z.enum(["none", "self", "other"]),
  controllerLabel: z.string().max(64).nullable(),
  controllerExpiresAt: z.string().datetime().nullable(),
  viewerCount: z.number().int().nonnegative(),
  error: z.string().max(2_048).nullable(),
  notice: z.string().max(256).optional(),
  runtimeId: runtimeIdSchema.optional(),
  tabId: browserTabIdSchema.optional(),
  runtimeCreatedAt: epochSchema.optional(),
  bridgeEpoch: epochSchema.optional(),
  recoveryState: browserRecoveryStateSchema.optional(),
});

export const browserFrameSchema = z.object({
  sessionId: opaqueTokenSchema,
  frameId: opaqueTokenSchema,
  mimeType: z.literal("image/jpeg"),
  transport: z.enum(["cdp-screencast", "screenshot"]),
  dataBase64: z.string().max(FRAME_MAX_BASE64_CHARS),
  byteLength: z.number().int().positive().max(FRAME_MAX_BYTES),
  width: z.number().int().positive().max(MAX_VIEWPORT.width),
  height: z.number().int().positive().max(MAX_VIEWPORT.height),
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
  runtimeId: runtimeIdSchema.optional(),
  captureEpoch: epochSchema.optional(),
  capturedAt: z.string().datetime(),
});

export const attachBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.attach",
  input: z.object({
    workspaceId: workspaceIdSchema,
    viewerLabel: z.string().trim().min(1).max(64),
    create: z.boolean().default(false),
    tabId: browserTabIdSchema.optional(),
  }),
  output: z.object({
    viewerToken: opaqueTokenSchema,
    state: browserStateSchema,
  }),
});

export const listBrowserTabsRpc = defineRpc({
  name: "daemon-link.browser.managed.tabs.list",
  input: z.object({ viewerToken: opaqueTokenSchema }),
  output: z.object({ tabs: z.array(browserTabSchema).max(MAX_BROWSER_TABS) }),
});

export const createBrowserTabRpc = defineRpc({
  name: "daemon-link.browser.managed.tabs.create",
  input: z.object({ viewerToken: opaqueTokenSchema }),
  output: z.object({ tabId: browserTabIdSchema }),
});

export const closeBrowserTabRpc = defineRpc({
  name: "daemon-link.browser.managed.tabs.close",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    tabId: browserTabIdSchema,
  }),
  output: z.object({ closed: z.literal(true) }),
});

export const detachBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.detach",
  input: z.object({ viewerToken: opaqueTokenSchema }),
  output: z.object({ detached: z.boolean() }),
});

/** Stop the current workspace runtime only when its controller still owns this session. */
export const closeBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.close",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    sessionId: opaqueTokenSchema,
    runtimeId: runtimeIdSchema,
  }),
  output: z.object({ closed: z.literal(true) }),
});

/** Reopen a deliberately closed workspace browser using its retained profile. */
export const reopenBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.reopen",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({ opened: z.literal(true) }),
});

export const listOpenBrowserWorkspacesRpc = defineRpc({
  name: "daemon-link.browser.managed.presence",
  input: z.object({}),
  output: z.object({ workspaceIds: z.array(workspaceIdSchema).max(32) }),
});

export const captureBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.capture",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    quality: z.enum(["low", "medium", "high", "maximum"]).default(DEFAULT_CAPTURE_QUALITY),
    knownFrameId: opaqueTokenSchema.nullable().default(null),
  }),
  output: z.object({
    state: browserStateSchema,
    frame: browserFrameSchema.nullable(),
  }),
});

export const acquireControlRpc = defineRpc({
  name: "daemon-link.browser.managed.control.acquire",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    takeover: z.boolean().default(false),
  }),
  output: z.object({
    controlToken: opaqueTokenSchema,
    state: browserStateSchema,
  }),
});

export const releaseControlRpc = defineRpc({
  name: "daemon-link.browser.managed.control.release",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

const expectedStateSchema = z.object({
  sessionId: opaqueTokenSchema,
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
  runtimeId: runtimeIdSchema.optional(),
  bridgeEpoch: epochSchema.optional(),
});

export const navigateBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.navigate",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    action: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("goto"),
        url: z.string().trim().min(1).max(8_192),
      }),
      z.object({ kind: z.literal("back") }),
      z.object({ kind: z.literal("forward") }),
      z.object({ kind: z.literal("reload") }),
    ]),
  }),
  output: z.object({ state: browserStateSchema }),
});

export const resizeBrowserRpc = defineRpc({
  name: "daemon-link.browser.managed.viewport.resize",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    viewport: viewportSchema,
    /** Panel following changes layout size without resetting device behavior or density. */
    preserveEmulation: z.boolean().optional(),
    /** Resolve automatic density and panel geometry in one controlled transition. */
    captureDensity: captureDensitySchema.optional(),
  }),
  output: z.object({ state: browserStateSchema }),
});

/** Independent, controller-authorized density selection; no page navigation or preset substitution. */
export const setCaptureDensityRpc = defineRpc({
  name: "daemon-link.browser.managed.capture.density",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    density: captureDensitySchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

export const applyDevicePresetRpc = defineRpc({
  name: "daemon-link.browser.managed.device.apply",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    presetId: devicePresetIdSchema,
    /** Mode-only changes retain current CSS dimensions and JPEG capture density. */
    preserveDisplay: z.boolean().optional(),
  }),
  output: z.object({ state: browserStateSchema }),
});
const displayedPointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
});

const targetFrameSchema = z.object({
  frameId: opaqueTokenSchema,
  navigationGeneration: generationSchema,
  viewportGeneration: generationSchema,
});

export const browserInputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    point: displayedPointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({
    kind: z.literal("move"),
    point: displayedPointSchema,
  }),
  z.object({
    kind: z.literal("drag"),
    start: displayedPointSchema,
    end: displayedPointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    kind: z.literal("scroll"),
    point: displayedPointSchema,
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
  z.object({
    kind: z.literal("type"),
    text: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
]);

export const sendBrowserInputRpc = defineRpc({
  name: "daemon-link.browser.managed.input",
  input: z.object({
    viewerToken: opaqueTokenSchema,
    controlToken: opaqueTokenSchema,
    expected: expectedStateSchema,
    target: targetFrameSchema,
    event: browserInputEventSchema,
  }),
  output: z.object({ state: browserStateSchema }),
});

/** Safe CSS cursor names only. Custom cursor URLs never reach the local client. */
export const browserCursorSchema = z.enum([
  "default",
  "none",
  "pointer",
  "text",
  "vertical-text",
  "crosshair",
  "move",
  "grab",
  "grabbing",
  "wait",
  "progress",
  "help",
  "not-allowed",
  "no-drop",
  "copy",
  "alias",
  "context-menu",
  "cell",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "s-resize",
  "e-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
]);
export type BrowserCursor = z.output<typeof browserCursorSchema>;

const touchPointSchema = displayedPointSchema.extend({
  id: z.number().int().min(0).max(2_147_483_647),
});
/** Native keyboard modifiers use CDP's bits: Alt 1, Control 2, Meta 4, Shift 8. */
/** Bound simultaneous physical-key cleanup work without restricting layout codes. */
export const MAX_HELD_BROWSER_KEYS = 32;

export const browserGestureKeySchema = z
  .object({
    kind: z.literal("key"),
    type: z.enum(["down", "up"]),
    key: z.string().min(1).max(64),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/),
    modifiers: z.number().int().min(0).max(15),
    repeat: z.boolean().default(false),
    text: z.string().min(1).max(32).optional(),
  })
  .superRefine((event, context) => {
    if (event.type === "up" && (event.repeat || event.text !== undefined)) {
      context.addIssue({ code: "custom", message: "Key release cannot repeat or insert text" });
    }
    if (event.text !== undefined && (event.modifiers & 7) !== 0) {
      context.addIssue({ code: "custom", message: "Shortcut keys cannot insert printable text" });
    }
  });
export type BrowserGestureKeyEvent = z.output<typeof browserGestureKeySchema>;

/**
 * Ordered live input, in displayed-image coordinates. Touch start/move contain
 * the complete active ID set; removing contacts in move releases those contacts.
 * End/cancel contain no points. Wheel deltas are bounded browser CSS pixels.
 */
// Pointer snapshots use the same CDP modifier bits as key events. Omission
// preserves native/older callers' held-key inference; explicit zero means none.
const pointerModifiersSchema = z.number().int().min(0).max(15).optional();
export const browserGestureEventSchema = z.discriminatedUnion("kind", [
  browserGestureKeySchema,
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(16_000) }),
  z.object({ kind: z.literal("leave") }),
  z.object({
    kind: z.literal("move"),
    point: displayedPointSchema,
    modifiers: pointerModifiersSchema,
  }),
  z.object({
    kind: z.literal("down"),
    point: displayedPointSchema,
    modifiers: pointerModifiersSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({
    kind: z.literal("up"),
    point: displayedPointSchema,
    modifiers: pointerModifiersSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({
    kind: z.literal("scroll"),
    point: displayedPointSchema,
    modifiers: pointerModifiersSchema,
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
  z
    .object({
      kind: z.literal("touch"),
      type: z.enum(["start", "move", "end", "cancel"]),
      points: z.array(touchPointSchema).max(5),
    })
    .superRefine((event, context) => {
      if ((event.type === "end" || event.type === "cancel") !== (event.points.length === 0)) {
        context.addIssue({
          code: "custom",
          message: "Touch start/move require points; end/cancel require none",
        });
      }
      if (new Set(event.points.map((point) => point.id)).size !== event.points.length) {
        context.addIssue({ code: "custom", message: "Touch identifiers must be unique" });
      }
    }),
]);
export type BrowserGestureEvent = z.output<typeof browserGestureEventSchema>;

const gestureContextSchema = z.object({
  viewerToken: opaqueTokenSchema,
  controlToken: opaqueTokenSchema,
  expected: expectedStateSchema.extend({ runtimeId: runtimeIdSchema, bridgeEpoch: epochSchema }),
});
const gestureContinuationSchema = gestureContextSchema.extend({
  gestureId: opaqueTokenSchema,
  sequence: z.number().int().positive().max(100_000),
});
/** Begin pins a decoded recent frame but sends no physical input. One live channel per controller. Keyboard events may share either pointer channel. */
export const beginBrowserGestureRpc = defineRpc({
  name: "daemon-link.browser.managed.gesture.begin",
  input: gestureContextSchema.extend({
    target: targetFrameSchema,
    pointerKind: z.enum(["mouse", "touch"]),
  }),
  output: z.union([
    z.object({
      state: browserStateSchema,
      gestureId: opaqueTokenSchema,
      nextSequence: z.number().int().positive(),
    }),
    // This receipt exists only before input.begin, so no physical action or channel is replayed.
    z.object({ state: browserStateSchema, admission: z.literal("stale-frame") }),
  ]),
});
/**
 * Strict sequence continues the original frame context despite this channel's
 * input invalidations. Independent mouse down/initial touch start require target;
 * additional contacts in a held touch gesture continue its pinned geometry.
 */
export const updateBrowserGestureRpc = defineRpc({
  name: "daemon-link.browser.managed.gesture.update",
  input: gestureContinuationSchema.extend({
    event: browserGestureEventSchema,
    target: targetFrameSchema.optional(),
  }),
  // The native input was acknowledged and navigated on its original attachment.
  // This closes the old channel; it never authorizes a continuation or a replay.
  output: z.object({
    state: browserStateSchema,
    gestureId: opaqueTokenSchema,
    nextSequence: z.number().int().positive(),
    cursor: browserCursorSchema.nullable(),
    completion: z.literal("navigation").optional(),
  }),
});
/**
 * End/cancel releases the original held input without retrying an uncertain action.
 * cancel permits a stale sequence after a lost reply, but still requires the exact
 * owned gesture/controller. Normal end requires the acknowledged next sequence.
 */
export const endBrowserGestureRpc = defineRpc({
  name: "daemon-link.browser.managed.gesture.end",
  input: gestureContinuationSchema.extend({ cancel: z.boolean().default(false) }),
  output: z.object({ state: browserStateSchema, cursor: browserCursorSchema.nullable() }),
});

export type BrowserState = z.output<typeof browserStateSchema>;
export type BrowserFrame = z.output<typeof browserFrameSchema>;
export type BrowserInputEvent = z.output<typeof browserInputEventSchema>;
export type Viewport = z.output<typeof viewportSchema>;
export type BrowserRecoveryState = z.output<typeof browserRecoveryStateSchema>;

export function isBrowserStateCurrent(previous: BrowserState, next: BrowserState): boolean {
  if (
    previous.runtimeCreatedAt !== undefined &&
    next.runtimeCreatedAt !== undefined &&
    next.runtimeCreatedAt < previous.runtimeCreatedAt
  ) {
    return false;
  }
  if (previous.sessionId !== next.sessionId) return true;
  if (didBrowserRuntimeRestart(previous, next)) return true;
  if (
    previous.runtimeId &&
    next.runtimeId &&
    previous.runtimeId === next.runtimeId &&
    previous.bridgeEpoch !== undefined &&
    next.bridgeEpoch !== undefined &&
    next.bridgeEpoch < previous.bridgeEpoch
  ) {
    return false;
  }
  return (
    next.navigationGeneration >= previous.navigationGeneration &&
    next.viewportGeneration >= previous.viewportGeneration
  );
}

export function didBrowserRuntimeRestart(previous: BrowserState, next: BrowserState): boolean {
  return Boolean(previous.runtimeId && next.runtimeId && previous.runtimeId !== next.runtimeId);
}

export interface MappedPoint {
  x: number;
  y: number;
}

export function mapDisplayedPoint(
  point: z.output<typeof displayedPointSchema>,
  viewport: Viewport,
): MappedPoint {
  if (point.x > point.width || point.y > point.height) {
    throw new Error("Pointer coordinates are outside the displayed frame");
  }
  return {
    x: Math.min(viewport.width - 1, Math.max(0, (point.x / point.width) * viewport.width)),
    y: Math.min(viewport.height - 1, Math.max(0, (point.y / point.height) * viewport.height)),
  };
}

export interface FrameSize {
  width: number;
  height: number;
}

export interface FrameRect extends FrameSize {
  x: number;
  y: number;
}

export function containedRect(container: FrameSize, image: FrameSize): FrameRect | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

/** Converts a point in the displayed image to the canonical viewport, scaling both axes by viewport.width / rect.width. */
export function toViewportPoint(
  point: MappedPoint,
  rect: FrameSize,
  viewport: Viewport,
): MappedPoint & FrameSize {
  const scale = viewport.width / rect.width;
  return {
    x: point.x * scale,
    y: Math.min(viewport.height, point.y * scale),
    width: viewport.width,
    height: viewport.height,
  };
}

type GetImageSize = (
  uri: string,
  success: (width: number, height: number) => void,
  failure: () => void,
) => void;

/** Looks up the intrinsic size once per distinct URI and drops results superseded by a newer URI. */
export function createImageSizeLoader(
  getSize: GetImageSize,
  onSize: (uri: string, size: FrameSize | null) => void,
): (uri: string) => void {
  let current: string | null = null;
  return (uri) => {
    if (uri === current) return;
    current = uri;
    getSize(
      uri,
      (width, height) => {
        if (current === uri) onSize(uri, { width, height });
      },
      () => {
        if (current === uri) onSize(uri, null);
      },
    );
  };
}
