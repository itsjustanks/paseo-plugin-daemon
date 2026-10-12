/** Real acquisition methods with fake CDP; shutdown never waits for uncertain image work. */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { CdpConnection } from "./cdp";

class Connection extends EventEmitter {
  isOpen = true;
  send = vi.fn(async () => ({}));
  close = vi.fn(() => {
    this.isOpen = false;
    this.emit("disconnect");
  });
}

/** Replace external process operations only, retaining real page/start/capture guards. */
function fixture() {
  const runtime = new AgentBrowserRuntime({
    nativeVideo: true,
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "jpeg-shutdown-test",
  });
  const connection = new Connection();
  const page = {
    connection,
    send: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      return {};
    }),
  };
  const control = runtime as unknown as {
    invoke(args: string[]): Promise<unknown>;
    assertVersion(): Promise<void>;
    connectCdp(): Promise<void>;
    captureScreenshot(): Promise<unknown>;
    page: typeof page | null;
    heldButtons: Set<string>;
    heldKeys: Map<string, { key: string; code: string }>;
    screencastFrame: unknown;
  };
  Object.assign(runtime, {
    page,
    connection,
    emulationAppliedPage: page,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  control.invoke = vi.fn(async () => ({ cdpUrl: "ws://127.0.0.1:1/fixture" }));
  control.assertVersion = vi.fn(async () => {});
  return { runtime, control, page, connection };
}

afterEach(() => vi.restoreAllMocks());

it.each(["Page.enable", "Page.getNavigationHistory"])(
  "explicit JPEG startup cannot resume from %s after shutdown",
  async (blockedMethod) => {
    const { runtime, page, control } = fixture();
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const send = page.send.getMockImplementation()!;
    page.send.mockImplementation(async (method) => {
      if (method === blockedMethod) {
        entered.resolve();
        await blocked.promise;
      }
      return await send(method);
    });
    const reconnect = vi.spyOn(runtime, "reconnect");
    const result = runtime.startScreencast().catch((error: unknown) => error);
    await entered.promise;
    await runtime.shutdown();
    blocked.resolve();
    expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
    expect(reconnect).not.toHaveBeenCalled();
    expect(page.send.mock.calls.some(([method]) => method === "Page.startScreencast")).toBe(false);
    expect(control.invoke).toHaveBeenCalledTimes(1);
  },
);

it("optional frame startup rejects shutdown without attempting screenshot fallback", async () => {
  const { runtime, page, control } = fixture();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  page.send.mockImplementation(async (method) => {
    if (method === "Page.enable") {
      entered.resolve();
      await blocked.promise;
    }
    return {};
  });
  const fallback = vi.spyOn(control, "captureScreenshot");
  const result = runtime.frame(1024, DEFAULT_JPEG_QUALITY, 0).catch((error: unknown) => error);
  await entered.promise;
  await runtime.shutdown();
  blocked.resolve();
  expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
  expect(fallback).not.toHaveBeenCalled();
});

it("a screenshot-only read cannot publish late pixels or capture after blocked metrics", async () => {
  const { runtime, page, control } = fixture();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const send = page.send.getMockImplementation()!;
  page.send.mockImplementation(async (method) => {
    if (method === "Page.getLayoutMetrics") {
      entered.resolve();
      await blocked.promise;
    }
    return await send(method);
  });
  const result = runtime.frame(1024, 100, 0).catch((error: unknown) => error);
  await entered.promise;
  await runtime.shutdown();
  blocked.resolve();
  expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
  expect(page.send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  expect(control.screencastFrame).toBeNull();
});

it("an already dispatched screenshot cannot cache or return its late bytes after shutdown", async () => {
  const { runtime, page } = fixture();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const send = page.send.getMockImplementation()!;
  page.send.mockImplementation(async (method) => {
    if (method === "Page.captureScreenshot") {
      entered.resolve();
      await blocked.promise;
      return { data: "late-pixels" };
    }
    return await send(method);
  });
  const result = runtime.frame(1024, 100, 0).catch((error: unknown) => error);
  await entered.promise;
  await runtime.shutdown();
  blocked.resolve();
  expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
  expect(
    page.send.mock.calls.filter(([method]) => method === "Page.captureScreenshot"),
  ).toHaveLength(1);
  await expect(runtime.frame(1024, 100, 0)).rejects.toThrow("closed");
});

it("reconnect paused at version discovery cannot invoke native connection after shutdown", async () => {
  const { runtime, control } = fixture();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  control.assertVersion = vi.fn(async () => {
    entered.resolve();
    await blocked.promise;
  });
  const result = runtime.reconnect().catch((error: unknown) => error);
  await entered.promise;
  await runtime.shutdown();
  blocked.resolve();
  expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
  expect(control.invoke).toHaveBeenCalledTimes(1);
  expect(control.invoke).toHaveBeenCalledWith([
    "--session",
    "jpeg-shutdown-test",
    "--json",
    "close",
  ]);
});

it("late opened CDP connection is closed without publication or target attachment", async () => {
  const { runtime, control } = fixture();
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<CdpConnection>();
  const late = new Connection();
  vi.spyOn(CdpConnection, "connect").mockImplementation(async () => {
    entered.resolve();
    return await blocked.promise;
  });
  const result = control.connectCdp().catch((error: unknown) => error);
  await entered.promise;
  await runtime.shutdown();
  blocked.resolve(late as unknown as CdpConnection);
  expect(await result).toMatchObject({ message: "Browser runtime is shutting down" });
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(late.send).not.toHaveBeenCalled();
  expect(control.page).toBeNull();
});

it("shutdown still releases original held input, then all fresh acquisition stays closed", async () => {
  const { runtime, page, control } = fixture();
  control.heldButtons.add("left");
  control.heldKeys.set("ControlLeft", { key: "Control", code: "ControlLeft" });
  await runtime.shutdown();
  expect(page.send).toHaveBeenCalledWith(
    "Input.dispatchMouseEvent",
    expect.objectContaining({ type: "mouseReleased", button: "left" }),
    { mutation: true },
  );
  expect(page.send).toHaveBeenCalledWith(
    "Input.dispatchKeyEvent",
    expect.objectContaining({ type: "keyUp", code: "ControlLeft" }),
    { mutation: true },
  );
  await expect(runtime.reconnect()).rejects.toThrow("shutting down");
  await expect(runtime.launch()).rejects.toThrow("shutting down");
  await expect(runtime.frame(1024, DEFAULT_JPEG_QUALITY, 0)).rejects.toThrow("closed");
  expect(control.invoke).toHaveBeenCalledTimes(1);
});
