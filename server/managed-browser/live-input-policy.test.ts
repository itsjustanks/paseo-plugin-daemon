import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserGestureEvent,
  type BrowserInputEvent,
  MAX_HELD_BROWSER_KEYS,
} from "../../shared/managed-browser/browser";
import { JPEG_QUALITY } from "../../shared/managed-browser/capture-settings";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";

/** Exercise the real policy with a deterministic owned runtime; no browser or services are started. */
async function fixture(
  timing: { now?: () => number; viewerTtlMs?: number; controlLeaseMs?: number } = {},
) {
  let counter = 0;
  let url = "https://fixture.invalid/";
  let inputGeneration = "0:0";
  let pinnedGeneration: string | null = null;
  let pinnedUrl: string | null = null;
  let intercept: (operation: string) => Promise<void> = async () => {};
  const calls: { operation: string; input: unknown }[] = [];
  const client: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "r".repeat(32),
      createdAt: 1,
    }),
    requestWorkspace: async (_workspace, operation, input) => {
      calls.push({ operation, input });
      await intercept(operation);
      if (operation === "input.begin") {
        const expectedInputGeneration = (input as { expectedInputGeneration?: string | null })
          .expectedInputGeneration;
        if (expectedInputGeneration != null && expectedInputGeneration !== inputGeneration) {
          throw new Error("Live browser input attachment changed before binding");
        }
        pinnedGeneration = inputGeneration;
        pinnedUrl = url;
      }
      if (
        operation === "input.check" &&
        (pinnedGeneration !== inputGeneration || pinnedUrl !== url)
      )
        throw new Error("Live browser input attachment changed");
      if (operation === "identity") return { userAgent: "Fixture Chromium" };
      if (operation === "state")
        return { url, title: "Fixture", canGoBack: false, canGoForward: false, inputGeneration };
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
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect: () => {},
  };
  const manager = new SessionManager({
    validateWorkspace: async () => true,
    client,
    issueToken: () => (++counter).toString().padStart(32, "0"),
    ...timing,
  });
  await manager.connect();
  const { viewerToken } = await manager.attach("owned-workspace", "Viewer");
  const { controlToken } = await manager.acquireControl(viewerToken);
  const capture = await manager.capture(viewerToken);
  const frame = capture.frame!;
  const expected = {
    sessionId: capture.state.sessionId,
    runtimeId: capture.state.runtimeId!,
    bridgeEpoch: capture.state.bridgeEpoch!,
    navigationGeneration: capture.state.navigationGeneration,
    viewportGeneration: capture.state.viewportGeneration,
  };
  const context = { viewerToken, controlToken, expected };
  const target = {
    frameId: frame.frameId,
    navigationGeneration: frame.navigationGeneration,
    viewportGeneration: frame.viewportGeneration,
  };
  let gestureId = "";
  let sequence = 1;
  return {
    manager,
    calls,
    context,
    target,
    begin: async (pointerKind: "mouse" | "touch" = "mouse") => {
      const reply = await manager.beginGesture({ ...context, target, pointerKind });
      if ("admission" in reply) throw new Error("Fixture expected accepted frame");
      gestureId = reply.gestureId;
      sequence = reply.nextSequence;
      return reply;
    },
    update: async (event: BrowserGestureEvent, withTarget = false) => {
      const result = await manager.updateGesture({
        ...context,
        gestureId,
        sequence,
        event,
        ...(withTarget ? { target } : {}),
      });
      sequence = result.nextSequence;
      return result;
    },
    end: async (cancel = false, overrideSequence?: number) =>
      manager.endGesture({ ...context, gestureId, sequence: overrideSequence ?? sequence, cancel }),
    changeUrl: (value: string) => {
      url = value;
    },
    reloadSameUrl: () => {
      inputGeneration = "0:1";
    },
    replaceTarget: () => {
      inputGeneration = "1:0";
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}

const point = (x = 50, y = 40) => ({ x, y, width: 640, height: 400 });
afterEach(() => vi.useRealTimers());

describe("owned ordered live input", () => {
  it("rejects a thirty-third distinct held key before native publication and cancels the bounded channel", async () => {
    const state = await fixture();
    try {
      await state.begin();
      for (let index = 0; index < MAX_HELD_BROWSER_KEYS; index++) {
        await state.update({
          kind: "key",
          type: "down",
          key: "Unidentified",
          code: `Unknown${index}`,
          modifiers: 0,
          repeat: false,
        });
      }
      await expect(
        state.update({
          kind: "key",
          type: "down",
          key: "Unidentified",
          code: "UnknownExtra",
          modifiers: 0,
          repeat: false,
        }),
      ).rejects.toThrow("Too many simultaneously held");
      expect(state.calls.filter(({ operation }) => operation === "input.key")).toHaveLength(
        MAX_HELD_BROWSER_KEYS,
      );
      expect(state.calls.filter(({ operation }) => operation === "input.end")).toHaveLength(1);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("releases held input before a mode-only change with unchanged display dimensions", async () => {
    const state = await fixture();
    try {
      await state.begin();
      await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
      const beforeChange = state.calls.length;
      const changed = await state.manager.applyDevicePreset({
        ...state.context,
        presetId: "pixel-7-sharp",
        preserveDisplay: true,
      });

      expect(changed.state.viewport).toEqual({ width: 1280, height: 800 });
      expect(changed.state.captureScale).toBe(1);
      // The runtime's input.end owns release of every held mouse/touch/key input.
      const changeCalls = state.calls.slice(beforeChange);
      const released = changeCalls.findIndex(({ operation }) => operation === "input.end");
      const emulated = changeCalls.findIndex(({ operation }) => operation === "emulate");
      expect(released).toBeGreaterThan(-1);
      expect(emulated).toBeGreaterThan(released);
      await expect(state.update({ kind: "move", point: point(90, 60) })).rejects.toThrow();
    } finally {
      await state.manager.disconnect();
    }
  });

  it("fills the panel while preserving mobile behavior and sharp capture density", async () => {
    const state = await fixture();
    try {
      const mobile = await state.manager.applyDevicePreset({
        ...state.context,
        presetId: "pixel-7-sharp",
      });
      const context = {
        ...state.context,
        expected: {
          ...state.context.expected,
          viewportGeneration: mobile.state.viewportGeneration,
        },
      };
      const viewport = { width: 1000, height: 700 };
      const resized = await state.manager.resize({ ...context, viewport, preserveEmulation: true });
      expect(resized.state.viewport).toEqual(viewport);
      expect(resized.state.devicePresetId).toBe("pixel-7-sharp");
      expect(resized.state.captureScale).toBe(2);
      expect(resized.state.userAgent).toBe(mobile.state.userAgent);
      expect(
        state.calls.filter(({ operation }) => operation === "emulate").at(-1)?.input,
      ).toMatchObject({
        ...viewport,
        captureScale: 2,
        mobile: true,
        touch: true,
        userAgent: mobile.state.userAgent,
      });

      const resizedContext = {
        ...context,
        expected: { ...context.expected, viewportGeneration: resized.state.viewportGeneration },
      };
      await expect(
        state.manager.resize({
          ...resizedContext,
          viewport: { width: 2000, height: 700 },
          preserveEmulation: true,
        }),
      ).rejects.toThrow("capture density");
      // Automatic following lowers density together with a larger CSS viewport.
      const large = await state.manager.resize({
        ...resizedContext,
        viewport: { width: 2400, height: 2000 },
        preserveEmulation: true,
        captureDensity: 1,
      });
      expect(large.state.viewport).toEqual({ width: 2400, height: 2000 });
      expect(large.state.captureScale).toBe(1);
      expect(large.state.devicePresetId).toBe("pixel-7-sharp");
      expect(large.state.userAgent).toBe(mobile.state.userAgent);
      expect(
        state.calls.filter(({ operation }) => operation === "emulate").at(-1)?.input,
      ).toMatchObject({
        width: 2400,
        height: 2000,
        captureScale: 1,
        mobile: true,
        touch: true,
      });
      const sharp = await state.manager.resize({
        ...resizedContext,
        expected: {
          ...resizedContext.expected,
          viewportGeneration: large.state.viewportGeneration,
        },
        viewport,
        preserveEmulation: true,
        captureDensity: 2,
      });
      expect(sharp.state.captureScale).toBe(2);
      expect(sharp.state.devicePresetId).toBe("pixel-7-sharp");
      // Explicit custom dimensions retain their established desktop reset behavior.
      const custom = await state.manager.resize({
        ...resizedContext,
        expected: {
          ...resizedContext.expected,
          viewportGeneration: sharp.state.viewportGeneration,
        },
        viewport,
      });
      expect(custom.state.devicePresetId).toBeNull();
      expect(custom.state.captureScale).toBe(1);
      expect(
        state.calls.filter(({ operation }) => operation === "emulate").at(-1)?.input,
      ).toMatchObject({
        mobile: false,
        touch: false,
        captureScale: 1,
      });
    } finally {
      await state.manager.disconnect();
    }
  });

  it("returns fresh state and closes the channel after an acknowledged mouse release navigates", async () => {
    const state = await fixture();
    try {
      await state.begin();
      await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
      state.intercept(async (operation) => {
        if (operation === "mouse.up") state.changeUrl("https://fixture.invalid/after");
      });
      const reply = await state.update({
        kind: "up",
        button: "left",
        clickCount: 1,
        point: point(),
      });
      expect(reply.state.url).toBe("https://fixture.invalid/after");
      expect(reply.state.navigationGeneration).toBe(
        state.context.expected.navigationGeneration + 1,
      );
      expect(reply.cursor).toBeNull();
      expect(reply.completion).toBe("navigation");
      expect(state.calls.filter((call) => call.operation === "mouse.up")).toHaveLength(1);
      await expect(state.update({ kind: "move", point: point() })).rejects.toThrow("unavailable");
    } finally {
      state.manager.disconnect();
    }
  });

  it("acknowledges a form-submit key before same-URL document replacement without replay", async () => {
    const state = await fixture();
    try {
      await state.begin();
      state.intercept(async (operation) => {
        if (operation === "input.key") state.reloadSameUrl();
      });
      const reply = await state.update({
        kind: "key",
        type: "down",
        key: "Enter",
        code: "Enter",
        modifiers: 0,
        repeat: false,
      });
      expect(reply.completion).toBe("navigation");
      expect(reply.state.navigationGeneration).toBe(
        state.context.expected.navigationGeneration + 1,
      );
      expect(state.calls.filter((call) => call.operation === "input.key")).toHaveLength(1);
      expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
      await expect(
        state.update({
          kind: "key",
          type: "up",
          key: "Enter",
          code: "Enter",
          modifiers: 0,
          repeat: false,
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      state.manager.disconnect();
    }
  });

  it("keeps pre-publication document drift and uncertain publication failures rejected", async () => {
    for (const scenario of ["before", "uncertain"] as const) {
      const state = await fixture();
      try {
        await state.begin();
        if (scenario === "before") state.reloadSameUrl();
        else
          state.intercept(async (operation) => {
            if (operation !== "mouse.down") return;
            state.changeUrl("https://fixture.invalid/after");
            throw new Error("Mutation outcome is unknown");
          });
        await expect(
          state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
        ).rejects.toThrow(scenario === "before" ? "attachment" : "unknown");
        expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(
          scenario === "before" ? 0 : 1,
        );
      } finally {
        state.manager.disconnect();
      }
    }
  });

  it("does not treat a bridge fence after publication as document-only completion", async () => {
    const state = await fixture();
    try {
      await state.begin();
      state.intercept(async (operation) => {
        if (operation !== "mouse.down") return;
        state.changeUrl("https://fixture.invalid/after");
        state.manager.setBridgeEpoch(2);
      });
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("bridge");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    } finally {
      state.manager.disconnect();
    }
  });

  it("refuses target replacement after a successful native input acknowledgment", async () => {
    const state = await fixture();
    try {
      await state.begin();
      let published = false;
      state.intercept(async (operation) => {
        if (operation === "mouse.down") published = true;
        if (operation === "input.check" && published) state.replaceTarget();
      });
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("attachment");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
      expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
    } finally {
      state.manager.disconnect();
    }
  });

  it("retains a bounded decoded frame after hover, then streams every pressed drag move without requiring new frames", async () => {
    const state = await fixture();
    await state.begin();
    expect((await state.update({ kind: "move", point: point() })).cursor).toBe("pointer");
    await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
    await state.update({ kind: "move", point: point(70) });
    await state.update({ kind: "move", point: point(90) });
    await state.update({ kind: "up", button: "left", clickCount: 1, point: point(90) });
    await state.end();
    expect(
      state.calls
        .filter((call) => call.operation === "mouse.move")
        .map((call) => (call.input as { x: number }).x),
    ).toEqual([100, 140, 180]);
    expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
    state.manager.disconnect();
  });

  it("returns known non-admission for revoked frame before channel publication or old-channel cancellation", async () => {
    const state = await fixture();
    await state.begin();
    await state.update({ kind: "scroll", point: point(), deltaX: 0, deltaY: 40 });
    const before = state.calls.length;
    const reply = await state.manager.beginGesture({
      ...state.context,
      target: { ...state.target, frameId: "z".repeat(32) },
      pointerKind: "mouse",
    });
    expect(reply).toHaveProperty("admission", "stale-frame");
    expect(reply).not.toHaveProperty("gestureId");
    expect(state.calls.slice(before).map((call) => call.operation)).not.toContain("input.begin");
    expect(state.calls.slice(before).map((call) => call.operation)).not.toContain("input.end");
    await state.update({ kind: "scroll", point: point(), deltaX: 0, deltaY: 40 });
    await expect(
      state.manager.beginGesture({
        ...state.context,
        controlToken: "wrong",
        target: state.target,
        pointerKind: "mouse",
      }),
    ).rejects.toThrow();
    state.manager.disconnect();
  });

  it("does not return stale admission if its final metadata read fails or discovers replacement navigation", async () => {
    for (const failure of ["runtime", "navigation"] as const) {
      const state = await fixture();
      try {
        await state.begin();
        await state.update({ kind: "scroll", point: point(), deltaX: 0, deltaY: 40 });
        let reads = 0;
        state.intercept(async (operation) => {
          if (operation !== "state" || ++reads !== 2) return;
          if (failure === "runtime") throw new Error("Runtime read unavailable");
          state.changeUrl("https://replacement.invalid/");
        });
        const before = state.calls.length;
        await expect(
          state.manager.beginGesture({
            ...state.context,
            target: { ...state.target, frameId: "z".repeat(32) },
            pointerKind: "mouse",
          }),
        ).rejects.toThrow(failure === "runtime" ? "Runtime read unavailable" : "navigation");
        expect(state.calls.slice(before).map((call) => call.operation)).not.toContain(
          "input.begin",
        );
      } finally {
        state.manager.disconnect();
      }
    }
  });

  it("leaves native hover through a coordinate-free owned event while retaining frame admission", async () => {
    const state = await fixture();
    await state.begin();
    await state.update({ kind: "move", point: point() });
    expect((await state.update({ kind: "leave" })).cursor).toBeNull();
    expect(state.calls.find((call) => call.operation === "mouse.leave")?.input).not.toHaveProperty(
      "x",
    );
    await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
    await expect(state.update({ kind: "leave" })).rejects.toThrow("Release held");
    expect(state.calls.filter((call) => call.operation === "mouse.leave")).toHaveLength(1);
    state.manager.disconnect();
  });

  it("every independent press needs a fresh decoded receipt; the receipt a press used is spent", async () => {
    const state = await fixture();
    try {
      await state.begin();
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }),
      ).rejects.toThrow("current frame");
      expect(state.calls.some((call) => call.operation === "mouse.down")).toBe(false);
      await state.begin();
      await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
      await state.update({ kind: "up", button: "left", clickCount: 1, point: point() });
      // Held release reuses its channel, but the same visible receipt cannot press again.
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("frame is stale");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
      // A discrete agent press stays strict as well.
      await expect(
        state.manager.sendInput({
          ...state.context,
          target: state.target,
          event: { kind: "click", point: point(), button: "left", clickCount: 1 },
        }),
      ).rejects.toThrow("frame is stale");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("a stalled presentation cannot admit a press after its receipt expires, however long control is held", async () => {
    vi.useFakeTimers();
    const state = await fixture();
    try {
      await state.begin();
      // Hover keeps the channel and lease alive without revoking the receipt.
      for (let elapsed = 0; elapsed < 6_000; elapsed += 2_000) {
        await vi.advanceTimersByTimeAsync(2_000);
        await state.update({ kind: "move", point: point() });
      }
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("frame is stale");
      expect(state.calls.some((call) => call.operation === "mouse.down")).toBe(false);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("an expired or spent receipt cannot reopen a channel, with or without prior admission", async () => {
    vi.useFakeTimers();
    const state = await fixture();
    try {
      await state.begin();
      await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
      await state.update({ kind: "up", button: "left", clickCount: 1, point: point() });
      await state.end();
      const beforeReopen = state.calls.length;
      const spent = await state.manager.beginGesture({
        ...state.context,
        target: state.target,
        pointerKind: "mouse",
      });
      expect(spent).toHaveProperty("admission", "stale-frame");
      expect(state.calls.slice(beforeReopen).some((call) => call.operation === "input.begin")).toBe(
        false,
      );
      const fresh = await state.manager.capture(state.context.viewerToken, "low");
      const freshTarget = {
        frameId: fresh.frame!.frameId,
        navigationGeneration: fresh.frame!.navigationGeneration,
        viewportGeneration: fresh.frame!.viewportGeneration,
      };
      await vi.advanceTimersByTimeAsync(5_001);
      const expired = await state.manager.beginGesture({
        ...state.context,
        target: freshTarget,
        pointerKind: "mouse",
      });
      expect(expired).toHaveProperty("admission", "stale-frame");
      expect(state.calls.some((call) => call.operation === "mouse.down")).toBe(true);
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("maps native touch coordinates, preserves stable identifiers and accepts partial release via the active set", async () => {
    const state = await fixture();
    await state.begin("touch");
    await state.update(
      {
        kind: "touch",
        type: "start",
        points: [
          { ...point(), id: 31 },
          { ...point(80), id: 99 },
        ],
      },
      true,
    );
    await state.update({ kind: "touch", type: "move", points: [{ ...point(60), id: 31 }] });
    await state.update({ kind: "touch", type: "end", points: [] });
    await state.end();
    const touches = state.calls
      .filter((call) => call.operation === "touch")
      .map((call) => call.input as { points: unknown[] });
    expect(touches[0]!.points).toEqual([
      { x: 100, y: 80, id: 31 },
      { x: 160, y: 80, id: 99 },
    ]);
    expect(touches[1]!.points).toEqual([{ x: 120, y: 80, id: 31 }]);
    expect(touches[2]!.points).toEqual([]);
    state.manager.disconnect();
  });

  it("accepts a staggered second finger within one held gesture, but refuses a new independent start from an old frame", async () => {
    const state = await fixture();
    await state.begin("touch");
    await state.update({ kind: "touch", type: "start", points: [{ ...point(), id: 1 }] }, true);
    await state.update({
      kind: "touch",
      type: "start",
      points: [
        { ...point(), id: 1 },
        { ...point(80), id: 2 },
      ],
    });
    await state.update({ kind: "touch", type: "end", points: [] });
    await expect(
      state.update({ kind: "touch", type: "start", points: [{ ...point(), id: 3 }] }, true),
    ).rejects.toThrow("frame");
    expect(state.calls.filter((call) => call.operation === "touch")).toHaveLength(3);
    state.manager.disconnect();
  });

  it("never replays an uncertain press and revokes its earlier discrete observation", async () => {
    const state = await fixture();
    try {
      await state.begin();
      state.intercept(async (operation) => {
        if (operation === "mouse.down") throw new Error("Unknown publication outcome");
      });
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("Unknown publication");
      await expect(
        state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
      ).rejects.toThrow("unavailable");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
      expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
      state.intercept(async () => {});
      await expect(
        state.manager.sendInput({
          ...state.context,
          target: state.target,
          event: { kind: "click", point: point(), button: "left", clickCount: 1 },
        }),
      ).rejects.toThrow("frame is stale");
      expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("rejects document replacement between policy preflight and native binding without pressing the replacement", async () => {
    const state = await fixture();
    try {
      state.intercept(async (operation) => {
        if (operation === "input.begin") state.reloadSameUrl();
      });
      await expect(state.begin()).rejects.toThrow("attachment changed before binding");
      expect(state.calls.some((call) => call.operation === "mouse.down")).toBe(false);
      const beginCall = state.calls.find((call) => call.operation === "input.begin");
      expect(beginCall?.input).toMatchObject({ expectedInputGeneration: "0:0" });
    } finally {
      await state.manager.disconnect();
    }
  });

  it("discrete input refuses a document that navigated after capture before any native primitive", async () => {
    const events: BrowserInputEvent[] = [
      { kind: "type", text: "secret" },
      { kind: "key", key: "Enter" },
      { kind: "move", point: point() },
      { kind: "scroll", point: point(), deltaX: 0, deltaY: 40 },
      { kind: "click", point: point(), button: "left", clickCount: 1 },
    ];
    for (const event of events) {
      const state = await fixture();
      try {
        state.changeUrl("https://fixture.invalid/autonomous-navigation");
        state.reloadSameUrl();
        const before = state.calls.length;
        await expect(
          state.manager.sendInput({ ...state.context, target: state.target, event }),
        ).rejects.toThrow("stale");
        expect(
          state.calls
            .slice(before)
            .filter((call) => /^(text|key|mouse|input\.begin)/.test(call.operation)),
        ).toEqual([]);
      } finally {
        await state.manager.disconnect();
      }
    }
  });

  it("pins the reconciled document at native begin, so a replacement racing the check publishes nothing", async () => {
    const state = await fixture();
    try {
      state.intercept(async (operation) => {
        if (operation === "input.begin") state.reloadSameUrl();
      });
      const before = state.calls.length;
      await expect(
        state.manager.sendInput({
          ...state.context,
          target: state.target,
          event: { kind: "type", text: "secret" },
        }),
      ).rejects.toThrow("attachment changed before binding");
      const calls = state.calls.slice(before);
      expect(calls.find((call) => call.operation === "input.begin")?.input).toMatchObject({
        expectedInputGeneration: "0:0",
      });
      expect(calls.some((call) => call.operation === "text.insert")).toBe(false);
      expect(calls.some((call) => call.operation === "input.end")).toBe(true);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("spends the capture when admitted discrete input fails partway, so it cannot be reused", async () => {
    const state = await fixture();
    try {
      state.intercept(async (operation) => {
        if (operation === "mouse.up") throw new Error("Runtime failure after press");
      });
      await expect(
        state.manager.sendInput({
          ...state.context,
          target: state.target,
          event: { kind: "click", point: point(), button: "left", clickCount: 1 },
        }),
      ).rejects.toThrow("Runtime failure");
      state.intercept(async () => {});
      await expect(
        state.manager.sendInput({
          ...state.context,
          target: state.target,
          event: { kind: "type", text: "again" },
        }),
      ).rejects.toThrow("frame is stale");
      expect(state.calls.filter((call) => call.operation === "text.insert")).toEqual([]);
    } finally {
      await state.manager.disconnect();
    }
  });

  it("rejects dropped sequence/layout and never replays an uncertain published packet", async () => {
    const state = await fixture();
    const begin = await state.begin();
    await expect(
      state.manager.updateGesture({
        ...state.context,
        gestureId: begin.gestureId,
        sequence: 2,
        event: { kind: "move", point: point() },
      }),
    ).rejects.toThrow("sequence");
    expect(state.calls.some((call) => call.operation === "mouse.move")).toBe(false);
    await state.begin();
    await state.update({ kind: "move", point: point() });
    await expect(state.update({ kind: "move", point: { ...point(), width: 600 } })).rejects.toThrow(
      "geometry",
    );
    await state.begin();
    state.intercept(async (op) => {
      if (op === "mouse.down") throw new Error("Unknown publication outcome");
    });
    await expect(
      state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true),
    ).rejects.toThrow("Unknown publication");
    expect(state.calls.filter((call) => call.operation === "mouse.down")).toHaveLength(1);
    expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(3);
    state.manager.disconnect();
  });

  it("same-URL reload, navigation and bridge epoch changes refuse and release the old channel", async () => {
    for (const change of ["reload", "url", "bridge"] as const) {
      const state = await fixture();
      await state.begin();
      if (change === "reload") state.reloadSameUrl();
      if (change === "url") state.changeUrl("https://fixture.invalid/replacement");
      if (change === "bridge") state.manager.setBridgeEpoch(2);
      await expect(state.update({ kind: "move", point: point() })).rejects.toThrow();
      expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
      expect(state.calls.some((call) => call.operation === "mouse.move")).toBe(false);
      state.manager.disconnect();
    }
  });

  it("closes the old channel without denying an acknowledged navigation-causing press", async () => {
    const state = await fixture();
    await state.begin();
    state.intercept(async (op) => {
      if (op === "mouse.down") state.reloadSameUrl();
    });
    const reply = await state.update(
      { kind: "down", button: "left", clickCount: 1, point: point() },
      true,
    );
    expect(reply.state.navigationGeneration).toBe(state.context.expected.navigationGeneration + 1);
    await expect(state.update({ kind: "move", point: point() })).rejects.toThrow("unavailable");
    expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
    state.manager.disconnect();
  });

  it("idle timeout fires without another request and takeover/detach release immediately", async () => {
    vi.useFakeTimers();
    const timed = await fixture();
    await timed.begin();
    await timed.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(timed.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
    timed.manager.disconnect();
    for (const operation of ["takeover", "detach", "release"] as const) {
      const state = await fixture();
      await state.begin();
      if (operation === "takeover") {
        const other = await state.manager.attach("owned-workspace", "Other");
        await state.manager.acquireControl(other.viewerToken, true);
      } else if (operation === "detach") await state.manager.detach(state.context.viewerToken);
      else
        await state.manager.releaseControl(state.context.viewerToken, state.context.controlToken);
      expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
      state.manager.disconnect();
    }
  });

  it("viewer or lease expiry releases the held gesture and rejects its late events", async () => {
    for (const expiry of ["lease", "viewer"] as const) {
      let now = 1_000;
      const state = await fixture({
        now: () => now,
        ...(expiry === "lease" ? { controlLeaseMs: 1_000 } : { viewerTtlMs: 1_000 }),
      });
      await state.begin();
      await state.update({ kind: "down", button: "left", clickCount: 1, point: point() }, true);
      now += 1_001;
      // Another viewer's request is what observes the expiry; no request of the holder is needed.
      await state.manager.attach("owned-workspace", "Other");
      await vi.waitFor(() =>
        expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1),
      );
      const before = state.calls.length;
      await expect(state.update({ kind: "move", point: point(60, 50) })).rejects.toThrow();
      expect(
        state.calls.slice(before).filter((call) => call.operation.startsWith("mouse.")),
      ).toEqual([]);
      state.manager.disconnect();
    }
  });

  it("cursor metadata failure is optional while input/context failures remain visible", async () => {
    const state = await fixture();
    await state.begin();
    state.intercept(async (op) => {
      if (op === "cursor") throw new Error("Unsupported hit test");
    });
    expect((await state.update({ kind: "move", point: point() })).cursor).toBeNull();
    await state.end();
    state.manager.disconnect();
  });
});

it("streams keyboard edges and committed text without a fresh frame per keystroke", async () => {
  const state = await fixture();
  await state.begin();
  const key = {
    kind: "key",
    type: "down",
    key: "a",
    code: "KeyA",
    modifiers: 0,
    repeat: false,
  } as const;
  await state.update(key);
  await state.update({ ...key, repeat: true });
  await state.update({ ...key, type: "up" });
  await state.update({ kind: "text", text: "漢字\n😀" });
  await state.end();
  expect(state.calls.filter((call) => call.operation === "input.key")).toHaveLength(3);
  expect(state.calls.filter((call) => call.operation === "input.text")).toEqual([
    { operation: "input.text", input: expect.objectContaining({ text: "漢字\n😀" }) },
  ]);
});

it("cancels a held gesture on device mode changes without reloading or inventing navigation", async () => {
  const state = await fixture();
  await state.begin();
  await state.update({
    kind: "key",
    type: "down",
    key: "Control",
    code: "ControlLeft",
    modifiers: 2,
    repeat: false,
  });
  const reply = await state.manager.applyDevicePreset({ ...state.context, presetId: "pixel-7" });
  expect(reply.state.navigationGeneration).toBe(state.context.expected.navigationGeneration);
  expect(reply.state.viewportGeneration).toBe(state.context.expected.viewportGeneration + 1);
  expect(state.calls.filter((call) => call.operation === "input.end")).toHaveLength(1);
  expect(
    state.calls.filter((call) => call.operation === "reload" || call.operation === "navigate"),
  ).toEqual([]);
  expect(state.calls.filter((call) => call.operation === "emulate").at(-1)?.input).toMatchObject({
    mobile: true,
    touch: true,
  });
});

it("threads actual click modifier snapshots through the owned gesture without key synthesis", async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.update(
      { kind: "down", point: point(), button: "left", clickCount: 1, modifiers: 10 },
      true,
    );
    await f.update({ kind: "up", point: point(), button: "left", clickCount: 1, modifiers: 0 });
    const pointer = f.calls.filter(
      (call) => call.operation === "mouse.down" || call.operation === "mouse.up",
    );
    expect(pointer.map((call) => call.input)).toEqual([
      expect.objectContaining({ modifiers: 10 }),
      expect.objectContaining({ modifiers: 0 }),
    ]);
    expect(f.calls.some((call) => call.operation === "input.key")).toBe(false);
    await f.end();
  } finally {
    f.manager.disconnect();
  }
});

it("requests JPEG100 and JPEG85 independently from the default-quality stream", async () => {
  const f = await fixture();
  try {
    await f.manager.capture(f.context.viewerToken, "maximum");
    await f.manager.capture(f.context.viewerToken, "high");
    expect(f.calls.filter((call) => call.operation === "frame").map((call) => call.input)).toEqual([
      expect.objectContaining({ quality: JPEG_QUALITY.medium }),
      expect.objectContaining({ quality: JPEG_QUALITY.maximum }),
      expect.objectContaining({ quality: JPEG_QUALITY.high }),
    ]);
  } finally {
    f.manager.disconnect();
  }
});
