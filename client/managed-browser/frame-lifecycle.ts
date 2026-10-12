import type { BrowserFrameAuthority as BrowserFrame } from "../../shared/managed-browser/browser-video";

/**
 * Tracks actionable captures across discrete input settlement. The decoded
 * image remains visible while admission waits for a capture begun after settle.
 * A factory keeps this upstream policy compatible with Paseo's mobile Hermes
 * compiler, which rejects the emitted class declaration in client bundles.
 */
export function createFrameLifecycle() {
  let epoch = 0;
  let frame: BrowserFrame | null = null;
  let visible: BrowserFrame | null = null;
  let gate: "idle" | "pending" | "refreshing" = "idle";

  const bump = () => {
    epoch += 1;
  };
  const drop = () => {
    frame = null;
    visible = null;
  };

  return {
    get epoch() {
      return epoch;
    },
    get frame() {
      return frame;
    },
    get visible() {
      return visible;
    },
    get busy() {
      return gate !== "idle";
    },
    bump,
    isCurrent(captureEpoch: number) {
      return captureEpoch === epoch;
    },
    /** Blocks further discrete input until settlement and a fresh decoded frame. */
    begin() {
      if (gate !== "idle") return false;
      gate = "pending";
      frame = null;
      bump();
      return true;
    },
    /** Advances even on failure; an uncertain action is never replayed. */
    settle() {
      frame = null;
      bump();
      gate = "refreshing";
    },
    /** A capture begun before settlement cannot restore admission. */
    accept(captureEpoch: number, captured: BrowserFrame) {
      if (captureEpoch !== epoch) return false;
      frame = captured;
      visible = captured;
      if (gate === "refreshing") gate = "idle";
      return true;
    },
    drop,
    reset() {
      drop();
      gate = "idle";
    },
  };
}
