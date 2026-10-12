import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HELD_BROWSER_KEYS } from "../../shared/managed-browser/browser";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { CdpUnknownOutcomeError } from "./cdp";
import { createRuntimeOwner } from "./runtime-owner";

/** Exercise native publication/cleanup without starting Chromium or touching any profile. */
function fixture() {
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "test",
  });
  const calls: {
    method: string;
    params: Record<string, unknown>;
    options: { timeoutMs?: number } | undefined;
  }[] = [];
  let intercept: (method: string) => Promise<void> = async () => {};
  const page = {
    send: async (
      method: string,
      params: Record<string, unknown> = {},
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ method, params, options });
      await intercept(method);
      return method === "Runtime.evaluate" ? { result: { value: "pointer" } } : {};
    },
  };
  const control = runtime as unknown as {
    page: typeof page;
    requirePage: () => Promise<typeof page>;
    documentGeneration: number;
    attachmentGeneration: number;
  };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  });
  control.requirePage = async () => control.page;
  return {
    runtime,
    control,
    page,
    calls,
    begin: (id: string) =>
      runtime.beginLiveInput(id, `${control.attachmentGeneration}:${control.documentGeneration}`),
    intercept: (next: typeof intercept) => {
      intercept = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("runtime-owned live input", () => {
  it("releases a discrete unknown-down only on its captured original page", async () => {
    const state = fixture();
    await state.begin("internal-discrete");
    const unknown = new CdpUnknownOutcomeError("Down acknowledgement lost");
    state.intercept(async (method) => {
      if (method === "Input.dispatchKeyEvent") throw unknown;
    });
    await expect(state.runtime.keyDown("Control", "Control", "internal-discrete")).rejects.toBe(
      unknown,
    );
    state.intercept(async () => {});
    const replacementCalls: string[] = [];
    state.control.page = {
      ...state.page,
      send: async (method: string) => {
        replacementCalls.push(method);
        return {};
      },
    };
    state.control.attachmentGeneration++;
    await state.runtime.endLiveInput("internal-discrete");
    expect(
      state.calls
        .filter((entry) => entry.method === "Input.dispatchKeyEvent")
        .map((entry) => entry.params.type),
    ).toEqual(["keyDown", "keyUp"]);
    expect(replacementCalls).toEqual([]);
  });

  for (const counter of ["documentGeneration", "attachmentGeneration"] as const) {
    it(`refuses ${counter} drift during page attachment before admitting input`, async () => {
      const state = fixture();
      const expected = `${state.control.attachmentGeneration}:${state.control.documentGeneration}`;
      state.control.requirePage = async () => {
        state.control[counter]++;
        return state.page;
      };

      await expect(state.runtime.beginLiveInput("new", expected)).rejects.toThrow(
        "before admission",
      );
      await expect(state.runtime.mouseDown(20, 30, "left", 1, "new")).rejects.toThrow("attachment");
      expect(state.calls).toEqual([]);
    });

    it(`refuses ${counter} drift while releasing a previous held input channel`, async () => {
      const state = fixture();
      await state.begin("old");
      await state.runtime.mouseDown(20, 30, "left", 1, "old");
      const expected = `${state.control.attachmentGeneration}:${state.control.documentGeneration}`;
      state.intercept(async (method) => {
        if (method === "Input.dispatchMouseEvent") state.control[counter]++;
      });

      await expect(state.runtime.beginLiveInput("new", expected)).rejects.toThrow(
        "before admission",
      );
      await expect(state.runtime.mouseDown(20, 30, "left", 1, "new")).rejects.toThrow("attachment");
      expect(state.calls.filter((call) => call.params.type === "mousePressed")).toHaveLength(1);
      expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
    });
  }

  it("releases a cancelled held drag at its last native pointer position, not the origin", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(300, 410, "owned");
    await state.runtime.endLiveInput("owned");
    const released = state.calls.filter((call) => call.params.type === "mouseReleased");
    expect(released).toHaveLength(1);
    expect(released[0]?.params).toMatchObject({ x: 300, y: 410, button: "left", buttons: 0 });
  });

  it("releases a held button where an unacknowledged press was sent", async () => {
    const state = fixture();
    await state.begin("owned");
    state.intercept(async (method) => {
      if (method === "Input.dispatchMouseEvent") throw new Error("Unknown publication outcome");
    });
    await expect(state.runtime.mouseDown(55, 66, "left", 1, "owned")).rejects.toThrow();
    state.intercept(async () => {});
    await state.runtime.endLiveInput("owned");
    const released = state.calls.filter((call) => call.params.type === "mouseReleased");
    expect(released[0]?.params).toMatchObject({ x: 55, y: 66 });
  });

  it("bounds optional cursor sampling without cancelling a held mouse or replaying its press", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseDown(20, 30, "left", 1, "owned");
    state.intercept(async (method) => {
      if (method === "Runtime.evaluate") throw new Error("Runtime.evaluate timed out");
    });

    expect(await state.runtime.cursorAt(20, 30, "owned")).toBeNull();
    expect(state.calls.find((call) => call.method === "Runtime.evaluate")?.options?.timeoutMs).toBe(
      250,
    );
    await state.runtime.mouseUp(20, 30, "left", 1, "owned");
    expect(state.calls.filter((call) => call.params.type === "mousePressed")).toHaveLength(1);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
    await state.runtime.endLiveInput("owned");
  });

  it("completes acknowledged input that navigates while closing original held-input cleanup", async () => {
    const state = fixture();
    await state.begin("owned");
    state.intercept(async (method) => {
      if (method !== "Input.dispatchKeyEvent" || state.calls.at(-1)?.params.type !== "keyDown")
        return;
      state.control.documentGeneration++;
      await state.runtime.endLiveInput("owned");
    });
    await expect(
      state.runtime.dispatchKey(
        { kind: "key", type: "down", key: "Enter", code: "Enter", modifiers: 0, repeat: false },
        "owned",
      ),
    ).resolves.toBeUndefined();
    expect(state.calls.filter((call) => call.params.type === "keyDown")).toHaveLength(1);
    expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
    await expect(state.runtime.assertLiveInput("owned")).rejects.toThrow("attachment");
  });

  it("does not complete target replacement or an unacknowledged send as successful navigation", async () => {
    for (const scenario of ["replacement", "uncertain"] as const) {
      const state = fixture();
      await state.begin("owned");
      state.intercept(async (method) => {
        if (method !== "Input.dispatchMouseEvent") return;
        state.control.documentGeneration++;
        if (scenario === "uncertain") throw new Error("Mutation outcome is unknown");
        state.control.page = { send: async () => ({}) };
      });
      await expect(state.runtime.mouseDown(20, 30, "left", 1, "owned")).rejects.toThrow(
        scenario === "replacement" ? "attachment" : "unknown",
      );
      state.intercept(async () => {});
      await state.runtime.endLiveInput("owned");
    }
  });

  it("does not restore held touches after an acknowledged touch start navigates", async () => {
    const state = fixture();
    await state.begin("owned");
    state.intercept(async (method) => {
      if (method !== "Input.dispatchTouchEvent" || state.calls.at(-1)?.params.type !== "touchStart")
        return;
      state.control.documentGeneration++;
      await state.runtime.endLiveInput("owned");
    });
    await state.runtime.touch("touchStart", [{ x: 20, y: 30, id: 7 }], "owned");
    await state.runtime.releaseHeldInput();
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
    await expect(state.runtime.assertLiveInput("owned")).rejects.toThrow("attachment");
  });

  it("releases original held mouse after plugin/IPC disappearance without another policy request", async () => {
    vi.useFakeTimers();
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await vi.advanceTimersByTimeAsync(4_000);
    await state.runtime.assertLiveInput("owned");
    await state.runtime.cursorAt(10, 20, "owned");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
    await expect(state.runtime.mouseMove(20, 30, "owned")).rejects.toThrow("attachment");
  });

  it.each(["move", "up"] as const)(
    "an expired %s rejected before publication does not change the release point",
    async (operation) => {
      vi.useFakeTimers();
      const state = fixture();
      await state.begin("owned");
      await state.runtime.mouseDown(10, 20, "left", 1, "owned");
      // Move the clock without firing the timer so assertLiveInput owns the expiry.
      vi.setSystemTime(Date.now() + 5_001);
      const rejected =
        operation === "move"
          ? state.runtime.mouseMove(500, 600, "owned")
          : state.runtime.mouseUp(500, 600, "left", 1, "owned");
      await expect(rejected).rejects.toThrow("attachment");
      expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toMatchObject([
        { params: { x: 10, y: 20 } },
      ]);
    },
  );

  it("a move rejected after replacement keeps the original attachment's last published point", async () => {
    const state = fixture();
    const replacement: unknown[] = [];
    await state.begin("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(30, 40, "owned");
    state.control.page = { send: async (...args: unknown[]) => replacement.push(args) } as never;
    await expect(state.runtime.mouseMove(500, 600, "owned")).rejects.toThrow("attachment");
    await state.runtime.endLiveInput("owned");
    expect(replacement).toEqual([]);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toMatchObject([
      { params: { x: 30, y: 40 } },
    ]);
  });

  it("discrete text and key input pinned to a channel never reach a navigated document", async () => {
    const state = fixture();
    await state.begin("discrete");
    state.control.documentGeneration++;
    await expect(state.runtime.insertText("late", "discrete")).rejects.toThrow("attachment");
    await expect(state.runtime.keyDown("Enter", "Enter", "discrete")).rejects.toThrow("attachment");
    expect(
      state.calls.filter((call) => /^Input\.(insertText|dispatchKeyEvent)$/.test(call.method)),
    ).toEqual([]);
  });

  it("acknowledged moves renew idle expiry but never the absolute five-minute limit", async () => {
    vi.useFakeTimers();
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    for (let index = 0; index < 74; index++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await state.runtime.mouseMove(20, 30, "owned");
    }
    await vi.advanceTimersByTimeAsync(4_001);
    expect(state.calls.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
  });

  it("cancels possibly published touch after lost acknowledgment and keeps original attachment on replacement", async () => {
    const state = fixture();
    await state.begin("owned");
    state.intercept(async (method) => {
      if (method === "Input.dispatchTouchEvent") throw new Error("Unknown publication outcome");
    });
    await expect(
      state.runtime.touch("touchStart", [{ x: 20, y: 30, id: 7 }], "owned"),
    ).rejects.toThrow("Unknown publication");
    const replacementCalls: string[] = [];
    state.control.page = {
      send: async (method) => {
        replacementCalls.push(method);
        return {};
      },
    };
    await state.runtime.endLiveInput("owned");
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
    expect(replacementCalls).toEqual([]);
  });

  it("ends removed touch contacts before moving survivors and cancels remaining held contacts", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.touch(
      "touchStart",
      [
        { x: 20, y: 30, id: 7 },
        { x: 60, y: 30, id: 9 },
      ],
      "owned",
    );
    await state.runtime.touch("touchMove", [{ x: 25, y: 35, id: 7 }], "owned");
    expect(
      state.calls
        .filter((call) => call.method === "Input.dispatchTouchEvent")
        .map((call) => call.params),
    ).toEqual([
      {
        type: "touchStart",
        touchPoints: [
          { x: 20, y: 30, id: 7 },
          { x: 60, y: 30, id: 9 },
        ],
      },
      { type: "touchEnd", touchPoints: [{ x: 60, y: 30, id: 9 }] },
      { type: "touchMove", touchPoints: [{ x: 25, y: 35, id: 7 }] },
    ]);
    await state.runtime.endLiveInput("owned");
    expect(state.calls.filter((call) => call.params.type === "touchCancel")).toHaveLength(1);
  });

  it("same-URL document replacement refuses publication and optional cursor rejects CSS URL values", async () => {
    const state = fixture();
    await state.begin("owned");
    state.control.documentGeneration++;
    await expect(state.runtime.mouseMove(20, 30, "owned")).rejects.toThrow("attachment");
    expect(state.calls).toEqual([]);
    await state.runtime.endLiveInput("owned");
    await state.begin("next");
    state.control.page.send = async () => ({
      result: { value: "url(https://secret.invalid/cursor), pointer" },
    });
    expect(await state.runtime.cursorAt(20, 30, "next")).toBeNull();
    await state.runtime.endLiveInput("next");
  });

  it("native leave uses only the fixed outside point and refuses departure while a button is held", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseLeave("owned");
    expect(state.calls[0]?.params).toEqual({
      type: "mouseMoved",
      x: -1,
      y: -1,
      button: "none",
      buttons: 0,
    });
    await state.runtime.mouseDown(20, 30, "left", 1, "owned");
    await expect(state.runtime.mouseLeave("owned")).rejects.toThrow("Release held");
    await state.runtime.endLiveInput("owned");
    await expect(state.runtime.mouseLeave("owned")).rejects.toThrow("attachment");
  });

  it("private runtime routing preserves gesture identity and refuses malformed native contact sets", async () => {
    const owner = await createRuntimeOwner();
    const runtime = {
      beginLiveInput: vi.fn(),
      assertLiveInput: vi.fn(),
      endLiveInput: vi.fn(),
      touch: vi.fn(),
      mouseMove: vi.fn(),
      dispatchKey: vi.fn(),
      insertText: vi.fn(),
    };
    const owned = { runtimeId: "owned", runtime } as unknown as Parameters<typeof owner.request>[0];
    await owner.request(owned, "input.begin", {
      gestureId: "gesture",
      expectedInputGeneration: "0:0",
    });
    await owner.request(owned, "mouse.move", { gestureId: "gesture", x: 20, y: 30 });
    await owner.request(owned, "touch", {
      gestureId: "gesture",
      type: "start",
      points: [{ id: 7, x: 20, y: 30 }],
    });
    expect(runtime.beginLiveInput).toHaveBeenCalledWith("gesture", "0:0");
    await expect(owner.request(owned, "input.begin", { gestureId: "gesture" })).rejects.toThrow(
      "generation is required",
    );
    expect(runtime.mouseMove).toHaveBeenCalledWith(20, 30, "gesture");
    expect(runtime.touch).toHaveBeenCalledWith("touchStart", [{ id: 7, x: 20, y: 30 }], "gesture");
    for (const points of [
      [
        { id: 7, x: 20, y: 30 },
        { id: 7, x: 30, y: 40 },
      ],
      [],
      [{ id: true, x: 20, y: 30 }],
    ]) {
      await expect(
        owner.request(owned, "touch", { gestureId: "gesture", type: "start", points }),
      ).rejects.toThrow();
    }
    expect(runtime.touch).toHaveBeenCalledTimes(1);
    const event = {
      kind: "key",
      type: "down",
      key: "Enter",
      code: "Enter",
      modifiers: 0,
      repeat: false,
    };
    await owner.request(owned, "input.key", { gestureId: "gesture", event });
    await owner.request(owned, "input.text", { gestureId: "gesture", text: "漢字😀" });
    expect(runtime.dispatchKey).toHaveBeenCalledWith(event, "gesture");
    expect(runtime.insertText).toHaveBeenCalledWith("漢字😀", "gesture");
    await expect(owner.request(owned, "input.key", { event })).rejects.toThrow();
    await expect(
      owner.request(owned, "input.key", {
        gestureId: "gesture",
        event: { ...event, modifiers: 99 },
      }),
    ).rejects.toThrow();
    await expect(
      owner.request(owned, "input.text", { gestureId: "gesture", text: "x".repeat(16001) }),
    ).rejects.toThrow();
    expect(runtime.dispatchKey).toHaveBeenCalledTimes(1);
    expect(runtime.insertText).toHaveBeenCalledTimes(1);
  });

  it("unpressed movement retains the ordinary no-button packet", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseMove(20, 30, "owned");
    expect(state.calls[0]?.params).toEqual({
      type: "mouseMoved",
      x: 20,
      y: 30,
      button: "none",
      buttons: 0,
    });
    await state.runtime.endLiveInput("owned");
  });

  for (const [button, mask] of [
    ["left", 1],
    ["right", 2],
    ["middle", 4],
  ] as const) {
    it(`held ${button} movement carries its native button and mask until release`, async () => {
      const state = fixture();
      await state.begin("owned");
      await state.runtime.mouseDown(10, 20, button, 1, "owned");
      await state.runtime.mouseMove(20, 30, "owned");
      await state.runtime.mouseUp(20, 30, button, 1, "owned");
      await state.runtime.mouseMove(30, 40, "owned");
      expect(
        state.calls.filter((call) => call.params.type === "mouseMoved").map((call) => call.params),
      ).toEqual([
        { type: "mouseMoved", x: 20, y: 30, button, buttons: mask },
        { type: "mouseMoved", x: 30, y: 40, button: "none", buttons: 0 },
      ]);
      await state.runtime.endLiveInput("owned");
    });
  }

  it("multiple held buttons use canonical priority, and cleanup leaves the next gesture unpressed", async () => {
    const state = fixture();
    await state.begin("owned");
    await state.runtime.mouseDown(10, 20, "middle", 1, "owned");
    await state.runtime.mouseDown(10, 20, "right", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseDown(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseUp(10, 20, "left", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.mouseUp(10, 20, "right", 1, "owned");
    await state.runtime.mouseMove(20, 30, "owned");
    await state.runtime.endLiveInput("owned");
    await state.begin("next");
    await state.runtime.mouseMove(20, 30, "next");
    expect(
      state.calls
        .filter((call) => call.params.type === "mouseMoved")
        .map((call) => [call.params.button, call.params.buttons]),
    ).toEqual([
      ["right", 6],
      ["left", 7],
      ["right", 6],
      ["middle", 4],
      ["none", 0],
    ]);
    expect(
      state.calls.filter((call) => call.params.type === "mouseReleased").at(-1)?.params.button,
    ).toBe("middle");
    await state.runtime.endLiveInput("next");
  });
});

it("publishes ordered native Unicode/repeat/shortcut keys and committed text on the pinned attachment", async () => {
  const state = fixture();
  await state.begin("keys");
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "é", code: "KeyE", modifiers: 0, repeat: false },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "é", code: "KeyE", modifiers: 0, repeat: true },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "up", key: "é", code: "KeyE", modifiers: 0, repeat: false },
    "keys",
  );
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "Control", code: "ControlLeft", modifiers: 2, repeat: false },
    "keys",
  );
  await state.runtime.mouseDown(10, 20, "left", 1, "keys");
  await state.runtime.insertText("漢字\n😀", "keys");
  expect(
    state.calls
      .filter((call) => call.method === "Input.dispatchKeyEvent")
      .map((call) => call.params),
  ).toMatchObject([
    { type: "keyDown", text: "é", code: "KeyE", autoRepeat: false },
    { type: "keyDown", text: "é", autoRepeat: true },
    { type: "keyUp", code: "KeyE" },
    { type: "rawKeyDown", code: "ControlLeft", modifiers: 2 },
  ]);
  expect(state.calls.find((call) => call.params.type === "mousePressed")?.params.modifiers).toBe(2);
  expect(state.calls.find((call) => call.method === "Input.insertText")?.params).toEqual({
    text: "漢字\n😀",
  });
  await state.runtime.endLiveInput("keys");
  expect(state.calls.at(-1)?.params).toMatchObject({
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
  });
});

