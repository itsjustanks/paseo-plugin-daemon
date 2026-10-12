/** Real navigation methods, fake CDP only; main commit is not DOM readiness. */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { CdpUnavailableError, CdpUnknownOutcomeError } from "./cdp";
import {
  NAVIGATION_ACK_TIMEOUT_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_METADATA_TIMEOUT_MS,
} from "./navigation-budget";

function fixture() {
  const connection = Object.assign(new EventEmitter(), { isOpen: true });
  const page = Object.assign(new EventEmitter(), {
    connection,
    send: vi.fn<
      (
        method: string,
        params?: Record<string, unknown>,
        options?: { timeoutMs?: number; mutation?: boolean },
      ) => Promise<unknown>
    >(),
  });
  const observe = async (method: string): Promise<unknown> => {
    if (method === "Page.getNavigationHistory")
      return {
        currentIndex: 1,
        entries: [
          { id: 1, url: "https://previous.invalid/" },
          { id: 2, url: "https://current.invalid/" },
          { id: 3, url: "https://next.invalid/" },
        ],
      };
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "root", loaderId: "old-loader" } } };
    if (method === "Runtime.evaluate")
      return { result: { value: { url: "https://next.invalid/", title: "Loading" } } };
    return {};
  };
  const commit = (
    url = "https://next.invalid/",
    loaderId = "next-loader",
    frameId = "root",
    parentId?: string,
  ): void => {
    page.emit("Page.frameNavigated", {
      frame: { id: frameId, loaderId, url, ...(parentId ? { parentId } : {}) },
    });
  };
  page.send.mockImplementation(async (method, params) => {
    if (method === "Page.navigate") {
      commit(params!.url as string);
      return { frameId: "root", loaderId: "next-loader" };
    }
    if (method === "Page.navigateToHistoryEntry") {
      commit(params!.entryId === 1 ? "https://previous.invalid/" : "https://next.invalid/");
      return {};
    }
    if (method === "Page.reload") {
      commit("https://current.invalid/");
      return {};
    }
    return observe(method);
  });
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "navigation-budget-test",
  });
  Object.assign(runtime, { page, connection, emulationAppliedPage: page, screencastActive: true });
  return { runtime, page, connection, commit, observe };
}

function expectClean(page: EventEmitter, connection: EventEmitter): void {
  for (const event of [
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Inspector.detached",
  ]) {
    expect(page.listenerCount(event)).toBe(0);
  }
  expect(connection.listenerCount("disconnect")).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("buffers the exact root loader commit before ACK without DOM readiness or stream restart", async () => {
  const { runtime, page, connection } = fixture();
  const barrier = vi.spyOn(runtime, "invalidateQueuedVideoFrames");
  await runtime.navigate("https://next.invalid/");
  expect(page.send).toHaveBeenCalledExactlyOnceWith(
    "Page.navigate",
    { url: "https://next.invalid/" },
    { mutation: true, timeoutMs: NAVIGATION_ACK_TIMEOUT_MS },
  );
  expect(page.listenerCount("Page.lifecycleEvent")).toBe(0);
  expect(barrier).toHaveBeenCalledTimes(1);
  expectClean(page, connection);
});

it("waits for commit after ACK while child frames, other roots and old loaders cannot settle it", async () => {
  const { runtime, page, connection, commit } = fixture();
  page.send.mockResolvedValue({ frameId: "root", loaderId: "next-loader" });
  let settled = false;
  const result = runtime.navigate("https://next.invalid/").then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(page.send).toHaveBeenCalledTimes(1));
  commit("https://next.invalid/", "next-loader", "child", "root");
  commit("https://next.invalid/", "next-loader", "other-root");
  commit("https://next.invalid/", "old-loader");
  await Promise.resolve();
  expect(settled).toBe(false);
  commit();
  await result;
  expectClean(page, connection);
});

it.each(["back", "forward", "reload"] as const)(
  "%s awaits a fresh main commit within bounded preflight/ACK budgets",
  async (action) => {
    const { runtime, page, connection } = fixture();
    await runtime[action]();
    const mutation = page.send.mock.calls.find(
      ([method]) => method === "Page.navigateToHistoryEntry" || method === "Page.reload",
    );
    expect(mutation?.[2]).toEqual({ mutation: true, timeoutMs: NAVIGATION_ACK_TIMEOUT_MS });
    for (const [method, , options] of page.send.mock.calls) {
      if (method === "Page.getFrameTree" || method === "Page.getNavigationHistory")
        expect(options!.timeoutMs).toBeLessThanOrEqual(NAVIGATION_METADATA_TIMEOUT_MS);
      expect(/Screencast|Lifecycle/.test(method)).toBe(false);
    }
    expectClean(page, connection);
  },
);

it("same-document navigation requires the acknowledged frame and normalized requested URL", async () => {
  const { runtime, page, connection } = fixture();
  page.send.mockImplementation(async () => {
    page.emit("Page.navigatedWithinDocument", {
      frameId: "child",
      url: "https://next.invalid/#section",
    });
    page.emit("Page.navigatedWithinDocument", {
      frameId: "root",
      url: "https://next.invalid/#wrong",
    });
    page.emit("Page.navigatedWithinDocument", {
      frameId: "root",
      url: "https://next.invalid/#section",
    });
    return { frameId: "root" };
  });
  await runtime.navigate("https://next.invalid:443/#section");
  expectClean(page, connection);
});

it("history same-document commits select the exact history URL", async () => {
  const { runtime, page, connection, observe } = fixture();
  page.send.mockImplementation(async (method) => {
    if (method === "Page.navigateToHistoryEntry") {
      page.emit("Page.navigatedWithinDocument", {
        frameId: "root",
        url: "https://previous.invalid/",
      });
      return {};
    }
    return observe(method);
  });
  await runtime.back();
  expectClean(page, connection);
});

