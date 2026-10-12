/**
 * Focused web keyboard/IME bridge. Its invisible editable sink gives the browser
 * a real composition target without modifying image children. Only controlled
 * canvas focus consumes host keys; blur releases the original remote channel.
 * Browser-reserved shortcuts are outside JavaScript's interception guarantees.
 */
import {
  type CanvasKeyboardEvent,
  type CanvasKeyEnvelope,
  createBrowserCanvasKeyboard,
} from "./browser-canvas-keyboard";

interface KeyboardDomEvent extends CanvasKeyEnvelope {
  data?: string | null;
  inputType?: string;
  clipboardData?: { getData(type: string): string } | null;
  preventDefault(): void;
  stopPropagation(): void;
}
interface KeyboardElement {
  tabIndex: number;
  value: string;
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  focus(options?: { preventScroll: boolean }): void;
  remove(): void;
  addEventListener(
    type: string,
    listener: (event: KeyboardDomEvent) => void,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: KeyboardDomEvent) => void,
    options?: { capture?: boolean },
  ): void;
}
export interface KeyboardCanvasNode extends KeyboardElement {
  appendChild(child: KeyboardElement): void;
  ownerDocument: {
    activeElement: unknown;
    hidden: boolean;
    createElement(tag: "textarea"): KeyboardElement;
    addEventListener(type: string, listener: (event: KeyboardDomEvent) => void): void;
    removeEventListener(type: string, listener: (event: KeyboardDomEvent) => void): void;
    defaultView: {
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    } | null;
  };
}
interface BindingOptions {
  enabled(): boolean;
  enqueue(event: CanvasKeyboardEvent): boolean;
  finish(): void;
  cancel(): void;
  onError(error: Error): void;
}

/** DOM-only binding; callers must dispose it and reset on route/control changes. */
export function bindBrowserCanvasKeyboard(node: KeyboardCanvasNode, options: BindingOptions) {
  const document = node.ownerDocument;
  const previousTabIndex = node.tabIndex;
  const sink = document.createElement("textarea");
  sink.tabIndex = -1;
  sink.setAttribute("aria-label", "Type in the shared browser");
  sink.setAttribute("autocomplete", "off");
  sink.setAttribute("autocapitalize", "off");
  sink.setAttribute("spellcheck", "false");
  Object.assign(sink.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    opacity: "0",
    left: "0",
    top: "0",
    padding: "0",
    border: "0",
    pointerEvents: "none",
  });
  node.tabIndex = 0;
  node.appendChild(sink);
  let composing = false;
  let compositionAdmitted = false;
  let altTextPending: string | null = null;
  const focused = () => document.activeElement === sink || document.activeElement === node;
  const keyboard = createBrowserCanvasKeyboard({
    ...options,
    enabled: () => options.enabled() && focused() && !document.hidden,
  });
  const consume = (event: KeyboardDomEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const reset = () => {
    keyboard.reset();
    compositionAdmitted = false;
    composing = false;
    altTextPending = null;
    sink.value = "";
  };
  const cancel = () => {
    reset();
    options.cancel();
  };
  const focus = () => {
    if (options.enabled() && !document.hidden) {
      sink.focus({ preventScroll: true });
    }
  };
  const down = (event: KeyboardDomEvent) => {
    if (!focused()) {
      return;
    }
    // Local paste supplies clipboard bytes separately. Sending Ctrl/Meta+V would
    // additionally paste an unrelated remote clipboard and duplicate the action.
    const pasteShortcut =
      !event.altKey &&
      (((event.ctrlKey || event.metaKey) && event.code === "KeyV") ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "Insert"));
    if (pasteShortcut) {
      if (options.enabled()) {
        event.stopPropagation();
      }
      return;
    }
    if (keyboard.key("down", event)) {
      const altPrintable =
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.getModifierState?.("AltGraph") &&
        Array.from(event.key).length === 1;
      altTextPending = altPrintable ? event.key : null;
      if (altTextPending) {
        // Option layouts can produce text with Alt held. Only the browser's
        // ensuing insertion event qualifies it; an Alt shortcut may emit none.
        event.stopPropagation();
      } else {
        consume(event);
      }
    } else if (options.enabled() && (composing || event.isComposing)) {
      event.stopPropagation();
    }
  };
  const up = (event: KeyboardDomEvent) => {
    // Document observes releases after focus loss without consuming Paseo input.
    if (keyboard.key("up", event) && focused()) {
      consume(event);
    }
    altTextPending = null;
  };
  const compositionStart = () => {
    altTextPending = null;
    composing = true;
    compositionAdmitted = options.enabled() && focused() && !document.hidden;
  };
  const commitText = (value: string) => {
    if (value.length > 16_000) {
      options.onError(new Error("Text is too long. Send up to 16,000 characters at once."));
      return;
    }
    keyboard.text(value);
  };
  const compositionEnd = (event: KeyboardDomEvent) => {
    const accepted = compositionAdmitted && options.enabled() && focused();
    composing = false;
    compositionAdmitted = false;
    if (accepted) {
      commitText(event.data ?? "");
    }
    sink.value = "";
  };
  const beforeInput = (event: KeyboardDomEvent) => {
    if (!composing && options.enabled() && focused()) {
      consume(event);
      if (altTextPending && event.inputType === "insertText" && event.data === altTextPending) {
        commitText(event.data);
      }
      altTextPending = null;
    }
  };
  const paste = (event: KeyboardDomEvent) => {
    if (!options.enabled() || !focused()) {
      return;
    }
    consume(event);
    altTextPending = null;
    commitText(event.clipboardData?.getData("text/plain") ?? "");
    sink.value = "";
  };
  const visibility = () => {
    if (document.hidden) {
      cancel();
    }
  };
  const listeners: Array<[KeyboardElement, string, (event: KeyboardDomEvent) => void]> = [
    [node, "pointerdown", focus],
    [node, "mousedown", focus],
    [node, "touchstart", focus],
    [node, "focus", focus],
    [sink, "keydown", down],
    [node, "keydown", down],
    [sink, "compositionstart", compositionStart],
    [sink, "compositionend", compositionEnd],
    [sink, "beforeinput", beforeInput],
    [sink, "paste", paste],
    [sink, "blur", cancel],
  ];
  for (const [element, type, listener] of listeners) {
    element.addEventListener(type, listener);
  }
  document.addEventListener("keyup", up);
  document.addEventListener("visibilitychange", visibility);
  document.defaultView?.addEventListener("blur", cancel);
  return {
    reset,
    dispose() {
      cancel();
      for (const [element, type, listener] of listeners) {
        element.removeEventListener(type, listener);
      }
      document.removeEventListener("keyup", up);
      document.removeEventListener("visibilitychange", visibility);
      document.defaultView?.removeEventListener("blur", cancel);
      node.tabIndex = previousTabIndex;
      sink.remove();
    },
  };
}
