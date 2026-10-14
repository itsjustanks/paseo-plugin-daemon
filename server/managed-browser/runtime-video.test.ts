import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  captures: [] as {
    options: unknown;
    idleExpired: boolean;
    sourceFailure: "startup" | "source-stopped" | "source-reset" | "source-dimensions" | null;
    read: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    invalidateQueuedFrames: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("./native-video-capture", () => ({
  NativeVideoCapture: class {
    options: unknown;
    idleExpired = false;
    sourceFailure: "startup" | "source-stopped" | "source-reset" | "source-dimensions" | null =
      null;
    read = vi.fn(async () => ({ status: "ready", streamId: "stream", packets: [] }));
    stop = vi.fn(async () => {});
    invalidateQueuedFrames = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      fixture.captures.push(this);
    }
  },
}));

import { AgentBrowserRuntime } from "./agent-browser-runtime";

function setup() {
  fixture.captures = [];
  const runtime = new AgentBrowserRuntime({
    nativeVideo: true,
    binaryPath: "/tmp/owned-bin",
    executablePath: "/tmp/owned-chrome",
    profilePath: "/tmp/owned-profile",
    ipcDirectory: "/tmp/owned-ipc",
    session: "fixture",
  });
  Object.assign(runtime, { nativeVideo: true }); // Test dormant internal fences only.
  const internal = runtime as unknown as {
    page: unknown;
    connection: unknown;
    viewport: unknown;
    emulationAppliedPage: unknown;
    attachmentGeneration: number;
    documentGeneration: number;
    restoreConfiguredEmulation(page: unknown): Promise<void>;
    assertVersion(): Promise<void>;
    connectCdp(): Promise<void>;
    invoke(args: string[]): Promise<unknown>;
  };
  const connection = Object.assign(new EventEmitter(), { isOpen: true, close: vi.fn() });
  const page = Object.assign(new EventEmitter(), {
    connection,
    targetId: "exact",
    send: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "root", loaderId: "prior-loader" } } };
      }
      if (method === "Page.reload") {
        // Real reload admission observes a fresh main-frame commit, which may
        // arrive before the ACK. No DOM readiness is needed for this barrier.
        page.emit("Page.frameNavigated", {
          frame: { id: "root", loaderId: "reload-loader", url: "https://fixture.invalid/" },
        });
      }
      return {};
    }),
  });
  internal.connection = connection;
  internal.page = page;
  internal.emulationAppliedPage = page;
  internal.viewport = {
    width: 412,
    height: 839,
    captureScale: 2,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  };
  return { runtime, internal, page, connection };
}
describe("native video runtime fence", () => {
  it("awaits native stop before screenshot and fences video reads until current pixels finish", async () => {
    const { runtime, internal, page } = setup();
    const stopping = Promise.withResolvers<void>();
    const stopStarted = Promise.withResolvers<void>();
    const screenshot = Promise.withResolvers<{ data: string }>();
    const screenshotStarted = Promise.withResolvers<void>();
    const data = Buffer.from([255,216,255,192,0,11,8,6,142,3,56,1,1,17,0,255,217]).toString("base64");
    page.send.mockImplementation(async (method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") { screenshotStarted.resolve(); return screenshot.promise; }
      return {};
    });
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const former = fixture.captures[0]!;
    former.stop.mockImplementationOnce(() => { stopStarted.resolve(); return stopping.promise; });
    const pending = runtime.frame(100, 85, 0);
    await stopStarted.promise;
    expect(page.send).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    internal.documentGeneration += 1;
    stopping.resolve();
    await screenshotStarted.promise;
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    screenshot.resolve({ data });
    expect((await pending).transport).toBe("screenshot");
    const fresh = await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fresh.status).toBe("ready");
    expect(fresh.inputGeneration).toBe(`${internal.attachmentGeneration}:${internal.documentGeneration}`);
    expect(fixture.captures).toHaveLength(2);
    expect((fixture.captures[1]!.options as { isCurrent(): boolean }).isCurrent()).toBe(true);
    await runtime.stopVideo();
  });

  it("does not bypass a native retirement already started by a video reader", async () => {
    const { runtime, page } = setup();
    const closing = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const data = Buffer.from([255,216,255,192,0,11,8,6,142,3,56,1,1,17,0,255,217]).toString("base64");
    page.send.mockImplementation(async (method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data };
      return {};
    });
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const former = fixture.captures[0]!;
    former.idleExpired = true;
    former.stop.mockImplementationOnce(() => { closeStarted.resolve(); return closing.promise; });
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    await closeStarted.promise;
    const pending = runtime.frame(100, 85, 0);
    try {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(page.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
    } finally { closing.resolve(); }
    expect((await pending).transport).toBe("screenshot");
    await runtime.stopVideo();
  });

  it("does not publish a screenshot when native stop rejects", async () => {
    const { runtime, page } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    fixture.captures[0]!.stop.mockRejectedValueOnce(new Error("Owned helper stop failed"));
    await expect(runtime.frame(100, 85, 0)).rejects.toThrow("Owned helper stop failed");
    expect(page.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
    await runtime.stopVideo();
  });

  it.each(["startup", "source-stopped", "source-reset"] as const)(
    "retires %s failure under continued demand and retries only after cooldown",
    async (failure) => {
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      const { runtime } = setup();
      try {
        await runtime.readVideo({ quality: "high", waitMs: 0 });
        const former = fixture.captures[0]!;
        former.sourceFailure = failure;
        expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
        expect(former.stop).toHaveBeenCalledOnce();
        for (let i = 0; i < 20; i++) await runtime.readVideo({ quality: "high", waitMs: 0 });
        expect(fixture.captures).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2999);
        await runtime.readVideo({ quality: "high", waitMs: 0 });
        expect(fixture.captures).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("ready");
        expect(fixture.captures).toHaveLength(2);
      } finally {
        await runtime.stopVideo();
        clock.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("never retries a permanent size failure for the same viewport, including after navigation", async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { runtime, internal } = setup();
    try {
      internal.viewport = {
        width: 412,
        height: 839,
        captureScale: 1,
        deviceScaleFactor: 2.625,
        mobile: true,
        touch: true,
      };
      await runtime.readVideo({ quality: "high", waitMs: 0 });
      expect(fixture.captures[0]!.options).toMatchObject({ width: 412, height: 839 });
      fixture.captures[0]!.sourceFailure = "source-dimensions";
      expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
      expect(fixture.captures[0]!.stop).toHaveBeenCalledOnce();
      internal.documentGeneration++;
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 20; i++) {
        expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe(
          "unsupported",
        );
      }
      expect(fixture.captures).toHaveLength(1);
      await runtime.setCaptureDensity(2, 2.625);
      expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("ready");
      expect(fixture.captures).toHaveLength(2);
      expect(fixture.captures[1]!.options).toMatchObject({ width: 824, height: 1678 });
      expect(internal.viewport).toMatchObject({ width: 412, height: 839, captureScale: 2 });
    } finally {
      await runtime.stopVideo();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps concurrent failed-source retirement fenced even after its cooldown", async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { runtime } = setup();
    const release = Promise.withResolvers<void>();
    try {
      await runtime.readVideo({ quality: "high", waitMs: 0 });
      const former = fixture.captures[0]!;
      former.sourceFailure = "source-stopped";
      former.stop.mockImplementationOnce(() => release.promise);
      let settled = false;
      const retirement = runtime.readVideo({ quality: "high", waitMs: 0 }).then((reply) => {
        settled = true;
        return reply;
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Backend teardown can outlive the outer plugin RPC deadline. The reader
      // must release its admission slot while replacement capture stays fenced.
      await vi.advanceTimersByTimeAsync(35000);
      expect(settled).toBe(true);
      const readers = await Promise.all(
        Array.from({ length: 8 }, () => runtime.readVideo({ quality: "high", waitMs: 0 })),
      );
      expect(readers.every((value) => value.status === "reset")).toBe(true);
      expect(fixture.captures).toHaveLength(1);
      let cleanupSettled = false;
      const cleanup = runtime.stopVideo().then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(cleanupSettled).toBe(false);
      release.resolve();
      await cleanup;
      await retirement;
      await Promise.all(
        Array.from({ length: 8 }, () => runtime.readVideo({ quality: "high", waitMs: 0 })),
      );
      expect(fixture.captures).toHaveLength(2);
      expect(former.stop).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await runtime.stopVideo();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a single cohort failure never retires a source used by a healthy peer", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const shared = fixture.captures[0]!;
    shared.read.mockResolvedValueOnce({
      status: "unsupported",
      streamId: "high",
      packets: [],
      reason: "Native video quality is unavailable",
    });
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
    expect((await runtime.readVideo({ quality: "low", waitMs: 0 })).status).toBe("ready");
    expect(shared.stop).not.toHaveBeenCalled();
    expect(fixture.captures).toHaveLength(1);
    await runtime.stopVideo();
  });
  it("forwards exact encoder settings and refuses invalid values before creating a source", async () => {
    const { runtime } = setup();
    await expect(runtime.readVideo({ quality: "high", bitrate: 1, fps: 30 })).rejects.toThrow();
    expect(fixture.captures).toHaveLength(0);
    await runtime.readVideo({ quality: "low", bitrate: 24_000_000, fps: 60, waitMs: 0 });
    expect(fixture.captures[0]!.read).toHaveBeenLastCalledWith({
      quality: "low",
      bitrate: 24_000_000,
      fps: 60,
      waitMs: 0,
    });
    await runtime.stopVideo();
  });

  it("retires an idle source under the stop barrier and resumes on the next read", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const expired = fixture.captures[0]!;
    expired.idleExpired = true;
    const stopping = Promise.withResolvers<void>();
    expired.stop.mockImplementationOnce(() => stopping.promise);
    let settled = false;
    const retirement = runtime.readVideo({ quality: "high", waitMs: 0 }).then((reply) => {
      settled = true;
      return reply;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(true);
    expect(await runtime.readVideo({ quality: "high", waitMs: 0 })).toMatchObject({
      status: "reset",
      packets: [],
    });
    expect(fixture.captures).toHaveLength(1);
    stopping.resolve();
    await runtime.stopVideo();
    expect(await retirement).toMatchObject({ status: "reset", packets: [] });
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(2);
    expect(expired.stop).toHaveBeenCalledOnce();
    await runtime.stopVideo();
  });

  it("turns expiry during a read into a recoverable reset, not permanent unsupported", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const expired = fixture.captures[0]!;
    expired.read.mockImplementationOnce(async () => {
      expired.idleExpired = true;
      return { status: "unsupported", packets: [] };
    });
    expect(await runtime.readVideo({ quality: "high", waitMs: 0 })).toMatchObject({
      status: "reset",
      packets: [],
    });
    expect(await runtime.readVideo({ quality: "high", waitMs: 0 })).toMatchObject({
      status: "reset",
      packets: [],
    });
    await runtime.stopVideo();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(2);
    await runtime.stopVideo();
  });

  it("creates the exact physical capture pixels and retains live pointer continuity", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures[0]?.options).toMatchObject({
      targetId: "exact",
      width: 824,
      height: 1678,
    });
    await runtime.mouseMove(10, 10);
    expect(fixture.captures[0]?.invalidateQueuedFrames).not.toHaveBeenCalled();
    await runtime.stopVideo();
  });
  it("document change while a read is pending returns reset without packets", async () => {
    const { runtime, internal } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    let resolveRead: (value: unknown) => void = () => {};
    fixture.captures[0]!.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const pending = runtime.readVideo({ quality: "high", waitMs: 500 });
    await Promise.resolve();
    await Promise.resolve();
    internal.documentGeneration++;
    resolveRead({ status: "ready", streamId: "old", packets: [{ dataBase64: "old" }] });
    expect(await pending).toMatchObject({ status: "reset", packets: [] });
    await runtime.stopVideo();
  });
  it("successful explicit reload clears queued video, never the shared source on mouse motion", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    await runtime.reload();
    expect(fixture.captures[0]?.invalidateQueuedFrames).toHaveBeenCalledOnce();
    await runtime.stopVideo();
  });
  it("replacement attachment cannot reuse a former capture's ownership callback", async () => {
    const { runtime, internal } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const owned = fixture.captures[0]!.options as { isCurrent(): boolean };
    expect(owned.isCurrent()).toBe(true);
    internal.attachmentGeneration++;
    expect(owned.isCurrent()).toBe(false);
    await runtime.stopVideo();
  });
  it("blocks replacement capture during an awaited resize stop, then uses the new exact pixels", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const former = fixture.captures[0]!;
    const stopping = Promise.withResolvers<void>();
    former.stop.mockImplementationOnce(() => stopping.promise);

    const resize = runtime.emulate({
      width: 1280,
      height: 1280,
      captureScale: 1,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    });
    expect((former.options as { isCurrent(): boolean }).isCurrent()).toBe(false);
    expect(await runtime.readVideo({ quality: "high", waitMs: 0 })).toMatchObject({
      status: "reset",
      packets: [],
    });
    expect(fixture.captures).toHaveLength(1);
    stopping.resolve();
    await resize;

    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(2);
    expect(fixture.captures[1]!.options).toMatchObject({ width: 1280, height: 1280 });
    expect((fixture.captures[1]!.options as { isCurrent(): boolean }).isCurrent()).toBe(true);
    await runtime.stopVideo();
  });
  it("holds the stop barrier even when no device operation follows", async () => {
    const { runtime } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const deferred = Promise.withResolvers<void>();
    fixture.captures[0]!.stop.mockImplementationOnce(() => deferred.promise);
    const stopping = runtime.stopVideo();
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(1);
    deferred.resolve();
    await stopping;
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(2);
    await runtime.stopVideo();
  });
  it("binds the source to the exact saved viewport object, even with unchanged attachment", async () => {
    const { runtime, internal } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const owner = fixture.captures[0]!.options as { isCurrent(): boolean };
    internal.viewport = {
      width: 1280,
      height: 800,
      captureScale: 1,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    };
    expect(owner.isCurrent()).toBe(false);
    await runtime.stopVideo();
  });
  it("restoration owns a continuous source barrier without creating a helper from native metrics", async () => {
    const { runtime, internal, page } = setup();
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const deferred = Promise.withResolvers<void>();
    fixture.captures[0]!.stop.mockImplementationOnce(() => deferred.promise);
    internal.emulationAppliedPage = null;
    const restoring = internal.restoreConfiguredEmulation(page);
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(1);
    deferred.resolve();
    await restoring;
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures[1]!.options).toMatchObject({ width: 824, height: 1678 });
    await runtime.stopVideo();
  });
  it("blocks startup throughout target selection and releases the gate after a rejected target", async () => {
    const { runtime } = setup();
    const listing = Promise.withResolvers<[]>();
    vi.spyOn(runtime, "targets").mockImplementationOnce(() => listing.promise);
    const selection = runtime.selectTarget("not-saved");
    const rejection = expect(selection).rejects.toThrow("Unknown page target");
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(0);
    listing.resolve([]);
    await rejection;
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(1);
    await runtime.stopVideo();
  });
  it("blocks capture while reconnect is restoring the saved page", async () => {
    const { runtime, internal, page, connection } = setup();
    const readiness = Promise.withResolvers<void>();
    internal.assertVersion = () => readiness.promise;
    internal.connectCdp = async () => {
      internal.connection = connection;
      internal.page = page;
      internal.emulationAppliedPage = page;
    };
    const reconnecting = runtime.reconnect();
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(0);
    readiness.resolve();
    await reconnecting;
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    expect(fixture.captures).toHaveLength(1);
    await runtime.stopVideo();
  });
  it("never starts a source during or after shutdown while native close is pending", async () => {
    const { runtime, internal } = setup();
    const closing = Promise.withResolvers<void>();
    internal.invoke = () => closing.promise;
    const shutdown = runtime.shutdown();
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(0);
    closing.resolve();
    await shutdown;
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("reset");
    expect(fixture.captures).toHaveLength(0);
  });
});

