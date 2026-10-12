/**
 * Local viewer geometry only. Frame pixels determine Fit's aspect ratio; Actual
 * size uses the remote viewport's CSS dimensions, independently of capture DPR.
 * Neither mode changes the remote viewport or its frame/input authority.
 */
import { containedRect, type FrameRect, type FrameSize } from "../../shared/managed-browser/browser";

export type BrowserCanvasDisplayMode = "fit" | "actual";

export interface BrowserCanvasLayout {
  /** Frame wrapper size; Actual's scroll host centers it within the available inner viewport. */
  contentSize: FrameSize;
  /** Position and displayed size inside that extent, also used by the input overlay. */
  frameRect: FrameRect;
}

/**
 * Calculate displayed geometry without treating sharp capture pixels as CSS
 * dimensions. Invalid/unmeasured sizes return null so no frame or input overlay
 * receives non-finite coordinates. Fit preserves containedRect's exact geometry.
 */
export function getBrowserCanvasLayout(
  containerSize: FrameSize,
  framePixelSize: FrameSize,
  viewportCssSize: FrameSize,
  mode: BrowserCanvasDisplayMode = "fit",
): BrowserCanvasLayout | null {
  if (!validSize(containerSize) || !validSize(framePixelSize)) return null;

  if (mode === "fit") {
    const frameRect = containedRect(containerSize, framePixelSize);
    return frameRect ? { contentSize: { ...containerSize }, frameRect } : null;
  }

  if (!validSize(viewportCssSize)) return null;
  return {
    contentSize: { ...viewportCssSize },
    frameRect: {
      x: 0,
      y: 0,
      width: viewportCssSize.width,
      height: viewportCssSize.height,
    },
  };
}

function validSize(size: FrameSize): boolean {
  return (
    Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
  );
}
