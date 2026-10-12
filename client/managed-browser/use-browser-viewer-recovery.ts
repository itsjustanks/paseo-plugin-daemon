/** Attach viewing only after the current viewing token expires; never replay control or input. */
import { useEffect, useState } from "react";
import {
  type BrowserViewerRecoveryObservation,
  createBrowserViewerRecovery,
} from "./browser-viewer-recovery";

interface ViewerRecoveryOptions extends BrowserViewerRecoveryObservation {
  reconnect(): void;
}

/** Bounded recovery follows the existing manual Reconnect path and its lifecycle fences. */
export function useBrowserViewerRecovery(options: ViewerRecoveryOptions): void {
  const [claim] = useState(createBrowserViewerRecovery);
  useEffect(() => {
    if (claim(options)) options.reconnect();
  }, [
    claim,
    options.identity,
    options.viewerToken,
    options.failedViewerToken,
    options.captureError,
    options.pending,
    options.reconnect,
  ]);
}
