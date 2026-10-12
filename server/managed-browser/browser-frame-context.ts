/** Matches issued pixels to their exact browser attachment and display generations. */
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";

/** Pixel equality alone cannot authorize a different document, runtime or viewport. */
export function frameMatchesBrowserContext(
  frame: Pick<
    BrowserFrame,
    "sessionId" | "runtimeId" | "captureEpoch" | "navigationGeneration" | "viewportGeneration"
  >,
  state: Pick<
    BrowserState,
    "sessionId" | "runtimeId" | "bridgeEpoch" | "navigationGeneration" | "viewportGeneration"
  >,
): boolean {
  return (
    frame.sessionId === state.sessionId &&
    frame.runtimeId === state.runtimeId &&
    frame.captureEpoch === state.bridgeEpoch &&
    frame.navigationGeneration === state.navigationGeneration &&
    frame.viewportGeneration === state.viewportGeneration
  );
}
