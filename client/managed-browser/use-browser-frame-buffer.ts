/**
 * Connects native Image decode callbacks to the bounded handoff model. The
 * visible-frame ref is changed in a layout effect, after the image-layer commit,
 * so transport metadata cannot authorize input against pixels not yet displayed.
 */
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";
import type { BrowserFrame } from "../../shared/managed-browser/browser";
import { createBrowserFrameBuffer, type FrameCandidate } from "./browser-frame-buffer";

/** Bind qualified captures and native callbacks to committed visible input authority. */
export function useBrowserFrameBuffer(
  visibleFrameRef: RefObject<BrowserFrame | null>,
  isCurrent: (candidate: FrameCandidate) => boolean,
) {
  const [model] = useState(createBrowserFrameBuffer);
  const [buffer, setBuffer] = useState(model.snapshot);
  const frame =
    buffer.front === null ? null : (buffer.layers[buffer.front]?.candidate.frame ?? null);

  useLayoutEffect(() => {
    visibleFrameRef.current = frame;
    return () => {
      visibleFrameRef.current = null;
    };
  }, [frame, visibleFrameRef]);

  const discardObsoletePending = useCallback(() => {
    const current = model.snapshot();
    const pending = current.pending === null ? null : current.layers[current.pending];
    if (pending && !isCurrent(pending.candidate)) {
      setBuffer(model.invalidatePending());
    }
  }, [isCurrent, model]);
  const reset = useCallback(() => {
    visibleFrameRef.current = null;
    setBuffer(model.reset());
  }, [model, visibleFrameRef]);
  const receive = useCallback(
    (candidate: FrameCandidate) => {
      if (!isCurrent(candidate)) {
        return;
      }
      const current = model.snapshot();
      const pending = current.pending === null ? null : current.layers[current.pending];
      if (pending && !isCurrent(pending.candidate)) {
        model.invalidatePending();
      }
      setBuffer(model.offer(candidate));
    },
    [isCurrent, model],
  );
  const settled = useCallback(
    (ticket: number, succeeded: boolean) => {
      const current = model.snapshot();
      const pending = current.pending === null ? null : current.layers[current.pending];
      if (!pending || pending.ticket !== ticket || !isCurrent(pending.candidate)) {
        return false;
      }
      setBuffer(model.settle(ticket, succeeded, isCurrent));
      return true;
    },
    [isCurrent, model],
  );

  return { buffer, frame, receive, settled, discardObsoletePending, reset };
}
