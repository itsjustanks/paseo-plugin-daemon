/**
 * One live input queue per mounted canvas, shared by native responders and real
 * web listeners. Ownership changes cancel old channels; decode-only frame updates
 * do not. Empty channels close after four seconds; their acknowledged geometry
 * can reopen only within the same control/document/layout. Cursor replies are
 * consumed only by the queue incarnation that sent
 * them. The existing capture polling keeps playback running during a drag.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AppState,
  type GestureResponderEvent,
  PanResponder,
  Platform,
  type View,
} from "react-native";
import type { BrowserCursor, BrowserState } from "../../shared/managed-browser/browser";
import { createBrowserCanvasInput } from "./browser-canvas-input";
import type { CanvasKeyboardEvent } from "./browser-canvas-keyboard";
import { bindBrowserCanvasKeyboard, type KeyboardCanvasNode } from "./browser-canvas-keyboard-web";
import {
  BROWSER_INPUT_IDLE_MS,
  type BrowserGestureAuthority,
  type BrowserGesturePoint,
  type BrowserGestureTransport,
  type BrowserTouchPoint,
  createBrowserInputQueue,
} from "./browser-input-queue";
import { type BrowserCanvasNode, bindBrowserCanvasWeb, setBrowserCanvasCursor } from "./web";

interface CanvasOptions {
  authority(): BrowserGestureAuthority | null;
  controlAuthority?(): import("./browser-input-queue").BrowserGestureControl | null;
  transport: BrowserGestureTransport;
  /** Control/session/generations/viewport/display rectangle, excluding frameId. */
  ownershipKey: string;
  /** Actual input-admitted paint publication, separate from the visually displayed frame. */
  decodedFrameId: string | null;
  enabled: boolean;
  displaySize: { width: number; height: number } | null;
  viewport: { width: number; height: number } | null;
  onState(state: BrowserState): void;
  onError(error: unknown): void;
  onFinish(): void;
  onPoint(point: BrowserGesturePoint): void;
  onActivity(active: boolean): void;
  onInputBoundary(): void;
  /** The host acknowledged an input that revoked every earlier frame receipt. */
  onInputAcknowledged?(): void;
}

/** Native touch coordinates are relative to the controlled overlay, with stable ID mapping. */
function nativePoints(
  event: GestureResponderEvent,
  size: CanvasOptions["displaySize"],
  ids: Map<string, number>,
): BrowserTouchPoint[] {
  if (!size || size.width <= 0 || size.height <= 0) return [];
  return event.nativeEvent.touches.map((touch) => {
    let id = ids.get(touch.identifier);
    if (id === undefined) {
      id = ids.size;
      ids.set(touch.identifier, id);
    }
    return {
      id,
      x: Math.max(0, Math.min(size.width, touch.locationX)),
      y: Math.max(0, Math.min(size.height, touch.locationY)),
      width: size.width,
      height: size.height,
    };
  });
}

