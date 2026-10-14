/**
 * Web-only input and video adapters for the native View's DOM host node. No DOM globals or
 * handlers leak into the cross-platform panel. Non-passive wheel/touch listeners
 * capture only a controlled image canvas; document mouse listeners preserve drags outside
 * its rectangle and visibility/blur immediately cancels held remote input.
 */
import { Platform } from "react-native";
import type { BrowserCursor } from "../../shared/managed-browser/browser";
import type { createBrowserCanvasInput } from "./browser-canvas-input";

type CanvasInput = ReturnType<typeof createBrowserCanvasInput>;
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface DomTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}
interface DomEvent {
  clientX?: number;
  clientY?: number;
  button?: number;
  detail?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  touches?: ArrayLike<DomTouch>;
  sourceCapabilities?: { firesTouchEvents?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
}
export interface BrowserCanvasNode {
  getBoundingClientRect(): Rect;
  addEventListener(
    type: string,
    listener: (event: DomEvent) => void,
    options?: { passive: boolean },
  ): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void): void;
  style: { cursor: string; touchAction: string };
  ownerDocument: {
    hidden: boolean;
    addEventListener(
      type: string,
      listener: (event: DomEvent) => void,
      options?: { passive?: boolean; capture?: boolean },
    ): void;
    removeEventListener(
      type: string,
      listener: (event: DomEvent) => void,
      options?: { capture?: boolean },
    ): void;
    defaultView: {
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    } | null;
  };
}

