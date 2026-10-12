import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook runtime: one component instance, state kept across renders.
const hooks = vi.hoisted(() => {
  const runtime = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<() => void>,
    rerender: () => {},
  };
  return runtime;
});

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const i = hooks.index++;
    hooks.slots[i] ??= { current: initial };
    return hooks.slots[i];
  },
  useState: (initial: unknown) => {
    const i = hooks.index++;
    hooks.slots[i] ??= initial;
    return [
      hooks.slots[i],
      (next: unknown) => {
        hooks.slots[i] =
          typeof next === "function" ? (next as (v: unknown) => unknown)(hooks.slots[i]) : next;
        hooks.rerender();
      },
    ];
  },
  useEffect: (effect: () => void) => {
    hooks.effects.push(effect);
  },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const Modal = Object.assign(() => null, { Content: () => null });
  return { Modal, TextInput: () => null };
});
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));
vi.mock("./browser-chrome", () => ({ ControlButton: () => null }));

import { ComposeTextControls } from "./browser-compose-controls";

type Node = { props?: Record<string, unknown> } | Node[] | string | null | undefined;
function find(
  node: Node,
  match: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const stack: Node[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) stack.push(...current);
    else if (current && typeof current === "object" && current.props) {
      if (match(current.props)) return current.props;
      stack.push(current.props.children as Node);
    }
  }
  throw new Error("element not found");
}

const composeText = vi.fn((_text: string) => true);
const cancelInput = vi.fn();
const onRequestControlForCompose = vi.fn();
let props: Parameters<typeof ComposeTextControls>[0];
let tree: Node;

function render(overrides: Partial<typeof props> = {}) {
  props = { ...props, ...overrides };
  hooks.index = 0;
  hooks.effects = [];
  tree = ComposeTextControls(props) as Node;
  // Effects run after render, as in React; state they set re-renders.
  for (const effect of hooks.effects) effect();
  return tree;
}
const done = () => find(tree, (p) => p.label === "Done");
const draft = (text: string) =>
  (find(tree, (p) => "onChangeText" in p).onChangeText as (t: string) => void)(text);

beforeEach(() => {
  hooks.slots = [];
  composeText.mockClear();
  cancelInput.mockClear();
  onRequestControlForCompose.mockClear();
  hooks.rerender = () => {
    hooks.index = 0;
    hooks.effects = [];
    tree = ComposeTextControls(props) as Node;
  };
  props = {
    styles: {} as never,
    theme: {} as never,
    composeText,
    cancelInput,
    enabled: true,
    ownershipKey: "page-1",
    documentKey: "doc-1",
    request: null,
    onRequestHandled: vi.fn(),
    onRequestControlForCompose,
    canRequestControl: false,
  };
});

function open() {
  render({ request: { id: 1, kind: "compose", ownershipKey: "page-1" } });
  draft("hello");
  render();
}

