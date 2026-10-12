/** Actual runtime JPEG path, fake CDP only. Swap time must survive transport delay. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

function jpeg(tag: number): string {
  return Buffer.from([
    255,
    216,
    255,
    224,
    0,
    3,
    tag,
    255,
    192,
    0,
    11,
    8,
    3,
    32,
    5,
    0,
    1,
    1,
    17,
    0,
    255,
    217,
  ]).toString("base64");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const runtime = new AgentBrowserRuntime({
    nativeVideo: true,
    binaryPath: "/tmp/unlaunched",
    executablePath: "/tmp/unlaunched",
    profilePath: "/tmp/uncreated",
    ipcDirectory: "/tmp/uncreated",
    session: "source-order-fixture",
  });
  const connection = Object.assign(new EventEmitter(), { isOpen: true });
  const page = Object.assign(new EventEmitter(), {
    connection,
    send: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
      if (method === "Page.getNavigationHistory")
        return {
          currentIndex: 0,
          entries: [{ id: 1, url: "https://source.invalid/", title: "Fixture" }],
        };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: jpeg(9) };
      return {};
    }),
  });
  Object.assign(runtime, {
    page,
    connection,
    emulationAppliedPage: page,
    screencastActive: true,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  const internal = runtime as unknown as {
    invalidateScreencastFrame(): void;
    onScreencastFrame(page: unknown, event: unknown): void;
    bindPageEvents(page: unknown): Promise<void>;
  };
  const emit = (sourceMs: number | undefined, tag = 1) =>
    internal.onScreencastFrame(page, {
      data: jpeg(tag),
      sessionId: 17,
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 800,
        ...(sourceMs === undefined ? {} : { timestamp: sourceMs / 1000 }),
      },
    });
  return { runtime, internal, page, emit };
}

/** Zero-wait stream polling still uses a native timer; settle that fake timer
 * without advancing the source clock or extending the freshness assertion. */
async function readFrame(runtime: AgentBrowserRuntime) {
  const pending = runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
  await vi.advanceTimersByTimeAsync(0);
  return pending;
}

it("preserves native swap time and its remaining one-second source lifetime", async () => {
  const { runtime, emit } = fixture();
  const sourceMs = Date.now() - 600;
  emit(sourceMs);
  const frame = await readFrame(runtime);
  expect(frame.transport).toBe("cdp-screencast");
  expect(frame.capturedAt).toBe(new Date(sourceMs).toISOString());
  await vi.advanceTimersByTimeAsync(401);
  expect((await readFrame(runtime)).transport).toBe("screenshot");
});

it.each([20, 10_000])(
  "refuses a queued pre-input swap aged %sms even when it arrives after invalidation",
  async (ageMs) => {
    const { runtime, internal, page, emit } = fixture();
    const sourceMs = Date.now() - ageMs;
    internal.invalidateScreencastFrame();
    emit(sourceMs);
    const frame = await readFrame(runtime);
    expect(frame.transport).toBe("screenshot");
    expect(frame.dataBase64).toBe(jpeg(9));
    expect(page.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 17 });
  },
);

it.each([0, 20, 50])(
  "post-input source offset +%sms cannot borrow clock tolerance to authorize old pixels",
  async (offsetMs) => {
    const { runtime, internal, page, emit } = fixture();
    internal.invalidateScreencastFrame();
    emit(Date.now() + offsetMs);
    const frame = await readFrame(runtime);
    expect(frame.transport).toBe("screenshot");
    expect(frame.dataBase64).toBe(jpeg(9));
    expect(page.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 17 });
  },
);

it("a genuinely later swap beyond post-input uncertainty keeps its native timestamp", async () => {
  const { runtime, internal, emit } = fixture();
  internal.invalidateScreencastFrame();
  await vi.advanceTimersByTimeAsync(51);
  const sourceMs = Date.now();
  emit(sourceMs);
  const frame = await readFrame(runtime);
  expect(frame.transport).toBe("cdp-screencast");
  expect(frame.capturedAt).toBe(new Date(sourceMs).toISOString());
});

it.each([undefined, NaN, Infinity, 1_800_000_000_051, 1_799_999_998_999])(
  "refuses missing, invalid, future or expired source time %s",
  async (sourceMs) => {
    const { runtime, emit } = fixture();
    emit(sourceMs);
    expect((await readFrame(runtime)).transport).toBe("screenshot");
  },
);

it("out-of-order or duplicate swaps cannot replace a newer admitted JPEG", async () => {
  const { runtime, emit } = fixture();
  emit(Date.now(), 2);
  const newest = await readFrame(runtime);
  emit(Date.now() - 10, 1);
  emit(Date.now(), 3);
  expect(await readFrame(runtime)).toBe(newest);
  expect(newest.dataBase64).toBe(jpeg(2));
});

it.each(["Page.frameNavigated", "Page.navigatedWithinDocument"])(
  "%s revokes cached and queued former-document JPEG",
  async (event) => {
    const { runtime, internal, page, emit } = fixture();
    await internal.bindPageEvents(page);
    const oldSourceMs = Date.now();
    emit(oldSourceMs);
    const prior = await readFrame(runtime);
    await vi.advanceTimersByTimeAsync(20);
    page.emit(
      event,
      event === "Page.frameNavigated"
        ? { frame: { id: "root", loaderId: "next", url: "https://next.invalid/" } }
        : { frameId: "root", url: "https://next.invalid/#next" },
    );
    emit(oldSourceMs, 2);
    const next = await readFrame(runtime);
    expect(next).not.toBe(prior);
    expect(next.transport).toBe("screenshot");
    expect(next.dataBase64).toBe(jpeg(9));
  },
);

it("child-frame and unrelated same-document events leave current main-frame pixels intact", async () => {
  const { runtime, internal, page, emit } = fixture();
  await internal.bindPageEvents(page);
  emit(Date.now());
  const before = await readFrame(runtime);
  page.emit("Page.frameNavigated", { frame: { id: "child", parentId: "root" } });
  page.emit("Page.navigatedWithinDocument", { frameId: "child", url: "https://child.invalid/#x" });
  expect(await readFrame(runtime)).toBe(before);
});
