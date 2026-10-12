import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import type { BrowserGestureEvent } from "../../shared/managed-browser/browser";
import { createBrowserCanvasInput } from "./browser-canvas-input";
import { type BrowserCanvasNode, bindBrowserCanvasWeb } from "./web";

type Handler = (event: Record<string, unknown>) => void;

/** Minimal DOM that records listeners; the real web adapter and real canvas input model run on it. */
function fixture() {
  const registry = new Map<string, Set<Handler>>();
  const target = (name: string) => ({
    addEventListener(type: string, listener: Handler) {
      const key = `${name}:${type}`;
      registry.set(key, (registry.get(key) ?? new Set()).add(listener));
    },
    removeEventListener(type: string, listener: Handler) {
      registry.get(`${name}:${type}`)?.delete(listener);
    },
  });
  const document = {
    hidden: false,
    ...target("doc"),
    defaultView: target("win"),
  };
  const node = {
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 300 }),
    ...target("node"),
    style: { cursor: "", touchAction: "" },
    ownerDocument: document,
  } as unknown as BrowserCanvasNode;
  const events: BrowserGestureEvent[] = [];
  let cancels = 0;
  const input = createBrowserCanvasInput({
    enabled: () => true,
    viewport: () => ({ width: 800, height: 600 }),
    enqueue: (event) => {
      events.push(event);
      return true;
    },
    finish: () => {},
    cancel: () => {
      cancels += 1;
    },
    onPoint: () => {},
    onActivity: () => {},
  });
  const dispose = bindBrowserCanvasWeb(
    node,
    input,
    () => true,
    () => {},
  );
  const fire = (where: string, type: string, event: Record<string, unknown> = {}) => {
    for (const listener of registry.get(`${where}:${type}`) ?? [])
      listener({ preventDefault() {}, stopPropagation() {}, ...event });
  };
  const kinds = () => events.map((event) => event.kind);
  return { document, events, fire, kinds, cancels: () => cancels, dispose };
}

const inside = { clientX: 200, clientY: 200, button: 0, detail: 1 };
const outside = { clientX: 900, clientY: 900, button: 0, detail: 1 };
const touch = (x: number, y: number) => ({
  touches: [{ identifier: 3, clientX: x, clientY: y }],
});

describe("web canvas adapter cancellation", () => {
  it("window blur cancels a held drag and drops the late document mouseup", () => {
    const f = fixture();
    f.fire("node", "mousedown", inside);
    f.fire("doc", "mousemove", outside);
    expect(f.kinds()).toEqual(["down", "move"]);
    f.fire("win", "blur");
    expect(f.cancels()).toBe(1);
    f.fire("doc", "mouseup", outside);
    f.fire("doc", "mousemove", outside);
    expect(f.kinds()).toEqual(["down", "move"]);
  });

  it("page hidden cancels a held button; a visible release afterwards publishes nothing", () => {
    const f = fixture();
    f.fire("node", "mousedown", inside);
    f.document.hidden = true;
    f.fire("doc", "visibilitychange");
    expect(f.cancels()).toBe(1);
    f.document.hidden = false;
    f.fire("node", "mouseup", inside);
    expect(f.kinds()).not.toContain("up");
  });

  it("a drag released outside the canvas still ends once at its pointer position, then leaves", () => {
    const f = fixture();
    f.fire("node", "mousedown", inside);
    f.fire("doc", "mouseup", outside);
    expect(f.events.filter((event) => event.kind === "up")).toHaveLength(1);
    expect(f.cancels()).toBe(0);
  });

  it("blur cancels held touch and quarantines its late move/end until liftoff", () => {
    const f = fixture();
    f.fire("node", "touchstart", touch(200, 200));
    expect(f.kinds()).toContain("touch");
    const before = f.events.length;
    f.fire("win", "blur");
    expect(f.cancels()).toBe(1);
    f.fire("node", "touchmove", touch(220, 220));
    f.fire("node", "touchend", { touches: [] });
    expect(f.events.length).toBe(before);
  });

  it("pointercancel and dispose cancel held input", () => {
    const f = fixture();
    f.fire("node", "mousedown", inside);
    f.fire("node", "pointercancel");
    expect(f.cancels()).toBe(1);
    f.fire("node", "mousedown", inside);
    f.dispose();
    expect(f.cancels()).toBeGreaterThanOrEqual(2);
    f.fire("doc", "mouseup", outside);
    expect(f.events.filter((event) => event.kind === "up")).toHaveLength(0);
  });
});
