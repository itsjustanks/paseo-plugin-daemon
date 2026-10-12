/**
 * Web-only overflow adapter for the public React Native ScrollView host. A single
 * DOM scroll node keeps both native desktop scrollbars at the viewer's edges.
 * Only local overflow/offsets are changed; child remote-input listeners are untouched.
 */
import type { BrowserCanvasDisplayMode } from "./browser-canvas-layout";

interface WebScrollNode {
  style: { overflowX: string; overflowY: string };
  scrollLeft: number;
  scrollTop: number;
}

export interface BrowserCanvasScrollHandle {
  getScrollableNode?(): unknown;
  getNativeScrollRef?(): unknown;
}

/**
 * Apply public ScrollView's second overflow axis before paint. Fit resets both
 * offsets without replacing children. An unavailable/non-web host is a no-op.
 * Actual disabled panning retains its previous observation offset.
 */
export function configureBrowserCanvasWebScrolling(
  handle: BrowserCanvasScrollHandle | null,
  mode: BrowserCanvasDisplayMode,
  localPanEnabled: boolean,
): void {
  if (!handle) return;
  const node = readScrollNode(handle);
  if (!node) return;

  const overflow = mode === "actual" && localPanEnabled ? "auto" : "hidden";
  node.style.overflowX = overflow;
  node.style.overflowY = overflow;
  if (mode === "fit") {
    node.scrollLeft = 0;
    node.scrollTop = 0;
  }
}

/** Prefer the documented scrollable host; tolerate platform refs that expose only the native scroll ref. */
function readScrollNode(handle: BrowserCanvasScrollHandle): WebScrollNode | null {
  for (const read of [handle.getScrollableNode, handle.getNativeScrollRef]) {
    if (!read) continue;
    try {
      const candidate: unknown = read.call(handle);
      if (!candidate || typeof candidate !== "object") continue;
      const node = candidate as Partial<WebScrollNode>;
      if (
        !node.style ||
        typeof node.style.overflowX !== "string" ||
        typeof node.style.overflowY !== "string"
      )
        continue;
      if (typeof node.scrollLeft !== "number" || typeof node.scrollTop !== "number") continue;
      return node as WebScrollNode;
    } catch {
      // A disappearing host must not break frame rendering or input cleanup.
    }
  }
  return null;
}
