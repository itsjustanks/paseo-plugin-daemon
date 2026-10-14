/** Real EventTarget envelopes exercise host suspension without a decoder or DOM shim. */
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { type BrowserVideoCanvasNode, bindBrowserVideoVisibility } from "./web";

it("tracks hidden documents and page-cache suspension and removes every listener", () => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  let intersection: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  const disconnected = vi.fn();
  const view = Object.assign(new EventTarget(), {
    IntersectionObserver: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersection = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  });
  const changes: boolean[] = [];
  const cleanup = bindBrowserVideoVisibility(
    {
      getClientRects: () => [1],
      ownerDocument: Object.assign(document, { defaultView: view }),
    } as unknown as BrowserVideoCanvasNode,
    (value) => changes.push(value),
  );
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  document.hidden = false;
  view.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("visibilitychange"));
  view.dispatchEvent(new Event("pageshow"));
  expect(changes).toEqual([true, false, false, false, true]);
  intersection!([{ isIntersecting: false }]);
  intersection!([{ isIntersecting: true }]);
  expect(changes.slice(-2)).toEqual([false, true]);
  cleanup();
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  view.dispatchEvent(new Event("pageshow"));
  expect(changes).toHaveLength(7);
  expect(disconnected).toHaveBeenCalledOnce();
});
