import { describe, expect, it } from "vitest";
import { createFrameLifecycle } from "../../client/managed-browser/frame-lifecycle";
import type { BrowserFrame } from "../../shared/managed-browser/browser";

function frame(frameId: string): BrowserFrame {
  return { frameId } as BrowserFrame;
}

/** A lifecycle holding an accepted, actionable frame. */
function ready(): ReturnType<typeof createFrameLifecycle> {
  const lifecycle = createFrameLifecycle();
  expect(lifecycle.accept(lifecycle.epoch, frame("base"))).toBe(true);
  return lifecycle;
}

describe("FrameLifecycle", () => {
  it("rejects a second submission before the first settles", () => {
    const lifecycle = ready();
    expect(lifecycle.begin()).toBe(true);
    expect(lifecycle.begin()).toBe(false);
    expect(lifecycle.frame).toBeNull();
  });

  it("keeps input blocked between settlement and the fresh capture", () => {
    const lifecycle = ready();
    lifecycle.begin();
    lifecycle.settle();
    expect(lifecycle.busy).toBe(true);
    expect(lifecycle.begin()).toBe(false);
    expect(lifecycle.frame).toBeNull();

    expect(lifecycle.accept(lifecycle.epoch, frame("fresh"))).toBe(true);
    expect(lifecycle.busy).toBe(false);
    expect(lifecycle.frame?.frameId).toBe("fresh");
    expect(lifecycle.begin()).toBe(true);
  });

  it("ignores a capture started during input that completes after settlement", () => {
    const lifecycle = ready();
    lifecycle.begin();
    const lateEpoch = lifecycle.epoch;
    lifecycle.settle();

    expect(lifecycle.accept(lateEpoch, frame("late"))).toBe(false);
    expect(lifecycle.frame).toBeNull();
    expect(lifecycle.busy).toBe(true);

    expect(lifecycle.accept(lifecycle.epoch, frame("fresh"))).toBe(true);
    expect(lifecycle.frame?.frameId).toBe("fresh");
  });

  it("does not unblock input when a capture finishes mid-input", () => {
    const lifecycle = ready();
    lifecycle.begin();
    expect(lifecycle.accept(lifecycle.epoch, frame("mid"))).toBe(true);
    expect(lifecycle.busy).toBe(true);
    lifecycle.settle();
    expect(lifecycle.frame).toBeNull();
  });

  it("recovers from an error by waiting for a fresh frame, never replaying", () => {
    const lifecycle = ready();
    lifecycle.begin();
    lifecycle.settle();
    expect(lifecycle.frame).toBeNull();
    expect(lifecycle.busy).toBe(true);
    expect(lifecycle.accept(lifecycle.epoch, frame("recovered"))).toBe(true);
    expect(lifecycle.busy).toBe(false);
  });

  it("keeps the last accepted image visible while input is blocked", () => {
    const lifecycle = ready();
    lifecycle.begin();
    expect(lifecycle.visible?.frameId).toBe("base");
    lifecycle.settle();
    expect(lifecycle.visible?.frameId).toBe("base");
    lifecycle.accept(lifecycle.epoch, frame("fresh"));
    expect(lifecycle.visible?.frameId).toBe("fresh");
  });

  it("drops visible and actionable frames on session change without freeing a pending gate", () => {
    const lifecycle = ready();
    lifecycle.begin();
    lifecycle.drop();
    expect(lifecycle.visible).toBeNull();
    expect(lifecycle.busy).toBe(true);
    lifecycle.reset();
    expect(lifecycle.busy).toBe(false);
  });
});
