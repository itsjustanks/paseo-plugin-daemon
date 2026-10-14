/**
 * Single-flight encoded-video reader. RPC waits never overlap per viewer; canceled
 * replies are discarded and cannot restore input against old pixels. Only web
 * clients decode video, and only when the host enabled it; others use the image path.
 * Document/AppState suspension releases the decoder and stops reads. A bounded
 * in-flight SDK read cannot be aborted; its result is discarded before resuming.
 * Read failures get three delayed attempts, with failure cleared only by paint.
 * Exhaustion stops traffic until an explicit rate-limited viewing retry; expiry stays
 * owned by the separate viewer reattachment policy.
 */

import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { BrowserState, Viewport } from "../../shared/managed-browser/browser";
import { type BrowserVideoPacket, readBrowserVideoRpc } from "../../shared/managed-browser/browser-video";
import { createBrowserVideoDecoder } from "./browser-video-decoder";
import {
  type BrowserVideoCanvasNode,
  bindBrowserVideoVisibility,
  createBrowserVideoEnvironment,
  supportsBrowserVideo,
} from "./browser-video-surface";
import { isExpiredBrowserViewerError } from "./browser-viewer-recovery";

interface BrowserVideoOptions {
  viewerToken: string | null;
  quality: "low" | "medium" | "high";
  bitrate?: import("../../shared/managed-browser/video-settings").VideoEncoderSettings["bitrate"];
  fps?: import("../../shared/managed-browser/video-settings").VideoEncoderSettings["fps"];
  /** Explicit host panel suspension, when supplied. Unmount also stops decoding. */
  active?: boolean;
  epoch(): number;
  viewport(): Viewport | null;
  isCurrent(packet: BrowserVideoPacket, epoch: number): boolean;
  /** Display may hold a previous document, never previous viewer/source/geometry. */
  isDisplayCurrent?(packet: BrowserVideoPacket): boolean;
  acceptState(state: BrowserState): boolean;
  onPresented(packet: BrowserVideoPacket, epoch: number): void;
}

/** Admit encoded tab video only after a current frame is painted. Hidden hosts
 * revoke video input synchronously; resuming requires a new decoder/key frame. */
