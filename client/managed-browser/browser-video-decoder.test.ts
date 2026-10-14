import { describe, expect, it } from "vitest";
import type { BrowserVideoPacket } from "../../shared/managed-browser/browser-video";
import {
  type BrowserVideoCodec,
  createBrowserVideoDecoder,
  type DecodedBrowserVideoFrame,
} from "./browser-video-decoder";

function packet(sequence = 1, type: "key" | "delta" = "key", generation = 1): BrowserVideoPacket {
  return {
    streamId: "s".repeat(32),
    captureGeneration: generation,
    sequence,
    timestampUs: sequence * 1000,
    type,
    codec: "vp8",
    width: 1280,
    height: 800,
    dataBase64: "AA==",
    capturedAt: "2026-10-03T00:00:00.000Z",
    frame: {
      frameId: String(sequence).padStart(32, "f"),
      sessionId: "a".repeat(32),
      navigationGeneration: 1,
      viewportGeneration: 1,
      width: 1280,
      height: 800,
      capturedAt: "2026-10-03T00:00:00.000Z",
    },
  };
}
function fixture(sourceVisuals = false, nativeDraw?: () => Promise<void>) {
  let currentEpoch = 1;
  let currentNavigation = 1;
  const admitted: number[] = [];
  let queueSize = 0;
  let scheduled: (() => void) | null = null;
  const callbacks: {
    output(frame: DecodedBrowserVideoFrame): void;
    error(error: unknown): void;
    dequeue(): void;
  }[] = [];
  const decoded: unknown[] = [];
  const drawn: number[] = [];
  const presented: number[] = [];
  const closed: number[] = [];
  const errors: unknown[] = [];
  let keys = 0;
  const decoder = createBrowserVideoDecoder({
    environment: {
      createDecoder(value) {
        callbacks.push(value);
        return {
          get decodeQueueSize() {
            return queueSize;
          },
          configure() {},
          decode(chunk) {
            decoded.push(chunk);
          },
          close() {},
        } satisfies BrowserVideoCodec;
      },
      createChunk: (value) => value,
      decodeBase64: () => new Uint8Array([0]),
      scheduleDraw(draw) {
        scheduled = draw;
        return () => {
          scheduled = null;
        };
      },
      draw(frame) {
        drawn.push(frame.timestamp);
        return nativeDraw?.();
      },
    },
    isCurrent: (value, epoch) =>
      epoch === currentEpoch && value.frame.navigationGeneration === currentNavigation,
    ...(sourceVisuals
      ? {
          isSourceCurrent: (value: BrowserVideoPacket) =>
            value.frame.navigationGeneration === currentNavigation,
        }
      : {}),
    onPresented(value, epoch) {
      presented.push(value.sequence);
      if (epoch === currentEpoch) admitted.push(value.sequence);
    },
    onNeedKeyFrame() {
      keys++;
    },
    onError(error) {
      errors.push(error);
    },
  });
  const output = (timestamp: number, codecIndex = callbacks.length - 1, width = 1280) => {
    callbacks[codecIndex]!.output({
      timestamp,
      displayWidth: width,
      displayHeight: 800,
      close() {
        closed.push(timestamp);
      },
    });
  };
  return {
    decoder,
    decoded,
    drawn,
    presented,
    admitted,
    codecs: () => callbacks.length,
    navigation: (value: number) => {
      currentNavigation = value;
    },
    closed,
    errors,
    output,
    paint() {
      const draw = scheduled;
      scheduled = null;
      draw?.();
    },
    epoch(value: number) {
      currentEpoch = value;
    },
    pressure(value: number) {
      queueSize = value;
    },
    drain() {
      callbacks.at(-1)?.dequeue();
    },
    keys: () => keys,
  };
}

