import { describe, expect, it } from "vitest";
import { browserGestureEventSchema, browserGestureKeySchema } from "../../shared/managed-browser/browser";
import { heldKeyModifiers, nativeKeyEvent } from "./keyboard-input";

const key = (key: string, code: string, modifiers = 0) =>
  browserGestureKeySchema.parse({ kind: "key", type: "down", key, code, modifiers });

describe("native keyboard envelopes", () => {
  it("preserves Unicode and space while Enter and Tab retain native meanings", () => {
    expect(nativeKeyEvent(key("😀", "KeyA"))).toMatchObject({ type: "keyDown", text: "😀" });
    expect(nativeKeyEvent(key(" ", "Space"))).toMatchObject({
      text: " ",
      windowsVirtualKeyCode: 32,
    });
    expect(nativeKeyEvent(key("Enter", "Enter"))).toMatchObject({
      text: "\r",
      windowsVirtualKeyCode: 13,
    });
    expect(nativeKeyEvent(key("Tab", "Tab"))).toMatchObject({
      type: "rawKeyDown",
      windowsVirtualKeyCode: 9,
    });
    expect(nativeKeyEvent(key("Tab", "Tab"))).not.toHaveProperty("text");
    expect(nativeKeyEvent(key("ArrowLeft", "ArrowLeft"))).toMatchObject({
      windowsVirtualKeyCode: 37,
    });
    expect(nativeKeyEvent(key("A", "KeyA", 8))).toMatchObject({ text: "A", modifiers: 8 });
  });

  it("forwards shortcuts and repeat without synthesizing printable characters", () => {
    expect(nativeKeyEvent(key("a", "KeyA", 2))).toMatchObject({
      type: "rawKeyDown",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    expect(nativeKeyEvent(key("a", "KeyA", 2))).not.toHaveProperty("text");
    expect(nativeKeyEvent({ ...key("a", "KeyA"), repeat: true })).toHaveProperty(
      "autoRepeat",
      true,
    );
    expect(heldKeyModifiers([{ key: "Control" }, { key: "Shift" }])).toBe(10);
  });

  it("rejects shortcut text, keyup text/repeat and oversized committed text", () => {
    expect(browserGestureKeySchema.safeParse({ ...key("a", "KeyA", 2), text: "a" }).success).toBe(
      false,
    );
    expect(
      browserGestureKeySchema.safeParse({ ...key("a", "KeyA"), type: "up", text: "a" }).success,
    ).toBe(false);
    expect(
      browserGestureKeySchema.safeParse({ ...key("a", "KeyA"), type: "up", repeat: true }).success,
    ).toBe(false);
    expect(browserGestureEventSchema.safeParse({ kind: "text", text: "漢字\n😀" }).success).toBe(
      true,
    );
    expect(
      browserGestureEventSchema.safeParse({ kind: "text", text: "x".repeat(16001) }).success,
    ).toBe(false);
  });
});