it("cleans possibly published keys on the original page and rejects unmatched repeat/up", async () => {
  const state = fixture();
  await state.begin("keys");
  const down = {
    kind: "key",
    type: "down",
    key: "Shift",
    code: "ShiftRight",
    modifiers: 8,
    repeat: false,
  } as const;
  await expect(state.runtime.dispatchKey({ ...down, repeat: true }, "keys")).rejects.toThrow();
  await expect(state.runtime.dispatchKey({ ...down, type: "up" }, "keys")).rejects.toThrow();
  state.intercept(async (method) => {
    if (method === "Input.dispatchKeyEvent") throw new Error("Lost key acknowledgment");
  });
  await expect(state.runtime.dispatchKey(down, "keys")).rejects.toThrow("Lost key");
  state.control.page = { send: async () => ({}) };
  await state.runtime.endLiveInput("keys");
  expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
});

it("expires held keyboard modifiers without another client request", async () => {
  vi.useFakeTimers();
  const state = fixture();
  await state.begin("keys");
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "Alt", code: "AltLeft", modifiers: 1, repeat: false },
    "keys",
  );
  await vi.advanceTimersByTimeAsync(5001);
  expect(state.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(1);
  await expect(state.runtime.insertText("late", "keys")).rejects.toThrow("attachment");
});

