/** Fresh metadata reads overlap CDP latency but never accept mixed native identities. */
import { describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

function fixture() {
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-state-profile",
    ipcDirectory: "/tmp/uncreated-state-ipc",
    session: "state-test",
  });
  const calls: string[] = [];
  const history = Promise.withResolvers<{
    currentIndex: number;
    entries: { url: string; title: string }[];
  }>();
  const metadata = Promise.withResolvers<{
    result: { value?: { url?: string; title?: string } };
  }>();
  const retryHistory = Promise.withResolvers<Awaited<typeof history.promise>>();
  const retryMetadata = Promise.withResolvers<Awaited<typeof metadata.promise>>();
  const timeouts: number[] = [];
  let onRead: (method: string, attempt: number) => void = () => {};
  const page = {
    send: (method: string, _input: unknown, options: { timeoutMs: number }) => {
      const attempt = calls.filter((call) => call === method).length;
      calls.push(method);
      timeouts.push(options.timeoutMs);
      onRead(method, attempt);
      if (method === "Page.getNavigationHistory") {
        return attempt === 0 ? history.promise : retryHistory.promise;
      }
      return attempt === 0 ? metadata.promise : retryMetadata.promise;
    },
  };
  const control = runtime as unknown as {
    page: typeof page;
    attachmentGeneration: number;
    documentGeneration: number;
    stopping: boolean;
    requirePage(): Promise<typeof page>;
  };
  control.page = page;
  control.requirePage = async () => page;
  return {
    runtime,
    control,
    page,
    calls,
    history,
    metadata,
    retryHistory,
    retryMetadata,
    timeouts,
    intercept: (callback: typeof onRead) => {
      onRead = callback;
    },
  };
}
const entries = [
  { url: "https://example.test/previous", title: "Previous" },
  { url: "https://example.test/current", title: "History title" },
];

