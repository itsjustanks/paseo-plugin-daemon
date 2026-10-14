/** Deliberately defer React commits to exercise canvas paint and RPC replacement windows. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "../../shared/managed-browser/browser";
import type {
  BrowserVideoPacket,
  BrowserVideoReadInput,
  BrowserVideoReadReply,
} from "../../shared/managed-browser/browser-video";
import { isVideoSourceCurrent } from "./browser-video-currency";
import type { BrowserVideoDecodeEnvironment } from "./browser-video-decoder";

interface HookSlot {
  value?: unknown;
  current?: unknown;
  dependencies?: unknown[];
  cleanup?: (() => void) | undefined;
}

const harness = vi.hoisted(() => ({
  slots: [] as HookSlot[],
  index: 0,
  effects: [] as (() => void)[],
  layouts: [] as (() => void)[],
  environment: null as unknown,
  reads: [] as {
    input: BrowserVideoReadInput;
    resolve(value: BrowserVideoReadReply): void;
    reject(error: unknown): void;
  }[],
  read: null as unknown,
  documentActive: true,
  appState: "active",
  visibility: null as null | ((active: boolean) => void),
  application: null as null | ((state: string) => void),
  disposals: 0,
  decoderCloses: 0,
}));
const imageQuery = vi.hoisted(() => ({
  options: null as null | { enabled: boolean; queryFn(): Promise<unknown> },
  refetch: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tanstack/react-query", () => ({
  CancelledError: class extends Error {},
  useQuery(options: { enabled: boolean; queryFn(): Promise<unknown> }) {
    imageQuery.options = options;
    return { refetch: imageQuery.refetch };
  },
}));
vi.mock("react", () => {
  const effect = (
    operation: () => (() => void) | void,
    dependencies: unknown[],
    layout: boolean,
  ) => {
    const index = harness.index++;
    const previous = harness.slots[index];
    if (previous && dependencies.every((value, i) => value === previous.dependencies?.[i])) return;
    const slot: HookSlot = { dependencies, cleanup: previous?.cleanup };
    harness.slots[index] = slot;
    (layout ? harness.layouts : harness.effects).push(() => {
      slot.cleanup?.();
      slot.cleanup = operation() ?? undefined;
    });
  };
  return {
    useState(initial: unknown) {
      const index = harness.index++;
      if (!harness.slots[index]) {
        harness.slots[index] = {
          value: typeof initial === "function" ? (initial as () => unknown)() : initial,
        };
      }
      const slot = harness.slots[index]!;
      return [
        slot.value,
        (value: unknown) => {
          slot.value = value;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = harness.index++;
      if (!harness.slots[index]) harness.slots[index] = { current: initial };
      return harness.slots[index];
    },
    useCallback(value: unknown) {
      harness.index++;
      return value;
    },
    useEffect: (operation: () => void, dependencies: unknown[]) =>
      effect(operation, dependencies, false),
    useLayoutEffect: (operation: () => void, dependencies: unknown[]) =>
      effect(operation, dependencies, true),
  };
});
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => harness.read }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener(_kind: string, callback: (state: string) => void) {
      harness.application = callback;
      return {
        remove() {
          harness.application = null;
        },
      };
    },
  },
}));
vi.mock("./browser-video-surface", () => ({
  bindBrowserVideoVisibility(_node: unknown, callback: (active: boolean) => void) {
    harness.visibility = callback;
    callback(harness.documentActive);
    return () => {
      harness.visibility = null;
    };
  },
  supportsBrowserVideo: () => true,
  createBrowserVideoEnvironment: () => ({
    environment: harness.environment,
    dispose() {
      harness.disposals += 1;
    },
  }),
}));

import { useBrowserVideo } from "./use-browser-video";

const packet = (sequence: number): BrowserVideoPacket => ({
  streamId: "s".repeat(32),
  captureGeneration: 1,
  sequence,
  timestampUs: sequence * 1000,
  type: sequence === 1 ? "key" : "delta",
  codec: "vp8",
  width: 1280,
  height: 800,
  dataBase64: "AA==",
  capturedAt: new Date().toISOString(),
  frame: {
    frameId: String(sequence).padStart(32, "x"),
    sessionId: "a".repeat(32),
    width: 1280,
    height: 800,
    capturedAt: new Date().toISOString(),
    runtimeId: "r".repeat(32),
    captureEpoch: 1,
    navigationGeneration: 1,
    viewportGeneration: 1,
  },
});
const drain = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function setup(retainDocumentDisplay = false) {
  let draw: (() => void) | null = null;
  const presented: number[] = [];
  const drawn: number[] = [];
  let quality: "high" | "low" = "high";
  let viewerToken = "v".repeat(32);
  let current = true;
  let mutationEpoch = 1;
  const identity = {
    sessionId: "a".repeat(32),
    runtimeId: "r".repeat(32),
    captureEpoch: 1,
    navigationGeneration: 1,
    viewportGeneration: 1,
  };
  let active = true;
  let bitrate: 2_000_000 | 5_000_000 | 12_000_000 | 24_000_000 = 12_000_000;
  let fps: 15 | 30 | 60 = 30;
  const environment: BrowserVideoDecodeEnvironment = {
    createDecoder(callbacks) {
      return {
        decodeQueueSize: 0,
        configure() {},
        close() {
          harness.decoderCloses += 1;
        },
        decode(value) {
          const timestamp = (value as { timestamp: number }).timestamp;
          callbacks.output({ timestamp, displayWidth: 1280, displayHeight: 800, close() {} });
        },
      };
    },
    createChunk: (value) => value,
    decodeBase64: () => new Uint8Array([0]),
    scheduleDraw(operation) {
      draw = operation;
      return () => {
        draw = null;
      };
    },
    draw(frame) {
      drawn.push(frame.timestamp);
    },
  };
  harness.environment = environment;
  harness.read = (input: BrowserVideoReadInput) =>
    new Promise<BrowserVideoReadReply>((resolve, reject) =>
      harness.reads.push({ input, resolve, reject }),
    );
  const render = () => {
    harness.index = 0;
    return useBrowserVideo({
      viewerToken,
      quality,
      active,
      bitrate,
      fps,
      epoch: () => mutationEpoch,
      viewport: () => ({ width: 1280, height: 800 }),
      // The mounted panel's real source predicate, fed a fake panel context, so a drift
      // in what the panel decides (for example consulting the input-only actionable flag)
      // fails here instead of in a copied predicate.
      isCurrent: (value, epoch) =>
        current &&
        isVideoSourceCurrent(
          {
            mounted: true,
            viewerActive: true,
            epoch: mutationEpoch,
            committedViewport: {
              sessionId: identity.sessionId,
              generation: identity.viewportGeneration,
            },
            state: {
              sessionId: identity.sessionId,
              runtimeId: identity.runtimeId,
              bridgeEpoch: identity.captureEpoch,
              navigationGeneration: identity.navigationGeneration,
              viewportGeneration: identity.viewportGeneration,
            } as unknown as BrowserState,
          },
          value,
          epoch,
        ),
      ...(retainDocumentDisplay
        ? {
            isDisplayCurrent: (value: BrowserVideoPacket) =>
              current &&
              Object.entries(identity).every(
                ([key, expected]) =>
                  key === "navigationGeneration" ||
                  value.frame[key as keyof typeof identity] === expected,
              ),
          }
        : {}),
      acceptState: () => true,
      onPresented(value) {
        presented.push(value.sequence);
      },
    });
  };
  const commit = () => {
    for (const run of harness.layouts.splice(0)) run();
    for (const run of harness.effects.splice(0)) run();
  };
  let result = render();
  commit();
  result.canvasRef({});
  result = render();
  commit();
  return {
    render,
    commit,
    drawn,
    presented,
    encoder(nextBitrate: typeof bitrate, nextFps: typeof fps) {
      bitrate = nextBitrate;
      fps = nextFps;
    },
    active(value: boolean) {
      active = value;
    },
    token(value: string) {
      viewerToken = value;
    },
    advanceEpoch() {
      mutationEpoch++;
    },
    identity(field: keyof typeof identity, value: string | number) {
      Object.assign(identity, { [field]: value });
    },
    obsolete() {
      current = false;
    },
    quality(value: "high" | "low") {
      quality = value;
    },
    reply(index: number, sequence: number, keyFrame = sequence === 1) {
      harness.reads[index]!.resolve({
        status: "ready",
        streamId: "s".repeat(32),
        state: {},
        packets: [{ ...packet(sequence), type: keyFrame ? "key" : "delta" }],
      } as BrowserVideoReadReply);
    },
    replyPackets(index: number, sequences: number[], display: number[] = []) {
      harness.reads[index]!.resolve({
        status: "ready",
        streamId: "s".repeat(32),
        state: {},
        packets: sequences.map((sequence) => ({
          ...packet(sequence),
          type: sequence === 1 ? "key" : "delta",
          // The host paints these but refuses them as input receipts.
          ...(display.includes(sequence) ? { actionable: false } : { actionable: true }),
        })),
      } as BrowserVideoReadReply);
    },
    disabled(index: number) {
      harness.reads[index]!.resolve({
        status: "unsupported",
        state: {},
        streamId: null,
        packets: [],
        reasonCode: "video-disabled",
        reason: "Encoded video is not enabled on this host",
      } as unknown as BrowserVideoReadReply);
    },
    capacity(index: number) {
      harness.reads[index]!.resolve({
        status: "unsupported",
        state: {},
        streamId: null,
        packets: [],
        reasonCode: "encoder-capacity",
        reason: "Three video profiles are active",
      } as unknown as BrowserVideoReadReply);
    },
    paint() {
      const operation = draw;
      draw = null;
      operation?.();
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  harness.slots = [];
  harness.index = 0;
  harness.effects = [];
  harness.layouts = [];
  harness.reads = [];
  harness.documentActive = true;
  harness.appState = "active";
  harness.visibility = null;
  harness.application = null;
  harness.disposals = 0;
  harness.decoderCloses = 0;
});
afterEach(() => {
  for (const slot of harness.slots) slot?.cleanup?.();
  vi.useRealTimers();
});

describe("video presentation lifecycle", () => {
  it("waits for first visibility commit, then publishes each actual canvas draw synchronously", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    expect(f.drawn).toEqual([1000]);
    expect(f.presented).toEqual([]);
    const result = f.render();
    f.commit();
    expect(result.frontRef.current?.sequence).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    f.reply(1, 2);
    await drain();
    f.paint();
    // No render/commit occurs here. Pixels and their input authority still agree.
    expect(result.frontRef.current?.sequence).toBe(2);
    expect(f.presented).toContain(2);
  });
  it("exposes fallback if the first painted frame becomes obsolete before visibility commit", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    f.obsolete();
    f.render();
    f.commit();
    const result = f.render();
    f.commit();
    expect(result.front).toBeNull();
    expect(result.frontRef.current).toBeNull();
    expect(f.presented).toEqual([]);
  });
  it("waits for an uncancelable old RPC before replacing quality", async () => {
    const f = setup();
    expect(harness.reads).toHaveLength(1);
    f.quality("low");
    f.render();
    f.commit();
    await drain();
    expect(harness.reads).toHaveLength(1);
    f.reply(0, 1);
    await drain();
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input.quality).toBe("low");
    expect(f.presented).toEqual([]);
  });
  it("revokes stale authority and requests fallback without erasing painted video", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    let result = f.render();
    f.commit();
    expect(result.frontRef.current).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(result.frontRef.current).toBeNull();
    result = f.render();
    f.commit();
    expect(result.front?.sequence).toBe(1);
    expect(result.fallbackRevision).toBeGreaterThan(0);
  });
  it("does not start a codec or request while the document is already hidden", async () => {
    harness.documentActive = false;
    const f = setup();
    await drain();
    expect(harness.reads).toHaveLength(0);
    harness.visibility?.(true);
    await drain();
    expect(harness.reads).toHaveLength(1);
    expect(harness.reads[0]!.input.requestKeyFrame).toBe(true);
    f.reply(0, 1);
  });
  it("releases decoding and stops background reads; resume waits for old RPC and requests a fresh key", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    const result = f.render();
    f.commit();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.reads).toHaveLength(2);
    harness.visibility?.(false);
    expect(result.frontRef.current).toBeNull();
    expect(harness.disposals).toBe(1);
    expect(harness.decoderCloses).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.reads).toHaveLength(2);
    harness.visibility?.(true);
    await drain();
    expect(harness.reads).toHaveLength(2);
    f.reply(1, 2);
    await drain();
    expect(harness.reads).toHaveLength(3);
    expect(harness.reads[2]!.input).toMatchObject({
      streamId: null,
      afterSequence: 0,
      requestKeyFrame: true,
    });
    f.paint();
    expect(f.presented).not.toContain(2);
  });
  it("cancels pending draws on application background and refuses a late visibility commit", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    f.render(); // deliberately leave the visibility layout commit pending
    harness.application?.("background");
    f.commit();
    expect(f.presented).toEqual([]);
    expect(f.render().frontRef.current).toBeNull();
    harness.visibility?.(true); // document active alone cannot override AppState
    await drain();
    expect(harness.reads).toHaveLength(1);
    harness.application?.("active");
    await drain();
    expect(harness.reads).toHaveLength(2);
    for (const slot of harness.slots) slot?.cleanup?.();
    expect(harness.visibility).toBeNull();
    expect(harness.application).toBeNull();
  });
  it("honors explicit panel suspension and unmount without restoring previous frame authority", async () => {
    const f = setup();
    f.reply(0, 1);
    await drain();
    f.paint();
    let result = f.render();
    f.commit();
    expect(result.frontRef.current).not.toBeNull();
    f.active(false);
    result = f.render();
    f.commit();
    expect(result.frontRef.current).toBeNull();
    expect(harness.disposals).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.reads).toHaveLength(1);
    f.active(true);
    f.render();
    f.commit();
    await drain();
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input.requestKeyFrame).toBe(true);
    for (const slot of harness.slots) slot?.cleanup?.();
    f.reply(1, 2);
    await drain();
    f.paint();
    expect(f.presented).not.toContain(2);
    expect(harness.disposals).toBe(2);
  });
  it("changes encoder settings through a fresh keyframe without overlapping the old read", async () => {
    const f = setup();
    expect(harness.reads[0]!.input).toMatchObject({ bitrate: 12_000_000, fps: 30 });
    f.encoder(24_000_000, 60);
    f.render();
    f.commit();
    await drain();
    expect(harness.reads).toHaveLength(1);
    f.reply(0, 1);
    await drain();
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input).toMatchObject({
      bitrate: 24_000_000,
      fps: 60,
      streamId: null,
      afterSequence: 0,
      requestKeyFrame: true,
    });
    f.paint();
    expect(f.presented).toEqual([]);
  });
  it("retries typed capacity only after2.5seconds while fallback stays visible, and clears soft error after paint", async () => {
    const f = setup();
    f.capacity(0);
    await drain();
    let result = f.render();
    f.commit();
    expect(result.front).toBeNull();
    expect(result.error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2499);
    expect(harness.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input).toMatchObject({
      streamId: null,
      afterSequence: 0,
      requestKeyFrame: true,
    });
    f.reply(1, 1);
    await drain();
    expect(f.render().error).not.toBeNull();
    f.paint();
    result = f.render();
    f.commit();
    expect(result.error).toBeNull();
    expect(result.frontRef.current).not.toBeNull();
  });
  it("decodes and paints a same-source display-only packet without breaking the delta chain or granting input", async () => {
    const f = setup();
    const front: (number | null)[] = [];
    for (const sequence of [1, 2, 3]) {
      f.replyPackets(sequence - 1, [sequence], [2]);
      await drain();
      f.paint();
      const result = f.render();
      f.commit();
      front.push(result.frontRef.current?.sequence ?? null);
      await vi.advanceTimersByTimeAsync(41);
    }
    // All three packets paint, so the codec chain 1 -> 2 -> 3 is intact.
    expect(f.drawn).toEqual([1000, 2000, 3000]);
    // The display-only packet never publishes input authority and does not leave the
    // older actionable receipt current; the next actionable packet does.
    expect(f.presented).not.toContain(2);
    expect(f.presented).toContain(3);
    expect(front).toEqual([1, null, 3]);
    // Each read continued the same stream without asking for a recovery keyframe.
    expect(harness.reads.slice(1, 4).map((read) => read.input.requestKeyFrame)).toEqual([
      false,
      false,
      false,
    ]);
  });
  it("still drops wrong-document display-only packets without decoding or painting them", async () => {
    const f = setup();
    f.identity("navigationGeneration", 2);
    f.replyPackets(0, [1, 2], [2]);
    await drain();
    f.paint();
    expect(f.drawn).toEqual([]);
    expect(f.presented).toEqual([]);
  });
  it("a host that disabled video stops reads and releases the decoder without an error", async () => {
    const f = setup();
    f.disabled(0);
    await drain();
    const result = f.render();
    f.commit();
    expect(result.front).toBeNull();
    expect(result.error).toBeNull();
    expect(harness.disposals).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.reads).toHaveLength(1);
  });
  it("hidden/unmounted viewers cancel the capacity retry timer and cannot restart background reads", async () => {
    const f = setup();
    f.capacity(0);
    await drain();
    harness.visibility?.(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.reads).toHaveLength(1);
    harness.visibility?.(true);
    await drain();
    expect(harness.reads).toHaveLength(2);
    f.capacity(1);
    await drain();
    for (const slot of harness.slots) slot?.cleanup?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.reads).toHaveLength(2);
  });
});

it("tags video viewing expiry with its exact token and ignores an obsolete late error", async () => {
  const f = setup();
  const expired = Object.assign(new Error("Request failed: Viewer token is invalid or expired"), {
    code: "handler_error",
  });
  harness.reads[0]!.reject(expired);
  await drain();
  expect(f.render().error).toBe(expired);
  expect(f.render().errorViewerToken).toBe("v".repeat(32));
  f.token("replacement".repeat(3));
  f.render();
  f.commit();
  await drain();
  expect(f.render().error).toBeNull();
  expect(f.render().errorViewerToken).toBeNull();
  const pending = harness.reads.at(-1)!;
  f.token("new".repeat(11));
  f.render();
  f.commit();
  pending.reject(expired);
  await drain();
  expect(f.render().error).toBeNull();
  expect(f.render().errorViewerToken).toBeNull();
});

it("a same-source empty reset retains displayed video while synchronously revoking input", async () => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  const rendered = f.render();
  f.commit();
  expect(rendered.frontRef.current?.sequence).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  harness.reads[1]!.resolve({
    status: "reset",
    state: {},
    streamId: null,
    packets: [],
  } as unknown as BrowserVideoReadReply);
  await drain();
  // The old rendered canvas can still cover the image until React commits.
  // Its mutable authority must already be gone at this point.
  expect(rendered.frontRef.current).toBeNull();
  expect(f.render().front?.sequence).toBe(1);
  f.commit();
  expect(rendered.frontRef.current).toBeNull();
  await vi.advanceTimersByTimeAsync(40);
  expect(harness.reads[2]!.input.afterSequence).toBe(0);
  expect(harness.reads[2]!.input.streamId).toBeNull();
  expect(harness.reads[2]!.input.requestKeyFrame).toBe(true);
  f.reply(2, 3, true);
  await drain();
  expect(f.render().front?.sequence).toBe(1);
  expect(rendered.frontRef.current).toBeNull();
  f.paint();
  const fresh = f.render();
  f.commit();
  expect(fresh.frontRef.current?.sequence).toBe(3);
});

describe("bounded viewing-read recovery", () => {
  it("recovers a timed-out read through a fresh key without replaying refresh or hiding failure before paint", async () => {
    const f = setup();
    const failure = new Error("Request failed: Plugin RPC timed out: shared-browser.invoke");
    harness.reads[0]!.reject(failure);
    await drain();
    expect(f.render().error).toBe(failure);
    for (let index = 0; index < 20; index++) f.render().refresh();
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input).toMatchObject({
      afterSequence: 0,
      streamId: null,
      requestKeyFrame: true,
    });
    f.reply(1, 10, true);
    await drain();
    expect(f.render().error).toBe(failure);
    f.paint();
    const result = f.render();
    f.commit();
    expect(result.error).toBeNull();
    expect(result.frontRef.current?.sequence).toBe(10);
  });

  it("exhausts retries despite ordinary refresh, then coalesces explicit viewing retry", async () => {
    const f = setup();
    for (const [index, delay] of [500, 1500, 3000].entries()) {
      harness.reads[index]!.reject(new Error("Transient source read failed"));
      await drain();
      await vi.advanceTimersByTimeAsync(delay);
    }
    const failure = new Error("Source remains unavailable");
    harness.reads[3]!.reject(failure);
    await drain();
    expect(f.render().error).toBe(failure);
    for (let index = 0; index < 20; index++) f.render().refresh();
    expect(harness.reads).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reads).toHaveLength(4);
    const result = f.render();
    for (let index = 0; index < 20; index++) result.refresh();
    await drain();
    expect(harness.reads).toHaveLength(4);
    for (let index = 0; index < 20; index++) result.retry();
    await drain();
    expect(harness.reads).toHaveLength(5);
    expect(f.render().error).toBe(failure);
    f.reply(4, 20, true);
    await drain();
    f.paint();
    expect(f.render().error).toBeNull();
  });

  it("leaves exact viewer expiry to the existing viewing-only reattachment policy", async () => {
    const f = setup();
    const expired = {
      code: "handler_error",
      message:
        "Request failed: Viewer token is invalid or expired requestType=plugin.rpc.invoke.request code=handler_error",
    };
    harness.reads[0]!.reject(expired);
    await drain();
    await vi.advanceTimersByTimeAsync(60_000);
    f.render().refresh();
    f.render().retry();
    await drain();
    expect(harness.reads).toHaveLength(1);
    expect(f.render().error).toBe(expired);
    expect(f.render().errorViewerToken).toBe("v".repeat(32));
  });

  it("suspension cancels retry waits and resumes only a new single-flight key read", async () => {
    setup();
    harness.reads[0]!.reject(new Error("Transient source failure"));
    await drain();
    harness.visibility!(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.reads).toHaveLength(1);
    harness.visibility!(true);
    await drain();
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input.requestKeyFrame).toBe(true);
  });

  it("discarded old-viewer failures cannot retry or replace the new viewer error state", async () => {
    const f = setup();
    f.token("n".repeat(32));
    f.render();
    f.commit();
    harness.reads[0]!.reject(new Error("Old viewer read failed late"));
    await drain();
    expect(harness.reads).toHaveLength(2);
    expect(harness.reads[1]!.input.viewerToken).toBe("n".repeat(32));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.reads).toHaveLength(2);
    expect(f.render().error).toBeNull();
  });
});

/** Exhaust one incarnation without painting, leaving no automatic read retry. */
async function exhaustViewingReader() {
  for (const [index, delay] of [500, 1500, 3000].entries()) {
    harness.reads[index]!.reject(new Error("Read remains unavailable"));
    await drain();
    await vi.advanceTimersByTimeAsync(delay);
  }
  harness.reads[3]!.reject(new Error("Read budget exhausted"));
  await drain();
}

