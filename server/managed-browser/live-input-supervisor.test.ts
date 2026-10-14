import { expect, it } from "vitest";
import { browserStateSchema } from "../../shared/managed-browser/browser";
import type { JsonValue, RuntimeRequest } from "./runtime-protocol";
import { RuntimeSupervisor } from "./supervisor";

/** Exercise the immutable supervisor's human RPC path without a plugin or browser process. */
it("routes validated human gestures, fences replaced plugin bridges and never exposes live gesture operations to agent tickets", async () => {
  const calls: string[] = [];
  const supervisor = new RuntimeSupervisor({
    owner: {
      create: async () => ({ runtimeId: "r".repeat(32) }),
      request: async (_runtime, operation) => {
        calls.push(operation);
        if (operation === "identity") return { userAgent: "Fixture Chromium" };
        if (operation === "state")
          return {
            url: "https://fixture.invalid",
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
            capturedAt: new Date().toISOString(),
          };
        if (operation === "cursor") return "pointer";
        return null;
      },
      stop: async () => {},
    },
  });
  const lease = supervisor.claimBridge("bridge");
  const request = async (
    operation: string,
    input: unknown,
    epoch = lease.epoch,
    bridgeId = "bridge",
  ) =>
    supervisor.dispatch({
      version: 3,
      id: "request",
      token: "unused-by-direct-fixture",
      bridgeId,
      epoch,
      method: "browser.request",
      operation,
      input: input as JsonValue,
    });
  try {
    const attached = (await request("attach", { create: true,
      workspaceId: "workspace",
      viewerLabel: "Viewer",
    })) as { viewerToken: string };
    const acquired = (await request("acquire-control", { viewerToken: attached.viewerToken })) as {
      controlToken: string;
    };
    const capture = (await request("capture", { viewerToken: attached.viewerToken })) as {
      state: unknown;
      frame: { frameId: string };
    };
    const state = browserStateSchema.parse(capture.state);
    const expected = {
      sessionId: state.sessionId,
      runtimeId: state.runtimeId!,
      bridgeEpoch: state.bridgeEpoch!,
      navigationGeneration: state.navigationGeneration,
      viewportGeneration: state.viewportGeneration,
    };
    const context = {
      viewerToken: attached.viewerToken,
      controlToken: acquired.controlToken,
      expected,
    };
    const target = {
      frameId: capture.frame.frameId,
      navigationGeneration: state.navigationGeneration,
      viewportGeneration: state.viewportGeneration,
    };
    const begun = (await request("gesture.begin", {
      ...context,
      target,
      pointerKind: "mouse",
    })) as { gestureId: string; nextSequence: number };
    await request("gesture.update", {
      ...context,
      gestureId: begun.gestureId,
      sequence: 1,
      event: {
        kind: "key",
        type: "down",
        key: "Control",
        code: "ControlLeft",
        modifiers: 2,
        repeat: false,
      },
    });
    expect(calls.filter((value) => value === "input.key")).toHaveLength(1);
    const afterKey = (await request("capture", { viewerToken: attached.viewerToken })) as {
      frame: { frameId: string };
    };
    await request("gesture.update", {
      ...context,
      gestureId: begun.gestureId,
      sequence: 2,
      target: { ...target, frameId: afterKey.frame.frameId },
      event: { kind: "down", point: { x: 10, y: 20, width: 1280, height: 800 } },
    });
    expect(calls.filter((value) => value === "mouse.down")).toHaveLength(1);
    await expect(
      request("gesture.update", {
        ...context,
        gestureId: begun.gestureId,
        sequence: 3,
        event: {
          kind: "scroll",
          point: { x: 10, y: 20, width: 1280, height: 800 },
          deltaX: 0,
          deltaY: Infinity,
        },
      }),
    ).rejects.toThrow();
    supervisor.claimBridge("replacement", true);
    await expect(
      request("gesture.end", { ...context, gestureId: begun.gestureId, sequence: 1, cancel: true }),
    ).rejects.toThrow("lease");
    // The old channel's supervisor-side cleanup still reaches its owned runtime.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((value) => value === "input.end")).toHaveLength(1);
    await expect(
      supervisor.dispatch({
        version: 3,
        id: "request",
        method: "agent.request",
        ticket: "invalid",
        operation: "gesture.begin",
        input: {},
      } as unknown as RuntimeRequest),
    ).rejects.toThrow();
  } finally {
    await supervisor.stopAll();
  }
});
