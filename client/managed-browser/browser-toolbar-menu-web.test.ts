import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { bindBrowserToolbarMenuWeb } from "./browser-toolbar-menu-web";

/** Deterministic host nodes exercise focus/ownership, without a browser or shared page. */
interface MenuEvent {
  key?: string;
  shiftKey?: boolean;
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}
function fixture(hierarchy?: Parameters<typeof bindBrowserToolbarMenuWeb>[5]) {
  const listeners = new Map<string, (event: MenuEvent) => void>();
  const doc = {
    activeElement: null as unknown,
    addEventListener: (name: string, fn: (event: MenuEvent) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const item = (disabled = false) => {
    const result = {
      focus: vi.fn(() => {
        doc.activeElement = result;
        listeners.get("focusin")?.({ target: result, preventDefault() {}, stopPropagation() {} });
      }),
      contains: (node: unknown) => node === result,
      getAttribute: (name: string) => (name === "aria-disabled" ? String(disabled) : null),
    };
    return result;
  };
  const items = [item(), item(true), item()];
  const triggerButton = item();
  const menu = {
    ownerDocument: doc,
    contains: (node: unknown) => items.some((item) => item === node),
    querySelectorAll: () => items,
  };
  const trigger = {
    contains: (node: unknown) => node === triggerButton,
    querySelectorAll: () => [triggerButton],
  };
  const backdrop = {};
  const overlay = { contains: (node: unknown) => node === backdrop || menu.contains(node) };
  const close = vi.fn();
  let restore = true;
  const dispose = bindBrowserToolbarMenuWeb(
    menu,
    trigger,
    close,
    () => restore,
    overlay,
    hierarchy,
  );
  const event = (key: string, target = doc.activeElement) => ({
    key,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  return {
    doc,
    menu,
    items,
    triggerButton,
    backdrop,
    listeners,
    close,
    dispose,
    event,
    handoff: () => {
      restore = false;
    },
  };
}

describe("local toolbar menu keyboard and dismissal", () => {
  it("Tab and Shift+Tab exit through the surrounding host controls", () => {
    for (const backwards of [false, true]) {
      const f = fixture();
      const before = { focus: vi.fn(), getAttribute: () => null };
      const after = { focus: vi.fn(), getAttribute: () => null };
      Object.assign(f.doc, {
        querySelectorAll: () => [before, f.triggerButton, after, ...f.items],
      });
      f.listeners.get("keydown")!({ ...f.event("Tab"), shiftKey: backwards });
      expect(f.close).toHaveBeenCalledOnce();
      f.dispose();
      expect((backwards ? before : after).focus).toHaveBeenCalledOnce();
      expect(f.triggerButton.focus).not.toHaveBeenCalled();
    }
  });
  it("focuses the first item and uses arrows/Home/End without forwarding keys", () => {
    const f = fixture();
    expect(f.doc.activeElement).toBe(f.items[0]);
    for (const [key, index] of [
      ["ArrowDown", 2],
      ["ArrowDown", 0],
      ["ArrowUp", 2],
      ["Home", 0],
      ["End", 2],
    ] as const) {
      const event = f.event(key);
      f.listeners.get("keydown")!(event);
      expect(f.doc.activeElement).toBe(f.items[index]);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    }
    f.dispose();
  });
  it("Escape dismisses and returns focus even if the row is removed before cleanup", () => {
    const f = fixture();
    const event = f.event("Escape");
    f.listeners.get("keydown")!(event);
    expect(f.close).toHaveBeenCalledOnce();
    f.doc.activeElement = {};
    f.dispose();
    expect(f.triggerButton.focus).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });
  it("does not restore focus when an action hands it to another dialog or keyboard", () => {
    const f = fixture();
    f.handoff();
    f.dispose();
    expect(f.triggerButton.focus).not.toHaveBeenCalled();
  });
  it("consumes local backdrop dismissal so it cannot click through to the remote page", () => {
    const f = fixture();
    const event = f.event("", f.backdrop);
    f.listeners.get("pointerdown")!(event);
    expect(f.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    f.dispose();
  });
  it("leaves deliberate outside-host focus alone", () => {
    const f = fixture();
    const event = f.event("", {});
    f.listeners.get("pointerdown")!(event);
    expect(f.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    f.dispose();
    expect(f.triggerButton.focus).not.toHaveBeenCalled();
  });
});

describe("root-owned submenu Tab exit", () => {
  it("Tab and Shift+Tab from a descendant skip the whole popup", () => {
    for (const backwards of [false, true]) {
      const f = fixture();
      const childMenu = {};
      const child = {
        focus: vi.fn(),
        getAttribute: () => null,
        closest: () => childMenu,
      };
      const originalContains = f.menu.contains;
      f.menu.contains = (node) => node === child || originalContains(node);
      const before = { focus: vi.fn(), getAttribute: () => null };
      const after = { focus: vi.fn(), getAttribute: () => null };
      Object.assign(f.doc, {
        querySelectorAll: () => [before, f.triggerButton, after, ...f.items, child],
      });
      f.doc.activeElement = child;
      const event = { ...f.event("Tab", child), shiftKey: backwards };
      f.listeners.get("keydown")!(event);
      expect(f.close).toHaveBeenCalledOnce();
      f.dispose();
      expect((backwards ? before : after).focus).toHaveBeenCalledOnce();
      expect(child.focus).not.toHaveBeenCalled();
      expect(f.triggerButton.focus).not.toHaveBeenCalled();
    }
  });
  it("nested binders leave Tab to the root without publishing a second close", () => {
    const closeRoot = vi.fn();
    const f = fixture({ nested: true, closeRoot });
    const event = f.event("Tab");
    f.listeners.get("keydown")!(event);
    expect(f.close).not.toHaveBeenCalled();
    expect(closeRoot).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    f.dispose();
  });
});
