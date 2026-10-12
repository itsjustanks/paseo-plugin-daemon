/**
 * Platform-neutral canvas gestures. Coordinate mapping belongs to the actual
 * displayed image rectangle, not capture pixels (including sharp mobile images).
 * Touch is always genuine multi-touch on every remote preset. Mouse buttons and
 * click counts come from physical events; surrounding Paseo chrome is untouched.
 */
import type { BrowserGestureEvent } from "../../shared/managed-browser/browser";
import type { BrowserGesturePoint, BrowserTouchPoint } from "./browser-input-queue";

export interface CanvasInputOptions {
  enabled(): boolean;
  viewport(): { width: number; height: number } | null;
  enqueue(event: BrowserGestureEvent): boolean;
  finish(): void;
  cancel(): void;
  onPoint(point: BrowserGesturePoint): void;
  onActivity(active: boolean): void;
}
const MAX_SCROLL_DELTA = 4_000;

/** Preserve wheel distance by splitting oversized deltas instead of clipping it. */
function scroll(
  options: CanvasInputOptions,
  point: BrowserGesturePoint,
  deltaX: number,
  deltaY: number,
  modifiers?: number,
) {
  let remainingX = deltaX;
  let remainingY = deltaY;
  while (Math.abs(remainingX) > 0.001 || Math.abs(remainingY) > 0.001) {
    const x = Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, remainingX));
    const y = Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, remainingY));
    if (
      !options.enqueue({
        kind: "scroll",
        point,
        deltaX: x,
        deltaY: y,
        ...(modifiers === undefined ? {} : { modifiers }),
      })
    )
      return;
    remainingX -= x;
    remainingY -= y;
  }
}

/** Consume normalized real pointer/touch events with stable touch identities. */
export function createBrowserCanvasInput(options: CanvasInputOptions) {
  const mouseButtons = new Set<"left" | "right" | "middle">();
  let activeTouchIds = new Set<number>();
  let touchBlockedUntilRelease = false;

  // Quarantine cancelled held contacts until actual liftoff. A move or added
  // finger cannot invent a new press on a replacement page or controller.
  const reset = () => {
    if (activeTouchIds.size) touchBlockedUntilRelease = true;
    mouseButtons.clear();
    activeTouchIds.clear();
    options.onActivity(false);
  };
  const cancel = () => {
    reset();
    options.cancel();
  };
  const mouseMove = (point: BrowserGesturePoint, modifiers?: number) => {
    if (!options.enabled()) return false;
    options.onPoint(point);
    if (!mouseButtons.size) options.onActivity(false);
    return options.enqueue({
      kind: "move",
      point,
      ...(modifiers === undefined ? {} : { modifiers }),
    });
  };
  const mouseDown = (
    point: BrowserGesturePoint,
    button: "left" | "right" | "middle",
    clickCount: 1 | 2,
    modifiers?: number,
  ) => {
    if (!options.enabled()) return false;
    options.onPoint(point);
    const accepted = options.enqueue({
      kind: "down",
      point,
      button,
      clickCount,
      ...(modifiers === undefined ? {} : { modifiers }),
    });
    if (accepted) {
      mouseButtons.add(button);
      options.onActivity(true);
    }
    return accepted;
  };
  const mouseUp = (
    point: BrowserGesturePoint,
    button: "left" | "right" | "middle",
    clickCount: 1 | 2,
    modifiers?: number,
  ) => {
    if (!mouseButtons.has(button)) return false;
    options.onPoint(point);
    const accepted = options.enqueue({
      kind: "up",
      point,
      button,
      clickCount,
      ...(modifiers === undefined ? {} : { modifiers }),
    });
    mouseButtons.delete(button);
    if (!mouseButtons.size) {
      options.onActivity(false);
      options.finish();
    }
    return accepted;
  };
  const wheel = (
    point: BrowserGesturePoint,
    deltaX: number,
    deltaY: number,
    modifiers?: number,
  ) => {
    if (!options.enabled()) return false;
    const viewport = options.viewport();
    if (!viewport) return false;
    options.onPoint(point);
    options.onActivity(true);
    scroll(
      options,
      point,
      (deltaX * viewport.width) / point.width,
      (deltaY * viewport.height) / point.height,
      modifiers,
    );
    return true;
  };

  const touch = (phase: "start" | "move" | "end" | "cancel", points: BrowserTouchPoint[]) => {
    if (phase === "cancel") {
      cancel();
      // Native touchCancel terminates the physical contact session itself.
      touchBlockedUntilRelease = false;
      return true;
    }
    if (touchBlockedUntilRelease) {
      if (points.length === 0) touchBlockedUntilRelease = false;
      return true;
    }
    if (!activeTouchIds.size && phase !== "start") return true;
    if (!options.enabled()) {
      cancel();
      touchBlockedUntilRelease = points.length > 0;
      return false;
    }
    if (points.length > 5 || new Set(points.map((point) => point.id)).size !== points.length) {
      cancel();
      return false;
    }
    const hasNewPoint = points.some((point) => !activeTouchIds.has(point.id));
    if (hasNewPoint && phase !== "start") {
      cancel();
      return true;
    }
    const type = points.length === 0 ? "end" : hasNewPoint ? "start" : "move";
    if (points.length === 0 && activeTouchIds.size === 0) return false;
    const accepted = options.enqueue({ kind: "touch", type, points });
    if (!accepted) {
      // An unavailable decoded frame or synchronous queue failure did not admit
      // these contacts. Never let a later move invent their missing start, or
      // overwrite a reset performed by the queue's error callback.
      cancel();
      touchBlockedUntilRelease = points.length > 0;
      return false;
    }
    activeTouchIds = new Set(points.map((point) => point.id));
    options.onActivity(points.length > 0);
    if (points.length === 0) options.finish();
    if (points[0]) options.onPoint(points[0]);
    return accepted;
  };

  return {
    mouseMove,
    mouseDown,
    mouseUp,
    wheel,
    touch,
    cancel,
    reset,
    isHoldingMouse: () => mouseButtons.size > 0,
    isTouchQuarantined: () => touchBlockedUntilRelease,
    leave: () => {
      if (!mouseButtons.size && !activeTouchIds.size) {
        options.enqueue({ kind: "leave" });
        options.finish();
      }
    },
  };
}
