import { describe, expect, it } from "vitest";
import { createNativeVideoBuffer, videoSourceTime } from "./native-video-buffer";
import type { RuntimeVideoPacket } from "./native-video-packet";

const packet = (
  sequence: number,
  type: "key" | "delta" = "delta",
  capturedAt = 1000,
): RuntimeVideoPacket => ({
  streamId: "stream",
  captureGeneration: 1,
  sequence,
  type,
  timestampUs: 1000000 + sequence,
  codec: "vp8",
  width: 1280,
  height: 800,
  dataBase64: Buffer.from("owned-packet").toString("base64"),
  capturedAt: new Date(capturedAt).toISOString(),
  capturedAtMonotonicMs: capturedAt,
});
describe("native encoded receipt buffer", () => {
  it("maps actual TimeTicks age instead of refreshing a delayed packet", () => {
    const clock = { sourceMs: 112000000, monotonicMs: 500, wallMs: 2000 };
    expect(videoSourceTime(112000100000, clock, 700, 2200)).toEqual({
      capturedAt: new Date(2100).toISOString(),
      capturedAtMonotonicMs: 600,
    });
    expect(videoSourceTime(112000100000, clock, 1701, 2200)).toBeNull();
    expect(videoSourceTime(112001000000, clock, 700, 2200)).toBeNull();
  });
  it("does not bootstrap a decoder from an arbitrary delta", () => {
    const buffer = createNativeVideoBuffer();
    buffer.add(packet(1));
    expect(buffer.read(0, 1100)).toEqual([]);
    buffer.add(packet(2, "key"));
    buffer.add(packet(3));
    expect(buffer.read(0, 1100).map((p) => p.sequence)).toEqual([2, 3]);
  });
  it("lost output suppresses dependent deltas until a keyframe", () => {
    const buffer = createNativeVideoBuffer();
    buffer.add(packet(1, "key"));
    buffer.add(packet(3));
    buffer.add(packet(4));
    expect(buffer.read(1, 1100)).toEqual([]);
    buffer.add(packet(5, "key"));
    buffer.add(packet(6));
    expect(buffer.read(1, 1100).map((p) => p.sequence)).toEqual([5, 6]);
  });
  it("never relabels or returns source frames beyond one second", () => {
    const buffer = createNativeVideoBuffer();
    buffer.add(packet(1, "key"));
    expect(buffer.read(0, 2000)[0]?.capturedAt).toBe(new Date(1000).toISOString());
    expect(buffer.read(0, 2001)).toEqual([]);
  });
  it("bounds slow consumers and restarts from a retained keyframe", () => {
    const buffer = createNativeVideoBuffer();
    for (let i = 1; i <= 80; i++) buffer.add(packet(i, i % 10 === 0 ? "key" : "delta"));
    const result = buffer.read(0, 1100);
    expect(result.length).toBeLessThanOrEqual(32);
    expect(result[0]?.type).toBe("key");
    expect(result.at(-1)?.sequence).toBe(80);
  });
  it("signals recovery for a missing key, but not ordinary waiting on a valid chain", () => {
    const buffer = createNativeVideoBuffer();
    expect(buffer.needsKeyFrame(0, 1100)).toBe(false);
    buffer.add(packet(1, "key"));
    expect(buffer.needsKeyFrame(1, 1100)).toBe(false);
    buffer.add(packet(3));
    expect(buffer.needsKeyFrame(1, 1100)).toBe(true);
    buffer.add(packet(4, "key"));
    expect(buffer.needsKeyFrame(1, 1100)).toBe(false);
    expect(buffer.needsKeyFrame(4, 2101)).toBe(false);
    expect(buffer.needsKeyFrame(0, 2101)).toBe(true);
  });
  it("requests a bootstrap key after ring eviction without disturbing a current decoder", () => {
    const buffer = createNativeVideoBuffer();
    buffer.add(packet(1, "key"));
    for (let sequence = 2; sequence <= 40; sequence++) buffer.add(packet(sequence));
    expect(buffer.read(0, 1100)).toEqual([]);
    expect(buffer.needsKeyFrame(0, 1100)).toBe(true);
    expect(buffer.needsKeyFrame(39, 1100)).toBe(false);
    expect(buffer.read(39, 1100).map((item) => item.sequence)).toEqual([40]);
  });
  it("a document barrier clears queued pixels without recycling sequence authority", () => {
    const buffer = createNativeVideoBuffer();
    buffer.add(packet(1, "key"));
    buffer.clear();
    buffer.add(packet(2));
    expect(buffer.read(0, 1100)).toEqual([]);
    buffer.add(packet(3, "key"));
    expect(buffer.read(0, 1100).map((p) => p.sequence)).toEqual([3]);
  });
});

it("sends the latest complete key chain instead of an obsolete multi-megabyte backlog", () => {
  const buffer = createNativeVideoBuffer();
  const large = (sequence: number, type: "key" | "delta") => ({
    ...packet(sequence, type),
    dataBase64: Buffer.alloc(type === "key" ? 512 * 1024 : 128 * 1024, sequence).toString("base64"),
  });
  buffer.add(large(1, "key"));
  for (let sequence = 2; sequence <= 24; sequence++) buffer.add(large(sequence, "delta"));
  buffer.add(large(25, "key"));
  buffer.add(large(26, "delta"));
  for (const after of [0, 1, 12, 24]) {
    const selected = buffer.read(after, 1100);
    expect(selected.map((value) => value.sequence)).toEqual([25, 26]);
    expect(
      selected.reduce((bytes, value) => bytes + Buffer.byteLength(value.dataBase64, "base64"), 0),
    ).toBe(640 * 1024);
    expect(buffer.needsKeyFrame(after, 1100)).toBe(false);
  }
  // Fast and slow viewers have independent cursors; no arbitrary delta skips.
  expect(buffer.read(25, 1100).map((value) => value.sequence)).toEqual([26]);
  expect(buffer.read(26, 1100)).toEqual([]);
});

it("never catches up across a delta dependency without a newer complete key", () => {
  const buffer = createNativeVideoBuffer();
  buffer.add(packet(1, "key"));
  for (let sequence = 2; sequence <= 20; sequence++) buffer.add(packet(sequence));
  expect(buffer.read(1, 1100).map((value) => value.sequence)).toEqual(
    Array.from({ length: 19 }, (_, i) => i + 2),
  );
});

it.each([-75_000, 75_000])(
  "retains source age rather than calibration wall time after a %i ms correction",
  (jump) => {
    const clock = { sourceMs: 112000000, monotonicMs: 500 };
    const time = videoSourceTime(112000100000, clock, 700, 2200 + jump)!;
    expect(time.capturedAtMonotonicMs).toBe(600);
    expect(Date.parse(time.capturedAt)).toBe(2100 + jump);
    const buffer = createNativeVideoBuffer();
    buffer.add({ ...packet(1, "key"), ...time });
    expect(buffer.read(0, 700)).toHaveLength(1);
    expect(buffer.read(0, 1601)).toEqual([]);
    expect(videoSourceTime(112000100000, clock, 1701, 2200 + jump)).toBeNull();
  },
);