it("retains one explicit navigation retry until the remaining cooldown boundary", async () => {
  const f = setup();
  await exhaustViewingReader();
  await vi.advanceTimersByTimeAsync(1000);
  for (let index = 0; index < 20; index++) f.render().retry();
  for (let index = 0; index < 20; index++) f.render().refresh();
  expect(harness.reads).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1999);
  expect(harness.reads).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.reads).toHaveLength(5);
  expect(harness.reads[4]!.input).toMatchObject({
    afterSequence: 0,
    streamId: null,
    requestKeyFrame: true,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(harness.reads).toHaveLength(5);
});

it.each(["suspend", "unmount", "viewer replacement"])(
  "cancels a queued explicit cooldown retry on %s",
  async (reason) => {
    const f = setup();
    await exhaustViewingReader();
    const retained = f.render().retry;
    retained();
    if (reason === "suspend") {
      harness.visibility!(false);
    } else if (reason === "unmount") {
      for (const slot of harness.slots) slot?.cleanup?.();
    } else {
      f.token("n".repeat(32));
      f.render();
      f.commit();
      await drain();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.reads).toHaveLength(reason === "viewer replacement" ? 5 : 4);
    if (reason === "viewer replacement") {
      expect(harness.reads[4]!.input.viewerToken).toBe("n".repeat(32));
    }
  },
);