/** Bind real web envelopes only on web; native touch uses the responder adapter. */
export function bindBrowserCanvasWeb(
  node: BrowserCanvasNode,
  input: CanvasInput,
  enabled: () => boolean,
  onCursorVisibility: (visible: boolean) => void,
) {
  if (Platform.OS !== "web") return () => {};
  const previousTouchAction = node.style.touchAction;
  node.style.touchAction = "none";
  const listeners = new Map<string, (event: DomEvent) => void>();
  const point = (x = 0, y = 0) => {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(rect.width, x - rect.left)),
      y: Math.max(0, Math.min(rect.height, y - rect.top)),
      width: rect.width,
      height: rect.height,
    };
  };
  const listen = (type: string, listener: (event: DomEvent) => void) => {
    listeners.set(type, listener);
    node.addEventListener(type, listener, { passive: false });
  };
  const consume = (event: DomEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // Snapshot actual pointer modifiers even when the key was pressed before
  // this canvas acquired focus. Do not fabricate remote keyboard edges.
  const modifiers = (event: DomEvent) =>
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0);
  let touchActive = false;
  const mouse = (type: "move" | "down" | "up", event: DomEvent) => {
    // Consumed touch events suppress compatibility mouse events in browsers.
    // Chromium also explicitly identifies them; never forward a second tap.
    if (touchActive || event.sourceCapabilities?.firesTouchEvents || !enabled()) {
      return;
    }
    const location = point(event.clientX, event.clientY);
    if (!location) return;
    onCursorVisibility(true);
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    const count = event.detail === 2 ? 2 : 1;
    if (type === "down") {
      if (input.mouseDown(location, button, count, modifiers(event))) consume(event);
    } else if (type === "up") {
      if (input.mouseUp(location, button, count, modifiers(event))) consume(event);
    } else {
      const held = input.isHoldingMouse();
      input.mouseMove(location, modifiers(event));
      if (held) consume(event);
    }
  };
  // MouseEvent.detail carries physical double-click counts. PointerEvent.detail
  // commonly stays zero. Only mouse events publish input, avoiding duplicate edges.
  listen("mousedown", (event) => mouse("down", event));
  listen("mousemove", (event) => mouse("move", event));
  listen("mouseup", (event) => mouse("up", event));
  listen("mouseleave", () => {
    onCursorVisibility(false);
    input.leave();
    node.style.cursor = "default";
  });
  listen("pointercancel", () => input.cancel());
  const isOutside = (event: DomEvent) => {
    const rect = node.getBoundingClientRect();
    return (
      event.clientX === undefined ||
      event.clientY === undefined ||
      event.clientX < rect.left ||
      event.clientX > rect.left + rect.width ||
      event.clientY < rect.top ||
      event.clientY > rect.top + rect.height
    );
  };
  const outsideMove = (event: DomEvent) => {
    if (input.isHoldingMouse()) {
      mouse("move", event);
      onCursorVisibility(!isOutside(event));
    }
  };
  const outsideUp = (event: DomEvent) => {
    if (input.isHoldingMouse()) {
      mouse("up", event);
      const outside = isOutside(event);
      onCursorVisibility(!outside);
      if (outside) input.leave();
    }
  };
  node.ownerDocument.addEventListener("mousemove", outsideMove);
  node.ownerDocument.addEventListener("mouseup", outsideUp);
  listen("contextmenu", (event) => {
    if (enabled()) consume(event);
  });
  listen("wheel", (event) => {
    if (!enabled()) return;
    const location = point(event.clientX, event.clientY);
    if (!location) return;
    // Wheel deltaMode is local CSS pixels, lines, or pages. Line-mode uses the
    // browser's conventional 16 CSS-pixel step; page mode uses this image's size.
    const multiplierX = event.deltaMode === 2 ? location.width : event.deltaMode === 1 ? 16 : 1;
    const multiplierY = event.deltaMode === 2 ? location.height : event.deltaMode === 1 ? 16 : 1;
    if (
      input.wheel(
        location,
        (event.deltaX ?? 0) * multiplierX,
        (event.deltaY ?? 0) * multiplierY,
        modifiers(event),
      )
    ) {
      consume(event);
    }
  });
  const documentTouchListeners = new Map<string, (event: DomEvent) => void>();
  for (const phase of ["start", "move", "end", "cancel"] as const) {
    // An observe-only overlay has pointerEvents:none. Track only contacts that
    // start over its image (without consuming them), so acquiring control mid-
    // contact cannot turn a later move/second finger into a remote fresh press.
    const trackUncontrolledContact = (event: DomEvent) => {
      const rect = node.getBoundingClientRect();
      const touches = Array.from(event.touches ?? []);
      const overImage = touches.some(
        (touch) =>
          touch.clientX >= rect.left &&
          touch.clientX <= rect.left + rect.width &&
          touch.clientY >= rect.top &&
          touch.clientY <= rect.top + rect.height,
      );
      if (input.isTouchQuarantined() || (!enabled() && overImage)) {
        const points = touches
          .map((touch) => {
            const location = point(touch.clientX, touch.clientY);
            return location ? { ...location, id: touch.identifier } : null;
          })
          .filter((item) => item !== null);
        input.touch(phase, points);
      }
    };
    documentTouchListeners.set(`touch${phase}`, trackUncontrolledContact);
    node.ownerDocument.addEventListener(`touch${phase}`, trackUncontrolledContact, {
      capture: true,
      passive: true,
    });
    listen(`touch${phase}`, (event) => {
      touchActive = phase !== "cancel" && (event.touches?.length ?? 0) > 0;
      const points = Array.from(event.touches ?? []).map((touch) => {
        const location = point(touch.clientX, touch.clientY);
        return location ? { ...location, id: touch.identifier } : null;
      });
      if (points.some((item) => !item)) {
        input.cancel();
        return;
      }
      const accepted = input.touch(
        phase,
        points.filter((item) => item !== null),
      );
      if (accepted && enabled()) {
        consume(event);
      }
    });
  }
  const cancel = () => {
    onCursorVisibility(false);
    touchActive = false;
    input.cancel();
    node.style.cursor = "default";
  };
  const visibility = () => {
    if (node.ownerDocument.hidden) cancel();
  };
  node.ownerDocument.addEventListener("visibilitychange", visibility);
  node.ownerDocument.defaultView?.addEventListener("blur", cancel);
  return () => {
    cancel();
    for (const [type, listener] of listeners) {
      node.removeEventListener(type, listener);
    }
    for (const [type, listener] of documentTouchListeners) {
      node.ownerDocument.removeEventListener(type, listener, { capture: true });
    }
    node.ownerDocument.removeEventListener("visibilitychange", visibility);
    node.ownerDocument.removeEventListener("mousemove", outsideMove);
    node.ownerDocument.removeEventListener("mouseup", outsideUp);
    node.ownerDocument.defaultView?.removeEventListener("blur", cancel);
    node.style.touchAction = previousTouchAction;
  };
}

