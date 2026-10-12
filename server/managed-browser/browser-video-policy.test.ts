import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserVideoReadInput, NativeVideoPacket } from "../../shared/managed-browser/browser-video";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";
import type { JsonValue } from "./runtime-protocol";

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disconnect();
});
function fixture(monotonicStart?: number) {
  let now = Date.parse("2026-10-03T12:00:00.000Z");
  let monotonicNow = monotonicStart ?? now;
  let token = 0;
  let generation = "1:1";
  let url = "https://fixture.invalid/";
  let wait: Promise<void> | null = null;
  let arrived = () => {};
  let failBarrier = false;
  let readStatus: "ready" | "waiting" | "unsupported" | "throw" = "ready";
  const calls: string[] = [];
  const videoInputs: unknown[] = [];
  const stateInputs: unknown[] = [];
  let metadataError: Error | null = null;
  let duringMetadata: (() => void) | null = null;
  let capacity = false;
  const packet: NativeVideoPacket & { capturedAtMonotonicMs: number } = {
    streamId: "v".repeat(32),
    captureGeneration: 1,
    sequence: 1,
    timestampUs: 1000,
    type: "key",
    codec: "vp8",
    width: 1280,
    height: 800,
    capturedAt: new Date(now).toISOString(),
    capturedAtMonotonicMs: monotonicNow,
    dataBase64: "AA==",
  };
  const client: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "r".repeat(32),
      createdAt: now,
    }),
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect() {},
    async requestWorkspace(_workspaceId, operation, params) {
      calls.push(operation);
      if (operation === "video.invalidate" && failBarrier) throw new Error("Fixture media failure");
      if (operation === "identity") return { userAgent: "Fixture" };
      if (operation === "state") {
        stateInputs.push(params);
        duringMetadata?.();
        if (metadataError) throw metadataError;
        return {
          url,
          title: "Fixture",
          inputGeneration: generation,
          canGoBack: false,
          canGoForward: false,
        };
      }
      if (operation === "video.read") {
        videoInputs.push(params);
        arrived();
        await wait;
        if (readStatus === "throw") throw new Error("Fixture startup failed");
        return {
          status: readStatus,
          ...(capacity
            ? { reasonCode: "encoder-capacity", reason: "Video encoder capacity is busy" }
            : {}),
          streamId: packet.streamId,
          inputGeneration: generation,
          packets: readStatus === "ready" ? [packet] : [],
        } as unknown as JsonValue;
      }
      return null;
    },
  };
  const manager = new SessionManager({
    client,
    validateWorkspace: async () => true,
    now: () => now,
    monotonicNow: () => monotonicNow,
    issueToken: () => `t${String(++token).padStart(32, "0")}`,
  });
  managers.push(manager);
  return {
    manager,
    packet,
    readStatus(status: typeof readStatus) {
      readStatus = status;
    },
    capacity() {
      capacity = true;
      readStatus = "unsupported";
    },
    failBarrier() {
      failBarrier = true;
    },
    calls,
    videoInputs,
    stateInputs,
    failMetadata(error: Error | null) {
      metadataError = error;
    },
    duringMetadata(callback: () => void) {
      duringMetadata = callback;
    },
    advance(ms: number) {
      now += ms;
      monotonicNow += ms;
    },
    shiftWall(ms: number) {
      now += ms;
    },
    change() {
      generation = "1:2";
      url = "https://fixture.invalid/new";
    },
    block() {
      let release!: () => void;
      wait = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      return { release, started };
    },
  };
}
function input(viewerToken: string): BrowserVideoReadInput {
  return {
    viewerToken,
    quality: "high",
    streamId: null,
    afterSequence: 0,
    waitMs: 250,
    requestKeyFrame: true,
  };
}

