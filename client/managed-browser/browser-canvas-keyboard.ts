/**
 * Normalize physical canvas keys without inventing presses after control loss.
 * IME and clipboard commits use text insertion; ordinary typing retains real
 * key/code/repeat/modifier events. The DOM adapter owns focus and composition.
 */
import type { BrowserGestureEvent } from "../../shared/managed-browser/browser";

export interface CanvasKeyEnvelope {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}
export type CanvasKeyboardEvent = Extract<BrowserGestureEvent, { kind: "key" | "text" }>;
interface KeyboardOptions {
  enabled(): boolean;
  enqueue(event: CanvasKeyboardEvent): boolean;
  finish(): void;
}

/** CDP modifier bits preserve the actual host combination, including Shift. */
export function canvasKeyModifiers(event: CanvasKeyEnvelope): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** A cancelled held key's repeat/up cannot begin input on a replacement page. */
export function createBrowserCanvasKeyboard(options: KeyboardOptions) {
  const admitted = new Set<string>();
  const blocked = new Set<string>();
  const identity = (event: CanvasKeyEnvelope) => event.code || event.key;
  const reset = () => {
    for (const key of admitted) blocked.add(key);
    admitted.clear();
  };
  const key = (type: "down" | "up", event: CanvasKeyEnvelope): boolean => {
    const id = identity(event);
    if (type === "up") {
      blocked.delete(id);
      if (!admitted.delete(id)) {
        return false;
      }
    } else {
      if (!options.enabled()) {
        blocked.add(id);
        return false;
      }
      if (
        event.isComposing ||
        event.key === "Dead" ||
        event.key === "Process" ||
        event.keyCode === 229
      ) {
        return false;
      }
      // A non-repeat is an authentic new physical edge after a missed blur keyup.
      if (!event.repeat) {
        blocked.delete(id);
      }
      if (blocked.has(id) || (event.repeat && !admitted.has(id))) {
        return false;
      }
    }
    if (
      !options.enabled() ||
      !event.key ||
      event.key.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(event.code)
    ) {
      return false;
    }
    const modifiers = canvasKeyModifiers(event);
    const printable =
      type === "down" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      Array.from(event.key).length === 1;
    const accepted = options.enqueue({
      kind: "key",
      type,
      key: event.key,
      code: event.code,
      modifiers,
      repeat: type === "down" && event.repeat,
      ...(printable ? { text: event.key } : {}),
    });
    if (accepted && type === "down") {
      admitted.add(id);
      // AltGraph can report Ctrl+Alt on international layouts. The real host
      // qualifier permits one text commit without rewriting a genuine shortcut.
      if (
        event.getModifierState?.("AltGraph") &&
        (modifiers & 7) !== 0 &&
        Array.from(event.key).length === 1
      ) {
        options.enqueue({ kind: "text", text: event.key });
      }
    }
    if (accepted && type === "up" && !admitted.size) {
      options.finish();
    }
    return accepted;
  };
  const text = (value: string): boolean => {
    if (!options.enabled() || !value || value.length > 16_000) {
      return false;
    }
    const accepted = options.enqueue({ kind: "text", text: value });
    if (accepted && !admitted.size) {
      options.finish();
    }
    return accepted;
  };
  return { key, text, reset };
}
