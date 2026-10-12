/**
 * One ordered live input channel, anchored to a decoded frame by browser-policy.
 * Owns only bounded gesture state/coordinates. The host supplies serialized
 * authority checks and transport cleanup; this module never grants a lease.
 */
import type { BrowserGestureEvent, Viewport } from "../../shared/managed-browser/browser";
import { MAX_HELD_BROWSER_KEYS, mapDisplayedPoint } from "../../shared/managed-browser/browser";

export const GESTURE_IDLE_MS = 5_000;
export const GESTURE_LIFETIME_MS = 5 * 60_000;

export class BrowserGesture {
  nextSequence = 1;
  idleUntil: number;
  readonly expiresAt: number;
  readonly buttons = new Set<string>();
  readonly touches = new Set<number>();
  readonly keys = new Set<string>();
  private display: { width: number; height: number } | null = null;
  timer: NodeJS.Timeout | null = null;
  lastPoint: { x: number; y: number } | null = null;

  constructor(
    readonly id: string,
    readonly viewerToken: string,
    readonly controlToken: string,
    readonly pointerKind: "mouse" | "touch",
    readonly expected: {
      sessionId: string;
      runtimeId: string;
      bridgeEpoch: number;
      navigationGeneration: number;
      viewportGeneration: number;
    },
    readonly viewport: Viewport,
    now: number,
    readonly runtimeInputGeneration: string | null = null,
  ) {
    this.idleUntil = now + GESTURE_IDLE_MS;
    this.expiresAt = now + GESTURE_LIFETIME_MS;
  }

  /** Reject dropped/replayed packets and expire even if a delayed queue resumes later. */
  assertSequence(sequence: number, now: number): void {
    if (sequence !== this.nextSequence) throw new Error("Browser gesture sequence is stale");
    if (now >= this.idleUntil || now >= this.expiresAt) throw new Error("Browser gesture expired");
  }

  /** Pin displayed geometry on first point; a mid-gesture local layout change must cancel. */
  mapPoint(point: { x: number; y: number; width: number; height: number }) {
    if (!this.display) this.display = { width: point.width, height: point.height };
    if (this.display.width !== point.width || this.display.height !== point.height) {
      throw new Error("Browser gesture display geometry changed");
    }
    const mapped = mapDisplayedPoint(point, this.viewport);
    this.lastPoint = mapped;
    return mapped;
  }

  /** Validate edges before publication. Continuation never invents a missing button/touch start. */
  validate(event: BrowserGestureEvent): void {
    if (event.kind === "leave" && this.buttons.size > 0)
      throw new Error("Release held mouse buttons before leaving");
    if (event.kind === "key") {
      if (event.type === "down" && this.keys.has(event.code) !== event.repeat) {
        throw new Error(
          event.repeat ? "Key repeat has no matching press" : "Key is already pressed",
        );
      }
      if (event.type === "up" && !this.keys.has(event.code)) {
        throw new Error("Key release has no matching press");
      }
      if (
        event.type === "down" &&
        !this.keys.has(event.code) &&
        this.keys.size >= MAX_HELD_BROWSER_KEYS
      ) {
        throw new Error("Too many simultaneously held browser keys");
      }
      return;
    }
    if (event.kind === "text") return;
    if ((event.kind === "touch") !== (this.pointerKind === "touch"))
      throw new Error("Browser gesture pointer kind changed");
    if (event.kind === "down" && this.buttons.has(event.button))
      throw new Error("Mouse button is already pressed");
    if (event.kind === "up" && !this.buttons.has(event.button))
      throw new Error("Mouse button is not pressed");
    if (event.kind === "touch") {
      if (
        event.type === "move" &&
        (this.touches.size === 0 || event.points.some((point) => !this.touches.has(point.id)))
      ) {
        throw new Error("Touch move has no matching start");
      }
      if (event.type === "start" && event.points.every((point) => this.touches.has(point.id))) {
        throw new Error("Touch start must add a touch identifier");
      }
    }
  }

  /** Commit the acknowledged edge, preserving explicitly released touch IDs. */
  acknowledge(event: BrowserGestureEvent, now: number): void {
    if (event.kind === "key" && event.type === "down") this.keys.add(event.code);
    if (event.kind === "key" && event.type === "up") this.keys.delete(event.code);
    if (event.kind === "down") this.buttons.add(event.button);
    if (event.kind === "up") this.buttons.delete(event.button);
    if (event.kind === "touch") {
      this.touches.clear();
      for (const point of event.points) this.touches.add(point.id);
    }
    this.nextSequence += 1;
    this.idleUntil = now + GESTURE_IDLE_MS;
  }

  /** Only an unpressed mouse move leaves existing bounded frame authority usable for a new press. */
  isHover(event: BrowserGestureEvent): boolean {
    return (event.kind === "move" || event.kind === "leave") && this.buttons.size === 0;
  }
}
