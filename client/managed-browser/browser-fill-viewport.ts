/** Convert the visible canvas's logical dimensions to a supported browser resolution. */
import { MAX_VIEWPORT, MIN_VIEWPORT } from "../../shared/managed-browser/viewport-limits";

/**
 * Round fractional layout pixels to the nearest browser CSS pixel. Unmeasured or
 * unsupported panels return null rather than silently clamping to a different size.
 * captureScale bounds physical image pixels without multiplying logical dimensions.
 */
export function getFillViewportResolution(
  size: { width: number; height: number },
  captureScale = 1,
) {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(captureScale) ||
    captureScale < 1 ||
    width < MIN_VIEWPORT.width ||
    width * captureScale > MAX_VIEWPORT.width ||
    height < MIN_VIEWPORT.height ||
    height * captureScale > MAX_VIEWPORT.height
  ) {
    return null;
  }
  return { width, height };
}
