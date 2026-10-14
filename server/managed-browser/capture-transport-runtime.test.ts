import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

/** Header fixture exercises actual bounded JPEG validation without launching Chromium. */
function jpeg(tag = 1): string {
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
let clock = 10_000;
beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + clock);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const runtime = new AgentBrowserRuntime({
    nativeVideo: true,
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "test",
  });
  const calls: string[] = [];
  let capture: (params: Record<string, unknown>) => Promise<{ data: string }> = async () => ({
    data: jpeg(),
  });
  const page = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === "Page.captureScreenshot") return capture(params);
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      return {};
    },
  };
  const control = runtime as unknown as {
    requirePage: () => Promise<typeof page>;
    page: typeof page;
    invalidateScreencastFrame: () => void;
    onScreencastFrame: (source: typeof page, event: object) => void;
  };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    screencastActive: true,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  control.requirePage = async () => control.page;
  const emit = (timestamp: number, source = page) =>
    control.onScreencastFrame(source, {
      data: jpeg(2),
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 800,
        timestamp: (Date.now() + timestamp / 1000) / 1000,
      },
      sessionId: 17,
    });
  return {
    runtime,
    control,
    page,
    calls,
    emit,
    setCapture: (next: typeof capture) => {
      capture = next;
    },
  };
}

describe("runtime capture hysteresis", () => {
  it("captures only the visible viewport without Chromium's touch-resetting beyond-viewport mode", async () => {
    const { runtime, setCapture } = fixture();
    setCapture(async (params) => {
      expect(params.captureBeyondViewport).toBe(false);
      expect(params.clip).toEqual({ x: 0, y: 0, width: 1280, height: 800, scale: 1 });
      return { data: jpeg() };
    });
    expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("screenshot");
  });

  it("does not bounce to CDP after a screenshot-induced event; reuses only fresh exact-request pixels", async () => {
    const { runtime, calls, emit, setCapture } = fixture();
    setCapture(async () => {
      emit(clock);
      return { data: jpeg() };
    });
    const first = await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    expect(first.transport).toBe("screenshot");
    clock += 250;
    expect(await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).toBe(first);
    expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(1);
    clock += 751;
    expect(await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).not.toBe(first);
    expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(2);
    await runtime.frame(100, 90, 0);
    await runtime.frame(101, 90, 0);
    expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(4);
  });

  it("only sustained valid current-session events recover CDP after dwell", async () => {
    const { runtime, page, emit } = fixture();
    await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    clock += 1100;
    emit(1);
    clock += 250;
    emit(2);
    clock += 250;
    emit(3, { ...page });
    expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("screenshot");
    clock += 300;
    emit(3);
    clock += 250;
    emit(4);
    clock += 250;
    emit(5);
    expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
  });

  it("late screenshot completion after input cannot return or restore old cached pixels", async () => {
    const { runtime, control, setCapture } = fixture();
    const shot = Promise.withResolvers<{ data: string }>();
    const started = Promise.withResolvers<void>();
    setCapture(async () => {
      started.resolve();
      return shot.promise;
    });
    const pending = runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    await started.promise;
    await runtime.insertText("owned-fixture");
    shot.resolve({ data: jpeg() });
    await expect(pending).rejects.toThrow("capture was invalidated");
    setCapture(async () => ({ data: jpeg(3) }));
    const fresh = await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    expect(fresh.dataBase64).toBe(jpeg(3));
    control.invalidateScreencastFrame();
    setCapture(async () => ({ data: jpeg(4) }));
    expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).dataBase64).toBe(jpeg(4));
  });

  it("late screenshot completion from a replaced page cannot authorize a frame", async () => {
    const { runtime, control, page, setCapture } = fixture();
    const shot = Promise.withResolvers<{ data: string }>();
    const started = Promise.withResolvers<void>();
    setCapture(async () => {
      started.resolve();
      return shot.promise;
    });
    const pending = runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    await started.promise;
    control.page = { ...page };
    control.invalidateScreencastFrame();
    shot.resolve({ data: jpeg() });
    await expect(pending).rejects.toThrow("capture was invalidated");
  });
});

