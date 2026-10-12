/** Native JPEG source ordering, independent of arrival time and image decoding.
 * CDP Page.ScreencastFrameMetadata.timestamp is frame-swap TimeSinceEpoch in
 * seconds. Missing/stale metadata cannot certify queued pixels after input.
 * Refused frames still get acknowledged by the runtime and use screenshot fallback.
 */
import { CAPTURE_MAX_AGE_MS } from "./capture-transport-policy";

// Match the existing native-video source-clock bound. This is clock tolerance,
// never an extension of the one-second native source freshness window.
const SOURCE_CLOCK_TOLERANCE_MS = 50;

/** Own one ordering watermark per runtime. Invalidation revokes every swap at or
 * before its wall-clock boundary plus clock uncertainty; accepted age retains the original monotonic
 * expiry even when an event spent time queued before arrival. */
export function createScreencastSourceTime() {
  let notBeforeMs = -Infinity;
  let lastSourceMs = -Infinity;

  return {
    invalidate(nowMs: number): void {
      notBeforeMs = Math.max(notBeforeMs, nowMs);
    },
    accept(timestampSeconds: number | undefined, wallNowMs: number, monotonicNowMs: number) {
      if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) return null;
      const sourceMs = timestampSeconds * 1000;
      const ageMs = wallNowMs - sourceMs;
      if (
        !Number.isFinite(sourceMs) ||
        ageMs < -SOURCE_CLOCK_TOLERANCE_MS ||
        ageMs > CAPTURE_MAX_AGE_MS ||
        // The accepted future-clock tolerance also applies to an old swap.
        // Require source time beyond the entire uncertainty interval after input.
        sourceMs <= notBeforeMs + SOURCE_CLOCK_TOLERANCE_MS ||
        sourceMs <= lastSourceMs
      ) {
        return null;
      }
      lastSourceMs = sourceMs;
      return {
        capturedAt: new Date(sourceMs).toISOString(),
        // Future clock tolerance does not buy extra freshness after receipt.
        receivedAt: monotonicNowMs - Math.max(0, ageMs),
      };
    },
  };
}
