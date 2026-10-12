/** Native source recovery is viewing-only and never retries a browser mutation.
 * Transient failures wait three monotonic seconds after failure admission, and
 * retirement independently gates replacement. A proven
 * size mismatch remains blocked until the owning attachment or viewport changes.
 */
import { performance } from "node:perf_hooks";

export const VIDEO_SOURCE_RECOVERY_COOLDOWN_MS = 3_000;
export type VideoSourceFailureCode =
  | "startup"
  | "source-stopped"
  | "source-reset"
  | "source-dimensions";
export interface VideoSourceRecoveryContext {
  connection: unknown;
  page: unknown;
  viewport: unknown;
  attachmentGeneration: number;
}

/** Keep failure admission separate from track lifetime, so demand cannot pin a
 * failed source and a stopped permanent failure cannot spin up replacements. */
export function createVideoSourceRecovery(now: () => number = () => performance.now()) {
  let context: VideoSourceRecoveryContext | null = null;
  let failure: VideoSourceFailureCode | null = null;
  let retryAfter = 0;
  const sameContext = (value: VideoSourceRecoveryContext): boolean => {
    if (context === null) {
      return false;
    }
    return (
      value.connection === context.connection &&
      value.page === context.page &&
      value.viewport === context.viewport &&
      value.attachmentGeneration === context.attachmentGeneration
    );
  };
  const selectContext = (value: VideoSourceRecoveryContext) => {
    if (sameContext(value)) {
      return;
    }
    context = { ...value };
    failure = null;
    retryAfter = 0;
  };
  return {
    /** Returns a private reason while acquisition is blocked. Document changes
     * alone cannot cure a mismatch in this exact configured pixel geometry. */
    blocked(value: VideoSourceRecoveryContext): VideoSourceFailureCode | null {
      selectContext(value);
      if (failure === "source-dimensions" || now() < retryAfter) {
        return failure;
      }
      return null;
    },
    /** Start the cooldown before asynchronous retirement, closing the admission
     * gap even when cleanup is slow. Cleanup completion remains mandatory. */
    failed(value: VideoSourceRecoveryContext, code: VideoSourceFailureCode): void {
      selectContext(value);
      failure = code;
      retryAfter = now() + VIDEO_SOURCE_RECOVERY_COOLDOWN_MS;
    },
  };
}
