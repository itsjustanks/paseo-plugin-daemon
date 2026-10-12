/** Integration evidence for the current runtime's independent idle and original-page cleanup fences. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { SessionManager } from "./browser-policy";

afterEach(() => vi.useRealTimers());

/** Real policy and native timers share fake elapsed time; only Chromium's CDP transport is stubbed. */
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "discrete-lifetime-fixture",
  });
  const publications: string[] = [];
  const page = {
    send: async (_method: string, params: Record<string, unknown> = {}) => {
      if (typeof params.type === "string") publications.push(params.type);
      return {};
    },
  };
  const native = runtime as unknown as {
    page: typeof page;
    requirePage: () => Promise<typeof page>;
    attachmentGeneration: number;
    documentGeneration: number;
  };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  native.requirePage = async () => native.page;
  let stateDelay = 0;
  let afterDownDelay = 0;
  let ids = 0;
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
      requestWorkspace: async (_workspace, operation, input) => {
        const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
        if (operation === "identity") return { userAgent: "Fixture" };
        if (operation === "state") {
          await vi.advanceTimersByTimeAsync(stateDelay);
          return {
            url: "https://fixture.invalid/",
            title: "Fixture",
            inputGeneration: `${native.attachmentGeneration}:${native.documentGeneration}`,
            canGoBack: false,
            canGoForward: false,
          };
        }
        if (operation === "frame") {
          return {
            dataBase64: "eA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date().toISOString(),
          };
        }
        const gestureId = String(data.gestureId);
        if (operation === "input.begin") {
          await runtime.beginLiveInput(gestureId, String(data.expectedInputGeneration));
        } else if (operation === "input.end") {
          await runtime.endLiveInput(gestureId);
        } else if (operation === "mouse.move") {
          await runtime.mouseMove(Number(data.x), Number(data.y), gestureId);
        } else if (operation === "mouse.down") {
          await runtime.mouseDown(Number(data.x), Number(data.y), "left", 1, gestureId);
          await vi.advanceTimersByTimeAsync(afterDownDelay);
        } else if (operation === "mouse.up") {
          await runtime.mouseUp(Number(data.x), Number(data.y), "left", 1, gestureId);
        }
        return null;
      },
    },
  });
  await manager.connect();
  const { viewerToken } = await manager.attach("owned", "Fixture");
  const { controlToken } = await manager.acquireControl(viewerToken);
  const capture = await manager.capture(viewerToken);
  return {
    manager,
    publications,
    setDelays: (metadata: number, afterDown: number) => {
      stateDelay = metadata;
      afterDownDelay = afterDown;
    },
    send: () =>
      manager.sendInput({
        viewerToken,
        controlToken,
        expected: {
          sessionId: capture.state.sessionId,
          runtimeId: capture.state.runtimeId!,
          bridgeEpoch: capture.state.bridgeEpoch!,
          navigationGeneration: capture.state.navigationGeneration,
          viewportGeneration: capture.state.viewportGeneration,
        },
        target: capture.frame!,
        event: {
          kind: "click",
          button: "left",
          clickCount: 1,
          point: { x: 100, y: 100, width: 1280, height: 800 },
        },
      }),
  };
}

it("finishes one click exceeding five seconds overall with each native idle gap bounded", async () => {
  const f = await fixture();
  try {
    f.setDelays(2_500, 0);
    const began = Date.now();
    await expect(f.send()).resolves.toHaveProperty("state");
    expect(Date.now() - began).toBeGreaterThan(5_000);
    expect(f.publications).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  } finally {
    f.manager.disconnect();
  }
});

it("retains native idle expiry, releases the original press once and refuses replay", async () => {
  const f = await fixture();
  try {
    f.setDelays(0, 6_000);
    await expect(f.send()).rejects.toThrow("attachment changed");
    expect(f.publications).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    await expect(f.send()).rejects.toThrow("frame is stale");
    expect(f.publications).toHaveLength(3);
  } finally {
    f.manager.disconnect();
  }
});