describe("ComposeTextControls", () => {
  it("opening cancels held canvas input and Done inserts once even when pressed rapidly", () => {
    open();
    expect(cancelInput).toHaveBeenCalledTimes(1);
    const press = done().onPress as () => void;
    press();
    press();
    expect(composeText).toHaveBeenCalledTimes(1);
    expect(composeText).toHaveBeenCalledWith("hello");
  });

  it("a second Done arriving while the first is being published inserts nothing more", () => {
    open();
    const press = done().onPress as () => void;
    composeText.mockImplementationOnce(() => {
      press();
      return true;
    });
    press();
    expect(composeText).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft for review when nothing was admitted, then allows one retry", () => {
    composeText.mockReturnValueOnce(false);
    open();
    (done().onPress as () => void)();
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledTimes(2);
  });

  it("a retained Done callback cannot insert after ownership changes; the same document rebinds once", () => {
    open();
    const stale = done().onPress as () => void;
    render({ ownershipKey: "page-2" });
    stale();
    expect(composeText).not.toHaveBeenCalled();
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledTimes(1);
    expect(composeText).toHaveBeenCalledWith("hello");
  });

  it("a replaced document refuses Done entirely", () => {
    open();
    const stale = done().onPress as () => void;
    render({ ownershipKey: "page-2", documentKey: "doc-2" });
    expect(done().disabled).toBe(true);
    stale();
    expect(composeText).not.toHaveBeenCalled();
  });

  it("without control, Done asks for control instead of inserting", () => {
    open();
    render({ enabled: false, canRequestControl: true });
    (done().onPress as () => void)();
    expect(composeText).not.toHaveBeenCalled();
    expect(onRequestControlForCompose).toHaveBeenCalledTimes(1);
  });

  it("a retained Done callback cannot insert after control is lost", () => {
    open();
    const stale = done().onPress as () => void;
    render({ enabled: false });
    stale();
    expect(composeText).not.toHaveBeenCalled();
  });

  it("keeps every character of input that arrives faster than a re-render, and never echoes a value back", () => {
    render({ request: { id: 1, kind: "compose", ownershipKey: "page-1" } });
    const field = find(tree, (p) => "onChangeText" in p);
    expect("value" in field).toBe(false);
    // One retained handler, no render between events: the host input owns the text.
    const change = field.onChangeText as (t: string) => void;
    for (const next of ["h", "he", "hel", "hell", "hello", "hello日", "hello日本"]) change(next);
    render();
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledTimes(1);
    expect(composeText).toHaveBeenCalledWith("hello日本");
  });

  it("commits ten rapid characters and an IME-style whole-string replacement exactly", () => {
    render({ request: { id: 1, kind: "compose", ownershipKey: "page-1" } });
    const change = find(tree, (p) => "onChangeText" in p).onChangeText as (t: string) => void;
    for (let i = 1; i <= 10; i++) change("abcdefghij".slice(0, i));
    change("にほんご"); // composition commit replaces the whole value
    render();
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledWith("にほんご");
  });

  it("clears the draft on close and reopen, and ignores a retained handler from the old draft", () => {
    render({ request: { id: 1, kind: "compose", ownershipKey: "page-1" } });
    const retained = find(tree, (p) => "onChangeText" in p).onChangeText as (t: string) => void;
    retained("old draft");
    render();
    (find(tree, (p) => p.label === "Cancel").onPress as () => void)();
    retained("late old text");
    render({ request: { id: 2, kind: "compose", ownershipKey: "page-1" } });
    expect(done().disabled).toBe(true);
    (done().onPress as () => void)();
    expect(composeText).not.toHaveBeenCalled();
  });

  const cancel = () => find(tree, (p) => p.label === "Cancel").onPress as () => void;
  const onOpenChange = () =>
    find(tree, (p) => "onOpenChange" in p).onOpenChange as (o: boolean) => void;
  const reopen = (id: number) => {
    cancel()();
    render({ request: { id, kind: "compose", ownershipKey: "page-1" } });
  };

  it("a retained Done from a closed draft cannot publish or close a same-owner replacement", () => {
    open();
    const staleDone = done().onPress as () => void;
    reopen(2);
    draft("new draft");
    render();
    staleDone();
    expect(composeText).not.toHaveBeenCalled();
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledTimes(1);
    expect(composeText).toHaveBeenCalledWith("new draft");
  });

  it("a retained Cancel or dismissal from a closed draft cannot close the replacement", () => {
    open();
    const staleCancel = cancel();
    const staleDismiss = onOpenChange();
    reopen(2);
    draft("keep me");
    render();
    staleCancel();
    staleDismiss(false);
    render();
    expect(find(tree, (p) => "open" in p && "onOpenChange" in p).open).toBe(true);
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenCalledWith("keep me");
  });

  it("a commit that synchronously opens a new draft publishes once and leaves that draft open", () => {
    open();
    composeText.mockImplementationOnce(() => {
      reopen(2);
      draft("second");
      return true;
    });
    (done().onPress as () => void)();
    render();
    expect(find(tree, (p) => "open" in p && "onOpenChange" in p).open).toBe(true);
    expect(composeText).toHaveBeenCalledTimes(1);
    (done().onPress as () => void)();
    expect(composeText).toHaveBeenLastCalledWith("second");
  });

  it("a retained Done from a closed draft neither rebinds nor requests control", () => {
    open();
    render({ enabled: false, canRequestControl: true });
    const staleDone = done().onPress as () => void;
    reopen(2);
    render({ enabled: false, canRequestControl: true });
    staleDone();
    expect(onRequestControlForCompose).not.toHaveBeenCalled();
    expect(composeText).not.toHaveBeenCalled();
  });
});
