/** Identity fence for a control request made from a specific visible page. */
import type { BrowserState } from "../../shared/managed-browser/browser";

export interface ControlRequestBasis {
  panelScope: string;
  viewerToken: string;
  tabId: string | null;
  sessionId: string;
  navigationGeneration: number;
  viewportGeneration: number;
  controllerRevision: number;
}

export interface ControlRequest {
  label: string;
  basis: ControlRequestBasis;
  needsFrame: boolean;
  run(): void;
}

/** Capture the page and ownership observation before showing a takeover dialog. */
export function controlRequestBasis(
  panelScope: string,
  viewerToken: string,
  state: BrowserState,
  controllerRevision: number,
): ControlRequestBasis {
  return {
    panelScope,
    viewerToken,
    tabId: state.tabId ?? null,
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
    controllerRevision,
  };
}

/** Reject a queued action if its viewer, tab, page, or controller observation changed. */
export function isControlRequestCurrent(
  basis: ControlRequestBasis,
  panelScope: string,
  viewerToken: string | null,
  state: BrowserState | null,
  controllerRevision: number,
): boolean {
  return Boolean(
    state &&
      basis.panelScope === panelScope &&
      basis.viewerToken === viewerToken &&
      basis.tabId === (state.tabId ?? null) &&
      basis.sessionId === state.sessionId &&
      basis.navigationGeneration === state.navigationGeneration &&
      basis.viewportGeneration === state.viewportGeneration &&
      basis.controllerRevision === controllerRevision,
  );
}