it("forwards first-click physical modifiers on all mouse packets without fabricated key presses", async () => {
  const state = fixture();
  await state.begin("mouse");
  await state.runtime.mouseDown(10, 20, "left", 1, "mouse", 2);
  await state.runtime.mouseMove(20, 30, "mouse", 10);
  await state.runtime.wheel(20, 30, 0, 40, "mouse", 1);
  await state.runtime.mouseUp(20, 30, "left", 1, "mouse", 0);
  expect(
    state.calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.params.modifiers),
  ).toEqual([2, 10, 1, 0]);
  expect(state.calls.some((call) => call.method === "Input.dispatchKeyEvent")).toBe(false);
  await state.runtime.endLiveInput("mouse");
});

it("explicit zero overrides held keyboard inference while omitted mouse masks retain it", async () => {
  const state = fixture();
  await state.begin("mouse");
  await state.runtime.dispatchKey(
    { kind: "key", type: "down", key: "Control", code: "ControlLeft", modifiers: 2, repeat: false },
    "mouse",
  );
  await state.runtime.mouseMove(20, 30, "mouse", 0);
  await state.runtime.mouseMove(20, 30, "mouse");
  expect(
    state.calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.params.modifiers),
  ).toEqual([0, 2]);
  await state.runtime.endLiveInput("mouse");
});

