import { expect, it } from "vitest";
import type { BrowserState } from "../../shared/managed-browser/browser";
import { SessionManager } from "./browser-policy";

/** Snapshot the current attachment, independently of a previously painted token. */
function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    runtimeId: state.runtimeId!,
    bridgeEpoch: state.bridgeEpoch!,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

it("revokes old bridge pixel tokens and admits a new capture without publishing stale input", async () => {
  let ids = 0;
  const calls: string[] = [];
  const manager = new SessionManager({
    validateWorkspace: async () => true,
    issueToken: () => String(++ids).padStart(32, "0"),
    client: {
      connect: async () => ({ epoch: 1 }),
      ensureWorkspace: async (workspaceId) => ({
        workspaceId,
        runtimeId: "r".repeat(32),
        createdAt: 1,
      }),
      archiveWorkspace: async () => {},
      closeWorkspace: async () => {},
      disconnect: () => {},
      requestWorkspace: async (_workspace, operation) => {
        calls.push(operation);
        if (operation === "identity") return { userAgent: "Fixture" };
        if (operation === "state")
          return {
            url: "https://fixture.invalid/",
            title: "Fixture",
            inputGeneration: "1:1",
            canGoBack: false,
            canGoForward: false,
          };
        if (operation === "frame")
          return {
            dataBase64: "AA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date().toISOString(),
          };
        return null;
      },
    },
  });
  try {
    await manager.connect();
    const { viewerToken } = await manager.attach("owned", "Fixture");
    const { controlToken } = await manager.acquireControl(viewerToken);
    const captured = await manager.capture(viewerToken);
    manager.setBridgeEpoch(2);
    const { state } = await manager.status(viewerToken);
    const old = captured.frame!;
    const refused = await manager.beginGesture({
      viewerToken,
      controlToken,
      pointerKind: "mouse",
      expected: expected(state),
      target: {
        frameId: old.frameId,
        navigationGeneration: old.navigationGeneration,
        viewportGeneration: old.viewportGeneration,
      },
    });
    expect(refused).toMatchObject({ admission: "stale-frame" });
    expect(calls).not.toContain("input.begin");

    const fresh = await manager.capture(viewerToken);
    expect(fresh.frame!.captureEpoch).toBe(2);
    const admitted = await manager.beginGesture({
      viewerToken,
      controlToken,
      pointerKind: "mouse",
      expected: expected(fresh.state),
      target: {
        frameId: fresh.frame!.frameId,
        navigationGeneration: fresh.frame!.navigationGeneration,
        viewportGeneration: fresh.frame!.viewportGeneration,
      },
    });
    expect(admitted).toHaveProperty("gestureId");
    expect(calls).toContain("input.begin");
  } finally {
    manager.disconnect();
  }
});