export function useBrowserVideo(options: BrowserVideoOptions) {
  const read = useRpc(readBrowserVideoRpc);
  const readRef = useRef(read);
  readRef.current = read;
  const pendingRead = useRef<Promise<
    import("../../shared/managed-browser/browser-video").BrowserVideoReadReply
  > | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const [node, setNode] = useState<BrowserVideoCanvasNode | null>(null);
  const videoGeneration = useRef(0);
  const authorityRevision = useRef(0);
  const displayedPacket = useRef<BrowserVideoPacket | null>(null);
  const [presentation, setPresentation] = useState<{
    packet: BrowserVideoPacket;
    epoch: number;
    viewport: Viewport | null;
    generation: number;
    authorityRevision: number;
  } | null>(null);
  const fallbackCounter = useRef(0);
  const fallbackRef = useRef(0);
  const [fallbackRevision, setFallbackRevision] = useState(0);
  const requestFallback = () => {
    if (fallbackRef.current) return;
    authorityRevision.current += 1;
    frontRef.current = null;
    fallbackRef.current = ++fallbackCounter.current;
    setFallbackRevision(fallbackRef.current);
  };
  /** Source/document/geometry validity: enough to decode and paint a packet. */
  const sourceCurrent = (packet: BrowserVideoPacket, epoch: number) =>
    latest.current.isCurrent(packet, epoch);
  /** Input eligibility: source validity plus a host receipt. A display-only packet
   * (actionable === false) may be decoded and painted but never admits a press. */
  const inputCurrent = (packet: BrowserVideoPacket, epoch: number) =>
    packet.actionable !== false && sourceCurrent(packet, epoch);
  const displayCurrent = (packet: BrowserVideoPacket) =>
    latest.current.isDisplayCurrent
      ? latest.current.isDisplayCurrent(packet)
      : latest.current.isCurrent(packet, latest.current.epoch());
  const front = presentation?.packet ?? null;
  const setFront = (value: BrowserVideoPacket | null, epoch = 0) => {
    displayedPacket.current = value;
    if (!value || inputCurrent(value, epoch)) {
      fallbackRef.current = 0;
      setFallbackRevision(0);
    }
    setPresentation(
      value
        ? {
            packet: value,
            epoch,
            viewport: latest.current.viewport(),
            generation: videoGeneration.current,
            authorityRevision: authorityRevision.current,
          }
        : null,
    );
  };
  const frontRef = useRef<BrowserVideoPacket | null>(null);
  const visible = useRef(false);
  const hostActive = useRef(false);
  const [active, setActive] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown; viewerToken: string | null } | null>(
    null,
  );
  const error = failure?.error ?? null;
  const refresh = useRef<() => void>(() => {});
  const retry = useRef<() => void>(() => {});
  const canvasRef = useCallback((value: unknown) => {
    setNode(value as BrowserVideoCanvasNode | null);
  }, []);

  useLayoutEffect(() => {
    if (
      hostActive.current &&
      presentation &&
      presentation.generation === videoGeneration.current &&
      // A mutation epoch revokes input, but the same source's last video pixels
      // remain a truthful visual hold while its next admitted frame is decoded.
      displayCurrent(presentation.packet)
    ) {
      visible.current = true;
      if (
        !fallbackRef.current &&
        presentation.authorityRevision === authorityRevision.current &&
        inputCurrent(presentation.packet, presentation.epoch)
      ) {
        frontRef.current = presentation.packet;
        latest.current.onPresented(presentation.packet, presentation.epoch);
      } else {
        frontRef.current = null;
      }
    } else {
      visible.current = false;
      frontRef.current = null;
      if (presentation) setFront(null);
    }
  }, [presentation, options.isCurrent]);

  useEffect(() => {
    // An old token's late read must never reattach the replacement viewer.
    const setError = (error: unknown) =>
      setFailure(error === null ? null : { error, viewerToken: options.viewerToken });
    frontRef.current = null;
    setFront(null);
    setError(null);
    if (!node || !options.viewerToken || !supportsBrowserVideo()) return;
    let runningCleanup: (() => void) | null = null;
    let documentActive = false;
    let applicationActive = AppState.currentState == null || AppState.currentState === "active";
    const start = () => {
      videoGeneration.current += 1;
      const target = createBrowserVideoEnvironment(node);
      if (!target) return null;
      let stopped = false;
      let readExhausted = false;
      let readRetries = 0;
      let retryWaiting = false;
      let retryNotBefore = 0;
      let explicitRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let lastPaintedAt = Date.now();
      let lastQuietReadAt = 0;
      let streamId: string | null = null;
      let sequence = 0;
      let keyRequested = true;
      let wake: (() => void) | null = null;
      const decoder = createBrowserVideoDecoder({
        environment: target.environment,
        isCurrent: (packet, epoch) => !stopped && latest.current.isCurrent(packet, epoch),
        // Same source/document packets preserve the codec's dependency chain,
        // including a reply that began before a local press. They carry that old
        // read epoch through paint and cannot authorize another press. A display-only
        // (non-actionable) packet is still source-valid and must keep decoding.
        isSourceCurrent: (packet) => !stopped && sourceCurrent(packet, latest.current.epoch()),
        onPresented(packet, epoch) {
          if (stopped) return;
          lastPaintedAt = Date.now();
          readRetries = 0;
          setError(null);
          // Once this canvas is visible, its pixels change before React commits.
          // Publish authority synchronously with that draw, never the old front.
          if (visible.current && inputCurrent(packet, epoch)) {
            frontRef.current = packet;
            latest.current.onPresented(packet, epoch);
          } else {
            frontRef.current = null;
          }
          setFront(packet, epoch);
        },
        onNeedKeyFrame() {
          keyRequested = true;
        },
        onError(failure) {
          if (stopped) return;
          stopped = true;
          frontRef.current = null;
          setFront(null);
          setError(failure);
          wake?.();
        },
      });
      const watchdog = setInterval(() => {
        if (Date.now() - Math.max(lastPaintedAt, lastQuietReadAt) <= 2500 || !visible.current)
          return;
        // Request a new image, but hold the already painted canvas until that
        // exact request is decoded. Display retention grants no input receipt.
        if (!fallbackRef.current) {
          requestFallback();
          decoder.reset();
          sequence = 0;
          streamId = null;
          keyRequested = true;
        }
      }, 500);
      const pause = (milliseconds: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, milliseconds);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      refresh.current = () => {
        // Refresh cannot bypass backoff or rearm an exhausted reader
        // just because another input finished.
        if (retryWaiting || readExhausted) return;
        // Input settlement wakes viewing without forcing another keyframe.
        // Source changes, chain gaps, resets and watchdog recovery request keys.
        wake?.();
      };
      const retryFailedReader = () => {
        if (stopped) return;
        // Reserved for explicit viewing recovery, such as successful navigation.
        // Expired viewers and decoder failures do not acquire a new read budget.
        if (!readExhausted) {
          refresh.current();
          return;
        }
        if (retryWaiting || explicitRetryTimer !== null) return;
        const remaining = retryNotBefore - Date.now();
        if (remaining > 0) {
          // Preserve one successful-navigation retry intent through cooldown.
          // This timer belongs to this exact viewer/visibility incarnation.
          explicitRetryTimer = setTimeout(() => {
            explicitRetryTimer = null;
            retryFailedReader();
          }, remaining);
          return;
        }
        runningCleanup?.();
        runningCleanup = null;
        synchronize();
      };
      retry.current = retryFailedReader;
      /** Recovery applies only to reads, never native input or decoder errors.
       * A successful empty reply does not replenish the budget: fresh paint does. */
      const recoverRead = async (failure: unknown): Promise<boolean> => {
        if (stopped || isExpiredBrowserViewerError(failure)) return false;
        visible.current = false;
        frontRef.current = null;
        setFront(null);
        setError(failure);
        decoder.reset();
        sequence = 0;
        streamId = null;
        keyRequested = true;
        const delay = [500, 1500, 3000][readRetries];
        if (delay === undefined) {
          readExhausted = true;
          retryNotBefore = Date.now() + 3000;
          return false;
        }
        readRetries += 1;
        retryWaiting = true;
        try {
          await pause(delay);
        } finally {
          retryWaiting = false;
        }
        return !stopped;
      };
      const pump = async () => {
        try {
          while (!stopped) {
            // Quality/viewer replacement waits for the old bounded RPC. The SDK
            // cannot abort it; overlapping requests would violate server admission.
            if (pendingRead.current) await pendingRead.current.catch(() => undefined);
            if (stopped) break;
            const epoch = latest.current.epoch();
            const requestKeyFrame = keyRequested;
            keyRequested = false;
            const request = readRef.current({
              viewerToken: options.viewerToken!,
              quality: options.quality,
              ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
              ...(options.fps === undefined ? {} : { fps: options.fps }),
              streamId,
              afterSequence: sequence,
              waitMs: 250,
              requestKeyFrame,
            });
            pendingRead.current = request;
            let reply: import("../../shared/managed-browser/browser-video").BrowserVideoReadReply;
            try {
              reply = await request;
            } catch (failure) {
              if (pendingRead.current === request) pendingRead.current = null;
              if (await recoverRead(failure)) continue;
              throw failure;
            } finally {
              if (pendingRead.current === request) pendingRead.current = null;
            }
            if (stopped) break;
            if (!latest.current.acceptState(reply.state)) continue;
            // An unchanged tab may produce no native frames. Only a healthy
            // same-stream read with every received packet already painted can
            // renew the quiet-picture hold. Reset, stale authority and a stuck
            // decoder still fall through to the ordinary stall watchdog.
            // Input revocation removes frontRef, but leaves these pixels visible.
            // Liveness may retain them without restoring their input authority.
            const painted = displayedPacket.current;
            if (
              reply.status === "waiting" &&
              painted &&
              reply.streamId === painted.streamId &&
              painted.sequence === sequence &&
              latest.current.isCurrent(painted, epoch)
            ) {
              lastQuietReadAt = Date.now();
            }
            if (reply.status === "unsupported") {
              if (reply.reasonCode === "video-disabled") {
                // Host policy, not a failure: stop reading, release the decoder and
                // canvas, and leave presentation to the ordinary image path.
                stopped = true;
                clearInterval(watchdog);
                visible.current = false;
                frontRef.current = null;
                setFront(null);
                target.dispose();
                break;
              }
              if (reply.reasonCode === "encoder-capacity") {
                // Capacity is a typed, viewing-only soft failure. Keep JPEG
                // fallback visible while old idle cohorts can release their slot.
                visible.current = false;
                frontRef.current = null;
                setFront(null);
                setError(new Error(reply.reason ?? "Video profiles are busy"));
                decoder.reset();
                sequence = 0;
                streamId = null;
                keyRequested = true;
                await pause(2500);
                continue;
              }
              const failure = new Error(reply.reason ?? "Browser video is unavailable");
              if (await recoverRead(failure)) continue;
              throw failure;
            }
            if (reply.status === "reset" && reply.packets.length === 0) {
              // A reset revokes input receipts immediately, including a paint
              // already queued for React commit. Display ownership is separate.
              authorityRevision.current += 1;
              frontRef.current = null;
              const displayed = displayedPacket.current;
              if (!displayed || !displayCurrent(displayed)) {
                visible.current = false;
                setFront(null);
              }
              // Retain same-cohort pixels until fresh paint or the existing stall
              // watchdog. Old JPEG underneath must not become input authority.
              decoder.reset();
              sequence = 0;
              streamId = null;
              keyRequested = true;
            } else {
              streamId = reply.streamId;
              for (const packet of reply.packets) {
                sequence = packet.sequence;
                if (!decoder.receive(packet, epoch)) keyRequested = true;
              }
            }
            // An unchanged tab can produce no native frames. Bound
            // empty/recovery polling and yield even when a reply is already buffered.
            await pause(reply.packets.length ? 0 : 40);
          }
        } catch (failure) {
          if (!stopped) {
            frontRef.current = null;
            setFront(null);
            setError(failure);
          }
        } finally {
          decoder.close();
        }
      };
      void pump();
      return () => {
        stopped = true;
        videoGeneration.current += 1;
        clearInterval(watchdog);
        if (explicitRetryTimer !== null) clearTimeout(explicitRetryTimer);
        explicitRetryTimer = null;
        visible.current = false;
        wake?.();
        decoder.close();
        target.dispose();
        refresh.current = () => {};
        retry.current = () => {};
        frontRef.current = null;
        setFront(null);
      };
    };
    const synchronize = () => {
      const active = documentActive && applicationActive && options.active !== false;
      hostActive.current = active;
      setActive(active);
      if (!active) {
        // Revoke pixels synchronously with real host suspension. Any uncancelable
        // bounded SDK read is discarded, and cannot overlap the next incarnation.
        runningCleanup?.();
        runningCleanup = null;
        visible.current = false;
        frontRef.current = null;
        setFront(null);
      } else if (!runningCleanup) {
        // A resumed decoder has no inherited stream/sequence and requests a key
        // frame. The existing epoch/frame checks still decide input authority.
        runningCleanup = start();
      }
    };
    const unbind = bindBrowserVideoVisibility(node, (active) => {
      documentActive = active;
      synchronize();
    });
    const subscription = AppState.addEventListener("change", (state) => {
      applicationActive = state === "active";
      synchronize();
    });
    return () => {
      hostActive.current = false;
      unbind();
      subscription.remove();
      runningCleanup?.();
      runningCleanup = null;
    };
  }, [node, options.viewerToken, options.quality, options.active, options.bitrate, options.fps]);

  return {
    active,
    canvasRef,
    front,
    frontViewport: presentation?.viewport ?? null,
    frontRef,
    fallbackRevision,
    /** Retire the held canvas only after the corresponding fallback painted. */
    completeFallback: (revision: number) => {
      if (revision && revision === fallbackRef.current) {
        visible.current = false;
        frontRef.current = null;
        setFront(null);
      }
    },
    error,
    errorViewerToken: failure?.viewerToken ?? null,
    refresh: () => refresh.current(),
    /** Explicit viewing retry; ordinary input/image refresh never rearms exhaustion. */
    retry: () => retry.current(),
    supported: supportsBrowserVideo(),
  };
}
