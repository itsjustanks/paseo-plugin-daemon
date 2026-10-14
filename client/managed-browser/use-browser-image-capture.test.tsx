import { afterEach, beforeEach, expect, it, vi } from "vitest";

// QueryObserver must use its real browser interval/focus scheduling in this
// otherwise DOM-free React test. No page, browser or network is started.
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible" },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CancelledError, focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useBrowserImageCapture } from "./use-browser-image-capture";

type Options = Parameters<typeof useBrowserImageCapture>[0];
type Reply = Awaited<ReturnType<Options["capture"]>>;
const reply = (status = "ready") => ({ state: { status }, frame: null }) as Reply;
const fixtures: Array<{ tree: ReactTestRenderer; client: QueryClient }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
});
afterEach(async () => {
  for (const { tree, client } of fixtures.splice(0)) {
    await act(async () => tree.unmount());
    client.clear();
  }
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

async function fixture(capture: Options["capture"], changes: Partial<Options> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  let options: Options = {
    viewerToken: "first-viewer", quality: "medium", activeInput: false,
    videoOwnsPresentation: false, hasVideoPresentation: () => false,
    refreshVideo: vi.fn(), mutationEpoch: () => 0, knownFrame: () => null,
    capture, ...changes,
  };
  let result!: ReturnType<typeof useBrowserImageCapture>;
  function Probe() {
    result = useBrowserImageCapture(options);
    // Match the panel's subscriptions; TanStack only notifies tracked properties.
    void result.query.error; void result.query.data; void result.query.fetchStatus;
    return null;
  }
  const element = () => <QueryClientProvider client={client}><Probe /></QueryClientProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(element()); });
  fixtures.push({ tree, client });
  await tick(1);
  return {
    current: () => result,
    async update(next: Partial<Options>) {
      options = { ...options, ...next };
      await act(async () => tree.update(element()));
      await tick(1);
    },
  };
}
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

it("stops after two real query failures, including focus and network reconnect", async () => {
  const capture = vi.fn<Options["capture"]>().mockRejectedValue(new Error("capture timed out"));
  const f = await fixture(capture);
  await tick(1600);
  expect(capture).toHaveBeenCalledTimes(2);
  await tick(60000);
  await act(async () => {
    focusManager.setFocused(false); focusManager.setFocused(true);
    onlineManager.setOnline(false); onlineManager.setOnline(true);
  });
  await tick(1000);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(f.current().query.error?.message).toBe("capture timed out");
});

it("an explicit retry succeeds and resumes ordinary polling", async () => {
  const capture = vi.fn<Options["capture"]>().mockRejectedValue(new Error("capture timed out"));
  const f = await fixture(capture);
  await tick(1600);
  expect(capture).toHaveBeenCalledTimes(2);
  capture.mockResolvedValue(reply());
  await act(async () => f.current().retryFrameCapture());
  await tick(1);
  expect(capture).toHaveBeenCalledTimes(3);
  expect(f.current().query.error).toBeNull();
  await tick(260);
  expect(capture).toHaveBeenCalledTimes(4);
});

it("one failure followed by success resets the budget", async () => {
  const capture = vi.fn<Options["capture"]>()
    .mockRejectedValueOnce(new Error("transient"))
    .mockResolvedValueOnce(reply())
    .mockRejectedValueOnce(new Error("transient again"))
    .mockResolvedValue(reply());
  const f = await fixture(capture);
  await tick(1600); await tick(260); await tick(260);
  expect(capture.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.current().query.error).toBeNull();
});

it("showing a hidden panel cannot restart an exhausted viewer", async () => {
  const capture = vi.fn<Options["capture"]>().mockRejectedValue(new Error("failed"));
  const f = await fixture(capture);
  await tick(1600); expect(capture).toHaveBeenCalledTimes(2);
  await f.update({ active: false });
  await f.update({ active: true });
  await tick(10000);
  expect(capture).toHaveBeenCalledTimes(2);
  capture.mockResolvedValue(reply());
  await act(async () => f.current().refreshCapture());
  await tick(1);
  expect(capture).toHaveBeenCalledTimes(3);
});

it("successful starting replies continue on the existing 1.5 second cadence", async () => {
  const capture = vi.fn<Options["capture"]>().mockResolvedValue(reply("starting"));
  await fixture(capture);
  expect(capture).toHaveBeenCalledOnce();
  await tick(1400); expect(capture).toHaveBeenCalledOnce();
  await tick(110); expect(capture).toHaveBeenCalledTimes(2);
  await tick(1510); expect(capture).toHaveBeenCalledTimes(3);
});

it.each([{ viewerToken: "reconnected-viewer" }, { quality: "high" as const }])(
  "new viewer or quality starts a fresh budget: %j", async (next) => {
    const capture = vi.fn<Options["capture"]>().mockRejectedValue(new Error("failed"));
    const f = await fixture(capture);
    await tick(1600); expect(capture).toHaveBeenCalledTimes(2);
    capture.mockResolvedValue(reply());
    await f.update(next);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(f.current().query.error).toBeNull();
  },
);

it("silent cancellation does not consume the next failure budget", async () => {
  const capture = vi.fn<Options["capture"]>()
    .mockRejectedValueOnce(new CancelledError({ silent: true, revert: true }))
    .mockRejectedValueOnce(new Error("first failure"))
    .mockResolvedValue(reply());
  const f = await fixture(capture);
  await act(async () => f.current().retryFrameCapture());
  await tick(1);
  await tick(1600);
  expect(capture).toHaveBeenCalledTimes(3);
  expect(f.current().query.error).toBeNull();
});

it.each([{ active: false }, { videoOwnsPresentation: true }, { hasVideoPresentation: () => true }])(
  "hidden and video presentation gates still block explicit and scheduled JPEG: %j", async (gate) => {
    const capture = vi.fn<Options["capture"]>().mockResolvedValue(reply());
    const f = await fixture(capture, gate);
    await tick(10000);
    await act(async () => { f.current().retryFrameCapture(); f.current().refreshCapture(); });
    await tick(1);
    expect(capture).not.toHaveBeenCalled();
  },
);

it("a late old-viewer failure cannot stop the new viewer", async () => {
  let rejectOld!: (error: Error) => void;
  const capture = vi.fn<Options["capture"]>()
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
    .mockRejectedValueOnce(new Error("new viewer first failure"))
    .mockResolvedValue(reply());
  const f = await fixture(capture);
  await f.update({ viewerToken: "new-viewer" });
  await act(async () => rejectOld(new Error("late old failure")));
  await tick(1600);
  expect(capture).toHaveBeenCalledTimes(3);
  expect(f.current().query.error).toBeNull();
});