it("refuses invalid mouse masks before publication or held-button bookkeeping", async () => {
  const state = fixture();
  await state.begin("mouse");
  for (const modifiers of [-1, 16, 1.5, Number.NaN]) {
    await expect(state.runtime.mouseDown(10, 20, "left", 1, "mouse", modifiers)).rejects.toThrow(
      "Mouse modifiers",
    );
    await expect(state.runtime.mouseMove(10, 20, "mouse", modifiers)).rejects.toThrow(
      "Mouse modifiers",
    );
    await expect(state.runtime.wheel(10, 20, 0, 40, "mouse", modifiers)).rejects.toThrow(
      "Mouse modifiers",
    );
    await expect(state.runtime.mouseUp(10, 20, "left", 1, "mouse", modifiers)).rejects.toThrow(
      "Mouse modifiers",
    );
  }
  await state.runtime.endLiveInput("mouse");
  expect(state.calls).toEqual([]);
});

it("runtime-owner validates physical modifiers and preserves omitted legacy arguments", async () => {
  const owner = await createRuntimeOwner();
  const runtime = { mouseDown: vi.fn(), mouseMove: vi.fn(), mouseUp: vi.fn(), wheel: vi.fn() };
  const owned = { runtimeId: "owned", runtime } as unknown as Parameters<typeof owner.request>[0];
  const point = {
    x: 10,
    y: 20,
    gestureId: "mouse",
    button: "left",
    clickCount: 1,
    deltaX: 0,
    deltaY: 40,
  };
  await owner.request(owned, "mouse.down", { ...point, modifiers: 2 });
  await owner.request(owned, "mouse.move", { ...point, modifiers: 0 });
  await owner.request(owned, "mouse.up", { ...point, modifiers: 8 });
  await owner.request(owned, "mouse.wheel", { ...point, modifiers: 4 });
  expect(runtime.mouseDown).toHaveBeenCalledWith(10, 20, "left", 1, "mouse", 2);
  expect(runtime.mouseMove).toHaveBeenCalledWith(10, 20, "mouse", 0);
  expect(runtime.mouseUp).toHaveBeenCalledWith(10, 20, "left", 1, "mouse", 8);
  expect(runtime.wheel).toHaveBeenCalledWith(10, 20, 0, 40, "mouse", 4);
  for (const modifiers of [null, "2", 16, -1, 1.5]) {
    await expect(owner.request(owned, "mouse.down", { ...point, modifiers })).rejects.toThrow();
  }
  expect(runtime.mouseDown).toHaveBeenCalledTimes(1);
  await owner.request(owned, "mouse.move", point);
  expect(runtime.mouseMove).toHaveBeenLastCalledWith(10, 20, "mouse");
});

