/**
 * Converts bounded physical keyboard envelopes to native CDP events. No page
 * script or browser editing command is exposed. CDP uses Windows virtual key
 * values on all platforms; unsupported physical codes retain DOM key/code only.
 */
import type { BrowserGestureKeyEvent } from "../../shared/managed-browser/browser";

const SPECIAL_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

/** Physical code chooses the accelerator code independently of keyboard layout text. */
export function virtualKeyCode(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (functionKey) return 111 + Number(functionKey[1]);
  return SPECIAL_CODES[code];
}

/** Native text is separate from shortcut keys; Tab stays a native focus command. */
function nativeKeyText(event: BrowserGestureKeyEvent): string | undefined {
  if (event.type !== "down" || (event.modifiers & 7) !== 0) return undefined;
  if (event.text !== undefined) return event.text;
  if (event.key === "Enter") return "\r";
  if (Array.from(event.key).length === 1) return event.key;
  return undefined;
}

/** Preserve real edge/repeat/text; never synthesize text for modifier shortcuts. */
export function nativeKeyEvent(event: BrowserGestureKeyEvent): Record<string, unknown> {
  const windowsVirtualKeyCode = virtualKeyCode(event.code);
  const text = nativeKeyText(event);
  const modifier = /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(event.code);
  const location = modifier ? (event.code.endsWith("Left") ? 1 : 2) : undefined;
  return {
    type: event.type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
    key: event.key,
    code: event.code,
    modifiers: event.modifiers,
    autoRepeat: event.repeat,
    ...(text !== undefined ? { text } : {}),
    ...(windowsVirtualKeyCode !== undefined ? { windowsVirtualKeyCode } : {}),
    ...(event.code.startsWith("Numpad") ? { isKeypad: true } : {}),
    ...(location !== undefined ? { location } : {}),
  };
}

/** Mouse chords use keys already published on this exact input attachment. */
export function heldKeyModifiers(keys: Iterable<{ key: string }>): number {
  let mask = 0;
  for (const { key } of keys) {
    if (key === "Alt" || key === "AltGraph") mask |= 1;
    if (key === "Control" || key === "AltGraph") mask |= 2;
    if (key === "Meta") mask |= 4;
    if (key === "Shift") mask |= 8;
  }
  return mask;
}
