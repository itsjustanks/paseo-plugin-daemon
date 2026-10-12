/** Exact fresh runtime receipts avoid resending cached JPEGs without reviving invalidated input. */
import { describe, expect, it } from "vitest";
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";
import { DEFAULT_CAPTURE_QUALITY } from "../../shared/managed-browser/capture-settings";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";
import type { JsonValue } from "./runtime-protocol";

async function fixture() {
  let now = 1_000;
  let token = 0;
  let frames = 0;
  let inputGeneration = "0:0";
  const raw: Record<string, JsonValue> = {
    dataBase64: Buffer.alloc(200_000, 120).toString("base64"),
    byteLength: 200_000,
    width: 1280,
    height: 800,
    transport: "screenshot",
    capturedAt: new Date(now).toISOString(),
  };
  const client: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "runtime-one",
      createdAt: 1,
    }),
    requestWorkspace: async (_workspace, operation, input) => {
      if (operation === "identity") return { userAgent: "Fixture" };
      if (operation === "state")
        return {
          url: "https://fixture.invalid/",
          title: "Fixture",
          canGoBack: false,
          canGoForward: false,
          inputGeneration,
        };
      if (operation === "frame") {
        frames++;
        return { ...raw };
      }
      if (operation === "emulate" && input && typeof input === "object" && !Array.isArray(input)) {
        raw.width = input.width!;
        raw.height = input.height!;
      }
      if (operation === "cursor") return null;
      return null;
    },
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect: () => {},
  };
  const manager = new SessionManager({
    client,
    now: () => now,
    validateWorkspace: async () => true,
    issueToken: () => String(++token).padStart(32, "0"),
  });
  await manager.connect();
  const viewer = await manager.attach("owned-perf-fixture", "Viewer");
  const control = await manager.acquireControl(viewer.viewerToken);
  const expected = (state: BrowserState) => ({
    sessionId: state.sessionId,
    runtimeId: state.runtimeId!,
    bridgeEpoch: state.bridgeEpoch!,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  });
  return {
    manager,
    raw,
    viewer,
    control,
    expected,
    get frames() {
      return frames;
    },
    advance(ms = 250) {
      now += ms;
    },
    documentChange() {
      inputGeneration = "0:1";
    },
    session: () =>
      (
        manager as unknown as { sessions: Map<string, { runtimeId: string; bridgeEpoch: number }> }
      ).sessions.get("owned-perf-fixture")!,
  };
}
const target = (frame: BrowserFrame) => ({
  frameId: frame.frameId,
  navigationGeneration: frame.navigationGeneration,
  viewportGeneration: frame.viewportGeneration,
});

