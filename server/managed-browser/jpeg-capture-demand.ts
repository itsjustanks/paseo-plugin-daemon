import { setTimeout, clearTimeout } from "./node-timers";
/** Runtime-owned JPEG activity lifetime. Viewer/control/video heartbeats do not
 * renew it. Start/stop transitions share one FIFO, while active reads and native
 * target transitions pin retirement before their asynchronous work begins.
 */
export const JPEG_CAPTURE_IDLE_MS = 3_000;

/** Own one unreferenced timer, not a periodic loop. The timeout is twice the
 * existing 1.5s startup image poll (ready polls are 250ms, active input 100ms).
 * Stop failure is reported once; no page mutation or start is silently replayed.
 */
export function createJpegCaptureDemand(options: {
  now(): number;
  retire(): Promise<void>;
  onError(error: unknown): void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastDemand: number | null = null;
  let pins = 0;
  let revision = 0;
  let closed = false;
  let tail = Promise.resolve();

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** Serialize native stream start/stop without retaining a failed queue tail. */
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (closed) throw new Error("JPEG capture lifetime is closed");
      return await operation();
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function arm() {
    clearTimer();
    if (closed || pins > 0 || lastDemand === null) return;
    const scheduledRevision = revision;
    timer = setTimeout(
      () => {
        timer = null;
        void serialize(async () => {
          if (pins > 0 || revision !== scheduledRevision || lastDemand === null) return;
          if (options.now() - lastDemand < JPEG_CAPTURE_IDLE_MS) {
            arm();
            return;
          }
          lastDemand = null;
          await options.retire();
        }).catch((error) => {
          if (!closed) options.onError(error);
        });
      },
      Math.max(1, lastDemand + JPEG_CAPTURE_IDLE_MS - options.now()),
    );
    timer.unref?.();
  }

  /** Pin before the first await. Native transitions may pass false to protect
   * existing reads without creating/renewing image demand on a video-only page.
   * Completion renews a real read, allowing slow startup/capture to finish safely.
   */
  function pin(renew = true): () => void {
    if (closed) throw new Error("JPEG capture lifetime is closed");
    clearTimer();
    pins += 1;
    if (renew) lastDemand = options.now();
    const pinnedRevision = revision;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pins -= 1;
      if (renew && !closed && pinnedRevision === revision) lastDemand = options.now();
      arm();
    };
  }

  /** Explicit stop discards demand; an older pending read cannot rearm its timer. */
  function cancel() {
    revision += 1;
    lastDemand = null;
    clearTimer();
  }

  /** Shutdown prevents queued native work and future acquisition. */
  function close() {
    closed = true;
    cancel();
  }
  return { pin, serialize, cancel, close };
}
