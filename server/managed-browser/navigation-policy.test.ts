/** Navigation metadata budget and single-publication behavior through the real session policy. */
import { afterEach, expect, it, vi } from "vitest";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";
import { CdpUnknownOutcomeError } from "./cdp";
import { NAVIGATION_METADATA_TIMEOUT_MS } from "./navigation-budget";

async function fixture() {
  let counter = 0;
  let url = "https://before.invalid/";
  let inputGeneration = "0:0";
  let metadataFails = false;
  let dispatchFails = false;
  const calls: { operation: string; input: unknown }[] = [];
  const client: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "r".repeat(32),
      createdAt: 1,
    }),
    requestWorkspace: async (_workspaceId, operation, input) => {
      calls.push({ operation, input });
      if (operation === "identity") return { userAgent: "Fixture" };
      if (operation === "state") {
        if (metadataFails) throw new Error("Browser metadata unavailable");
        return {
          url,
          title: "Still loading",
          canGoBack: true,
          canGoForward: true,
          inputGeneration,
        };
      }
      if (["navigate", "back", "forward", "reload"].includes(operation)) {
        if (dispatchFails) throw new CdpUnknownOutcomeError("Navigation acknowledgement unknown");
        // A redirect is observed from the native state, never invented from the request URL.
        url = "https://redirected.invalid/";
        inputGeneration = "0:1";
      }
      return null;
    },
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect() {},
  };
  const manager = new SessionManager({
    client,
    validateWorkspace: async () => true,
    issueToken: () => String(++counter).padStart(32, "0"),
  });
  await manager.connect();
  const attached = await manager.attach("owned", "Viewer");
  const control = await manager.acquireControl(attached.viewerToken);
  const context = {
    viewerToken: attached.viewerToken,
    controlToken: control.controlToken,
    expected: {
      sessionId: control.state.sessionId,
      navigationGeneration: control.state.navigationGeneration,
      viewportGeneration: control.state.viewportGeneration,
      runtimeId: control.state.runtimeId!,
      bridgeEpoch: control.state.bridgeEpoch!,
    },
  };
  calls.length = 0;
  return {
    manager,
    context,
    calls,
    failMetadata: () => {
      metadataFails = true;
    },
    failDispatch: () => {
      dispatchFails = true;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(["goto", "back", "forward", "reload"] as const)(
  "%s performs one bounded post-observation, with one preflight only for history actions",
  async (kind) => {
    const f = await fixture();
    try {
      const action = kind === "goto" ? { kind, url: "https://requested.invalid/" } : { kind };
      const result = await f.manager.navigate({ ...f.context, action });
      expect(result.state.url).toBe("https://redirected.invalid/");
      expect(result.state.title).toBe("Still loading");
      const metadata = f.calls.filter((call) => call.operation === "state");
      expect(metadata).toHaveLength(kind === "back" || kind === "forward" ? 2 : 1);
      expect(
        metadata.every(
          (call) =>
            JSON.stringify(call.input) ===
            JSON.stringify({ timeoutMs: NAVIGATION_METADATA_TIMEOUT_MS }),
        ),
      ).toBe(true);
      expect(
        f.calls.filter((call) =>
          ["navigate", "back", "forward", "reload"].includes(call.operation),
        ),
      ).toHaveLength(1);
    } finally {
      await f.manager.disconnect();
    }
  },
);

it("acknowledged navigation with unavailable metadata returns explicit error, never cached-ready", async () => {
  const f = await fixture();
  try {
    f.failMetadata();
    const result = await f.manager.navigate({
      ...f.context,
      action: { kind: "goto", url: "https://requested.invalid/" },
    });
    expect(result.state.status).toBe("error");
    expect(result.state.error).toBe("Browser metadata unavailable");
    expect(f.calls.map((call) => call.operation)).toEqual(["navigate", "state"]);
  } finally {
    await f.manager.disconnect();
  }
});

it("failed history preflight blocks publication", async () => {
  const f = await fixture();
  try {
    f.failMetadata();
    await expect(f.manager.navigate({ ...f.context, action: { kind: "back" } })).rejects.toThrow(
      "metadata unavailable",
    );
    expect(f.calls.map((call) => call.operation)).toEqual(["state"]);
  } finally {
    await f.manager.disconnect();
  }
});

it("uncertain native publication is not retried or relabelled as a loaded document", async () => {
  const f = await fixture();
  try {
    f.failDispatch();
    await expect(
      f.manager.navigate({
        ...f.context,
        action: { kind: "goto", url: "https://requested.invalid/" },
      }),
    ).rejects.toBeInstanceOf(CdpUnknownOutcomeError);
    expect(f.calls.map((call) => call.operation)).toEqual(["navigate"]);
  } finally {
    await f.manager.disconnect();
  }
});
