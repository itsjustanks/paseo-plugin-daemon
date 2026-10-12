import { describe, expect, it } from "vitest";
import {
  type CanvasKeyboardEvent,
  type CanvasKeyEnvelope,
  canvasKeyModifiers,
  createBrowserCanvasKeyboard,
} from "./browser-canvas-keyboard";

const envelope = (overrides: Partial<CanvasKeyEnvelope> = {}): CanvasKeyEnvelope => ({
  key: "a",
  code: "KeyA",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...overrides,
});
function fixture() {
  const events: CanvasKeyboardEvent[] = [];
  let enabled = true;
  let finishes = 0;
  const input = createBrowserCanvasKeyboard({
    enabled: () => enabled,
    enqueue: (event) => {
      events.push(event);
      return true;
    },
    finish: () => {
      finishes += 1;
    },
  });
  return {
    input,
    events,
    disable: () => {
      enabled = false;
    },
    enable: () => {
      enabled = true;
    },
    finishes: () => finishes,
  };
}
describe("physical canvas keyboard", () => {
  it("commits qualified AltGraph text once but never converts Ctrl+Alt shortcuts", () => {
    const f = fixture();
    const euro = envelope({
      key: "€",
      code: "KeyE",
      ctrlKey: true,
      altKey: true,
      getModifierState: (value) => value === "AltGraph",
    });
    f.input.key("down", euro);
    f.input.key("up", euro);
    f.input.key("down", envelope({ key: "e", code: "KeyE", ctrlKey: true, altKey: true }));
    expect(f.events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "€" },
    ]);
    expect(f.events.filter((event) => event.kind === "key")).toHaveLength(3);
    expect(
      f.events.filter((event) => event.kind === "key").every((event) => event.text === undefined),
    ).toBe(true);
    const separate = fixture();
    separate.input.key(
      "down",
      envelope({ key: "€", getModifierState: (value) => value === "AltGraph" }),
    );
    expect(separate.events).toEqual([
      { kind: "key", type: "down", key: "€", code: "KeyA", modifiers: 0, repeat: false, text: "€" },
    ]);
  });
  it("preserves Unicode text, physical repeat/code and all modifier bits", () => {
    const f = fixture();
    f.input.key("down", envelope({ key: "é" }));
    f.input.key("down", envelope({ key: "é", repeat: true }));
    f.input.key("up", envelope({ key: "é", repeat: true }));
    expect(f.events).toEqual([
      { kind: "key", type: "down", key: "é", code: "KeyA", modifiers: 0, repeat: false, text: "é" },
      { kind: "key", type: "down", key: "é", code: "KeyA", modifiers: 0, repeat: true, text: "é" },
      { kind: "key", type: "up", key: "é", code: "KeyA", modifiers: 0, repeat: false },
    ]);
    expect(
      canvasKeyModifiers(envelope({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })),
    ).toBe(15);
    f.input.key("down", envelope({ ctrlKey: true }));
    expect(f.events.at(-1)).not.toHaveProperty("text");
  });
  it("never starts from a cancelled repeat or a repeat that began observe-only", () => {
    const f = fixture();
    f.input.key("down", envelope());
    f.input.reset();
    expect(f.input.key("down", envelope({ repeat: true }))).toBe(false);
    expect(f.input.key("up", envelope())).toBe(false);
    f.disable();
    f.input.key("down", envelope());
    f.enable();
    expect(f.input.key("down", envelope({ repeat: true }))).toBe(false);
    expect(f.input.key("up", envelope())).toBe(false);
    expect(f.input.key("down", envelope())).toBe(true);
    expect(f.events).toHaveLength(2);
  });
  it("does not type composition intermediates; commits bounded text separately", () => {
    const f = fixture();
    expect(f.input.key("down", envelope({ isComposing: true }))).toBe(false);
    expect(f.input.key("down", envelope({ key: "Dead" }))).toBe(false);
    expect(f.input.key("down", envelope({ keyCode: 229 }))).toBe(false);
    expect(f.input.text("日本語🙂")).toBe(true);
    expect(f.input.text("x".repeat(16_001))).toBe(false);
    expect(f.events).toEqual([{ kind: "text", text: "日本語🙂" }]);
  });
  it("keeps modifier holds through other keys and finishes only after last keyup", () => {
    const f = fixture();
    const ctrl = envelope({ key: "Control", code: "ControlLeft", ctrlKey: true });
    f.input.key("down", ctrl);
    f.input.key("down", envelope({ ctrlKey: true }));
    f.input.key("up", envelope({ ctrlKey: true }));
    expect(f.finishes()).toBe(0);
    f.input.key("up", { ...ctrl, ctrlKey: false });
    expect(f.finishes()).toBe(1);
  });
});