describe("video authority", () => {
  it("reconciles external document changes without a JPEG/status request and discards the transition batch", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const reads = f.calls.filter((call) => call === "state").length;
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("ready");
    expect(f.calls.filter((call) => call === "state")).toHaveLength(reads);
    f.change();
    const transition = await f.manager.readVideo(input(a.viewerToken));
    expect(transition.status).toBe("reset");
    expect(transition.packets).toEqual([]);
    expect(transition.state.url).toBe("https://fixture.invalid/new");
    expect(transition.state.navigationGeneration).toBeGreaterThan(a.state.navigationGeneration);
    expect(f.stateInputs.at(-1)).toEqual({ timeoutMs: 3000 });
    const next = await f.manager.readVideo(input(a.viewerToken));
    expect(next.status).toBe("ready");
    expect(next.state.navigationGeneration).toBe(transition.state.navigationGeneration);
    expect(next.packets[0]!.frame.navigationGeneration).toBe(transition.state.navigationGeneration);
    expect(f.calls.filter((call) => call === "state")).toHaveLength(reads + 1);
  });

  it("keeps failed mismatch reconciliation visibly unavailable and retries no native input", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.change();
    f.failMetadata(new Error("Bounded metadata observation timed out"));
    const failed = await f.manager.readVideo(input(a.viewerToken));
    expect(failed.status).toBe("reset");
    expect(failed.packets).toEqual([]);
    expect(failed.state.status).toBe("error");
    expect(failed.state.url).toBe(a.state.url);
    expect(failed.state.error).toContain("timed out");
    f.failMetadata(null);
    const recovered = await f.manager.readVideo(input(a.viewerToken));
    expect(recovered.status).toBe("reset");
    expect(recovered.packets).toEqual([]);
    expect(recovered.state.status).toBe("ready");
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("ready");
    expect(f.calls).not.toContain("mouse.down");
  });

  it("does not revive an expired viewer while reconciling a native generation mismatch", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.change();
    f.duringMetadata(() => f.advance(46_000));
    await expect(f.manager.readVideo(input(a.viewerToken))).rejects.toThrow("Viewer token");
  });

  it("keeps ordinary admitted click and end replies metadata-free while video continues", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const { controlToken } = await f.manager.acquireControl(a.viewerToken);
    const first = await f.manager.readVideo(input(a.viewerToken));
    const frame = first.packets[0]!.frame;
    const expected = {
      sessionId: first.state.sessionId,
      runtimeId: first.state.runtimeId!,
      bridgeEpoch: first.state.bridgeEpoch!,
      navigationGeneration: first.state.navigationGeneration,
      viewportGeneration: first.state.viewportGeneration,
    };
    const target = {
      frameId: frame.frameId,
      navigationGeneration: frame.navigationGeneration,
      viewportGeneration: frame.viewportGeneration,
    };
    const context = { viewerToken: a.viewerToken, controlToken, expected };
    const preflightReads = f.stateInputs.length;
    const begin = await f.manager.beginGesture({ ...context, target, pointerKind: "mouse" });
    if (!("gestureId" in begin)) throw new Error("Fixture expected admitted input");
    expect(f.stateInputs).toHaveLength(preflightReads + 1);
    const reads = f.stateInputs.length;
    // A target metadata failure must not enter the hot acknowledgement path.
    // The native input.check observations still fence every published edge.
    f.failMetadata(new Error("Target metadata would be blocked"));
    const point = { x: 20, y: 20, width: 1280, height: 800 };
    const down = await f.manager.updateGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 1,
      target,
      event: { kind: "down", point, button: "left", clickCount: 1 },
    });
    expect(down.state.status).toBe("ready");
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("ready");
    await f.manager.updateGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 2,
      event: { kind: "up", point, button: "left", clickCount: 1 },
    });
    const end = await f.manager.endGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 3,
      cancel: false,
    });
    expect(end.state.status).toBe("ready");
    expect(f.stateInputs).toHaveLength(reads);
    expect(f.calls.filter((call) => call === "mouse.down")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "mouse.up")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "input.end")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "input.check").length).toBeGreaterThanOrEqual(9);
    expect(f.calls).not.toContain("video.invalidate");
  });

  it("deduplicates an exact source receipt across viewers without pretending it is a JPEG", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const b = await f.manager.attach("workspace", "B");
    const first = await f.manager.readVideo(input(a.viewerToken));
    const second = await f.manager.readVideo(input(b.viewerToken));
    expect(first.packets[0]!.frame.frameId).toBe(second.packets[0]!.frame.frameId);
    expect(first.packets[0]!.frame).not.toHaveProperty("mimeType");
    expect(first.packets[0]!.frame.capturedAt).toBe(f.packet.capturedAt);
  });
  it("leaves status and detach available while a native read waits", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const block = f.block();
    const pending = f.manager.readVideo(input(a.viewerToken));
    await block.started;
    await f.manager.status(a.viewerToken);
    await f.manager.detach(a.viewerToken);
    block.release();
    await expect(pending).rejects.toThrow("Viewer token");
  });
  it("bounds one pending read per viewer and permits another viewer", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const b = await f.manager.attach("workspace", "B");
    const block = f.block();
    const pending = f.manager.readVideo(input(a.viewerToken));
    await block.started;
    await expect(f.manager.readVideo(input(a.viewerToken))).rejects.toThrow("already pending");
    const other = f.manager.readVideo(input(b.viewerToken));
    block.release();
    expect((await pending).status).toBe("ready");
    expect((await other).status).toBe("ready");
  });
  it("returns no old pixels across a document change during a read", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const block = f.block();
    const pending = f.manager.readVideo(input(a.viewerToken));
    await block.started;
    f.change();
    block.release();
    expect((await pending).packets).toEqual([]);
  });
  it("cannot reissue pre-action pixels from a reply held across a settled command", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const control = await f.manager.acquireControl(a.viewerToken);
    const initial = await f.manager.readVideo(input(a.viewerToken));
    const authority = initial.packets[0]!.frame;
    const block = f.block();
    const pending = f.manager.readVideo({ ...input(a.viewerToken), requestKeyFrame: false });
    await block.started;
    await f.manager.sendInput({
      viewerToken: a.viewerToken,
      controlToken: control.controlToken,
      expected: {
        sessionId: initial.state.sessionId,
        navigationGeneration: initial.state.navigationGeneration,
        viewportGeneration: initial.state.viewportGeneration,
      },
      target: {
        frameId: authority.frameId,
        navigationGeneration: authority.navigationGeneration,
        viewportGeneration: authority.viewportGeneration,
      },
      event: { kind: "type", text: "owned fixture" },
    });
    block.release();
    const late = await pending;
    expect(late.status).toBe("reset");
    expect(late.packets).toEqual([]);
  });
  it("preserves an accepted input outcome if media fails and still fences later old packets", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const control = await f.manager.acquireControl(a.viewerToken);
    const initial = await f.manager.readVideo(input(a.viewerToken));
    const authority = initial.packets[0]!.frame;
    f.advance(1);
    f.failBarrier();
    await expect(
      f.manager.sendInput({
        viewerToken: a.viewerToken,
        controlToken: control.controlToken,
        expected: {
          sessionId: initial.state.sessionId,
          navigationGeneration: initial.state.navigationGeneration,
          viewportGeneration: initial.state.viewportGeneration,
        },
        target: {
          frameId: authority.frameId,
          navigationGeneration: authority.navigationGeneration,
          viewportGeneration: authority.viewportGeneration,
        },
        event: { kind: "type", text: "owned fixture" },
      }),
    ).resolves.toHaveProperty("state");
    expect((await f.manager.readVideo(input(a.viewerToken))).packets).toEqual([]);
  });
  it("refuses old source receipts and wrong native dimensions", async () => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.advance(1001);
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("reset");
    f.packet.capturedAt = new Date(Date.parse(f.packet.capturedAt) + 1001).toISOString();
    f.packet.capturedAtMonotonicMs += 1001;
    f.packet.width = 400;
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("reset");
  });
  it("refuses malformed payloads and accepts no media without a viewer", async () => {
    const f = fixture();
    await expect(f.manager.readVideo(input("x".repeat(32)))).rejects.toThrow("Viewer token");
    const a = await f.manager.attach("workspace", "A");
    f.packet.codec = "";
    await expect(f.manager.readVideo(input(a.viewerToken))).rejects.toThrow("invalid video packet");
  });
});

