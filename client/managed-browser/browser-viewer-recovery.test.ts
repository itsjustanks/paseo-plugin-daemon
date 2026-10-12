import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  createBrowserViewerRecovery,
  isBrowserClosedError,
  isExpiredBrowserViewerError,
} from "./browser-viewer-recovery";

const expired = Object.assign(
  new Error(
    "Request failed: Viewer token is invalid or expired requestType=plugin.rpc.invoke.request code=handler_error",
  ),
  { code: "handler_error" },
);
const observation = {
  identity: "host-a/workspace-a",
  viewerToken: "old-viewer",
  failedViewerToken: "old-viewer",
  captureError: expired,
  pending: false,
};

describe("expired browser viewing recovery", () => {
  it("recognizes explicit closure without treating it as an expired viewer", () => {
    const closed = Object.assign(
      new Error(
        "Request failed: Browser is closed requestType=plugin.rpc.invoke.request code=handler_error",
      ),
      { code: "handler_error" },
    );
    expect(isBrowserClosedError(closed)).toBe(true);
    expect(isExpiredBrowserViewerError(closed)).toBe(false);
    expect(isBrowserClosedError(expired)).toBe(false);
  });
  it("matches the actual SDK handler-error suffix but not transport, control or arbitrary failures", () => {
    expect(isExpiredBrowserViewerError(expired)).toBe(true);
    expect(
      isExpiredBrowserViewerError(
        Object.assign(new Error("Request failed: Viewer token is invalid or expired"), {
          code: "handler_error",
        }),
      ),
    ).toBe(true);
    expect(isExpiredBrowserViewerError(new Error("Viewer token is invalid or expired"))).toBe(true);
    for (const error of [
      new Error("Control lease is invalid or expired"),
      new Error("Browser frame is stale"),
      new Error("Bridge disconnected"),
      Object.assign(new Error("Viewer token is invalid or expired"), { code: "unknown_outcome" }),
      Object.assign(new Error("Viewer token is invalid or expired"), { code: "rpc_timeout" }),
      { code: "handler_error", message: "Other error: Viewer token is invalid or expired" },
    ])
      expect(isExpiredBrowserViewerError(error)).toBe(false);
  });

  it("reattaches once for each expired token and leaves failures for explicit reconnect", () => {
    const claim = createBrowserViewerRecovery();
    expect(claim({ ...observation, pending: true })).toBe(false);
    expect(claim(observation)).toBe(true);
    expect(claim(observation)).toBe(false);
    expect(claim({ ...observation, pending: true })).toBe(false);
    expect(claim({ ...observation, viewerToken: "new", failedViewerToken: "new" })).toBe(true);
  });

  it("ignores obsolete token errors, missing attachments and unrelated current capture errors", () => {
    const claim = createBrowserViewerRecovery();
    expect(claim({ ...observation, viewerToken: "replacement" })).toBe(false);
    expect(claim({ ...observation, viewerToken: null })).toBe(false);
    expect(claim({ ...observation, captureError: new Error("Timeout") })).toBe(false);
    expect(claim(observation)).toBe(true);
  });

  it("permits a distinct scope's attachment while retaining per-token loop protection", () => {
    const claim = createBrowserViewerRecovery();
    expect(claim(observation)).toBe(true);
    expect(claim(observation)).toBe(false);
    expect(claim({ ...observation, identity: "host-b/workspace-a" })).toBe(true);
    expect(claim({ ...observation, identity: "host-b/workspace-a" })).toBe(false);
  });
});

it("the actual capture query observer discards old token errors when its token key changes", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const replacement = Promise.withResolvers<string>();
  const observer = new QueryObserver(client, {
    queryKey: ["hosts-browser", "capture", "old-viewer"],
    queryFn: async (): Promise<string> => {
      throw expired;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    expect(observer.getCurrentResult().error).toBe(expired);
    observer.setOptions({
      queryKey: ["hosts-browser", "capture", "new-viewer"],
      queryFn: () => replacement.promise,
      retry: false,
    });
    expect(observer.getCurrentResult().error).toBeNull();
    expect(observer.getCurrentResult().status).toBe("pending");
    replacement.resolve("fresh capture");
    await observer.refetch({ cancelRefetch: false });
    expect(observer.getCurrentResult().error).toBeNull();
    expect(observer.getCurrentResult().data).toBe("fresh capture");
  } finally {
    replacement.resolve("cleanup");
    unsubscribe();
    client.clear();
  }
});