it("a local input epoch revokes video input without exposing the underlying JPEG", async () => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  f.advanceEpoch();
  const held = f.render();
  f.commit();
  expect(held.front?.sequence).toBe(1);
  expect(held.frontRef.current).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  f.reply(1, 2, true);
  await drain();
  expect(held.frontRef.current).toBeNull();
  f.paint();
  const fresh = f.render();
  f.commit();
  expect(fresh.frontRef.current?.sequence).toBe(2);
});

it("an empty reset fences a video paint whose React visibility commit is still pending", async () => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  await vi.advanceTimersByTimeAsync(1);
  harness.reads[1]!.resolve({
    status: "reset",
    state: {},
    streamId: null,
    packets: [],
  } as unknown as BrowserVideoReadReply);
  await drain();
  f.commit();
  const held = f.render();
  expect(held.front?.sequence).toBe(1);
  expect(held.frontRef.current).toBeNull();
});

it.each([
  ["sessionId", "replacement"],
  ["runtimeId", "replacement"],
  ["captureEpoch", 2],
  ["navigationGeneration", 2],
  ["viewportGeneration", 2],
] as const)("does not retain old video across changed %s", async (field, value) => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  f.identity(field, value);
  f.render();
  f.commit();
  expect(f.render().front).toBeNull();
  expect(f.render().frontRef.current).toBeNull();
});

