import { describe, expect, it } from "vitest";
import {
  type BrowserFrameBuffer,
  createBrowserFrameBuffer,
  type FrameCandidate,
} from "./browser-frame-buffer";

function candidate(id: string, pixels = id, generation = 0): FrameCandidate {
  return {
    viewerToken: "viewer-a",
    mutationEpoch: 0,
    frame: {
      sessionId: "session-a",
      frameId: id,
      mimeType: "image/jpeg",
      transport: "screenshot",
      dataBase64: pixels,
      byteLength: pixels.length,
      width: 1280,
      height: 800,
      navigationGeneration: generation,
      viewportGeneration: 0,
      runtimeId: "runtime-a",
      capturedAt: "2026-10-02T12:00:00.000Z",
    },
  };
}
function pendingTicket(buffer: BrowserFrameBuffer): number {
  const state = buffer.snapshot();
  if (state.pending === null) throw new Error("No pending decoder");
  return state.layers[state.pending]!.ticket;
}
function visible(buffer: BrowserFrameBuffer) {
  const state = buffer.snapshot();
  return state.front === null ? null : state.layers[state.front];
}
function decodeFirst(buffer: BrowserFrameBuffer) {
  buffer.offer(candidate("front"));
  buffer.settle(pendingTicket(buffer), true, () => true);
}

describe("decoded Shared Browser frame handoff", () => {
  it("keeps initial capture hidden until successful decode, then retains it during replacement", () => {
    const buffer = createBrowserFrameBuffer();
    buffer.offer(candidate("front"));
    expect(visible(buffer)).toBeNull();
    buffer.settle(pendingTicket(buffer), true, () => true);
    const original = visible(buffer);
    buffer.offer(candidate("next"));
    expect(visible(buffer)).toBe(original);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("front");
    buffer.settle(pendingTicket(buffer), true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("next");
  });

  it("retains the decoded front and input frame after a failed replacement", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    const original = visible(buffer);
    buffer.offer(candidate("failed"));
    buffer.settle(pendingTicket(buffer), false, () => true);
    expect(visible(buffer)).toBe(original);
    expect(buffer.snapshot().imageError).toBe(false);
    buffer.offer(candidate("retry"));
    buffer.settle(pendingTicket(buffer), true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("retry");
  });

  it("shows the established initial error only when no decoded front exists", () => {
    const buffer = createBrowserFrameBuffer();
    buffer.offer(candidate("bad-first"));
    buffer.settle(pendingTicket(buffer), false, () => true);
    expect(buffer.snapshot().imageError).toBe(true);
    expect(visible(buffer)).toBeNull();
  });

  it("advances identical-pixel frame authority without replacing its decoded source", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    const source = visible(buffer)?.source;
    const ticket = visible(buffer)?.ticket;
    buffer.offer(candidate("new-authority", "front", 1));
    expect(visible(buffer)?.candidate.frame.frameId).toBe("new-authority");
    expect(visible(buffer)?.candidate.frame.navigationGeneration).toBe(1);
    expect(visible(buffer)?.source).toBe(source);
    expect(visible(buffer)?.ticket).toBe(ticket);
    expect(buffer.snapshot().pending).toBeNull();
  });

  it("coalesces fast captures without cancelling the slow decoder or accumulating images", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    buffer.offer(candidate("slow"));
    const ticket = pendingTicket(buffer);
    for (let i = 0; i < 100; i++) buffer.offer(candidate(`queued-${i}`));
    expect(pendingTicket(buffer)).toBe(ticket);
    expect(buffer.snapshot().layers.filter(Boolean)).toHaveLength(2);
    expect(buffer.snapshot().queued?.frame.frameId).toBe("queued-99");
    buffer.settle(ticket, true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("slow");
    buffer.settle(pendingTicket(buffer), true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("queued-99");
  });

  it("ignores late callbacks when the same native slot was reused for a newer generation", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    buffer.offer(candidate("obsolete"));
    const oldTicket = pendingTicket(buffer);
    buffer.invalidatePending();
    buffer.offer(candidate("current", "current", 1));
    const newTicket = pendingTicket(buffer);
    buffer.settle(oldTicket, true, () => true);
    buffer.settle(oldTicket, false, () => true);
    expect(pendingTicket(buffer)).toBe(newTicket);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("front");
    buffer.settle(newTicket, true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("current");
  });

  it("never promotes a decoded frame whose viewer/runtime/generation authority expired", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    buffer.offer(candidate("obsolete"));
    buffer.offer({ ...candidate("fresh"), viewerToken: "viewer-b" });
    const isCurrent = (item: FrameCandidate) => item.viewerToken === "viewer-b";
    buffer.settle(pendingTicket(buffer), true, isCurrent);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("front");
    buffer.settle(pendingTicket(buffer), true, isCurrent);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("fresh");
  });

  it("clears workspace pixels and prevents ticket replay after reset", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    buffer.offer(candidate("old-workspace"));
    const oldTicket = pendingTicket(buffer);
    buffer.reset();
    expect(visible(buffer)).toBeNull();
    buffer.offer(candidate("new-workspace"));
    const fresh = buffer.snapshot();
    buffer.settle(oldTicket, true, () => true);
    expect(buffer.snapshot()).toBe(fresh);
    buffer.settle(pendingTicket(buffer), true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("new-workspace");
  });

  it("a freshest capture identical to the front cancels obsolete pending promotion", () => {
    const buffer = createBrowserFrameBuffer();
    decodeFirst(buffer);
    buffer.offer(candidate("transient"));
    const oldTicket = pendingTicket(buffer);
    buffer.offer(candidate("back-to-front", "front"));
    buffer.settle(oldTicket, true, () => true);
    expect(visible(buffer)?.candidate.frame.frameId).toBe("back-to-front");
  });
});