it("bounds live held keys before native publication and still permits repeat, release and cancel", async () => {
  const state = fixture();
  await state.begin("keys");
  const key = (code: string, type: "down" | "up" = "down", repeat = false) => ({
    kind: "key" as const,
    type,
    key: "Unidentified",
    code,
    modifiers: 0,
    repeat,
  });
  for (let index = 0; index < MAX_HELD_BROWSER_KEYS; index++) {
    await state.runtime.dispatchKey(key(`Unknown${index}`), "keys");
  }
  await expect(state.runtime.dispatchKey(key("UnknownExtra"), "keys")).rejects.toThrow(
    "Too many simultaneously held",
  );
  expect(state.calls.filter((call) => call.params.type === "rawKeyDown")).toHaveLength(
    MAX_HELD_BROWSER_KEYS,
  );
  await state.runtime.dispatchKey(key("Unknown0", "down", true), "keys");
  await state.runtime.dispatchKey(key("Unknown0", "up"), "keys");
  await state.runtime.dispatchKey(key("UnknownReplacement"), "keys");
  await state.runtime.endLiveInput("keys");
  const releases = state.calls.filter((call) => call.params.type === "keyUp");
  expect(releases).toHaveLength(MAX_HELD_BROWSER_KEYS + 1);
  expect(releases.some((call) => call.params.code === "UnknownExtra")).toBe(false);
});