it.each(["back", "forward"] as const)(
  "%s matches a cross-document history URL whose fragment is a separate native field",
  async (action) => {
    const { runtime, page, connection, observe } = fixture();
    page.send.mockImplementation(async (method) => {
      if (method === "Page.getNavigationHistory") {
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "https://previous.invalid/#section" },
            { id: 2, url: "https://current.invalid/" },
            { id: 3, url: "https://next.invalid/#section" },
          ],
        };
      }
      if (method === "Page.navigateToHistoryEntry") {
        page.emit("Page.frameNavigated", {
          frame: {
            id: "root",
            loaderId: "next-loader",
            url: action === "back" ? "https://previous.invalid/" : "https://next.invalid/",
            urlFragment: "#section",
          },
        });
        return {};
      }
      return observe(method);
    });
    await runtime[action]();
    expect(
      page.send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
    ).toHaveLength(1);
    expectClean(page, connection);
  },
);

it.each([undefined, "net::ERR_ABORTED"])(
  "a native download ACK keeps the document even with errorText=%s",
  async (errorText) => {
    const { runtime, page, connection } = fixture();
    page.send.mockResolvedValue({
      frameId: "root",
      isDownload: true,
      ...(errorText ? { errorText } : {}),
    });
    await runtime.navigate("https://next.invalid/download");
    expect(page.send).toHaveBeenCalledTimes(1);
    expectClean(page, connection);
  },
);

it("a detached download ACK cannot bypass the original attachment guard", async () => {
  const { runtime, page, connection } = fixture();
  page.send.mockImplementation(async () => {
    connection.isOpen = false;
    connection.emit("disconnect");
    return { frameId: "root", isDownload: true, errorText: "net::ERR_ABORTED" };
  });
  await expect(runtime.navigate("https://next.invalid/download")).rejects.toBeInstanceOf(
    CdpUnknownOutcomeError,
  );
  expect(page.send).toHaveBeenCalledTimes(1);
  expectClean(page, connection);
});

it("missing matching commit after ACK is bounded uncertainty with no replay", async () => {
  vi.useFakeTimers();
  const { runtime, page, connection, commit } = fixture();
  page.send.mockImplementation(async () => {
    commit("https://next.invalid/", "old-loader");
    return { frameId: "root", loaderId: "next-loader" };
  });
  const result = runtime.navigate("https://next.invalid/").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(NAVIGATION_COMMIT_TIMEOUT_MS);
  expect(await result).toBeInstanceOf(CdpUnknownOutcomeError);
  expect(page.send).toHaveBeenCalledTimes(1);
  expectClean(page, connection);
});

it.each(["disconnect", "replacement"] as const)(
  "%s during ACK-to-commit cannot admit late old-page events",
  async (kind) => {
    const { runtime, page, connection, commit } = fixture();
    page.send.mockResolvedValue({ frameId: "root", loaderId: "next-loader" });
    const result = runtime.navigate("https://next.invalid/").catch((error: unknown) => error);
    await vi.waitFor(() => expect(page.send).toHaveBeenCalledTimes(1));
    if (kind === "disconnect") connection.emit("disconnect");
    else Object.assign(runtime, { page: new EventEmitter(), attachmentGeneration: 1 });
    commit();
    expect(await result).toBeInstanceOf(CdpUnknownOutcomeError);
    expectClean(page, connection);
  },
);

it("unacknowledged timeout remains uncertain and cleans observers without replay", async () => {
  vi.useFakeTimers();
  const { runtime, page, connection } = fixture();
  page.send.mockImplementation(
    async (_method, _params, options) =>
      await new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new CdpUnknownOutcomeError("Page.navigate timed out; mutation outcome is unknown"),
            ),
          options!.timeoutMs,
        ),
      ),
  );
  const result = runtime.navigate("https://next.invalid/").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(NAVIGATION_ACK_TIMEOUT_MS);
  expect(await result).toBeInstanceOf(CdpUnknownOutcomeError);
  expect(page.send).toHaveBeenCalledTimes(1);
  expectClean(page, connection);
});

it("an explicit native failure is not relabelled success", async () => {
  const { runtime, page, connection } = fixture();
  page.send.mockResolvedValue({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
  await expect(runtime.navigate("https://next.invalid/")).rejects.toThrow("Navigation failed");
  expectClean(page, connection);
});

it("failed history preflight blocks mutation", async () => {
  const { runtime, page } = fixture();
  page.send.mockRejectedValue(new CdpUnavailableError("history unavailable"));
  await expect(runtime.back()).rejects.toThrow("history unavailable");
  expect(
    page.send.mock.calls.every(
      ([method]) => method === "Page.getNavigationHistory" || method === "Page.getFrameTree",
    ),
  ).toBe(true);
});

it("navigation metadata is bounded while ordinary state retains its default", async () => {
  const { runtime, page } = fixture();
  await runtime.state({ timeoutMs: NAVIGATION_METADATA_TIMEOUT_MS });
  expect(
    page.send.mock.calls.every(
      ([, , options]) => options!.timeoutMs! <= NAVIGATION_METADATA_TIMEOUT_MS,
    ),
  ).toBe(true);
  page.send.mockClear();
  await runtime.state();
  expect(
    page.send.mock.calls.find(([method]) => method === "Runtime.evaluate")?.[2]?.timeoutMs,
  ).toBe(15_000);
  await expect(runtime.state({ timeoutMs: 0 })).rejects.toThrow("metadata timeout");
});
