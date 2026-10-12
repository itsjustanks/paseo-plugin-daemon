// Visibility observation adapted from Omer Cohen's MIT-licensed paseo-shared-browser
// at daed6eb12f4156ca392f71c48e7a9ccca231ae8c. License: ../server/browser-LICENSE.txt.
// Optional web visibility through the mounted native View's structural ref.
// No DOM globals or DOM library: native visibility is owned by AppState and the caller's visible prop.
import { Platform } from "react-native";
type BrowserNode = {
  getClientRects(): { length: number };
  ownerDocument: {
    hidden?: boolean;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    defaultView: {
      IntersectionObserver?: new (callback: (entries: { isIntersecting: boolean }[]) => void) => { observe(node: BrowserNode): void; disconnect(): void };
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    } | null;
  };
};
export function observeBrowserVisibility(value: unknown, changed: (visible: boolean) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  const node = value as BrowserNode | null;
  if (!node?.ownerDocument || typeof node.getClientRects !== "function") return () => {};
  const owner = node.ownerDocument; const view = owner.defaultView;
  let intersecting = node.getClientRects().length > 0; let suspended = false;
  const update = () => changed(!owner.hidden && !suspended && intersecting);
  const observer = view?.IntersectionObserver ? new view.IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); update(); }) : null;
  const hide = () => { suspended = true; update(); };
  const show = () => { suspended = false; update(); };
  observer?.observe(node); owner.addEventListener("visibilitychange", update);
  view?.addEventListener("pagehide", hide); view?.addEventListener("pageshow", show); update();
  return () => { observer?.disconnect(); owner.removeEventListener("visibilitychange", update); view?.removeEventListener("pagehide", hide); view?.removeEventListener("pageshow", show); };
}