/** Cursor enums originate from the guarded remote response, never custom URLs. */
export function setBrowserCanvasCursor(node: unknown, cursor: BrowserCursor | null): void {
  if (Platform.OS === "web" && node && typeof node === "object" && "style" in node) {
    (node as BrowserCanvasNode).style.cursor = cursor ?? "default";
  }
}

/** Public web codec boundary. Native clients never read browser constructors. */
export function supportsBrowserVideo(): boolean {
  if (Platform.OS !== "web") return false;
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

declare const VideoDecoder: {
  new (callbacks: {
    output(frame: import("./browser-video-decoder").DecodedBrowserVideoFrame): void;
    error(error: unknown): void;
  }): import("./browser-video-decoder").BrowserVideoCodec & {
    addEventListener(type: "dequeue", listener: () => void): void;
  };
};
declare const EncodedVideoChunk: {
  new (input: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): unknown;
};
declare function atob(data: string): string;

interface VideoCanvasElement {
  width: number;
  height: number;
  style: { width: string; height: string; display: string };
  getContext(kind: "2d"): {
    drawImage(frame: unknown, x: number, y: number): void;
  } | null;
  remove(): void;
}
export interface BrowserVideoCanvasNode {
  getClientRects(): ArrayLike<unknown>;
  appendChild(child: VideoCanvasElement): void;
  ownerDocument: {
    createElement(kind: "canvas"): VideoCanvasElement;
    hidden?: boolean;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    defaultView: {
      IntersectionObserver: new (
        callback: (entries: { isIntersecting: boolean }[]) => void,
      ) => {
        observe(node: BrowserVideoCanvasNode): void;
        disconnect(): void;
      };
      requestAnimationFrame(callback: () => void): number;
      cancelAnimationFrame(id: number): void;
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    } | null;
  };
}

/** Decode validated packet bytes without a per-character callback or intermediate
 * binary string on modern clients. Older web clients retain an exact byte loop.
 * This web adapter is never evaluated as a native phone video implementation. */
export function decodeBrowserVideoBytes(data: string): Uint8Array {
  const bytes = Uint8Array as typeof Uint8Array & { fromBase64?(value: string): Uint8Array };
  if (typeof bytes.fromBase64 === "function") return bytes.fromBase64(data);

  const binary = atob(data);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

/** Create one retained canvas; every decoded VideoFrame is drawn before its authority is admitted. */
export function createBrowserVideoEnvironment(node: BrowserVideoCanvasNode) {
  if (!supportsBrowserVideo()) return null;
  const canvas = node.ownerDocument.createElement("canvas");
  const context = canvas.getContext("2d");
  const view = node.ownerDocument.defaultView;
  if (!context || !view) return null;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  node.appendChild(canvas);
  const environment: import("./browser-video-decoder").BrowserVideoDecodeEnvironment = {
    createDecoder(callbacks) {
      const decoder = new VideoDecoder(callbacks);
      decoder.addEventListener("dequeue", callbacks.dequeue);
      return decoder;
    },
    createChunk: (input) => new EncodedVideoChunk(input),
    decodeBase64(data) {
      return decodeBrowserVideoBytes(data);
    },
    scheduleDraw(draw) {
      const id = view.requestAnimationFrame(draw);
      return () => view.cancelAnimationFrame(id);
    },
    draw(frame) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      context.drawImage(frame, 0, 0);
    },
  };
  return { environment, dispose: () => canvas.remove() };
}

/** Observe the actual canvas document, including page-cache suspension. The
 * initial callback is synchronous; cleanup never synthesizes a resume. */
export function bindBrowserVideoVisibility(
  node: BrowserVideoCanvasNode,
  onActive: (active: boolean) => void,
) {
  const document = node.ownerDocument;
  const view = document.defaultView;
  let suspended = false;
  let intersecting = node.getClientRects().length > 0;
  const changed = () => onActive(!document.hidden && !suspended && intersecting);
  const observer = view
    ? new view.IntersectionObserver((entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting);
        changed();
      })
    : null;
  observer?.observe(node);
  const hide = () => {
    suspended = true;
    changed();
  };
  const show = () => {
    suspended = false;
    changed();
  };
  document.addEventListener("visibilitychange", changed);
  view?.addEventListener("pagehide", hide);
  view?.addEventListener("pageshow", show);
  changed();
  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", changed);
    view?.removeEventListener("pagehide", hide);
    view?.removeEventListener("pageshow", show);
  };
}