/** Attach the same authority-preserving input model to native View or web host events. */
export function useBrowserCanvasInput(options: CanvasOptions) {
  const current = useRef(options);
  current.current = options;
  const nodeRef = useRef<unknown>(null);
  const [node, setNode] = useState<unknown>(null);
  const alive = useRef(true);
  const inputModel = useRef<ReturnType<typeof createBrowserCanvasInput> | null>(null);
  const keyboard = useRef<ReturnType<typeof bindBrowserCanvasKeyboard> | null>(null);
  const cursorVisible = useRef(false);
  const frameWaiters = useRef(
    new Set<{
      afterFrameId: string;
      resolve(): void;
      reject(error: Error): void;
    }>(),
  );
  const rejectFrameWaiters = () => {
    for (const waiter of frameWaiters.current)
      waiter.reject(new Error("Browser input context changed."));
    frameWaiters.current.clear();
  };
  const [queue] = useState(() =>
    createBrowserInputQueue({
      transport: {
        begin: (input) => current.current.transport.begin(input),
        update: (input) => current.current.transport.update(input),
        end: (input) => current.current.transport.end(input),
      },
      authority: () => (alive.current ? current.current.authority() : null),
      controlAuthority: () => {
        if (!alive.current) return null;
        if (current.current.controlAuthority) return current.current.controlAuthority();
        return current.current.authority();
      },
      onState: (state) => {
        if (alive.current) current.current.onState(state);
      },
      onCursor: (cursor: BrowserCursor | null) => {
        if (cursorVisible.current) setBrowserCanvasCursor(nodeRef.current, cursor);
      },
      onError: (error) => {
        // Queue owns cleanup; reset local contacts without recursively cancelling.
        inputModel.current?.reset();
        keyboard.current?.reset();
        cursorVisible.current = false;
        setBrowserCanvasCursor(nodeRef.current, null);
        clearIdle();
        if (alive.current) current.current.onError(error);
      },
      onAcknowledged: () => {
        if (alive.current) current.current.onInputAcknowledged?.();
      },
      onNavigationComplete: () => {
        // Server already closed the acknowledged channel. Quarantine local
        // holds before state projection; never replay their old-page release.
        inputModel.current?.reset();
        keyboard.current?.reset();
        cursorVisible.current = false;
        setBrowserCanvasCursor(nodeRef.current, null);
        clearIdle();
        rejectFrameWaiters();
      },
      onFinish: () => {
        if (alive.current) current.current.onFinish();
      },
      waitForFrame(afterFrameId, maxWaitMs = 4_000) {
        return new Promise<void>((resolve, reject) => {
          const waiter = {
            afterFrameId,
            resolve: () => {
              clearTimeout(timeout);
              frameWaiters.current.delete(waiter);
              resolve();
            },
            reject: (error: Error) => {
              clearTimeout(timeout);
              frameWaiters.current.delete(waiter);
              reject(error);
            },
          };
          // The existing server gesture idle bound is five seconds. Stop an unsent
          // press before it expires; time alone never authorizes new image pixels.
          const timeout = setTimeout(
            () =>
              waiter.reject(
                new Error(
                  "Waiting for a current decoded frame. Release the gesture and try again.",
                ),
              ),
            Math.min(4_000, maxWaitMs),
          );
          frameWaiters.current.add(waiter);
        });
      },
    }),
  );
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  };
  const [input] = useState(() =>
    createBrowserCanvasInput({
      enabled: () => alive.current && current.current.enabled,
      viewport: () => current.current.viewport,
      enqueue(event) {
        clearIdle();
        // Queue snapshots the actual decoded admission before a local epoch bump.
        // Already admitted edges continue on their opaque channel independently.
        const accepted = queue.enqueue(event);
        if (
          accepted &&
          (event.kind === "down" || (event.kind === "touch" && event.type === "start"))
        ) {
          current.current.onInputBoundary();
        }
        if (event.kind === "move" || event.kind === "scroll") {
          idleTimer.current = setTimeout(() => {
            // Never end a slow held drag just because the user stopped moving.
            if (!input.isHoldingMouse()) {
              current.current.onActivity(false);
              queue.finish();
            }
          }, BROWSER_INPUT_IDLE_MS);
        }
        return accepted;
      },
      finish: () => {
        clearIdle();
        // Release was enqueued immediately. Keep the empty exact channel for
        // ordinary repeat input, closing before the server's five-second idle bound.
        idleTimer.current = setTimeout(() => queue.finish(), BROWSER_INPUT_IDLE_MS);
      },
      cancel: () => {
        clearIdle();
        keyboard.current?.reset();
        cursorVisible.current = false;
        setBrowserCanvasCursor(nodeRef.current, null);
        queue.cancel();
        rejectFrameWaiters();
      },
      onPoint: (point) => current.current.onPoint(point),
      onActivity: (active) => {
        if (alive.current) current.current.onActivity(active);
      },
    }),
  );

  inputModel.current = input;

  const enqueueKeyboard = useCallback(
    (event: CanvasKeyboardEvent) => {
      clearIdle();
      const accepted = queue.enqueue(event);
      if (accepted) {
        if (event.kind === "text" || (event.type === "down" && !event.repeat)) {
          current.current.onInputBoundary();
        }
        current.current.onActivity(true);
      }
      return accepted;
    },
    [queue],
  );
  const finishKeyboard = useCallback(() => {
    current.current.onActivity(false);
    // Keep one channel through ordinary inter-key gaps. New typing clears this
    // timer, while blur/control loss cancels immediately through the input model.
    clearIdle();
    idleTimer.current = setTimeout(() => queue.finish(), BROWSER_INPUT_IDLE_MS);
  }, [queue]);
  /** Insert an explicitly committed draft once; false means nothing was admitted. */
  const composeText = useCallback(
    (text: string): boolean => {
      if (!alive.current || !current.current.enabled || !text) return false;
      if (text.length > 16_000) {
        current.current.onError(
          new Error("Text is too long. Send up to 16,000 characters at once."),
        );
        return false;
      }
      const accepted = enqueueKeyboard({ kind: "text", text });
      if (accepted) finishKeyboard();
      return accepted;
    },
    [enqueueKeyboard, finishKeyboard],
  );

  const previousOwnership = useRef(options.ownershipKey);
  useLayoutEffect(() => {
    if (previousOwnership.current === options.ownershipKey) return;
    previousOwnership.current = options.ownershipKey;
    input.cancel();
  }, [input, options.ownershipKey]);
  useLayoutEffect(() => {
    for (const waiter of frameWaiters.current) {
      const admitted = current.current.authority();
      if (
        options.decodedFrameId &&
        admitted?.target.frameId === options.decodedFrameId &&
        options.decodedFrameId !== waiter.afterFrameId
      ) {
        waiter.resolve();
      }
    }
  }, [options.decodedFrameId]);
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") input.cancel();
    });
    return () => {
      alive.current = false;
      input.cancel();
      subscription.remove();
    };
  }, [input]);
  useEffect(() => {
    if (Platform.OS !== "web" || !node || typeof node !== "object" || !("addEventListener" in node))
      return;
    return bindBrowserCanvasWeb(
      node as BrowserCanvasNode,
      input,
      () => alive.current && current.current.enabled,
      (visible) => {
        cursorVisible.current = visible;
        if (!visible) setBrowserCanvasCursor(nodeRef.current, null);
      },
    );
  }, [input, node]);

  useEffect(() => {
    if (Platform.OS !== "web" || !node || typeof node !== "object" || !("ownerDocument" in node))
      return;
    const binding = bindBrowserCanvasKeyboard(node as KeyboardCanvasNode, {
      enabled: () => alive.current && current.current.enabled,
      enqueue: enqueueKeyboard,
      finish: finishKeyboard,
      cancel: input.cancel,
      onError: (error) => {
        if (alive.current) current.current.onError(error);
      },
    });
    keyboard.current = binding;
    return () => {
      binding.dispose();
      if (keyboard.current === binding) keyboard.current = null;
    };
  }, [input, node, enqueueKeyboard, finishKeyboard]);

  const ids = useRef(new Map<string, number>());
  const [panResponder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: (event) => {
        if (Platform.OS === "web" || !current.current.enabled) return false;
        // A newly granted responder must contain only genuinely new contacts.
        // A second finger cannot import a first contact that began observe-only.
        const changed = new Set(
          (event.nativeEvent.changedTouches ?? []).map((touch) => touch.identifier),
        );
        return (
          event.nativeEvent.touches.length > 0 &&
          event.nativeEvent.touches.every((touch) => changed.has(touch.identifier))
        );
      },
      // Moving a contact after lease acquisition is not a fresh start edge.
      onMoveShouldSetPanResponder: () => false,
      onPanResponderGrant: (event) => {
        ids.current.clear();
        input.touch("start", nativePoints(event, current.current.displaySize, ids.current));
      },
      onPanResponderStart: (event) =>
        input.touch("start", nativePoints(event, current.current.displaySize, ids.current)),
      onPanResponderMove: (event) =>
        input.touch("move", nativePoints(event, current.current.displaySize, ids.current)),
      onPanResponderEnd: (event) =>
        input.touch("end", nativePoints(event, current.current.displaySize, ids.current)),
      onPanResponderRelease: () => {
        input.touch("end", []);
        ids.current.clear();
      },
      onPanResponderTerminate: () => {
        input.touch("cancel", []);
        ids.current.clear();
      },
      onPanResponderTerminationRequest: () => false,
    }),
  );
  const canvasRef = useCallback((next: View | null) => {
    nodeRef.current = next;
    setNode(next);
  }, []);

  return {
    canvasRef,
    panHandlers: Platform.OS === "web" ? {} : panResponder.panHandlers,
    cancel: input.cancel,
    composeText,
  };
}