it.each(["waiting", "unsupported", "throw"] as const)(
  "stops capture on final detach after a %s read without receipts",
  async (status) => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.readStatus(status);
    await f.manager.readVideo(input(a.viewerToken)).catch(() => undefined);
    await f.manager.detach(a.viewerToken);
    expect(f.calls.filter((call) => call === "video.stop")).toHaveLength(1);
  },
);

it("stops failed capture when the last viewer expires without a detach request", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.readStatus("unsupported");
    await f.manager.readVideo(input(a.viewerToken));
    f.advance(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls.filter((call) => call === "video.stop")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps capture when a viewer renews its lease and cancels expiry on reset", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.readStatus("unsupported");
    await f.manager.readVideo(input(a.viewerToken));
    f.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await f.manager.status(a.viewerToken);
    f.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.calls).not.toContain("video.stop");
    f.manager.reset();
    f.advance(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls).not.toContain("video.stop");
  } finally {
    vi.useRealTimers();
  }
});

it("forwards independent bounded video settings while retaining viewer/frame authority", async () => {
  const f = fixture();
  const viewer = await f.manager.attach("workspace", "Viewer");
  await f.manager.readVideo({ ...input(viewer.viewerToken), bitrate: 24_000_000, fps: 60 });
  expect(f.videoInputs).toEqual([expect.objectContaining({ bitrate: 24_000_000, fps: 60 })]);
});

it("preserves the typed capacity fallback without issuing mutation packets", async () => {
  const f = fixture();
  const attached = await f.manager.attach("workspace", "A");
  f.capacity();
  const reply = await f.manager.readVideo(input(attached.viewerToken));
  expect(reply.status).toBe("unsupported");
  expect(reply.reasonCode).toBe("encoder-capacity");
  expect(reply.packets).toEqual([]);
  expect(f.calls.some((call) => call.startsWith("input."))).toBe(false);
});