it("honors low/medium quality independently while high viewers keep the shared stream", async () => {
  const { runtime, calls, emit, setCapture } = fixture();
  const qualities: unknown[] = [];
  setCapture(async (params) => {
    qualities.push(params.quality);
    return { data: jpeg() };
  });
  emit(1);
  expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
  const low = await runtime.frame(100, 70, 0);
  expect(low.transport).toBe("screenshot");
  expect(await runtime.frame(100, 70, 0)).toBe(low);
  expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
  expect((await runtime.frame(100, 90, 0)).transport).toBe("screenshot");
  expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
  expect(qualities).toEqual([70, 90]);
  expect(calls).not.toContain("Page.startScreencast");
  expect(calls).not.toContain("Page.stopScreencast");
});

it("reduces quality only to satisfy the byte cap and never substitutes a cached high-quality frame", async () => {
  const { runtime, setCapture } = fixture();
  const qualities: unknown[] = [];
  setCapture(async (params) => {
    qualities.push(params.quality);
    return { data: params.quality === 70 ? jpeg() + "AAAA".repeat(50) : jpeg() };
  });
  await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
  expect((await runtime.frame(100, 70, 0)).transport).toBe("screenshot");
  expect(qualities).toEqual([DEFAULT_JPEG_QUALITY, 70, 65]);
});

it("keeps native video alive for valid JPEG stream and exact cached screenshot fastpaths", async () => {
  const { runtime, emit } = fixture();
  const firstStop = vi.fn(async () => {});
  Object.assign(runtime, { video: { stop: firstStop } });
  emit(1);
  expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
  expect(firstStop).not.toHaveBeenCalled();
  const screenshot = await runtime.frame(100, 85, 0);
  expect(firstStop).toHaveBeenCalledOnce();
  const nextStop = vi.fn(async () => {});
  Object.assign(runtime, { video: { stop: nextStop } });
  expect(await runtime.frame(100, 85, 0)).toBe(screenshot);
  expect(nextStop).not.toHaveBeenCalled();
  await runtime.stopVideo();
});