describe("video decode admission", () => {
  it("preserves a full 32-packet relay burst while actual asynchronous decoder capacity drains", async () => {
    let queueSize = 0;
    let maximumQueue = 0;
    let codecCloses = 0;
    let keys = 0;
    const decoded: number[] = [];
    const presented: number[] = [];
    let draw: (() => void) | null = null;
    const decoder = createBrowserVideoDecoder({
      environment: {
        createDecoder(callbacks) {
          return {
            get decodeQueueSize() {
              return queueSize;
            },
            configure() {},
            decode(value) {
              const chunk = value as { timestamp: number };
              decoded.push(chunk.timestamp);
              queueSize++;
              maximumQueue = Math.max(maximumQueue, queueSize);
              // Native WebCodecs dispatches asynchronous dequeue/output tasks,
              // rather than draining during the hook's synchronous batch loop.
              queueMicrotask(() => {
                queueSize--;
                callbacks.dequeue();
                callbacks.output({
                  timestamp: chunk.timestamp,
                  displayWidth: 1280,
                  displayHeight: 800,
                  close() {},
                });
              });
            },
            close() {
              codecCloses++;
            },
          };
        },
        createChunk: (value) => value,
        decodeBase64: () => new Uint8Array([0]),
        scheduleDraw(callback) {
          draw = callback;
          return () => {
            draw = null;
          };
        },
        draw() {},
      },
      isCurrent: () => true,
      onPresented: (value) => presented.push(value.sequence),
      onNeedKeyFrame: () => {
        keys++;
      },
      onError: (error) => {
        throw error;
      },
    });
    for (let sequence = 1; sequence <= 32; sequence++) {
      expect(decoder.receive(packet(sequence, sequence === 1 ? "key" : "delta"), 1)).toBe(true);
    }
    expect(decoded).toHaveLength(4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(decoded).toEqual(Array.from({ length: 32 }, (_, index) => (index + 1) * 1000));
    expect(maximumQueue).toBe(4);
    expect(codecCloses).toBe(0);
    expect(keys).toBe(0);
    const paint = draw as (() => void) | null;
    paint?.();
    expect(presented).toEqual([32]);
    decoder.close();
  });

  it("rejects queued old authority at dequeue before dispatching or painting it", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.pressure(4);
    f.decoder.receive(packet(2, "delta"), 1);
    f.epoch(2);
    f.pressure(0);
    f.drain();
    f.output(1000);
    f.paint();
    expect(f.decoded).toHaveLength(1);
    expect(f.presented).toEqual([]);
    expect(f.keys()).toBe(1);
  });

  it("bounds buffered chunks even when the codec dequeues without producing output", () => {
    const f = fixture();
    for (let sequence = 1; sequence <= 64; sequence++) {
      expect(f.decoder.receive(packet(sequence, sequence === 1 ? "key" : "delta"), 1)).toBe(true);
    }
    expect(f.decoder.receive(packet(65, "delta"), 1)).toBe(false);
    expect(f.keys()).toBe(1);
    expect(f.decoder.receive(packet(66, "key"), 1)).toBe(true);
    f.output(1000, 0);
    f.paint();
    expect(f.presented).toEqual([]);
  });

  it("bounds retained encoded payload independently of packet count", () => {
    const f = fixture();
    const payload = "A".repeat(3 * 1024 * 1024);
    expect(f.decoder.receive({ ...packet(), dataBase64: payload }, 1)).toBe(true);
    f.pressure(4);
    expect(f.decoder.receive({ ...packet(2, "delta"), dataBase64: payload }, 1)).toBe(true);
    expect(f.decoder.receive({ ...packet(3, "delta"), dataBase64: payload }, 1)).toBe(false);
    expect(f.keys()).toBe(1);
    expect(f.decoded).toHaveLength(1);
  });
  it("admits only after actual decode and local draw", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    expect(f.presented).toEqual([]);
    f.output(1000);
    expect(f.presented).toEqual([]);
    f.paint();
    expect(f.drawn).toEqual([1000]);
    expect(f.presented).toEqual([1]);
    expect(f.closed).toEqual([1000]);
  });
  it("drops frames invalidated while decoding or awaiting local paint", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.output(1000);
    f.epoch(2);
    f.paint();
    expect(f.drawn).toEqual([]);
    expect(f.closed).toEqual([1000]);
  });
  it("closes superseded frames and paints only the newest output", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.decoder.receive(packet(2, "delta"), 1);
    f.output(1000);
    f.output(2000);
    f.paint();
    expect(f.drawn).toEqual([2000]);
    expect(f.closed).toEqual([1000, 2000]);
  });
  it("does not let a reordered older decoder output replace the queued newest frame", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.decoder.receive(packet(2, "delta"), 1);
    f.output(2000);
    f.output(1000);
    f.paint();
    expect(f.drawn).toEqual([2000]);
    expect(f.closed).toEqual([1000, 2000]);
  });
  it("never decodes a delta after a transport gap", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    expect(f.decoder.receive(packet(3, "delta"), 1)).toBe(false);
    expect(f.decoded).toHaveLength(1);
    expect(f.keys()).toBe(1);
    expect(f.decoder.receive(packet(4, "key"), 1)).toBe(true);
  });
  it("ignores a late old-decoder output even when its timestamp collides", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.decoder.receive(packet(1, "key", 2), 1);
    f.output(1000, 0);
    f.paint();
    expect(f.drawn).toEqual([]);
    f.output(1000, 1);
    f.paint();
    expect(f.presented).toEqual([1]);
  });
  it("bounds codec pressure and ignores duplicate delivery", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.decoder.receive(packet(), 1);
    expect(f.decoded).toHaveLength(1);
    f.pressure(4);
    expect(f.decoder.receive(packet(2, "delta"), 1)).toBe(true);
    expect(f.decoded).toHaveLength(1);
    expect(f.keys()).toBe(0);
    f.pressure(0);
    f.drain();
    expect(f.decoded).toHaveLength(2);
  });
  it("refuses mismatched decoded geometry", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.output(1000, 0, 400);
    f.paint();
    expect(f.drawn).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });
  it("closes pending and late frames on idempotent disposal", () => {
    const f = fixture();
    f.decoder.receive(packet(), 1);
    f.output(1000);
    f.decoder.close();
    f.decoder.close();
    f.output(1000);
    f.paint();
    expect(f.drawn).toEqual([]);
    expect(f.closed).toEqual([1000, 1000]);
  });
});

