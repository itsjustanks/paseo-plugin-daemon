import { describe, expect, it } from "vitest";
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";
import { bindBrowserCanvasKeyboard, type KeyboardCanvasNode } from "./browser-canvas-keyboard-web";

type Listener = (event: never) => void;

/** Minimal DOM: only listener registration and focus, enough to drive the real adapter. */
function fakeDom() {
  const registry = new Map<string, Set<Listener>>();
  const target = (name: string) => ({
    add(type: string, listener: Listener) {
      const key = `${name}:${type}`;
      registry.set(key, (registry.get(key) ?? new Set()).add(listener));
    },
    remove(type: string, listener: Listener) {
      registry.get(`${name}:${type}`)?.delete(listener);
    },
  });
  const nodeTarget = target("node");
  const sinkTarget = target("sink");
  const docTarget = target("doc");
  const winTarget = target("win");
  const document = {
    activeElement: null as unknown,
    hidden: false,
    createElement: () => sink,
    addEventListener: docTarget.add,
    removeEventListener: docTarget.remove,
    defaultView: { addEventListener: winTarget.add, removeEventListener: winTarget.remove },
  };
  const sink = {
    tabIndex: 0,
    value: "",
    style: {},
    setAttribute() {},
    focus() {
      document.activeElement = sink;
    },
    remove() {},
    addEventListener: sinkTarget.add,
    removeEventListener: sinkTarget.remove,
  };
  const node = {
    ...sink,
    appendChild() {},
    ownerDocument: document,
    addEventListener: nodeTarget.add,
    removeEventListener: nodeTarget.remove,
  } as unknown as KeyboardCanvasNode;
  sink.focus();
  const fire = (name: string, type: string, event: object = {}) => {
    for (const listener of registry.get(`${name}:${type}`) ?? [])
      (listener as (event: object) => void)({
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
  };
  return { node, document, fire };
}

const key = {
  key: "a",
  code: "KeyA",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
};

function bind() {
  const dom = fakeDom();
  const events: CanvasKeyboardEvent[] = [];
  let cancels = 0;
  const binding = bindBrowserCanvasKeyboard(dom.node, {
    enabled: () => true,
    enqueue: (event) => {
      events.push(event);
      return true;
    },
    finish: () => {},
    cancel: () => {
      cancels += 1;
    },
    onError: () => {},
  });
  return { ...dom, events, binding, cancels: () => cancels };
}

describe("web canvas keyboard adapter cancellation", () => {
  it.each([
    ["sink blur", (dom: ReturnType<typeof bind>) => dom.fire("sink", "blur")],
    ["window blur", (dom: ReturnType<typeof bind>) => dom.fire("win", "blur")],
    [
      "page hidden",
      (dom: ReturnType<typeof bind>) => {
        dom.document.hidden = true;
        dom.fire("doc", "visibilitychange");
      },
    ],
  ])("%s cancels the held key and drops its late release", (_name, lose) => {
    const dom = bind();
    dom.fire("sink", "keydown", key);
    expect(dom.events.map((event) => event.kind)).toEqual(["key"]);
    lose(dom);
    expect(dom.cancels()).toBe(1);
    dom.document.hidden = false;
    dom.fire("doc", "keyup", key);
    dom.fire("sink", "keydown", { ...key, repeat: true });
    expect(dom.events).toHaveLength(1);
  });
});


describe("web canvas text insertion does not duplicate physical input", () => {
  it("keeps the physical key as the sole insertion when beforeinput follows", () => {
    const dom = bind();
    dom.fire("sink", "keydown", key);
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "a" });
    dom.fire("doc", "keyup", key);
    expect(dom.events.map((event) => event.kind)).toEqual(["key", "key"]);
  });
  it("pastes local text once without sending a remote clipboard shortcut", () => {
    const dom = bind();
    dom.fire("sink", "keydown", { ...key, key: "v", code: "KeyV", metaKey: true });
    dom.fire("sink", "paste", { clipboardData: { getData: () => "local text" } });
    dom.fire("sink", "beforeinput", { inputType: "insertFromPaste", data: "local text" });
    expect(dom.events).toEqual([{ kind: "text", text: "local text" }]);
  });
  it("commits composition once and ignores intermediate and trailing insertion events", () => {
    const dom = bind();
    dom.fire("sink", "compositionstart");
    dom.fire("sink", "beforeinput", { inputType: "insertCompositionText", data: "に" });
    dom.fire("sink", "compositionend", { data: "日本語" });
    dom.fire("sink", "beforeinput", { inputType: "insertText", data: "日本語" });
    expect(dom.events).toEqual([{ kind: "text", text: "日本語" }]);
  });
  it("drops a composition commit after visibility cancels its admission", () => {
    const dom = bind();
    dom.fire("sink", "compositionstart");
    dom.document.hidden = true; dom.fire("doc", "visibilitychange");
    dom.document.hidden = false;
    dom.fire("sink", "compositionend", { data: "日本語" });
    expect(dom.events).toEqual([]);
  });
});
