/** Exercise the actual trusted helper program's producer bounds without a fake duplicate policy. */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

it("oversize closes only that encoder, and repeated source frames cannot restart expensive keys", async () => {
  const packets: { error?: string; streamId?: string }[] = [];
  const encoders: { configuration: { bitrate: number }; calls: number; closed: boolean }[] = [];
  let deliver: (result: unknown) => void = () => {};
  let stopped = false;
  const scaledFrames: {
    timestamp: number;
    displayWidth: number;
    displayHeight: number;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const reader = {
    read: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    cancel: async () => {
      deliver({ done: true });
    },
  };
  class Encoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    configuration = { bitrate: 0 };
    calls = 0;
    closed = false;
    encodeQueueSize = 0;
    constructor(readonly callbacks: { output(chunk: unknown, metadata: unknown): void }) {
      encoders.push(this);
    }
    configure(value: { bitrate: number }) {
      this.configuration = value;
    }
    encode(frame: { timestamp: number }) {
      this.calls++;
      this.callbacks.output(
        {
          timestamp: frame.timestamp,
          type: "key",
          byteLength: this.configuration.bitrate > 5_000_000 ? 2_097_153 : 10,
          copyTo: (bytes: Uint8Array) => bytes.fill(1),
        },
        {},
      );
    }
    close() {
      if (this.closed) throw new Error("already closed");
      this.closed = true;
    }
    reset() {
      if (this.closed) throw new Error("already closed");
    }
  }
  const context = createContext({
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "exact-stream" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 800 }) }],
          getTracks: () => [
            {
              stop: () => {
                stopped = true;
              },
            },
          ],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: Encoder,
    VideoFrame: class {
      timestamp: number;
      displayWidth: number;
      displayHeight: number;
      close = vi.fn();
      constructor(
        source: { timestamp: number },
        options: { displayWidth: number; displayHeight: number },
      ) {
        this.timestamp = source.timestamp;
        this.displayWidth = options.displayWidth;
        this.displayHeight = options.displayHeight;
        scaledFrames.push(this);
      }
    },
    nativeVideoPacket: (json: string) => packets.push(JSON.parse(json)),
    performance: { now: () => 100 },
    Uint8Array,
    Map,
    Set,
    Object,
    JSON,
    Number,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  await runInContext('startCapture("exact",1280,800,1)', context);
  await runInContext('addEncoder("high","high-stream")', context);
  await runInContext('addEncoder("low","low-stream")', context);
  const frame = (timestamp: number) => ({
    timestamp,
    displayWidth: 1280,
    displayHeight: 800,
    close() {},
  });
  deliver({ value: frame(100000), done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(encoders[0]?.closed).toBe(true);
  expect(packets).toContainEqual({
    error: "Native video quality exceeds its packet bound",
    streamId: "high-stream",
  });
  deliver({ value: frame(133333), done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(encoders[0]?.calls).toBe(1);
  expect(encoders[1]?.calls).toBe(2);
  expect(packets.filter((packet) => packet.streamId === "low-stream")).toHaveLength(2);
  await runInContext("resetCapture(2,150000)", context);
  deliver({ value: { ...frame(200000), displayHeight: 799 }, done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(packets).toContainEqual({
    error: "Native video dimensions changed",
    reasonCode: "source-dimensions",
  });
  await runInContext("stopCapture()", context);
  expect(stopped).toBe(true);
  await runInContext('startCapture("exact",412,839,3)', context);
  await runInContext('addEncoder("low","odd-stream")', context);
  const close = vi.fn();
  deliver({
    value: { timestamp: 300000, displayWidth: 412, displayHeight: 838, format: "I420", close },
    done: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(packets).toContainEqual(
    expect.objectContaining({
      streamId: "odd-stream",
      width: 412,
      height: 839,
      timestampUs: 300000,
    }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(scaledFrames[0]?.close).toHaveBeenCalledOnce();
  await runInContext("stopCapture()", context);
});

it.each([
  [412, 839, 412, 838],
  [393, 659, 392, 658],
  [413, 800, 412, 800],
])(
  "corrects only even-aligned YUV dimensions for %i by %i",
  (width, height, nativeWidth, nativeHeight) => {
    const frames: unknown[] = [];
    const context = createContext({
      VideoFrame: class {
        constructor(
          readonly source: unknown,
          readonly options: unknown,
        ) {
          frames.push(this);
        }
      },
    });
    runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
    const native = {
      displayWidth: nativeWidth,
      displayHeight: nativeHeight,
      format: "I420",
      timestamp: 42,
    };
    context.frame = native;
    const result = runInContext(`frameForViewport(frame,${width},${height})`, context);
    expect(result.source).toBe(native);
    expect(result.options).toEqual({ displayWidth: width, displayHeight: height });
    expect(frames).toHaveLength(1);
    context.frame = { ...native, displayWidth: width, displayHeight: height };
    expect(runInContext(`frameForViewport(frame,${width},${height})`, context)).toBe(context.frame);
    for (const invalid of [
      { ...native, displayHeight: nativeHeight - 2 },
      { ...native, displayWidth: nativeWidth + 2 },
      { ...native, format: "RGBA" },
    ]) {
      context.frame = invalid;
      expect(runInContext(`frameForViewport(frame,${width},${height})`, context)).toBeNull();
    }
  },
);

describe("native snapshot job slot", () => {
  type Reply = { token: string; status: string; [key: string]: unknown };
  /** One trusted helper program with a controllable source, canvas and timer clock. */
  function harness(options: { canvas?: boolean } = {}) {
    let deliver: (result: unknown) => void = () => {};
    const reader = {
      read: () => new Promise((resolve) => { deliver = resolve; }),
      cancel: async () => { deliver({ done: true }); },
    };
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const conversions: { quality: number; resolve(blob: unknown): void; reject(error: unknown): void }[] = [];
    const draws: unknown[] = [];
    const canvases: unknown[] = [];
    class Canvas {
      constructor(readonly width: number, readonly height: number) { canvases.push(this); }
      getContext() { return { drawImage: (image: unknown) => draws.push(image) }; }
      convertToBlob(options: { quality: number }) {
        return new Promise((resolve, reject) => conversions.push({ quality: options.quality, resolve, reject }));
      }
    }
    const context = createContext({
      chrome: {
        debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
        tabCapture: { getMediaStreamId: async () => "exact-stream" },
      },
      navigator: { mediaDevices: { getUserMedia: async () => ({
        getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 800 }) }],
        getTracks: () => [{ stop() {} }],
      }) } },
      MediaStreamTrackProcessor: class { readable = { getReader: () => reader }; },
      VideoEncoder: class {},
      VideoFrame: class {},
      ...(options.canvas === false ? {} : { OffscreenCanvas: Canvas }),
      nativeVideoPacket: () => {},
      setTimeout: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
      performance: { now: () => 100 },
      Uint8Array, Map, Set, Object, JSON, Number, Math, Promise, Array,
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    });
    runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const frames: { timestamp: number; close: ReturnType<typeof vi.fn>; cloneClose: ReturnType<typeof vi.fn> }[] = [];
    const frame = (timestamp: number) => {
      const cloneClose = vi.fn();
      const value = {
        timestamp, displayWidth: 1280, displayHeight: 800, close: vi.fn(),
        clone: () => ({ clone: true, timestamp, close: cloneClose }),
        cloneClose,
      };
      frames.push(value);
      return value;
    };
    return {
      context,
      reader,
      conversions,
      draws,
      canvases,
      frames,
      start: (generation = 1) => runInContext(`startCapture("exact",1280,800,${generation})`, context),
      push: async (timestamp: number) => { deliver({ value: frame(timestamp), done: false }); await settle(); },
      arm: (token: string, floor: number, generation = 1, maxBytes = 600_000, quality = 80) =>
        runInContext(`captureSnapshot(${JSON.stringify(token)},${quality},${maxBytes},${floor},${generation},1500)`, context) as Promise<Reply>,
      slot: () => runInContext("snapshotSlotState().reserved", context) as boolean,
      fireTimers: () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
      blob: (size: number) => ({ type: "image/jpeg", size, arrayBuffer: async () => new Uint8Array(size).fill(7).buffer }),
      settle,
    };
  }
  const token = (digit: string) => digit.repeat(32);

  it("selects only the next current frame at its floor, closes the clone right after drawing, and publishes once", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 200_000);
    await h.push(100_000); // older than the floor
    expect(h.draws).toHaveLength(0);
    await h.push(200_000);
    expect(h.draws).toHaveLength(1);
    expect(h.frames[1]!.cloneClose).toHaveBeenCalledOnce(); // closed synchronously, before conversion settles
    expect(h.conversions).toHaveLength(1);
    expect(h.slot()).toBe(true);
    h.conversions[0]!.resolve(h.blob(12));
    const value = await reply;
    expect(value).toMatchObject({ token: token("a"), status: "ready", generation: 1, timestampUs: 200_000, width: 1280, height: 800, byteLength: 12 });
    expect(Buffer.from(String(value.dataBase64), "base64")).toHaveLength(12);
    await h.settle();
    expect(h.slot()).toBe(false);
    await runInContext("stopCapture()", h.context);
  });

  it("allows one job only: a second request is busy rather than coalesced", async () => {
    const h = harness();
    await h.start();
    void h.arm(token("a"), 0);
    expect(await h.arm(token("b"), 0)).toEqual({ token: token("b"), status: "busy" });
    await runInContext("stopCapture()", h.context);
  });

  it("keeps the reservation through a timeout until the unabortable conversion settles, then discards it", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 0);
    await h.push(300_000);
    expect(h.conversions).toHaveLength(1);
    h.fireTimers(); // deadline while convertToBlob is still pending
    expect(await reply).toEqual({ token: token("a"), status: "timeout" });
    expect(h.slot()).toBe(true);
    expect(await h.arm(token("b"), 0)).toEqual({ token: token("b"), status: "busy" });
    await h.push(400_000);
    expect(h.draws).toHaveLength(1); // no second draw can overwrite the shared canvas
    h.conversions[0]!.resolve(h.blob(12));
    await h.settle();
    expect(h.conversions).toHaveLength(1); // the cancelled ladder does not continue
    expect(h.slot()).toBe(false);
    await runInContext("stopCapture()", h.context);
  });

  it("releases immediately when the deadline passes before any frame was selected", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 999_999_999);
    h.fireTimers();
    expect(await reply).toEqual({ token: token("a"), status: "timeout" });
    expect(h.slot()).toBe(false);
    await runInContext("stopCapture()", h.context);
  });

  it("a newer reset makes an armed request stale; a request for the pending generation keeps waiting with the stronger floor", async () => {
    const h = harness();
    await h.start(1);
    const stale = h.arm(token("a"), 0, 1);
    await runInContext("resetCapture(2,500000)", h.context);
    expect(await stale).toEqual({ token: token("a"), status: "stale" });
    expect(h.slot()).toBe(false);
    const ahead = h.arm(token("b"), 0, 3); // issued before resetCapture(3) reached the helper
    await h.push(600_000); // generation 2 frame: not selected
    expect(h.draws).toHaveLength(0);
    await runInContext("resetCapture(3,700000)", h.context);
    await h.push(650_000); // below the raised floor
    expect(h.draws).toHaveLength(0);
    await h.push(700_000);
    expect(h.draws).toHaveLength(1);
    h.conversions[0]!.resolve(h.blob(9));
    expect(await ahead).toMatchObject({ status: "ready", generation: 3, timestampUs: 700_000 });
    expect(await h.arm(token("c"), 0, 2)).toEqual({ token: token("c"), status: "stale" });
    await runInContext("stopCapture()", h.context);
  });

  it("stop refuses publication but cannot let a restarted capture overlap the old conversion", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 0);
    await h.push(300_000);
    const stopping = runInContext("stopCapture()", h.context);
    expect(await reply).toEqual({ token: token("a"), status: "stopped" });
    await stopping;
    expect(h.slot()).toBe(true);
    await h.start(2);
    expect(await h.arm(token("b"), 0, 2)).toEqual({ token: token("b"), status: "busy" });
    h.conversions[0]!.resolve(h.blob(10));
    await h.settle();
    expect(h.slot()).toBe(false);
    const next = h.arm(token("c"), 0, 2);
    await h.push(400_000);
    expect(h.conversions).toHaveLength(2);
    h.conversions[1]!.resolve(h.blob(10));
    expect(await next).toMatchObject({ status: "ready", generation: 2 });
    await runInContext("stopCapture()", h.context);
  });

  it("releases the canvas when a stopped capture's last conversion settles late", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 0);
    await h.push(300_000);
    await runInContext("stopCapture()", h.context);
    expect(await reply).toEqual({ token: token("a"), status: "stopped" });
    // Still reserved and still referenced while the unabortable conversion runs.
    expect(h.slot()).toBe(true);
    expect(runInContext("snapshotCanvas !== null", h.context)).toBe(true);
    h.conversions[0]!.resolve(h.blob(10));
    await h.settle();
    expect(h.slot()).toBe(false);
    expect(runInContext("capture === null && snapshotCanvas === null", h.context)).toBe(true);
  });

  it("keeps the canvas when a capture restarted before the old conversion settled", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 0);
    await h.push(300_000);
    await runInContext("stopCapture()", h.context);
    await reply;
    await h.start(2); // new active capture; the old job still owns the slot
    h.conversions[0]!.resolve(h.blob(10));
    await h.settle();
    expect(h.slot()).toBe(false);
    expect(runInContext("capture !== null && snapshotCanvas !== null", h.context)).toBe(true);
    const next = h.arm(token("b"), 0, 2);
    await h.push(400_000);
    expect(h.canvases).toHaveLength(1); // reused, never a second overlapping canvas
    h.conversions[1]!.resolve(h.blob(10));
    expect(await next).toMatchObject({ status: "ready", generation: 2 });
    await runInContext("stopCapture()", h.context);
    expect(runInContext("snapshotCanvas === null", h.context)).toBe(true); // idle stop releases immediately
  });

  it("steps down at most three qualities to the byte cap, then reports too-large", async () => {
    const h = harness();
    await h.start();
    const fits = h.arm(token("a"), 0, 1, 1_000, 90);
    await h.push(300_000);
    h.conversions[0]!.resolve(h.blob(5_000));
    await h.settle();
    h.conversions[1]!.resolve(h.blob(2_000));
    await h.settle();
    h.conversions[2]!.resolve(h.blob(900));
    expect(await fits).toMatchObject({ status: "ready", byteLength: 900 });
    expect(h.conversions.map((conversion) => conversion.quality)).toEqual([0.9, 0.85, 0.65]);
    await h.settle();
    const large = h.arm(token("b"), 0, 1, 1_000, 90);
    await h.push(400_000);
    for (let index = 3; index < 6; index++) {
      h.conversions[index]!.resolve(h.blob(5_000));
      await h.settle();
    }
    expect(await large).toEqual({ token: token("b"), status: "too-large" });
    expect(h.conversions).toHaveLength(6);
    expect(h.slot()).toBe(false);
    await runInContext("stopCapture()", h.context);
  });

  it("caps any requested budget at the 600000-byte frame limit", async () => {
    const h = harness();
    await h.start();
    const reply = h.arm(token("a"), 0, 1, 5_000_000);
    await h.push(300_000);
    h.conversions[0]!.resolve(h.blob(600_001));
    await h.settle();
    h.conversions[1]!.resolve(h.blob(600_000));
    expect(await reply).toMatchObject({ status: "ready", byteLength: 600_000 });
    await runInContext("stopCapture()", h.context);
  });

  it("is unsupported without OffscreenCanvas and does not reserve the slot", async () => {
    const h = harness({ canvas: false });
    await h.start();
    expect(await h.arm(token("a"), 0)).toEqual({ token: token("a"), status: "unsupported" });
    expect(h.slot()).toBe(false);
    await runInContext("stopCapture()", h.context);
  });

  it("does nothing without a request: no draw, canvas or conversion per source frame", async () => {
    const h = harness();
    await h.start();
    await h.push(100_000);
    await h.push(200_000);
    expect(h.draws).toHaveLength(0);
    expect(h.canvases).toHaveLength(0);
    expect(h.conversions).toHaveLength(0);
    await runInContext("stopCapture()", h.context);
  });
});
