/**
 * Own the viewer's JPEG query and refresh scheduling. A current painted video
 * front owns presentation and viewer renewal, so image polling, focus and input
 * refresh cannot create redundant screenshots. Clearing video resumes the same
 * image fallback query; already-published bounded RPCs are never replayed.
 */
import type { RpcInput } from "@getpaseo/plugin";
import { CancelledError, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { BrowserFrame, captureBrowserRpc } from "../../shared/managed-browser/browser";
import type { CaptureQuality } from "../../shared/managed-browser/capture-settings";
import { browserCaptureInterval } from "./browser-capture-cadence";

interface ImageCaptureOptions {
  /** Hidden retained panels keep state but publish no new media requests. */
  active?: boolean;
  viewerToken: string | null;
  quality: CaptureQuality;
  activeInput: boolean;
  /** Exact held-video fallback request, zero during normal image playback. */
  fallbackRevision?: number;
  videoOwnsPresentation: boolean;
  /** Read actual current video authority at request/follow-up time, before React commits. */
  hasVideoPresentation(): boolean;
  refreshVideo(): void;
  mutationEpoch(): number;
  knownFrame(): BrowserFrame | null;
  capture(
    input: RpcInput<typeof captureBrowserRpc>,
  ): Promise<ReturnType<typeof captureBrowserRpc.output.parse>>;
}

/** Preserve captured query identity/epoch and the existing single-flight fallback refresh. */
export function useBrowserImageCapture(options: ImageCaptureOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const failures = useRef({ viewerToken: options.viewerToken, quality: options.quality, count: 0 });
  if (failures.current.viewerToken !== options.viewerToken || failures.current.quality !== options.quality) {
    failures.current = { viewerToken: options.viewerToken, quality: options.quality, count: 0 };
  }
  // Each query keeps its own counter: a late reply from an old viewer cannot
  // stop a newly attached viewer. Explicit refresh remains available when stopped.
  const captureFailures = failures.current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const query = useQuery({
    queryKey: ["hosts-browser", "capture", options.viewerToken, options.quality],
    queryFn: async () => {
      if (!options.viewerToken) throw new Error("The browser viewer is not attached.");
      // A timer already queued before video paint must not publish a JPEG RPC.
      if (
        !mounted.current ||
        latest.current.active === false ||
        latest.current.viewerToken !== options.viewerToken ||
        latest.current.quality !== options.quality ||
        latest.current.videoOwnsPresentation ||
        latest.current.hasVideoPresentation()
      ) {
        throw new CancelledError({ silent: true, revert: true });
      }
      const mutationEpoch = options.mutationEpoch();
      const fallbackRevision = latest.current.fallbackRevision ?? 0;
      inFlight.current = true;
      try {
        const result = await options.capture({
          viewerToken: options.viewerToken,
          quality: options.quality,
          // A held-video handoff needs an actual image payload, even when the
          // underlying JPEG still matches the server's incremental cache.
          knownFrameId: fallbackRevision ? null : (options.knownFrame()?.frameId ?? null),
        });
        captureFailures.count = 0;
        return {
          ...result,
          mutationEpoch,
          fallbackRevision,
          viewerToken: options.viewerToken,
          captureQuality: options.quality,
        };
      } catch (error) {
        if (!(error instanceof CancelledError)) captureFailures.count += 1;
        throw error;
      } finally {
        inFlight.current = false;
      }
    },
    enabled: () =>
      options.active !== false &&
      Boolean(options.viewerToken) &&
      captureFailures.count < 2 &&
      !options.videoOwnsPresentation &&
      !options.hasVideoPresentation(),
    retry: false,
    refetchInterval: (query) =>
      options.active === false || options.videoOwnsPresentation || captureFailures.count >= 2
        ? false
        : browserCaptureInterval(query.state.data?.state.status, options.activeInput),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: () => !options.videoOwnsPresentation && captureFailures.count < 2,
    refetchOnReconnect: () => !options.videoOwnsPresentation && captureFailures.count < 2,
    staleTime: 0,
  });

  const refreshCapture = useCallback(() => {
    const current = latest.current;
    if (!mounted.current || current.active === false) return;
    current.refreshVideo();
    if (!current.viewerToken || current.videoOwnsPresentation || current.hasVideoPresentation())
      return;
    const requestWasInFlight = inFlight.current;
    const viewerToken = current.viewerToken;
    const quality = current.quality;
    const request = query.refetch({ cancelRefetch: false });
    if (requestWasInFlight) {
      void request.then(() => {
        const after = latest.current;
        if (
          !mounted.current ||
          after.active === false ||
          after.viewerToken !== viewerToken ||
          after.quality !== quality ||
          after.videoOwnsPresentation ||
          after.hasVideoPresentation()
        )
          return;
        void query.refetch({ cancelRefetch: false });
      });
    }
  }, [query.refetch]);

  const retryFrameCapture = useCallback(() => {
    const current = latest.current;
    if (
      mounted.current &&
      current.active !== false &&
      current.viewerToken &&
      !current.videoOwnsPresentation &&
      !current.hasVideoPresentation()
    ) {
      void query.refetch({ cancelRefetch: false });
    }
  }, [query.refetch]);

  return { query, refreshCapture, retryFrameCapture };
}