it("stall fallback retains painted video until the exact newly decoded image handoff", async () => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  await vi.advanceTimersByTimeAsync(1);
  harness.reads[1]!.resolve({
    status: "reset",
    state: {},
    streamId: null,
    packets: [],
  } as unknown as BrowserVideoReadReply);
  await drain();
  expect(f.render().front?.sequence).toBe(1);
  expect(f.render().frontRef.current).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  const held = f.render();
  f.commit();
  expect(held.front?.sequence).toBe(1);
  expect(held.frontRef.current).toBeNull();
  expect(held.fallbackRevision).toBeGreaterThan(0);
  held.completeFallback(held.fallbackRevision + 1);
  expect(f.render().front?.sequence).toBe(1);
  held.completeFallback(held.fallbackRevision);
  expect(f.render().front).toBeNull();
});

it("holds navigation pixels without starting fallback or granting old document authority", async () => {
  const f = setup(true);
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  f.identity("navigationGeneration", 2);
  let result = f.render();
  f.commit();
  result = f.render();
  expect(result.front?.sequence).toBe(1);
  expect(result.frontRef.current).toBeNull();
  expect(result.fallbackRevision).toBe(0);
  f.identity("runtimeId", "replacement");
  f.render();
  f.commit();
  expect(f.render().front).toBeNull();
});