it.each([-10_000, 10_000])(
  "keeps fresh video admissible across a %i ms wall-clock correction",
  async (jump) => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    f.shiftWall(jump);
    const reply = await f.manager.readVideo(input(a.viewerToken));
    expect(reply.status).toBe("ready");
    expect(reply.packets).toHaveLength(1);
    expect(reply.packets[0]).not.toHaveProperty("capturedAtMonotonicMs");
    f.advance(1001);
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("reset");
  },
);

it.each([-10_000, 10_000])(
  "preserves the post-action video fence across a %i ms wall-clock correction",
  async (jump) => {
    const f = fixture();
    const a = await f.manager.attach("workspace", "A");
    const control = await f.manager.acquireControl(a.viewerToken);
    const initial = await f.manager.readVideo(input(a.viewerToken));
    const frame = initial.packets[0]!.frame;
    f.advance(1);
    await f.manager.sendInput({
      viewerToken: a.viewerToken,
      controlToken: control.controlToken,
      expected: initial.state,
      target: frame,
      event: { kind: "type", text: "owned fixture" },
    });
    f.shiftWall(jump);
    // Even an apparently new wall timestamp cannot promote pre-action pixels.
    f.packet.capturedAt = new Date(Date.parse(f.packet.capturedAt) + jump + 1).toISOString();
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("reset");
    f.advance(100);
    f.packet.capturedAtMonotonicMs += 101;
    f.packet.timestampUs += 101_000;
    f.packet.sequence += 1;
    expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("ready");
  },
);

it.each([-10_000, 0, 10_000])(
  "cannot restore pre-gesture input authority across a %i ms wall correction, including a zero elapsed fence",
  async (jump) => {
    const f = fixture(0);
    const a = await f.manager.attach("workspace", "A");
    const { controlToken } = await f.manager.acquireControl(a.viewerToken);
    const initial = await f.manager.readVideo(input(a.viewerToken));
    const target = initial.packets[0]!.frame;
    const context = {
      viewerToken: a.viewerToken,
      controlToken,
      expected: {
        ...initial.state,
        runtimeId: initial.state.runtimeId!,
        bridgeEpoch: initial.state.bridgeEpoch!,
      },
    };
    const begin = await f.manager.beginGesture({ ...context, target, pointerKind: "touch" });
    if (!("gestureId" in begin)) throw new Error("Fixture input was not admitted");
    const point = { x: 20, y: 20, width: 1280, height: 800 };
    await f.manager.updateGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 1,
      target,
      event: { kind: "touch", type: "start", points: [{ ...point, id: 0 }] },
    });
    await f.manager.updateGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 2,
      event: { kind: "touch", type: "end", points: [] },
    });
    await f.manager.endGesture({
      ...context,
      gestureId: begin.gestureId,
      sequence: 3,
      cancel: false,
    });
    f.shiftWall(jump);
    // Re-reading the original receipt can display it, but cannot re-arm a discrete press.
    const old = await f.manager.readVideo(input(a.viewerToken));
    expect(old.status).toBe("ready");
    expect(old.packets[0]!.frame.frameId).toBe(target.frameId);
    await expect(
      f.manager.sendInput({ ...context, target, event: { kind: "type", text: "old pixels" } }),
    ).rejects.toThrow("frame is stale");
    f.advance(100);
    f.packet.capturedAtMonotonicMs = 100;
    f.packet.sequence++;
    f.packet.timestampUs += 100_000;
    const fresh = await f.manager.readVideo(input(a.viewerToken));
    await expect(
      f.manager.sendInput({
        ...context,
        target: fresh.packets[0]!.frame,
        event: { kind: "type", text: "fresh pixels" },
      }),
    ).resolves.toHaveProperty("state");
  },
);

it("fails closed when private native timing is missing", async () => {
  const f = fixture();
  const a = await f.manager.attach("workspace", "A");
  Reflect.deleteProperty(f.packet, "capturedAtMonotonicMs");
  await expect(f.manager.readVideo(input(a.viewerToken))).rejects.toThrow("invalid video packet");
});

it("rejects future native time and refuses to re-stamp an existing receipt", async () => {
  const f = fixture(0);
  const a = await f.manager.attach("workspace", "A");
  f.packet.capturedAtMonotonicMs = 51;
  expect((await f.manager.readVideo(input(a.viewerToken))).status).toBe("reset");
  f.packet.capturedAtMonotonicMs = 50;
  const reply = await f.manager.readVideo(input(a.viewerToken));
  expect(reply.status).toBe("ready");
  expect(reply.packets[0]!.frame).not.toHaveProperty("capturedAtMonotonicMs");
  f.advance(1);
  f.packet.capturedAtMonotonicMs = 51;
  await expect(f.manager.readVideo(input(a.viewerToken))).rejects.toThrow("receipt timestamp");
});
