import { describe, expect, it, vi } from "vitest";
import type { BrowserGestureEvent } from "../../shared/managed-browser/browser";
import { createBrowserCanvasInput } from "./browser-canvas-input";

const point = { x: 40, y: 20, width: 400, height: 300 };
function fixture() {
  const events: BrowserGestureEvent[] = [];
  let ended = 0;
  const input = createBrowserCanvasInput({
    enabled: () => true,
    viewport: () => ({ width: 800, height: 600 }),
    enqueue: (event) => {
      events.push(event);
      return true;
    },
    finish: () => {
      ended += 1;
    },
    cancel: () => {},
    onPoint: () => {},
    onActivity: () => {},
  });
  return { input, events, ended: () => ended };
}

describe("natural canvas input", () => {
  it("quarantines a refused touch start until all physical contacts are released", () => {
    const enqueue = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const activity = vi.fn();
    const cancel = vi.fn();
    const input = createBrowserCanvasInput({
      enabled: () => true,
      viewport: () => ({ width: 800, height: 600 }),
      enqueue,
      finish: vi.fn(),
      cancel,
      onPoint: vi.fn(),
      onActivity: activity,
    });
    const first = { ...point, id: 7 };
    const second = { ...point, id: 9 };
    expect(input.touch("start", [first])).toBe(false);
    expect(input.isTouchQuarantined()).toBe(true);
    expect(activity).not.toHaveBeenCalledWith(true);
    // A fresh decoded frame must not turn this held contact into an orphan move.
    input.touch("move", [{ ...first, x: 60 }]);
    input.touch("start", [first, second]);
    input.touch("end", [second]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    input.touch("end", []);
    expect(input.isTouchQuarantined()).toBe(false);
    expect(input.touch("start", [first])).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith({ kind: "touch", type: "start", points: [first] });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not restore held touch state after a synchronous queue failure resets the model", () => {
    const events: BrowserGestureEvent[] = [];
    let reject = false;
    const input = createBrowserCanvasInput({
      enabled: () => true,
      viewport: () => ({ width: 800, height: 600 }),
      enqueue: (event) => {
        events.push(event);
        if (reject) {
          input.reset();
          return false;
        }
        return true;
      },
      finish: vi.fn(),
      cancel: vi.fn(),
      onPoint: vi.fn(),
      onActivity: vi.fn(),
    });
    const first = { ...point, id: 7 };
    input.touch("start", [first]);
    reject = true;
    expect(input.touch("move", [{ ...first, x: 60 }])).toBe(false);
    expect(input.isTouchQuarantined()).toBe(true);
    reject = false;
    input.touch("move", [{ ...first, x: 100 }]);
    expect(events).toHaveLength(2);
    input.touch("end", []);
    input.touch("start", [first]);
    expect(events.at(-1)).toEqual({ kind: "touch", type: "start", points: [first] });
  });

  it("allows a new physical touch after a refused final release", () => {
    const enqueue = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const input = createBrowserCanvasInput({
      enabled: () => true,
      viewport: () => ({ width: 800, height: 600 }),
      enqueue,
      finish: vi.fn(),
      cancel: vi.fn(),
      onPoint: vi.fn(),
      onActivity: vi.fn(),
    });
    const contact = { ...point, id: 7 };
    input.touch("start", [contact]);
    expect(input.touch("end", [])).toBe(false);
    expect(input.isTouchQuarantined()).toBe(false);
    expect(input.touch("start", [contact])).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith({ kind: "touch", type: "start", points: [contact] });
  });

  it("keeps actual right, middle and double-click edges without a mode override", () => {
    const f = fixture();
    for (const [button, clickCount] of [
      ["left", 1],
      ["left", 2],
      ["right", 1],
      ["middle", 1],
    ] as const) {
      f.input.mouseDown(point, button, clickCount);
      f.input.mouseUp(point, button, clickCount);
    }
    expect(
      f.events.map((event) =>
        event.kind === "down" || event.kind === "up"
          ? [event.kind, event.button, event.clickCount]
          : null,
      ),
    ).toEqual([
      ["down", "left", 1],
      ["up", "left", 1],
      ["down", "left", 2],
      ["up", "left", 2],
      ["down", "right", 1],
      ["up", "right", 1],
      ["down", "middle", 1],
      ["up", "middle", 1],
    ]);
  });

  it("forwards held mouse motion before release rather than synthesizing a final drag", () => {
    const f = fixture();
    f.input.mouseDown(point, "left", 1);
    f.input.mouseMove({ ...point, x: 60 });
    f.input.mouseMove({ ...point, x: 100 });
    expect(f.ended()).toBe(0);
    expect(f.events.map((event) => event.kind)).toEqual(["down", "move", "move"]);
    f.input.mouseUp({ ...point, x: 100 }, "left", 1);
    expect(f.ended()).toBe(1);
  });

  it("always forwards genuine touch contacts, including held press and pinch partial release", () => {
    const f = fixture();
    const first = { ...point, id: 7 };
    const second = { ...point, x: 200, id: 9 };
    f.input.touch("start", [first]);
    expect(f.events).toEqual([{ kind: "touch", type: "start", points: [first] }]);
    expect(f.ended()).toBe(0);
    f.input.touch("start", [first, second]);
    f.input.touch("move", [
      { ...first, x: 20 },
      { ...second, x: 240 },
    ]);
    f.input.touch("end", [second]);
    f.input.touch("end", []);
    expect(
      f.events.map((event) =>
        event.kind === "touch"
          ? [event.type, event.points.map((contact) => contact.id)]
          : event.kind,
      ),
    ).toEqual([
      ["start", [7]],
      ["start", [7, 9]],
      ["move", [7, 9]],
      ["move", [9]],
      ["end", []],
    ]);
    expect(f.ended()).toBe(1);
  });
});

it("preserves genuine pointer modifier snapshots without fabricating held keys", () => {
  const f = fixture();
  f.input.mouseDown(point, "left", 1, 10);
  f.input.mouseMove(point, 2);
  f.input.mouseUp(point, "left", 1, 0);
  f.input.wheel(point, 0, 5000, 4);
  expect(
    f.events.slice(0, 3).map((event) => ("modifiers" in event ? event.modifiers : undefined)),
  ).toEqual([10, 2, 0]);
  expect(f.events.slice(3).every((event) => event.kind === "scroll" && event.modifiers === 4)).toBe(
    true,
  );
  expect(f.events.some((event) => event.kind === "key")).toBe(false);
  f.input.mouseMove(point); // Native callers preserve existing held-key inference.
  expect(f.events.at(-1)).not.toHaveProperty("modifiers");
});