describe("native snapshot capture path", () => {
  function nativeFixture(snapshot: (control: Record<string, unknown>) => Promise<unknown>) {
    const base = fixture();
    const stop = vi.fn(async () => {});
    const snapshotCalls: { quality: number; maxBytes: number }[] = [];
    const internal = base.runtime as unknown as Record<string, unknown> & {
      capturePolicy: { invalidate(): void };
    };
    const video = {
      stop,
      snapshot: vi.fn(async (input: { quality: number; maxBytes: number }) => {
        snapshotCalls.push(input);
        return snapshot(internal);
      }),
    };
    Object.assign(base.runtime, { video, connection: { isOpen: true } });
    return { ...base, stop, video, snapshotCalls, internal };
  }
  const live = (overrides: Record<string, unknown> = {}) => ({
    dataBase64: jpeg(3),
    byteLength: Buffer.byteLength(jpeg(3), "base64"),
    width: 1280,
    height: 800,
    capturedAt: new Date(Date.now() - 200).toISOString(),
    capturedAtMonotonicMs: clock - 200,
    ...overrides,
  });

  it("serves quality-mismatch captures from the live track without stopping video or calling CDP", async () => {
    const { runtime, calls, stop, snapshotCalls } = nativeFixture(async () => live());
    const frame = await runtime.frame(100, 70, 0);
    expect(frame).toMatchObject({ transport: "native-snapshot", width: 1280, height: 800 });
    expect(frame.capturedAt).toBe(new Date(1_800_000_000_000 + 10_000 - 200).toISOString());
    expect(snapshotCalls).toEqual([{ quality: 70, maxBytes: 100 }]);
    expect(stop).not.toHaveBeenCalled();
    expect(calls).not.toContain("Page.captureScreenshot");
  });

  it("serves unhealthy-stream fallback captures from the live track too", async () => {
    const { runtime, calls, stop } = nativeFixture(async () => live());
    const frame = await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
    expect(frame.transport).toBe("native-snapshot");
    expect(stop).not.toHaveBeenCalled();
    expect(calls).not.toContain("Page.captureScreenshot");
  });

  it("caches by quality with age measured from the source capture time, never relabelled as new", async () => {
    const { runtime, snapshotCalls } = nativeFixture(async () => live());
    const first = await runtime.frame(100, 70, 0);
    clock += 700; // 900ms after source capture
    expect(await runtime.frame(100, 70, 0)).toBe(first);
    expect(snapshotCalls).toHaveLength(1);
    clock += 200; // 1100ms after source capture, though only 900ms after arrival
    const next = await runtime.frame(100, 70, 0);
    expect(next).not.toBe(first);
    expect(snapshotCalls).toHaveLength(2);
  });

  it("falls back to the arbitrated screenshot when the snapshot refuses or throws", async () => {
    for (const refuse of [async () => null, async () => { throw new Error("helper refused"); }]) {
      const { runtime, calls, stop } = nativeFixture(refuse);
      const frame = await runtime.frame(100, 70, 0);
      expect(frame.transport).toBe("screenshot");
      expect(stop).toHaveBeenCalledOnce();
      expect(calls).toContain("Page.captureScreenshot");
    }
  });

  it.each([
    ["document", (control: Record<string, unknown>) => { control.documentGeneration = Number(control.documentGeneration) + 1; }],
    ["attachment", (control: Record<string, unknown>) => { control.attachmentGeneration = Number(control.attachmentGeneration) + 1; }],
    ["viewport", (control: Record<string, unknown>) => { control.viewport = { ...(control.viewport as object) }; }],
    ["capture policy", (control: Record<string, unknown> & { capturePolicy: { invalidate(): void } }) => { control.capturePolicy.invalidate(); }],
  ])("refuses and never caches a snapshot whose %s changed while it was pending", async (_label, change) => {
    const { runtime, calls, snapshotCalls } = nativeFixture(async (control) => {
      change(control as never);
      return live();
    });
    const frame = await runtime.frame(100, 70, 0);
    expect(frame.transport).toBe("screenshot");
    expect(calls).toContain("Page.captureScreenshot");
    expect(snapshotCalls).toHaveLength(1);
  });

  it.each([
    ["undecodable JPEG", { dataBase64: Buffer.from("not a jpeg").toString("base64"), byteLength: 10 }],
    ["wrong reported size", { width: 1279 }],
    ["bytes above the caller budget", { byteLength: 101 }],
  ])("refuses a snapshot with %s", async (_label, overrides) => {
    const { runtime, calls } = nativeFixture(async () => live(overrides));
    expect((await runtime.frame(100, 70, 0)).transport).toBe("screenshot");
    expect(calls).toContain("Page.captureScreenshot");
  });

  it("does not snapshot while video is retiring or when internally opted out", async () => {
    const retiring = nativeFixture(async () => live());
    Object.assign(retiring.runtime, { videoRetirement: Promise.resolve() });
    expect((await retiring.runtime.frame(100, 70, 0)).transport).toBe("screenshot");
    expect(retiring.snapshotCalls).toHaveLength(0);
    const optedOut = nativeFixture(async () => live());
    Object.assign(optedOut.runtime, { nativeSnapshots: false });
    expect((await optedOut.runtime.frame(100, 70, 0)).transport).toBe("screenshot");
    expect(optedOut.snapshotCalls).toHaveLength(0);
  });

  it("does not snapshot when a screencast frame or exact cache already answers", async () => {
    const { runtime, emit, snapshotCalls } = nativeFixture(async () => live());
    emit(1);
    expect((await runtime.frame(100, DEFAULT_JPEG_QUALITY, 0)).transport).toBe("cdp-screencast");
    expect(snapshotCalls).toHaveLength(0);
  });
});