describe("exact runtime receipt reuse across policy cache expiry", () => {
  it("returns metadata-only repeated polls while preserving current-frame input authority", async () => {
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken);
      for (let index = 0; index < 3; index++) {
        f.advance();
        const repeated = await f.manager.capture(
          f.viewer.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          first.frame!.frameId,
        );
        expect(repeated.frame).toBeNull();
      }
      expect(f.frames).toBe(4);
      const result = await f.manager.beginGesture({
        viewerToken: f.viewer.viewerToken,
        controlToken: f.control.controlToken,
        expected: f.expected(first.state),
        target: target(first.frame!),
        pointerKind: "mouse",
      });
      expect(result).toHaveProperty("gestureId");
    } finally {
      f.manager.disconnect();
    }
  });

  it("assigns a new token for any changed runtime receipt field, including equal pixels at a new capture time", async () => {
    for (const [field, value] of [
      ["capturedAt", "2026-10-03T12:00:00.000Z"],
      ["transport", "cdp-screencast"],
      ["dataBase64", Buffer.alloc(200_000, 121).toString("base64")],
      ["byteLength", 1],
    ] as const) {
      const f = await fixture();
      try {
        const first = await f.manager.capture(f.viewer.viewerToken);
        f.advance();
        f.raw[field] = value;
        if (field === "byteLength") f.raw.dataBase64 = "eA==";
        const next = await f.manager.capture(
          f.viewer.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          first.frame!.frameId,
        );
        expect(next.frame?.frameId).not.toBe(first.frame!.frameId);
      } finally {
        f.manager.disconnect();
      }
    }
  });

  it("keeps per-quality tokens separate even for identical runtime receipts", async () => {
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken, "high");
      f.advance();
      const next = await f.manager.capture(f.viewer.viewerToken, "medium", first.frame!.frameId);
      expect(next.frame?.frameId).not.toBe(first.frame!.frameId);
    } finally {
      f.manager.disconnect();
    }
  });

  it("cannot revive an identical runtime receipt after input invalidation", async () => {
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken);
      await f.manager.sendInput({
        viewerToken: f.viewer.viewerToken,
        controlToken: f.control.controlToken,
        expected: f.expected(first.state),
        target: target(first.frame!),
        event: { kind: "type", text: "x" },
      });
      f.advance();
      const next = await f.manager.capture(
        f.viewer.viewerToken,
        DEFAULT_CAPTURE_QUALITY,
        first.frame!.frameId,
      );
      expect(next.frame?.frameId).not.toBe(first.frame!.frameId);
      await expect(
        f.manager.beginGesture({
          viewerToken: f.viewer.viewerToken,
          controlToken: f.control.controlToken,
          expected: f.expected(next.state),
          target: target(first.frame!),
          pointerKind: "mouse",
        }),
      ).resolves.toMatchObject({ admission: "stale-frame" });
    } finally {
      f.manager.disconnect();
    }
  });

  it("changes token for exact resized geometry and refuses malformed old dimensions", async () => {
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken);
      await f.manager.resize({
        viewerToken: f.viewer.viewerToken,
        controlToken: f.control.controlToken,
        expected: f.expected(first.state),
        viewport: { width: 1920, height: 1200 },
      });
      const next = await f.manager.capture(
        f.viewer.viewerToken,
        DEFAULT_CAPTURE_QUALITY,
        first.frame!.frameId,
      );
      expect(next.frame).toMatchObject({ width: 1920, height: 1200 });
      expect(next.frame!.frameId).not.toBe(first.frame!.frameId);
      f.advance();
      f.raw.width = 1280;
      await expect(f.manager.capture(f.viewer.viewerToken)).rejects.toThrow("stale viewport");
    } finally {
      f.manager.disconnect();
    }
  });

  it("does not reuse receipts under changed runtime identity or bridge epoch", async () => {
    for (const field of ["runtimeId", "bridgeEpoch"] as const) {
      const f = await fixture();
      try {
        const first = await f.manager.capture(f.viewer.viewerToken);
        f.advance();
        if (field === "runtimeId") f.session().runtimeId = "runtime-two";
        else f.session().bridgeEpoch = 2;
        const next = await f.manager.capture(
          f.viewer.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          first.frame!.frameId,
        );
        expect(next.frame!.frameId).not.toBe(first.frame!.frameId);
      } finally {
        f.manager.disconnect();
      }
    }
  });

  it("cannot deduplicate legacy unmarked receipts or metadata after a document change", async () => {
    for (const field of ["capturedAt", "transport"] as const) {
      const f = await fixture();
      try {
        delete f.raw[field];
        const first = await f.manager.capture(f.viewer.viewerToken);
        f.advance();
        const next = await f.manager.capture(
          f.viewer.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          first.frame!.frameId,
        );
        expect(next.frame!.frameId).not.toBe(first.frame!.frameId);
      } finally {
        f.manager.disconnect();
      }
    }
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken);
      f.documentChange();
      await f.manager.status(f.viewer.viewerToken);
      f.advance();
      const next = await f.manager.capture(
        f.viewer.viewerToken,
        DEFAULT_CAPTURE_QUALITY,
        first.frame!.frameId,
      );
      expect(next.frame!.frameId).not.toBe(first.frame!.frameId);
      expect(next.state.navigationGeneration).toBeGreaterThan(first.state.navigationGeneration);
    } finally {
      f.manager.disconnect();
    }
  });

  it("avoids repeated large payloads while every expired policy read still asks the runtime for fresh pixels", async () => {
    const f = await fixture();
    try {
      const first = await f.manager.capture(f.viewer.viewerToken);
      let before = JSON.stringify(first).length;
      let after = before;
      for (let index = 0; index < 3; index++) {
        f.advance();
        const reply = await f.manager.capture(
          f.viewer.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          first.frame!.frameId,
        );
        after += JSON.stringify(reply).length;
        before += JSON.stringify({ state: reply.state, frame: first.frame }).length;
      }
      expect(after).toBeLessThan(before * 0.26);
      expect(f.frames).toBe(4);
    } finally {
      f.manager.disconnect();
    }
  });
});