describe("native snapshot keeps the healthy video instance", () => {
  const data = Buffer.from([255,216,255,192,0,11,8,6,142,3,56,1,1,17,0,255,217]).toString("base64");
  function liveSnapshot(onSnapshot: () => void = () => {}) {
    return vi.fn(async () => {
      onSnapshot();
      // Older than the 1s cache window, so every agent capture asks the track again.
      return {
        dataBase64: data,
        byteLength: Buffer.byteLength(data, "base64"),
        width: 824,
        height: 1678,
        capturedAt: new Date(Date.now() - 1_100).toISOString(),
        capturedAtMonotonicMs: performance.now() - 1_100,
      };
    });
  }

  it("15 agent captures against live video cause no stop, no replacement and no reset", async () => {
    const { runtime, page } = setup();
    expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("ready");
    const capture = fixture.captures[0]! as (typeof fixture.captures)[number] & { snapshot?: unknown };
    const snapshot = liveSnapshot();
    capture.snapshot = snapshot;
    for (let cycle = 0; cycle < 15; cycle++) {
      expect((await runtime.frame(600_000, 85, 0)).transport).toBe("native-snapshot");
      expect((await runtime.readVideo({ quality: "high", waitMs: 0 })).status).toBe("ready");
    }
    expect(snapshot).toHaveBeenCalledTimes(15);
    expect(capture.stop).not.toHaveBeenCalled();
    expect(fixture.captures).toHaveLength(1);
    expect(page.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
    await runtime.stopVideo();
  });

  it("a navigation during a pending snapshot refuses it and keeps the arbitrated fallback", async () => {
    const { runtime, internal, page } = setup();
    page.send.mockImplementation(async (method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data };
      return {};
    });
    await runtime.readVideo({ quality: "high", waitMs: 0 });
    const capture = fixture.captures[0]! as (typeof fixture.captures)[number] & { snapshot?: unknown };
    capture.snapshot = liveSnapshot(() => {
      internal.documentGeneration += 1;
    });
    const frame = await runtime.frame(600_000, 85, 0);
    expect(frame.transport).toBe("screenshot");
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(page.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(true);
    await runtime.stopVideo();
  });
});
