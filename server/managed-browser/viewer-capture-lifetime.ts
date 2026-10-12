import { setTimeout, clearTimeout } from "./node-timers";
/**
 * Releases optional capture resources when their last viewer lease expires.
 * Pixel receipts are not ownership: failed startup can still own a track/helper.
 * The browser itself stays alive. Callers recheck current viewers before cleanup.
 */
export interface ViewerCaptureLifetime {
  /** Start or refresh cleanup scheduling after capture is attempted. */
  arm(): void;
  /** Cancel this lifetime during explicit cleanup or session disposal. */
  cancel(): void;
}

/** Own one unreferenced timer per session, using current viewer expiry facts. */
export function createViewerCaptureLifetime(options: {
  now(): number;
  latestExpiry(): number | null;
  onExpired(): Promise<void>;
}): ViewerCaptureLifetime {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0;

  function cancel(): void {
    revision += 1;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    cancel();
    const expiry = options.latestExpiry();
    if (expiry === null) return;
    const scheduledRevision = revision;
    timer = setTimeout(
      async () => {
        timer = null;
        if (scheduledRevision !== revision) return;
        const currentExpiry = options.latestExpiry();
        if (currentExpiry !== null && currentExpiry > options.now()) {
          arm();
          return;
        }
        // A slow cleanup must not clear a newer viewer's schedule or replay work.
        await options.onExpired().catch(() => undefined);
      },
      Math.max(1, expiry - options.now()),
    );
    timer.unref?.();
  }

  return { arm, cancel };
}
