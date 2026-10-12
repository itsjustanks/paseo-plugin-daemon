/** Actual runtime entry points with owned fake CDP, no Chromium/process fixture. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { AgentBrowserRuntime, type RuntimeFrame } from "./agent-browser-runtime";
import { JPEG_CAPTURE_IDLE_MS } from "./jpeg-capture-demand";

function jpeg(tag: number) {
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
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup() {
  const runtime = new AgentBrowserRuntime({
    nativeVideo: true,
    binaryPath: "/tmp/unlaunched",
    executablePath: "/tmp/unlaunched-chrome",
    profilePath: "/tmp/uncreated-p",
    ipcDirectory: "/tmp/uncreated-i",
    session: "fixture",
  });
  const page = { send: vi.fn(async (_method: string, _params?: unknown) => ({})) };
  let tag = 0;
  const internal = runtime as unknown as {
    page: typeof page;
    requirePage(): Promise<typeof page>;
    startScreencastSession(source: typeof page): Promise<void>;
    onScreencastFrame(source: typeof page, event: unknown): void;
    captureScreenshot(budget: number, quality: number, preserve?: boolean): Promise<RuntimeFrame>;
    screencastActive: boolean;
    invoke(args: string[]): Promise<unknown>;
  };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  internal.requirePage = vi.fn(async () => page);
  const emit = () =>
    internal.onScreencastFrame(page, {
      sessionId: 7,
      data: jpeg(++tag),
      metadata: { timestamp: (Date.now() + tag / 1000) / 1000 },
    });
  internal.startScreencastSession = vi.fn(async () => {
    emit();
  });
  internal.captureScreenshot = vi.fn(
    async (): Promise<RuntimeFrame> => ({
      width: 1280,
      height: 800,
      transport: "screenshot",
      dataBase64: jpeg(++tag),
      byteLength: 24,
      capturedAt: new Date().toISOString(),
    }),
  );
  return { runtime, internal, page, emit };
}
/** A restored stream's first swap can fall inside the conservative source
 * margin. Settle zero-wait polling so the honest screenshot fallback can finish. */
async function readFrame(runtime: AgentBrowserRuntime, quality: number = DEFAULT_JPEG_QUALITY) {
  const pending = runtime.frame(100, quality, 0);
  await vi.advanceTimersByTimeAsync(0);
  return pending;
}

it("lazy image/agent read starts shared JPEG once, idle video-only interval stops it, fresh read restarts", async () => {
  const { runtime, internal, page, emit } = setup();
  expect(internal.startScreencastSession).not.toHaveBeenCalled();
  const first = await readFrame(runtime);
  await vi.advanceTimersByTimeAsync(1500);
  emit();
  await readFrame(runtime);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  expect(page.send).toHaveBeenCalledWith("Page.stopScreencast", {}, { mutation: true });
  expect(internal.screencastActive).toBe(false);
  const renewed = await readFrame(runtime);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(2);
  expect(renewed.dataBase64).not.toBe(first.dataBase64);
  await runtime.stopScreencast();
});
it("nonmatching viewer quality stays screenshot-only and cannot keep JPEG95 running", async () => {
  const { runtime, internal } = setup();
  for (const quality of [70, 90, 100]) await readFrame(runtime, quality);
  expect(internal.startScreencastSession).not.toHaveBeenCalled();
  expect(internal.captureScreenshot).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  expect(internal.screencastActive).toBe(false);
});
it("switching to screenshot-only quality does not renew the former shared stream", async () => {
  const { runtime, internal } = setup();
  await readFrame(runtime);
  for (let i = 0; i < 7; i++) {
    await vi.advanceTimersByTimeAsync(500);
    await readFrame(runtime, 100);
  }
  expect(internal.screencastActive).toBe(false);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(1);
});

it("stream startup and screenshot completion both pin retirement beyond the idle deadline", async () => {
  const { runtime, internal, page, emit } = setup();
  const startup = Promise.withResolvers<void>();
  internal.startScreencastSession = vi.fn(async () => {
    await startup.promise;
    emit();
  });
  const read = runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(page.send).not.toHaveBeenCalledWith("Page.stopScreencast", {}, { mutation: true });
  startup.resolve();
  await read;
  const screenshot = Promise.withResolvers<RuntimeFrame>();
  internal.captureScreenshot = vi.fn(() => screenshot.promise);
  const fallback = runtime.frame(100, 100, 0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(internal.screencastActive).toBe(true);
  screenshot.resolve({
    width: 1280,
    height: 800,
    transport: "screenshot",
    dataBase64: jpeg(9),
    byteLength: 24,
    capturedAt: new Date().toISOString(),
  });
  await fallback;
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  expect(internal.screencastActive).toBe(false);
});
it("renewed read waits for exact old stop acknowledgment before restarting", async () => {
  const { runtime, internal, page } = setup();
  await readFrame(runtime);
  const stop = Promise.withResolvers<object>();
  page.send.mockImplementation(async (method) =>
    method === "Page.stopScreencast" ? await stop.promise : {},
  );
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  const renewed = runtime.frame(100, DEFAULT_JPEG_QUALITY, 0);
  await vi.advanceTimersByTimeAsync(100);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(1);
  stop.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  await renewed;
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(2);
  await runtime.stopScreencast();
});
it("failed optional stream falls back without setup retry every image poll; idle renew permits new setup", async () => {
  const { runtime, internal } = setup();
  internal.startScreencastSession = vi.fn(async () => {
    throw new Error("unsupported stream");
  });
  await readFrame(runtime);
  await readFrame(runtime);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(1);
  expect(internal.captureScreenshot).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  await readFrame(runtime);
  expect(internal.startScreencastSession).toHaveBeenCalledTimes(2);
  await runtime.stopScreencast();
});
it("shutdown cancels runtime-owned JPEG timer even without explicit viewer detach", async () => {
  const { runtime, internal, page } = setup();
  await readFrame(runtime);
  internal.invoke = vi.fn(async () => ({}));
  await runtime.shutdown();
  await vi.advanceTimersByTimeAsync(10000);
  expect(page.send).not.toHaveBeenCalledWith("Page.stopScreencast", {}, { mutation: true });
  expect(vi.getTimerCount()).toBe(0);
});