describe("fresh parallel native page metadata", () => {
  it("discards both old reads and returns one fresh pair after a same-page document change", async () => {
    const f = fixture();
    const pending = f.runtime.state();
    await Promise.resolve();
    f.control.documentGeneration++;
    f.retryHistory.resolve({
      currentIndex: 0,
      entries: [{ url: "https://example.test/new", title: "New history" }],
    });
    f.retryMetadata.resolve({
      result: { value: { url: "https://example.test/new#ready", title: "New DOM" } },
    });
    f.history.resolve({ currentIndex: 1, entries });
    f.metadata.resolve({
      result: { value: { url: "https://example.test/old", title: "Old DOM" } },
    });
    expect(await pending).toEqual({
      url: "https://example.test/new#ready",
      title: "New DOM",
      canGoBack: false,
      canGoForward: false,
      inputGeneration: "0:1",
    });
    expect(f.calls).toEqual([
      "Page.getNavigationHistory",
      "Runtime.evaluate",
      "Page.getNavigationHistory",
      "Runtime.evaluate",
    ]);
  });

  it("starts both independent reads before either resolves and retains native history facts", async () => {
    const f = fixture();
    const pending = f.runtime.state();
    await Promise.resolve();
    expect(f.calls).toEqual(["Page.getNavigationHistory", "Runtime.evaluate"]);
    f.metadata.resolve({
      result: { value: { url: "https://example.test/current#hash", title: "Fresh title" } },
    });
    f.history.resolve({ currentIndex: 1, entries });
    expect(await pending).toMatchObject({
      url: "https://example.test/current#hash",
      title: "Fresh title",
      canGoBack: true,
      canGoForward: false,
    });
  });
  it("preserves existing native-history fallback when DOM values are absent", async () => {
    const f = fixture();
    const pending = f.runtime.state();
    f.metadata.resolve({ result: {} });
    f.history.resolve({ currentIndex: 0, entries });
    expect(await pending).toMatchObject({
      url: entries[0]!.url,
      title: "Previous",
      canGoBack: false,
      canGoForward: true,
    });
  });
  it("refuses attachment, page replacement or shutdown during either pending observation", async () => {
    for (const kind of ["attachment", "page", "shutdown"] as const) {
      const f = fixture();
      const pending = f.runtime.state();
      await Promise.resolve();
      if (kind === "shutdown") f.control.stopping = true;
      if (kind === "attachment") f.control.attachmentGeneration++;
      if (kind === "page")
        f.control.page = { send: () => Promise.resolve({}) } as unknown as typeof f.page;
      f.history.resolve({ currentIndex: 1, entries });
      f.metadata.resolve({ result: { value: { title: "Obsolete document" } } });
      await expect(pending).rejects.toThrow(
        kind === "shutdown" ? "shutting down" : "metadata changed",
      );
      expect(f.calls).toHaveLength(2);
    }
  });
  it("refuses repeated document changes after exactly two read pairs", async () => {
    const f = fixture();
    f.intercept((method, attempt) => {
      if (method === "Runtime.evaluate" && attempt === 1) f.control.documentGeneration++;
    });
    const pending = f.runtime.state();
    await Promise.resolve();
    f.control.documentGeneration++;
    f.history.resolve({ currentIndex: 1, entries });
    f.metadata.resolve({ result: {} });
    f.retryHistory.resolve({ currentIndex: 0, entries });
    f.retryMetadata.resolve({ result: {} });
    await expect(pending).rejects.toThrow("metadata changed");
    expect(f.calls).toHaveLength(4);
  });

  it("shares the original timeout budget across both pairs without restarting attachment", async () => {
    const f = fixture();
    let clock = 1_000;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const pending = f.runtime.state({ timeoutMs: 1_000 });
      await Promise.resolve();
      clock += 700;
      f.control.documentGeneration++;
      f.history.resolve({ currentIndex: 1, entries });
      f.metadata.resolve({ result: {} });
      f.retryHistory.resolve({ currentIndex: 0, entries });
      f.retryMetadata.resolve({ result: {} });
      await pending;
      expect(f.timeouts).toHaveLength(4);
      expect(f.timeouts.slice(0, 2).every((timeout) => timeout <= 1_000)).toBe(true);
      expect(f.timeouts.slice(2).every((timeout) => timeout <= 300)).toBe(true);
    } finally {
      monotonic.mockRestore();
    }
  });

  it("does not begin a second pair after the original budget expires", async () => {
    const f = fixture();
    let clock = 1_000;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const pending = f.runtime.state({ timeoutMs: 1_000 });
      await Promise.resolve();
      clock += 1_000;
      f.control.documentGeneration++;
      f.history.resolve({ currentIndex: 1, entries });
      f.metadata.resolve({ result: {} });
      await expect(pending).rejects.toThrow("metadata observation timed out");
      expect(f.calls).toHaveLength(2);
    } finally {
      monotonic.mockRestore();
    }
  });

  for (const phase of ["first", "second"] as const) {
    it(`refuses successful held ${phase} replies at or after the original deadline`, async () => {
      const f = fixture();
      let clock = 1_000;
      const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
      try {
        const secondStarted = Promise.withResolvers<void>();
        f.intercept((method, attempt) => {
          if (method === "Runtime.evaluate" && attempt === 1) secondStarted.resolve();
        });
        const pending = f.runtime.state({ timeoutMs: 1_000 });
        await Promise.resolve();
        if (phase === "second") {
          clock += 700;
          f.control.documentGeneration++;
          f.history.resolve({ currentIndex: 1, entries });
          f.metadata.resolve({ result: {} });
          await secondStarted.promise;
          expect(f.calls).toHaveLength(4);
          clock += 301;
          f.retryHistory.resolve({ currentIndex: 0, entries });
          f.retryMetadata.resolve({ result: { value: { title: "Late fresh metadata" } } });
        } else {
          clock += 1_000;
          f.history.resolve({ currentIndex: 1, entries });
          f.metadata.resolve({ result: { value: { title: "Late metadata" } } });
        }
        await expect(pending).rejects.toThrow("metadata observation timed out");
        expect(f.calls).toHaveLength(phase === "second" ? 4 : 2);
      } finally {
        monotonic.mockRestore();
      }
    });
  }

  it("propagates failed native reads rather than reusing earlier metadata", async () => {
    for (const failed of ["history", "metadata"]) {
      const f = fixture();
      const pending = f.runtime.state();
      const refusal = expect(pending).rejects.toThrow("Read unavailable");
      await Promise.resolve();
      f.control.documentGeneration++;
      if (failed === "history") f.history.reject(new Error("Read unavailable"));
      else f.history.resolve({ currentIndex: 1, entries });
      if (failed === "metadata") f.metadata.reject(new Error("Read unavailable"));
      else f.metadata.resolve({ result: {} });
      await refusal;
      expect(f.calls).toHaveLength(2);
    }
  });
});