it("rapid local presses preserve one decoder and delta cursor while old-read paint cannot grant input", async () => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  await vi.advanceTimersByTimeAsync(1);
  const initialCloses = harness.decoderCloses;
  for (let index = 0; index < 5; index++) {
    f.advanceEpoch();
    f.render();
    f.commit();
    f.render().refresh();
    f.reply(index * 2 + 1, index * 2 + 2, false);
    await drain();
    f.paint();
    let result = f.render();
    f.commit();
    expect(result.front?.sequence).toBe(index * 2 + 2);
    expect(result.frontRef.current).toBeNull();
    expect(f.presented).not.toContain(index * 2 + 2);
    await vi.advanceTimersByTimeAsync(1);
    const nextRead = harness.reads[index * 2 + 2]!;
    expect(nextRead.input.afterSequence).toBe(index * 2 + 2);
    expect(nextRead.input.streamId).toBe("s".repeat(32));
    expect(nextRead.input.requestKeyFrame).toBe(false);
    f.reply(index * 2 + 2, index * 2 + 3, false);
    await drain();
    f.paint();
    result = f.render();
    f.commit();
    expect(result.frontRef.current?.sequence).toBe(index * 2 + 3);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(harness.decoderCloses).toBe(initialCloses);
  expect(f.drawn).toHaveLength(11);
});

