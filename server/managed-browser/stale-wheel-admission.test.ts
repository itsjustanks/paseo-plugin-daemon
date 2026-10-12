import assert from "node:assert/strict";
import { it } from "vitest";
import {
  type BrowserGestureAuthority,
  createBrowserInputQueue,
} from "../../client/managed-browser/browser-input-queue";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";

it("recovers a captured-before-wheel frame that decodes after invalidation without repeating the first wheel", async () => {
  // No native process or profile: actual queue + policy, with delayed decoder and deterministic clock.
  let token = 0;
  let now = 1_000;
  const calls: string[] = [];
  const client: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "r".repeat(32),
      createdAt: 1,
    }),
    requestWorkspace: async (_workspace, operation) => {
      calls.push(operation);
      if (operation === "identity") return { userAgent: "Fixture Chromium" };
      if (operation === "state")
        return {
          url: "https://fixture.invalid/",
          title: "Fixture",
          canGoBack: false,
          canGoForward: false,
          inputGeneration: "0:0",
        };
      if (operation === "frame")
        return {
          dataBase64: "eA==",
          byteLength: 1,
          width: 1280,
          height: 800,
          capturedAt: new Date(now).toISOString(),
        };
      if (operation === "cursor") return "default";
      return null;
    },
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect: () => {},
  };
  const manager = new SessionManager({
    client,
    validateWorkspace: async () => true,
    now: () => now,
    frameCacheMs: 0,
    issueToken: () => String(++token).padStart(32, "0"),
  });
  await manager.connect();
  const { viewerToken } = await manager.attach("owned-fixture", "Viewer");
  const { controlToken } = await manager.acquireControl(viewerToken);
  const a = await manager.capture(viewerToken);
  const context = {
    viewerToken,
    controlToken,
    expected: {
      sessionId: a.state.sessionId,
      runtimeId: a.state.runtimeId!,
      bridgeEpoch: a.state.bridgeEpoch!,
      navigationGeneration: a.state.navigationGeneration,
      viewportGeneration: a.state.viewportGeneration,
    },
  };
  const target = (frame: NonNullable<typeof a.frame>) => ({
    frameId: frame.frameId,
    navigationGeneration: frame.navigationGeneration,
    viewportGeneration: frame.viewportGeneration,
  });
  let current: BrowserGestureAuthority = {
    ...context,
    target: target(a.frame!),
  };
  const errors: unknown[] = [];
  let decoderPending: NonNullable<typeof a.frame> | null = null;
  let waited = 0;
  const queue = createBrowserInputQueue({
    authority: () => current,
    transport: {
      begin: (input) => manager.beginGesture(input),
      end: (input) => manager.endGesture(input),
      update: async (input) => {
        // A different capture is already issued before input; its slow decoder commits after the wheel reply.
        now++;
        decoderPending = (await manager.capture(viewerToken)).frame!;
        const result = await manager.updateGesture(input);
        current = { ...context, target: target(decoderPending) };
        return result;
      },
    },
    onState: () => {},
    onCursor: () => {},
    onError: (error) => errors.push(error),
    onFinish: () => {},
    waitForFrame: async () => {
      waited++;
      now++;
      const fresh = await manager.capture(viewerToken);
      current = { ...context, target: target(fresh.frame!) };
    },
  });
  const flush = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  try {
    queue.enqueue({
      kind: "scroll",
      point: { x: 100, y: 100, width: 1280, height: 800 },
      deltaX: 0,
      deltaY: 40,
    });
    await flush();
    queue.finish();
    await flush();
    assert.equal(errors.length, 0);
    assert.notEqual(current.target.frameId, a.frame!.frameId);
    queue.enqueue({
      kind: "scroll",
      point: { x: 100, y: 100, width: 1280, height: 800 },
      deltaX: 0,
      deltaY: 40,
    });
    await flush();
    assert.equal(waited, 1);
    assert.equal(errors.length, 0);
    assert.equal(calls.filter((call) => call === "mouse.wheel").length, 2);
    assert.equal(calls.filter((call) => call === "input.begin").length, 2);
  } finally {
    queue.cancel();
    manager.disconnect();
  }
});