it("source-qualified old-epoch visuals keep the delta chain without input admission", () => {
  const f = fixture(true);
  f.decoder.receive(packet(1), 1);
  f.output(1000);
  f.paint();
  f.epoch(2);
  expect(f.decoder.receive(packet(2, "delta"), 1)).toBe(true);
  f.output(2000);
  f.paint();
  expect(f.drawn).toEqual([1000, 2000]);
  expect(f.admitted).toEqual([1]);
  expect(f.decoder.receive(packet(3, "delta"), 2)).toBe(true);
  f.output(3000);
  f.paint();
  expect(f.admitted).toEqual([1, 3]);
  expect(f.codecs()).toBe(1);
  expect(f.keys()).toBe(0);
});

it("source-only visual continuity still refuses obsolete navigation and unknown delta gaps", () => {
  const f = fixture(true);
  f.decoder.receive(packet(1), 1);
  f.navigation(2);
  f.output(1000);
  f.paint();
  expect(f.drawn).toEqual([]);
  expect(f.decoder.receive(packet(2, "delta"), 1)).toBe(false);
  const next = packet(3);
  next.frame.navigationGeneration = 2;
  expect(f.decoder.receive(next, 1)).toBe(true);
  f.output(3000);
  f.paint();
  const gap = packet(5, "delta");
  gap.frame.navigationGeneration = 2;
  expect(f.decoder.receive(gap, 1)).toBe(false);
  expect(f.keys()).toBe(1);
});

it("replaces a blocked decoder backlog only at a complete newer key without requesting recovery", () => {
  const f = fixture();
  expect(f.decoder.receive(packet(1, "key"), 1)).toBe(true);
  f.pressure(4);
  expect(f.decoder.receive(packet(2, "delta"), 1)).toBe(true);
  expect(f.decoder.receive(packet(3, "delta"), 1)).toBe(true);
  expect(f.decoder.receive(packet(4, "key"), 1)).toBe(true);
  f.output(1000, 0);
  f.paint();
  expect(f.presented).toEqual([]);
  f.pressure(0);
  f.drain();
  f.output(4000);
  f.paint();
  expect(f.decoded.map((value) => (value as { timestamp: number }).timestamp)).toEqual([
    1000, 4000,
  ]);
  expect(f.presented).toEqual([4]);
  expect(f.keys()).toBe(0);
  expect(f.errors).toEqual([]);
});

it("catch-up retains the original input epoch even when newer key pixels remain visually valid", () => {
  const f = fixture(true);
  f.decoder.receive(packet(1, "key"), 1);
  f.pressure(4);
  f.decoder.receive(packet(2, "delta"), 1);
  f.decoder.receive(packet(3, "key"), 1);
  f.epoch(2);
  f.pressure(0);
  f.drain();
  f.output(3000);
  f.paint();
  expect(f.presented).toEqual([3]);
  expect(f.admitted).toEqual([]);
  expect(f.keys()).toBe(0);
});

/** A native acknowledgement may arrive after mutation or decoder replacement. */
it.each(["current", "mutation", "reset"] as const)(
  "admits asynchronous native paint only for a current receipt (%s)",
  async (invalidation) => {
    let complete = () => {};
    const f = fixture(
      false,
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    f.decoder.receive(packet(), 1);
    f.output(1000);
    f.paint();
    expect(f.presented).toEqual([]);
    if (invalidation === "mutation") f.epoch(2);
    if (invalidation === "reset") f.decoder.reset();
    complete();
    await Promise.resolve();
    expect(f.presented).toEqual(invalidation === "current" ? [1] : []);
    expect(f.closed).toEqual([1000]);
    f.decoder.close();
  },
);

it("serializes native paints while keeping only the newest waiting frame", async () => {
  let complete = () => {};
  const f = fixture(
    false,
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  f.decoder.receive(packet(), 1);
  f.output(1000);
  f.paint();
  f.decoder.receive(packet(2, "delta"), 1);
  f.output(2000);
  f.decoder.receive(packet(3, "delta"), 1);
  f.output(3000);
  f.paint();
  expect(f.drawn).toEqual([1000]);
  expect(f.presented).toEqual([]);
  complete();
  await Promise.resolve();
  expect(f.presented).toEqual([1]);
  f.paint();
  expect(f.drawn).toEqual([1000, 3000]);
  complete();
  await Promise.resolve();
  expect(f.presented).toEqual([1, 3]);
  expect(f.closed).toEqual([2000, 1000, 3000]);
  f.decoder.close();
});
