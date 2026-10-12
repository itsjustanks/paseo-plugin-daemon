/** Density writes reuse controller snapshots and mutation settlement without preset substitution.
 * The latest callback authority is checked before publication, and pending writes
 * are never retried. A settings change preserves page/CSS/mode at the server seam.
 */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  type BrowserState,
  type CaptureDensity,
  canUseCaptureDensity,
  type setCaptureDensityRpc,
} from "../../shared/managed-browser/browser";

type Request = ReturnType<typeof setCaptureDensityRpc.input.parse>;
interface Options {
  identity: string;
  current(): {
    state: BrowserState;
    context: Omit<Request, "density">;
  } | null;
  change(input: Request): Promise<{ state: BrowserState }>;
  beforeChange(): void;
  onSuccess(state: BrowserState): void;
  onError(error: unknown): void;
}

/** Retained menu callbacks recheck the current controller and actual CSS size before sending. */
export function useBrowserCaptureDensity(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = (request: { input: Request; identity: string }) => {
    const current = latest.current.current();
    return (
      mounted.current &&
      request.identity === latest.current.identity &&
      current !== null &&
      current.state.controller === "self" &&
      current.context.viewerToken === request.input.viewerToken &&
      current.context.controlToken === request.input.controlToken &&
      current.context.expected.sessionId === request.input.expected.sessionId &&
      current.context.expected.runtimeId === request.input.expected.runtimeId &&
      current.context.expected.bridgeEpoch === request.input.expected.bridgeEpoch
    );
  };
  const mutation = useMutation({
    mutationFn: (request: { input: Request; identity: string }) => options.change(request.input),
    retry: false,
    onSuccess: (result, request) => {
      if (isCurrent(request)) latest.current.onSuccess(result.state);
    },
    onError: (error, request) => {
      if (isCurrent(request)) latest.current.onError(error);
    },
    onSettled: () => {
      active.current = false;
    },
  });
  return {
    pending: mutation.isPending,
    select(density: CaptureDensity) {
      const current = latest.current.current();
      if (
        !mounted.current ||
        latest.current.identity !== options.identity ||
        active.current ||
        !current ||
        current.state.controller !== "self" ||
        current.state.status !== "ready" ||
        !canUseCaptureDensity(current.state.viewport, density) ||
        current.state.captureScale === density
      ) {
        return;
      }
      active.current = true;
      latest.current.beforeChange();
      mutation.mutate({ input: { ...current.context, density }, identity: options.identity });
    },
  };
}
