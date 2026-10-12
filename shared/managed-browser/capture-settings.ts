/** JPEG quality and byte bounds shared by the human viewer, agent adapter and browser runtime. */
export const DEFAULT_CAPTURE_QUALITY = "medium" as const;
export const JPEG_QUALITY = { low: 40, medium: 65, high: 85, maximum: 100 } as const;
export type CaptureQuality = keyof typeof JPEG_QUALITY;
export const DEFAULT_JPEG_QUALITY = JPEG_QUALITY[DEFAULT_CAPTURE_QUALITY];

// Preserve the original RPC frame bound; large captures reduce JPEG quality to fit.
export const FRAME_MAX_BYTES = 600_000;
export const FRAME_MAX_BASE64_CHARS = Math.ceil(FRAME_MAX_BYTES / 3) * 4;

/** Actual image pixels are independent of CSS layout and input coordinates for sharper phone capture. */
export function captureDimensions(viewport: { width: number; height: number }, captureScale = 1) {
  return {
    width: Math.round(viewport.width * captureScale),
    height: Math.round(viewport.height * captureScale),
  };
}
