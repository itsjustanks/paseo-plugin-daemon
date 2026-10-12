import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
const { observeBrowserVisibility } = await import("../client/browser-visibility");
describe("mounted browser view visibility", () => {
  it("pauses on document hiding, page suspension, and a hidden panel, then removes all observers", () => {
    const events = new Map<string, () => void>(); const changes = vi.fn(); const disconnect = vi.fn(); let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    const addEventListener = (name: string, listener: () => void) => events.set(name, listener);
    const removeEventListener = (name: string) => events.delete(name);
    const owner = { hidden: false, addEventListener, removeEventListener, defaultView: {
      addEventListener, removeEventListener, IntersectionObserver: class {
        constructor(callback: typeof intersect) { intersect = callback; } observe() {} disconnect = disconnect;
      },
    } };
    const cleanup = observeBrowserVisibility({ ownerDocument: owner, getClientRects: () => ({ length: 1 }) }, changes);
    expect(changes).toHaveBeenLastCalledWith(true);
    owner.hidden = true; events.get("visibilitychange")!(); expect(changes).toHaveBeenLastCalledWith(false);
    owner.hidden = false; events.get("visibilitychange")!(); expect(changes).toHaveBeenLastCalledWith(true);
    intersect([{ isIntersecting: false }]); expect(changes).toHaveBeenLastCalledWith(false);
    intersect([{ isIntersecting: true }]); events.get("pagehide")!(); expect(changes).toHaveBeenLastCalledWith(false);
    events.get("pageshow")!(); expect(changes).toHaveBeenLastCalledWith(true);
    cleanup(); expect(disconnect).toHaveBeenCalledOnce(); expect(events.size).toBe(0);
  });
  it("starts paused for a panel that has no visible layout rectangle", () => {
    const changes = vi.fn(); const cleanup = observeBrowserVisibility({ getClientRects: () => ({ length: 0 }), ownerDocument: { hidden: false, addEventListener() {}, removeEventListener() {}, defaultView: null } }, changes);
    expect(changes).toHaveBeenCalledWith(false); cleanup();
  });
});