it("stops hidden-panel JPEG requests, including a queued refresh follow-up", async () => {
  const { useBrowserImageCapture } = await import("./use-browser-image-capture");
  const capture = vi.fn();
  let active = true;
  const render = () => {
    harness.index = 0;
    return useBrowserImageCapture({
      active,
      viewerToken: "viewer",
      quality: "high",
      activeInput: false,
      videoOwnsPresentation: false,
      hasVideoPresentation: () => false,
      refreshVideo: vi.fn(),
      mutationEpoch: () => 0,
      knownFrame: () => null,
      capture,
    });
  };
  const shown = render();
  expect(imageQuery.options?.enabled).toBe(true);
  const queuedCapture = imageQuery.options!.queryFn;
  active = false;
  const hidden = render();
  expect(imageQuery.options?.enabled).toBe(false);
  await expect(queuedCapture()).rejects.toBeDefined();
  hidden.refreshCapture();
  hidden.retryFrameCapture();
  shown.refreshCapture();
  expect(capture).not.toHaveBeenCalled();
  expect(imageQuery.refetch).not.toHaveBeenCalled();
  active = true;
  render().refreshCapture();
  expect(imageQuery.refetch).toHaveBeenCalledOnce();
});

it.each([false, true])("keeps a healthy quiet video after local input: %s", async (afterInput) => {
  const f = setup();
  f.reply(0, 1);
  await drain();
  f.paint();
  f.render();
  f.commit();
  if (afterInput) {
    f.advanceEpoch();
    f.render();
    f.commit();
  }
  await vi.advanceTimersByTimeAsync(1);
  for (let index = 1; index <= 8; index++) {
    harness.reads[index]!.resolve({
      status: "waiting",
      streamId: "s".repeat(32),
      state: {},
      packets: [],
    } as unknown as BrowserVideoReadReply);
    await drain();
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(f.render().fallbackRevision).toBe(0);
  if (afterInput) {
    expect(f.render().frontRef.current).toBeNull();
  } else {
    expect(f.render().frontRef.current?.sequence).toBe(1);
  }
  // A genuinely stuck next read still invokes the existing fallback watchdog.
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.render().fallbackRevision).toBeGreaterThan(0);
});
