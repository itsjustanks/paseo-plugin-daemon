/** Select capture detail from actual displayed size, independently of page layout. */
import { type CaptureDensity, canUseCaptureDensity } from "../../shared/managed-browser/capture-density";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";

export type CaptureDensityMode = "auto" | CaptureDensity;

/**
 * Choose the smallest supported density that covers the display's physical
 * pixels, or the highest available density when 2x cannot fully cover them.
 * Fit accounts for letterboxing; Actual uses CSS size even when clipped.
 * Unmeasured geometry returns null so it cannot trigger speculative writes.
 */
export function getAutomaticCaptureDensity(
  viewport: { width: number; height: number },
  container: { width: number; height: number },
  pixelRatio: number,
  mode: BrowserCanvasDisplayMode,
): CaptureDensity | null {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) return null;
  const layout = getBrowserCanvasLayout(container, viewport, viewport, mode);
  if (!layout) return null;
  const requiredDensity =
    Math.max(layout.frameRect.width / viewport.width, layout.frameRect.height / viewport.height) *
    pixelRatio;
  // Fractional panel measurements can differ from rounded CSS layout by one
  // physical pixel. That alone should not double source resolution on a 1x screen.
  const roundingTolerance = 1 / Math.max(viewport.width, viewport.height);
  if (requiredDensity > 1 + roundingTolerance && canUseCaptureDensity(viewport, 2)) return 2;
  return canUseCaptureDensity(viewport, 1) ? 1 : null;
}