it("applies the same held-key bound to discrete native key-down commands", async () => {
  const state = fixture();
  for (let index = 0; index < MAX_HELD_BROWSER_KEYS; index++) {
    await state.runtime.keyDown("Unidentified", `Unknown${index}`);
  }
  await expect(state.runtime.keyDown("Unidentified", "UnknownExtra")).rejects.toThrow(
    "Too many simultaneously held",
  );
  await state.runtime.keyUp("Unidentified", "Unknown0");
  await state.runtime.keyDown("Unidentified", "UnknownReplacement");
  expect(state.calls.some((call) => call.params.code === "UnknownExtra")).toBe(false);
});

it("runtime-owner validates and forwards encoder controls without changing legacy omission", async () => {
  const owner = await createRuntimeOwner();
  const runtime = {
    readVideo: vi.fn(async (_input: unknown) => ({ status: "waiting", packets: [] })),
  };
  const owned = { runtimeId: "owned", runtime } as unknown as Parameters<typeof owner.request>[0];
  await owner.request(owned, "video.read", { bitrate: 24_000_000, fps: 60 });
  expect(runtime.readVideo).toHaveBeenLastCalledWith(
    expect.objectContaining({ bitrate: 24_000_000, fps: 60 }),
  );
  await owner.request(owned, "video.read", {});
  expect(runtime.readVideo.mock.calls[1]?.[0]).not.toHaveProperty("bitrate");
  expect(runtime.readVideo.mock.calls[1]?.[0]).not.toHaveProperty("fps");
  await expect(owner.request(owned, "video.read", { bitrate: 1 })).rejects.toThrow();
  await expect(owner.request(owned, "video.read", { fps: 120 })).rejects.toThrow();
  expect(runtime.readVideo).toHaveBeenCalledTimes(2);
});
