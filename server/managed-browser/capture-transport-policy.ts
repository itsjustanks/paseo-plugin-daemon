/**
 * Owns transport hysteresis and bounded screenshot reuse, independently of JPEG
 * decoding. A quiet CDP stream can emit one frame because captureScreenshot ran;
 * those frames are still acknowledged/cached, but cannot establish recovery.
 * The 250ms post-capture exclusion is conservative because CDP provides no
 * causal request ID on screencast events. Cached receipt age is monotonic.
 */
import type { RuntimeFrame } from "./agent-browser-runtime";

export const CAPTURE_MAX_AGE_MS = 1_000;
const FALLBACK_MIN_DWELL_MS = 1_500;
const RECOVERY_MIN_EVENTS = 3;
const RECOVERY_MIN_SPAN_MS = 500;
const RECOVERY_MAX_GAP_MS = 500;
const SCREENSHOT_EVENT_GUARD_MS = 250;
const RECOVERY_ID_MEMORY = 32;

type ScreenshotCache = {
  frame: RuntimeFrame;
  receivedAt: number;
  quality: number;
  maxBytes: number;
};

/** Create one policy per runtime. Invalidation revokes outstanding screenshot completion tokens. */
export function createCaptureTransportPolicy() {
  let generation = 0;
  let fallbackSince: number | null = null;
  let screenshot: ScreenshotCache | null = null;
  let screenshotsInFlight = 0;
  let ignoreStreamUntil = 0;
  let recoveryFirstAt: number | null = null;
  let recoveryLastAt: number | null = null;
  let recoveryCount = 0;
  const recoveryIds = new Set<string>();

  function clearRecovery(): void {
    recoveryFirstAt = null;
    recoveryLastAt = null;
    recoveryCount = 0;
    recoveryIds.clear();
  }

  /**
   * Clear cached screenshots/evidence and revoke old async completions. Keep an
   * existing fallback dwell: input/session changes require fresh recovery evidence.
   */
  function invalidate(): void {
    generation += 1;
    screenshot = null;
    screenshotsInFlight = 0;
    ignoreStreamUntil = 0;
    clearRecovery();
  }

  /** Enter fallback once; recapture/cache expiry must not extend the minimum dwell. */
  function enterFallback(now: number): void {
    if (fallbackSince !== null) return;
    fallbackSince = now;
    clearRecovery();
  }

  /** Feed only valid current-session CDP events, with distinct provider timestamps when available. */
  function observeStream(identity: string, now: number): void {
    if (fallbackSince === null) return;
    if (screenshotsInFlight > 0 || now <= ignoreStreamUntil) return;
    if (recoveryLastAt !== null && now - recoveryLastAt > RECOVERY_MAX_GAP_MS) {
      clearRecovery();
    }
    if (recoveryIds.has(identity)) return;
    if (recoveryFirstAt === null) recoveryFirstAt = now;
    recoveryLastAt = now;
    recoveryCount = Math.min(RECOVERY_MIN_EVENTS, recoveryCount + 1);
    recoveryIds.add(identity);
    if (recoveryIds.size > RECOVERY_ID_MEMORY) {
      const oldest = recoveryIds.values().next().value;
      if (oldest !== undefined) recoveryIds.delete(oldest);
    }
  }

  /** Require sustained independent activity before allowing a fresh stream to replace fallback. */
  function canUseStream(now: number): boolean {
    if (fallbackSince === null) return true;
    if (
      recoveryFirstAt === null ||
      recoveryLastAt === null ||
      now - fallbackSince < FALLBACK_MIN_DWELL_MS ||
      recoveryCount < RECOVERY_MIN_EVENTS ||
      recoveryLastAt - recoveryFirstAt < RECOVERY_MIN_SPAN_MS ||
      now - recoveryLastAt > RECOVERY_MAX_GAP_MS
    )
      return false;
    fallbackSince = null;
    clearRecovery();
    return true;
  }

  /** Reuse only identical quality/budget requests; larger budgets deserve a new quality decision. */
  function readScreenshot(now: number, quality: number, maxBytes: number): RuntimeFrame | null {
    const cached = screenshot;
    if (
      !cached ||
      now - cached.receivedAt > CAPTURE_MAX_AGE_MS ||
      cached.quality !== quality ||
      cached.maxBytes !== maxBytes
    )
      return null;
    return cached.frame;
  }

  /**
   * Begin capture and return its mutation/session epoch. A quality-only viewer
   * capture keeps independent stream recovery evidence, while still excluding
   * capture-induced events until the same causal guard expires.
   */
  function beginScreenshot(options: { preserveRecovery?: boolean } = {}): number {
    screenshotsInFlight += 1;
    if (!options.preserveRecovery) clearRecovery();
    return generation;
  }

  /** End causal exclusion only for this still-current capture generation. */
  function endScreenshot(token: number, now: number): void {
    if (token !== generation) return;
    screenshotsInFlight = Math.max(0, screenshotsInFlight - 1);
    ignoreStreamUntil = Math.max(ignoreStreamUntil, now + SCREENSHOT_EVENT_GUARD_MS);
  }

  /** Never install a pre-input/session screenshot after its asynchronous RPC resolves. */
  function rememberScreenshot(
    token: number,
    frame: RuntimeFrame,
    now: number,
    quality: number,
    maxBytes: number,
  ): boolean {
    if (token !== generation) return false;
    screenshot = { frame, receivedAt: now, quality, maxBytes };
    return true;
  }

  return {
    invalidate,
    enterFallback,
    observeStream,
    canUseStream,
    readScreenshot,
    beginScreenshot,
    endScreenshot,
    rememberScreenshot,
    currentGeneration: () => generation,
    isCurrent: (token: number) => token === generation,
  };
}
