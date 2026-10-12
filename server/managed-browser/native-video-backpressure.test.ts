/** Exercise producer backpressure using the actual shipped helper program.
 * Unencoded source skips preserve intact dependencies; lost encoded output still
 * requires a key. Delayed outputs/ACKs model ordinary codec and relay pressure.
 */
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

/** Delayed native codec output and ACKs, with the shipped trusted program unmodified. */
async function fixture(failFirstEncoder = false) {
  const packets: { sequence: number; type: string; timestampUs: number }[] = [];
  let deliver: (result: unknown) => void = () => {};
  const reader = {
    read: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    cancel: async () => deliver({ done: true }),
  };
  const pending: { timestamp: number; type: string }[] = [];
  const encoded: { timestamp: number; keyFrame: boolean }[] = [];
  let encoder: Encoder;
  const instances: Encoder[] = [];
  class Encoder {
    static async isConfigSupported(candidate: unknown) {
      return { supported: true, config: candidate };
    }
    encodeQueueSize = 0;
    constructor(readonly callbacks: { output(chunk: unknown, metadata: unknown): void }) {
      encoder = this;
      instances.push(this);
    }
    configure() {}
    reset() {}
    close() {}
    encode(frame: { timestamp: number }, options: { keyFrame: boolean }) {
      if (failFirstEncoder && this === instances[0]) throw new Error("Codec stopped");
      this.encodeQueueSize++;
      encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
      pending.push({ timestamp: frame.timestamp, type: options.keyFrame ? "key" : "delta" });
    }
    output() {
      const value = pending.shift();
      if (!value) throw new Error("No queued fixture frame");
      this.encodeQueueSize--;
      this.callbacks.output(
        { ...value, byteLength: 10, copyTo: (bytes: Uint8Array) => bytes.fill(1) },
        {},
      );
    }
  }
  const context = createContext({
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "stream" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({ width: 320, height: 240 }) }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: Encoder,
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
  await runInContext('startCapture("exact",320,240,1)', context);
  await runInContext('addEncoder("high","stream",12000000,30)', context);
  if (failFirstEncoder) {
    await runInContext('addEncoder("low","healthy",2000000,30)', context);
  }
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    packets,
    encoded,
    async frame(timestamp: number) {
      deliver({
        value: { timestamp, displayWidth: 320, displayHeight: 240, close() {} },
        done: false,
      });
      await turn();
    },
    output: () => encoder!.output(),
    ack: () =>
      runInContext(
        'for(const p of fixturePackets) acknowledge("stream",p.sequence)',
        Object.assign(context, { fixturePackets: packets }),
      ),
    request: () => runInContext('requestKeyFrame("high")', context),
    stop: () => runInContext("stopCapture()", context),
  };
}

it("preserves encoded deltas during source backpressure with no extra recovery key", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    f.ack();
    await f.frame(33333);
    await f.frame(66666);
    await f.frame(99999);
    expect(f.encoded).toHaveLength(3);
    f.output();
    f.output();
    f.ack();
    await f.frame(133332);
    f.output();
    expect(f.packets.map((p) => [p.timestampUs, p.type])).toEqual([
      [0, "key"],
      [33333, "delta"],
      [66666, "delta"],
      [133332, "delta"],
    ]);
    expect(f.encoded.filter((e) => e.keyFrame)).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("keeps two-packet ACK pressure bounded without restarting an intact codec chain", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    await f.frame(33333);
    f.output();
    await f.frame(66666);
    expect(f.encoded).toHaveLength(2);
    f.ack();
    await f.frame(99999);
    f.output();
    expect(f.packets.map((packet) => packet.type)).toEqual(["key", "delta", "delta"]);
    expect(f.encoded.filter((entry) => entry.keyFrame)).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("adds a requested key without suppressing an intact pending delta", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    f.ack();
    await f.frame(33333);
    f.request();
    f.output();
    await f.frame(66666);
    f.output();
    expect(f.packets.map((p) => p.type)).toEqual(["key", "delta", "key"]);
  } finally {
    await f.stop();
  }
});

it("still suppresses dependencies after an actual encoded output is dropped", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    f.ack();
    await f.frame(33333);
    await f.frame(66666);
    f.output();
    await f.frame(99999);
    f.output();
    f.output();
    expect(f.packets.map((p) => p.timestampUs)).toEqual([0, 33333, 66666]);
    f.ack();
    await f.frame(133332);
    f.output();
    expect(f.packets.at(-1)?.type).toBe("key");
  } finally {
    await f.stop();
  }
});

it("shipped packet conversion is exact with native and legacy byte APIs", () => {
  for (const native of [true, false]) {
    const context = createContext({
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    });
    runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
    if (!native) runInContext("Uint8Array.prototype.toBase64 = undefined", context);
    for (const size of [0, 1, 2, 65537, 1048576]) {
      const value = runInContext(
        `bytes64(Uint8Array.from({length:${size}},(_,i)=>(i*17+13)%256))`,
        context,
      );
      const expected = Buffer.alloc(size);
      for (let i = 0; i < size; i += 1) expected[i] = (i * 17 + 13) % 256;
      expect(value).toBe(expected.toString("base64"));
    }
  }
});

it("isolates synchronous encoder failure while a healthy peer keeps receiving frames", async () => {
  const f = await fixture(true);
  try {
    await f.frame(0);
    f.output();
    f.ack();
    await f.frame(33333);
    f.output();
    expect(f.packets).toContainEqual({ error: "Native video encoder stopped", streamId: "stream" });
    expect(f.packets).not.toContainEqual({ error: "Native video capture stopped" });
    expect(f.packets.filter((packet) => packet.type).map((packet) => packet.type)).toEqual([
      "key",
      "delta",
    ]);
  } finally {
    await f.stop();
  }
});
