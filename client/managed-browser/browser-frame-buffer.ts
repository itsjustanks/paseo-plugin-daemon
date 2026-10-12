/**
 * Owns decoded browser-frame handoff independently of transport capture cadence.
 * Two stable image slots retain the decoded front while one replacement loads;
 * one newest queued capture bounds memory without starving a slow decoder.
 * Frame IDs are opaque. A decode ticket, not capture timestamps, rejects late
 * native callbacks. Callers qualify session/generation ownership separately.
 */
import type { BrowserFrame } from "../../shared/managed-browser/browser";

export type FrameCandidate = {
  frame: BrowserFrame;
  /** Canonical CSS layout captured with these pixels, independent of capture density. */
  viewport?: { width: number; height: number };
  viewerToken: string;
  mutationEpoch: number;
  /** Held-video handoff request captured when this image RPC began. */
  fallbackRevision?: number;
};
export type FrameLayer = {
  ticket: number;
  candidate: FrameCandidate;
  source: { uri: string };
};
export type FrameBufferSnapshot = {
  layers: readonly [FrameLayer | null, FrameLayer | null];
  front: 0 | 1 | null;
  pending: 0 | 1 | null;
  queued: FrameCandidate | null;
  imageError: boolean;
};

/** Exact JPEG reuse avoids reloading an already decoded image for a fresh frame ID. */
function samePixels(a: BrowserFrame, b: BrowserFrame): boolean {
  return (
    a.mimeType === b.mimeType &&
    a.width === b.width &&
    a.height === b.height &&
    a.dataBase64 === b.dataBase64
  );
}

/**
 * Create a bounded handoff model. Use plain closures rather than a class because
 * the client is evaluated dynamically across Paseo hosts, outside Metro's normal
 * class lowering. Visible input authority is published only after React commits.
 */
export function createBrowserFrameBuffer() {
  let nextTicket = 0;
  let value: FrameBufferSnapshot = {
    layers: [null, null],
    front: null,
    pending: null,
    queued: null,
    imageError: false,
  };

  function snapshot(): FrameBufferSnapshot {
    return value;
  }

  /** Replace an obsolete pending decode without discarding the last decoded front. */
  function invalidatePending(): FrameBufferSnapshot {
    const layers: [FrameLayer | null, FrameLayer | null] = [...value.layers];
    if (value.pending !== null) {
      layers[value.pending] = null;
    }
    value = { ...value, layers, pending: null, queued: null };
    return value;
  }

  /** Clear workspace-owned pixels. Ticket numbers never reset, including across workspaces. */
  function reset(): FrameBufferSnapshot {
    value = {
      layers: [null, null],
      front: null,
      pending: null,
      queued: null,
      imageError: false,
    };
    return value;
  }

  /** Offer a qualified capture; newest queued metadata replaces earlier queued captures. */
  function offer(candidate: FrameCandidate): FrameBufferSnapshot {
    const front = value.front;
    const frontLayer = front === null ? null : value.layers[front];
    if (front !== null && frontLayer && samePixels(frontLayer.candidate.frame, candidate.frame)) {
      invalidatePending();
      const layers: [FrameLayer | null, FrameLayer | null] = [...value.layers];
      layers[front] = { ...frontLayer, candidate };
      value = { ...value, layers, imageError: false };
      return value;
    }

    if (value.pending !== null) {
      value = { ...value, queued: candidate };
      return value;
    }

    const slot = front === 0 ? 1 : 0;
    const layers: [FrameLayer | null, FrameLayer | null] = [...value.layers];
    layers[slot] = {
      ticket: ++nextTicket,
      candidate,
      source: { uri: `data:${candidate.frame.mimeType};base64,${candidate.frame.dataBase64}` },
    };
    value = { ...value, layers, pending: slot, queued: null, imageError: false };
    return value;
  }

  /**
   * Accept only this pending image's successful load. Failure or expired authority
   * never removes the front. Only a still-qualified newest queued capture is loaded.
   */
  function settle(
    ticket: number,
    succeeded: boolean,
    isCurrent: (candidate: FrameCandidate) => boolean,
  ): FrameBufferSnapshot {
    const pending = value.pending;
    const layer = pending === null ? null : value.layers[pending];
    if (pending === null || !layer || layer.ticket !== ticket) {
      return value;
    }

    const queued = value.queued;
    const accepted = succeeded && isCurrent(layer.candidate);
    const layers: [FrameLayer | null, FrameLayer | null] = [...value.layers];
    if (!accepted) {
      layers[pending] = null;
    }
    value = {
      ...value,
      layers,
      front: accepted ? pending : value.front,
      pending: null,
      queued: null,
      imageError: !succeeded && value.front === null && isCurrent(layer.candidate),
    };
    if (queued && isCurrent(queued)) {
      offer(queued);
    }
    return value;
  }
  return { snapshot, invalidatePending, reset, offer, settle };
}

export type BrowserFrameBuffer = ReturnType<typeof createBrowserFrameBuffer>;
