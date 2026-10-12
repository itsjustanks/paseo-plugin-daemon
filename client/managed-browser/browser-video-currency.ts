/** Source, document and geometry validity of a viewer frame, shared by the panel and its tests. */
import type { BrowserState } from "../../shared/managed-browser/browser";
import type { BrowserFrameAuthority, BrowserVideoPacket } from "../../shared/managed-browser/browser-video";

export function isFrameCurrent(frame: BrowserFrameAuthority, state: BrowserState): boolean {
  return (
    frame.sessionId === state.sessionId &&
    (!frame.runtimeId || !state.runtimeId || frame.runtimeId === state.runtimeId) &&
    (frame.captureEpoch === undefined ||
      state.bridgeEpoch === undefined ||
      frame.captureEpoch === state.bridgeEpoch) &&
    frame.navigationGeneration === state.navigationGeneration &&
    frame.viewportGeneration === state.viewportGeneration
  );
}

export interface VideoSourceContext {
  mounted: boolean;
  viewerActive: boolean;
  epoch: number;
  committedViewport: { sessionId: string; generation: number } | null;
  state: BrowserState | null;
}

/**
 * Whether a packet may be decoded and painted. This is source validity only: a
 * display-only packet (actionable === false) is still a link in the codec's delta
 * chain, so the input-only flag must never be consulted here. Input admission is
 * the video hook's separate inputCurrent guard.
 */
export function isVideoSourceCurrent(
  context: VideoSourceContext,
  packet: BrowserVideoPacket,
  epoch: number,
): boolean {
  return (
    context.mounted &&
    context.viewerActive &&
    epoch === context.epoch &&
    context.committedViewport?.sessionId === packet.frame.sessionId &&
    context.committedViewport?.generation === packet.frame.viewportGeneration &&
    context.state !== null &&
    isFrameCurrent(packet.frame, context.state)
  );
}
