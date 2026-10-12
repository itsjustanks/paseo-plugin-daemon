/**
 * Recover viewing after its short-lived viewer token expires during background
 * suspension. Only a viewing capture/video error can use this policy; mutation failure must
 * never trigger action replay, control acquisition or lease takeover.
 */
const VIEWER_EXPIRED_MESSAGE = "Viewer token is invalid or expired";
const BROWSER_CLOSED_MESSAGE = "Browser is closed";

/** Recognize the server's explicit close fence without confusing it with a transport failure. */
export function isBrowserClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message !== "string") return false;
  if (value.code !== undefined && value.code !== "handler_error") return false;
  const message = value.message.startsWith("Request failed: ")
    ? value.message.slice("Request failed: ".length)
    : value.message;
  return (
    message === BROWSER_CLOSED_MESSAGE ||
    (value.code === "handler_error" && message.startsWith(`${BROWSER_CLOSED_MESSAGE} requestType=`))
  );
}

/** Match the owned handler error, including Paseo's documented RPC error suffix. */
export function isExpiredBrowserViewerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message !== "string") return false;
  if (value.code !== undefined && value.code !== "handler_error") return false;
  // Daemon session.js applies this exact prefix before the client appends
  // requestType/code. Arbitrary error text never grants automatic recovery.
  const message =
    value.code === "handler_error" && value.message.startsWith("Request failed: ")
      ? value.message.slice("Request failed: ".length)
      : value.message;
  if (message === VIEWER_EXPIRED_MESSAGE) return true;
  return (
    value.code === "handler_error" && message.startsWith(`${VIEWER_EXPIRED_MESSAGE} requestType=`)
  );
}

export interface BrowserViewerRecoveryObservation {
  /** Host/workspace scope of the mounted panel, never a printer or page identity. */
  identity: string;
  viewerToken: string | null;
  /** Exact token of the failed capture query or video reader; an old viewer cannot recover its replacement. */
  failedViewerToken: string | null;
  captureError: unknown;
  pending: boolean;
}

/**
 * Claim at most one automatic viewing reattachment per expired token. Failure
 * keeps manual Reconnect available. A new token or panel scope permits its own
 * later recovery; this helper neither issues input nor holds browser authority.
 */
export function createBrowserViewerRecovery() {
  let scope: string | null = null;
  let attemptedToken: string | null = null;
  return (observation: BrowserViewerRecoveryObservation): boolean => {
    if (scope !== observation.identity) {
      scope = observation.identity;
      attemptedToken = null;
    }
    const token = observation.viewerToken;
    if (
      observation.pending ||
      !token ||
      observation.failedViewerToken !== token ||
      attemptedToken === token ||
      !isExpiredBrowserViewerError(observation.captureError)
    ) {
      return false;
    }
    attemptedToken = token;
    return true;
  };
}
