/**
 * Workspace browser panel orchestration: viewer/control ownership, current
 * decoded receipts, media handoff and menu actions. Native/DOM forwarding and
 * presentation models live in focused counterpart hooks; this module never
 * replays published mutations or substitutes visible pixels for input authority.
 */
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LayoutChangeEvent, Text, useWindowDimensions, View } from "react-native";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  DEVICE_PRESETS,
  type DevicePresetId,
  detachBrowserRpc,
  didBrowserRuntimeRestart,
  endBrowserGestureRpc,
  isBrowserStateCurrent,
  listBrowserTabsRpc,
  MAX_BROWSER_TABS,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  navigateBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "../../shared/managed-browser/browser";
import type { BrowserFrameAuthority } from "../../shared/managed-browser/browser-video";
import { groupResolutionPresets } from "../../shared/managed-browser/resolution-menu";
import {
  type CaptureDensityMode,
  getAutomaticCaptureDensity,
} from "./browser-auto-capture-density";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";
import { BrowserCanvasViewport } from "./browser-canvas-viewport";
import {
  CanvasPlaceholder,
  ChromeIconButton,
  ControlButton,
  ErrorNotice,
  Field,
} from "./browser-chrome";
import { ComposeTextControls } from "./browser-compose-controls";
import { BrowserControlDialog } from "./browser-control-dialog";
import {
  type ControlRequest,
  type ControlRequestBasis,
  controlRequestBasis,
  isControlRequestCurrent,
} from "./browser-control-request";
import { BrowserDialogBody } from "./browser-dialog-body";
import { type EmulationSelection, matchingResolutionPresetId } from "./browser-emulation-mode";
import { getFillViewportResolution } from "./browser-fill-viewport";
import type { FrameCandidate } from "./browser-frame-buffer";
import { BrowserFrameImage } from "./browser-frame-image";
import { createStyles, DIMENSION, SPACE } from "./browser-panel-styles";
import { BrowserResolutionPicker } from "./browser-resolution-picker";
import { BrowserTabs } from "./browser-tabs";
import {
  BrowserMenuHeading,
  BrowserMenuItem,
  BrowserMenuSeparator,
  BrowserToolbarMenu,
} from "./browser-toolbar-menu";
import { isFrameCurrent } from "./browser-video-currency";
import { isBrowserClosedError, isExpiredBrowserViewerError } from "./browser-viewer-recovery";
import { createFrameLifecycle } from "./frame-lifecycle";
import { useBrowserAutoCaptureDensity } from "./use-browser-auto-capture-density";
import { useBrowserCanvasInput } from "./use-browser-canvas-input";
import { useBrowserCaptureDensity } from "./use-browser-capture-density";
import { useBrowserEmulationMode } from "./use-browser-emulation-mode";
import { useBrowserFillViewport } from "./use-browser-fill-viewport";
import { useBrowserFrameBuffer } from "./use-browser-frame-buffer";
import { useBrowserImageCapture } from "./use-browser-image-capture";
import { useBrowserScopedMutation } from "./use-browser-scoped-mutation";
import { useBrowserViewerRecovery } from "./use-browser-viewer-recovery";
import { useResolutionFavorites } from "./use-resolution-favorites";

// Preserve the existing contribution entry/test import while ownership lives in a focused module.


const MAX_VIEWER_LABEL_LENGTH = 64;
const MAX_URL_LENGTH = 8_192;
const BYTES_PER_KIBIBYTE = 1_024;

type SpecialKey = Extract<BrowserInputEvent, { kind: "key" }>["key"];

interface Size {
  width: number;
  height: number;
}

interface ControlledActions {
  navigate(action: "back" | "forward" | "reload" | "goto", url?: string): void;
  applyViewport(): void;
  fillViewport(): void;
  selectDevicePreset(id: DevicePresetId): void;
  changeDensity(value: CaptureDensityMode): void;
  toggleEmulation(): void;
  sendKey(key: SpecialKey): void;
  openCompose(kind: "compose" | "commit"): void;
  closeTab(): void;
  closeBrowser(): void;
  confirmCloseTab(): void;
  confirmCloseBrowser(): void;
}

const SPECIAL_KEYS: readonly { key: SpecialKey; label: string }[] = [
  { key: "Enter", label: "Enter" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
  { key: "Backspace", label: "Backspace" },
  { key: "Delete", label: "Delete" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowRight", label: "→" },
  { key: "Home", label: "Home" },
  { key: "End", label: "End" },
  { key: "PageUp", label: "Page up" },
  { key: "PageDown", label: "Page down" },
  { key: "Space", label: "Space" },
];

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The workspace browser request failed.";
}
function hasUnknownMutationOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code === "unknown_outcome") return true;
  if (
    code === "transport_closed_after_dispatch" ||
    code === "transport_lost_after_dispatch" ||
    code === "rpc_timeout" ||
    name === "RpcTimeoutError" ||
    name === "TransportLostAfterDispatchError"
  ) {
    return true;
  }
  const dispatched = record.dispatched === true || record.requestDispatched === true;
  return dispatched && /(transport|connection|timeout)/.test(code || name.toLowerCase());
}

/** A painted document may remain visible within the same source and geometry. */
function isFrameDisplayCurrent(frame: BrowserFrameAuthority, state: BrowserState): boolean {
  return Boolean(
    frame.runtimeId &&
      state.runtimeId &&
      frame.captureEpoch !== undefined &&
      state.bridgeEpoch !== undefined &&
      frame.sessionId === state.sessionId &&
      frame.runtimeId === state.runtimeId &&
      frame.captureEpoch === state.bridgeEpoch &&
      frame.viewportGeneration === state.viewportGeneration,
  );
}

export function ManagedBrowserPanel({
  theme,
  host,
  layout,
  workspaceId,
  createIfMissing = false,
  onCreateAttempt,
  onWatchExternal,
}: PluginWorkspacePanelProps & { createIfMissing?: boolean; onCreateAttempt?(): void; onWatchExternal?(): void }) {
  const createPermit = useRef(createIfMissing);
  const queryClient = useQueryClient();
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const { scale: screenPixelRatio } = useWindowDimensions();
  const viewerLabel = useState(() =>
    `Paseo ${layout.platform} · ${host.label} · ${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.slice(0, MAX_VIEWER_LABEL_LENGTH),
  )[0];

  const attachBrowser = useRpc(attachBrowserRpc);
  const detachBrowser = useRpc(detachBrowserRpc);
  const captureBrowser = useRpc(captureBrowserRpc);
  const closeBrowser = useRpc(closeBrowserRpc);
  const closeTab = useRpc(closeBrowserTabRpc);
  const createTab = useRpc(createBrowserTabRpc);
  const listTabs = useRpc(listBrowserTabsRpc);
  const reopenBrowser = useRpc(reopenBrowserRpc);
  const acquireControl = useRpc(acquireControlRpc);
  const releaseControl = useRpc(releaseControlRpc);
  const navigateBrowser = useRpc(navigateBrowserRpc);
  const resizeBrowser = useRpc(resizeBrowserRpc);
  const applyDevicePreset = useRpc(applyDevicePresetRpc);
  const setCaptureDensity = useRpc(setCaptureDensityRpc);
  const sendBrowserInput = useRpc(sendBrowserInputRpc);
  const beginBrowserGesture = useRpc(beginBrowserGestureRpc);
  const updateBrowserGesture = useRpc(updateBrowserGestureRpc);
  const endBrowserGesture = useRpc(endBrowserGestureRpc);

  const mountedRef = useRef(false);
  const activeViewerTokenRef = useRef<string | null>(null);
  const stateRef = useRef<BrowserState | null>(null);
  // Lease observations can change while acquisition awaits with no local token.
  // Count ownership transitions, not expiry renewals or ordinary media frames.
  const controllerObservationRevision = useRef(0);
  const frameRef = useRef<BrowserFrame | null>(null);
  const committedViewport = useRef<{ sessionId: string; generation: number } | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [inputLifecycle] = useState(createFrameLifecycle);
  const [legacyInputBusy, setLegacyInputBusy] = useState(false);
  // A visual-only old-read paint cannot wake strict initial-admission waiters.
  const [admittedPaint, setAdmittedPaint] = useState<{ frameId: string; epoch: number } | null>(
    null,
  );
  /** Notify initial-admission waiters only when the actual painted receipt gains input authority. */
  const publishAdmittedPaint = (frameId: string, epoch: number) => {
    setAdmittedPaint((previous) => {
      if (previous?.frameId === frameId && previous.epoch === epoch) return previous;
      return { frameId, epoch };
    });
  };

  const [state, setState] = useState<BrowserState | null>(null);
  const [controlToken, setControlToken] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [browserClosed, setBrowserClosed] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const selectedTabIdRef = useRef(selectedTabId);
  selectedTabIdRef.current = selectedTabId;
  const [tabMutationPending, setTabMutationPending] = useState(false);
  const [tabCloseConfirmationOpen, setTabCloseConfirmationOpen] = useState(false);
  const [controlRequest, setControlRequest] = useState<ControlRequest | null>(null);
  const [pendingControlAction, setPendingControlAction] = useState<ControlRequest | null>(null);
  const [controlRequestPending, setControlRequestPending] = useState(false);
  const controlRequestPendingRef = useRef(false);
  const controlledActionsRef = useRef<ControlledActions | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [reopenPending, setReopenPending] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const preferences = useResolutionFavorites(host.id);
  const [keysSubmenuOpen, setKeysSubmenuOpen] = useState(false);
  const keysAnchorRef = useRef<View | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<"display" | "actions" | null>(null);
  const [scaleMode, setScaleMode] = useState<BrowserCanvasDisplayMode>("fit");
  const paneRef = useRef<View | null>(null);
  const displayAnchorRef = useRef<View | null>(null);
  const actionsAnchorRef = useRef<View | null>(null);
  const [paneSize, setPaneSize] = useState<Size>({ width: 0, height: 0 });
  const panelScope = `${host.id}/${workspaceId}`;
  const [fillViewportScope, setFillViewportScope] = useState<string | null>(panelScope);
  const fillViewportEnabled = fillViewportScope === panelScope;
  const [densitySelection, setDensitySelection] = useState<{
    scope: string;
    mode: CaptureDensityMode;
  }>({ scope: panelScope, mode: "auto" });
  const densityMode = densitySelection.scope === panelScope ? densitySelection.mode : "auto";
  const [automaticDensityFailureScope, setAutomaticDensityFailureScope] = useState<string | null>(
    null,
  );
  const automaticDensityEnabled =
    densityMode === "auto" && automaticDensityFailureScope !== panelScope;
  useEffect(() => {
    setFillViewportScope(panelScope);
    setDensitySelection({ scope: panelScope, mode: "auto" });
    setAutomaticDensityFailureScope(null);
  }, [panelScope]);
  const panelScopeRef = useRef(panelScope);
  panelScopeRef.current = panelScope;
  const menuRestoreFocus = useRef(true);
  const closeToolbarMenu = useCallback((restoreFocus = true) => {
    menuRestoreFocus.current = restoreFocus;
    setKeysSubmenuOpen(false);
    setToolbarMenu(null);
  }, []);
  const toggleToolbarMenu = (menu: "display" | "actions") => {
    menuRestoreFocus.current = true;
    setKeysSubmenuOpen(false);
    setToolbarMenu((current) => (current === menu ? null : menu));
  };
  const [composeRequest, setComposeRequest] = useState<{
    id: number;
    kind: "compose" | "commit";
    ownershipKey: string;
  } | null>(null);
  const nextComposeRequest = useRef(0);
  const [activeInput, setActiveInput] = useState(false);
  const activeInputRef = useRef(false);
  /** Fence automatic timers immediately, before React commits a new physical press. */
  const handleInputActivity = useCallback((active: boolean) => {
    activeInputRef.current = active;
    setActiveInput(active);
  }, []);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCandidateCurrent = useCallback((candidate: FrameCandidate) => {
    const current = stateRef.current;
    return (
      mountedRef.current &&
      candidate.viewerToken === activeViewerTokenRef.current &&
      candidate.mutationEpoch === inputLifecycle.epoch &&
      current !== null &&
      isFrameCurrent(candidate.frame, current)
    );
  }, []);
  const { buffer, frame, receive, settled, discardObsoletePending, reset } = useBrowserFrameBuffer(
    frameRef,
    isCandidateCurrent,
  );
  const imageError = buffer.imageError;

  const acceptState = useCallback(
    (next: BrowserState) => {
      const previous = stateRef.current;
      if (previous && !isBrowserStateCurrent(previous, next)) return false;
      // Server state projects "self" against this exact viewer token. Media can
      // observe our acquisition before its RPC returns the control token, so
      // that transition must not revoke its own still-pending settlement.
      // Competing ownership and subsequent release still advance the fence.
      const observesOwnAcquisition = previous?.controller !== "self" && next.controller === "self";
      if (
        previous &&
        !observesOwnAcquisition &&
        (previous.controller !== next.controller ||
          previous.controllerLabel !== next.controllerLabel)
      ) {
        controllerObservationRevision.current += 1;
      }
      const currentFrame = frameRef.current;
      if (previous && didBrowserRuntimeRestart(previous, next)) {
        setRuntimeNotice(
          "Browser restarted. The preserved viewer connection now targets the new runtime.",
        );
        setControlToken(null);
      }
      if (currentFrame && !isFrameCurrent(currentFrame, next)) {
        lastPointRef.current = null;
      }
      stateRef.current = next;
      // Repeated captures in the new generation must not cancel its slow decoder.
      discardObsoletePending();
      setState(next);
      return true;
    },
    [discardObsoletePending],
  );

  const attachQuery = useQuery({
    queryKey: ["hosts-browser", "attach", host.id, workspaceId, viewerLabel, selectedTabId],
    queryFn: async () => {
      const create = createPermit.current;
      createPermit.current = false;
      onCreateAttempt?.();
      const result = await attachBrowser({
        create,
        workspaceId,
        viewerLabel,
        ...(selectedTabId ? { tabId: selectedTabId } : {}),
      });
      if (!mountedRef.current) {
        await detachBrowser({ viewerToken: result.viewerToken }).catch(() => undefined);
        throw new Error("The browser panel closed before attachment completed.");
      }
      return result;
    },
    retry: false,
    enabled: !browserClosed,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const closedView = browserClosed || isBrowserClosedError(attachQuery.error);
  const closedViewRef = useRef(closedView);
  closedViewRef.current = closedView;
  const attachedTabMatches = !selectedTabId || attachQuery.data?.state.tabId === selectedTabId;
  const viewerToken =
    reconnecting || closedView || !attachedTabMatches
      ? null
      : (attachQuery.data?.viewerToken ?? null);
  const tabsQueryKey = ["hosts-browser", "tabs", host.id, workspaceId];
  const tabsQuery = useQuery({
    queryKey: tabsQueryKey,
    queryFn: () => listTabs({ viewerToken: viewerToken! }),
    enabled: Boolean(viewerToken),
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const tabs = tabsQuery.data?.tabs;
    const selected = selectedTabId ?? stateRef.current?.tabId;
    if (!tabs || !selected || tabs.some((tab) => tab.id === selected)) return;
    setSelectedTabId(tabs[0]?.id ?? null);
  }, [selectedTabId, tabsQuery.data]);

  useEffect(() => {
    if (isBrowserClosedError(attachQuery.error)) setBrowserClosed(true);
  }, [attachQuery.error]);

  useEffect(() => {
    if (!closedView) return;
    setControlRequest(null);
    setPendingControlAction(null);
  }, [closedView]);

  useEffect(() => {
    if (!viewerToken) return;
    activeViewerTokenRef.current = viewerToken;
    return () => {
      if (activeViewerTokenRef.current === viewerToken) activeViewerTokenRef.current = null;
      void detachBrowser({ viewerToken }).catch(() => undefined);
    };
  }, [detachBrowser, viewerToken]);

  useEffect(() => {
    if (!reconnecting && attachQuery.data) acceptState(attachQuery.data.state);
  }, [acceptState, attachQuery.data, reconnecting]);

  useEffect(() => {
    stateRef.current = null;
    frameRef.current = null;
    setState(null);
    reset();
    inputLifecycle.bump();
    inputLifecycle.reset();
    setLegacyInputBusy(false);
    setControlToken(null);
    setOperationError(null);
    setRuntimeNotice(null);
    setBrowserClosed(false);
    setSelectedTabId(null);
    setTabCloseConfirmationOpen(false);
    setControlRequest(null);
    setPendingControlAction(null);
    setCloseConfirmationOpen(false);
  }, [reset, workspaceId, host.id, inputLifecycle]);

  useEffect(() => {
    // A tab selection changes the viewer's page and frame authority, even
    // though the underlying Chromium process and saved profile stay shared.
    inputLifecycle.bump();
    activeViewerTokenRef.current = null;
    stateRef.current = null;
    frameRef.current = null;
    reset();
    setState(null);
    setControlToken(null);
    setControlRequest(null);
    setPendingControlAction(null);
    setOperationError(null);
    setReconnecting(false);
  }, [selectedTabId, inputLifecycle, reset]);

  useLayoutEffect(() => {
    committedViewport.current = state
      ? { sessionId: state.sessionId, generation: state.viewportGeneration }
      : null;
  }, [state?.sessionId, state?.viewportGeneration]);

  const {
    query: captureQuery,
    refreshCapture,
    retryFrameCapture,
  } = useBrowserImageCapture({
    active: true,
    viewerToken,
    quality: preferences.captureQuality,
    activeInput,
    videoOwnsPresentation: false,
    hasVideoPresentation: () => false,
    refreshVideo: () => undefined,
    mutationEpoch: () => inputLifecycle.epoch,
    knownFrame: () => frameRef.current,
    capture: captureBrowser,
  });

  useEffect(() => {
    const result = captureQuery.data;
    if (
      !result ||
      result.viewerToken !== activeViewerTokenRef.current ||
      result.captureQuality !== preferences.captureQuality ||
      result.mutationEpoch !== inputLifecycle.epoch ||
      !acceptState(result.state)
    ) {
      return;
    }
    if (result.frame && isFrameCurrent(result.frame, result.state)) {
      receive({
        frame: result.frame,
        viewport: result.state.viewport,
        viewerToken: result.viewerToken,
        mutationEpoch: result.mutationEpoch,
        fallbackRevision: result.fallbackRevision,
      });
    }
  }, [acceptState, captureQuery.data, preferences.captureQuality, receive]);

  useEffect(() => {
    if (state?.controller !== "self" && controlToken) setControlToken(null);
  }, [controlToken, state?.controller, state?.sessionId]);

  useEffect(() => {
    if (!state || addressFocused) return;
    setAddressDraft(state.url);
  }, [addressFocused, state?.sessionId, state?.url]);

  useEffect(() => {
    if (!state) return;
    setViewportWidth(String(state.viewport.width));
    setViewportHeight(String(state.viewport.height));
  }, [state?.sessionId, state?.viewport.height, state?.viewport.width]);

  const mutationFailed = useCallback(
    (error: unknown) => {
      const message = errorMessage(error);
      setOperationError(
        hasUnknownMutationOutcome(error)
          ? `${message} Mutation outcome is unknown; state refreshed and the action was not replayed.`
          : message,
      );
      refreshCapture();
    },
    [refreshCapture],
  );

  const mutationSucceeded = useCallback(
    (next: BrowserState) => {
      setOperationError(null);
      acceptState(next);
      refreshCapture();
    },
    [acceptState, refreshCapture],
  );

  const mutationIdentity = JSON.stringify([
    host.id,
    workspaceId,
    viewerToken,
    controlToken,
    controllerObservationRevision.current,
  ]);
  // Ref observations revoke settlement immediately, before the state commit.
  const currentMutationIdentity = () =>
    JSON.stringify([
      host.id,
      workspaceId,
      activeViewerTokenRef.current,
      controlToken,
      controllerObservationRevision.current,
    ]);
  const acquireMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: acquireControl,
    onSuccess: (result) => {
      setControlToken(result.controlToken);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const releaseMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: releaseControl,
    onSuccess: (result) => {
      setControlToken(null);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const navigateMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: navigateBrowser,
    onSuccess: (result) => {
      mutationSucceeded(result.state);
      // Only acknowledged navigation grants explicit viewing recovery. Ordinary
      // gesture/image refresh does not rearm an exhausted video reader.
    },
    onError: mutationFailed,
  });
  const resizeMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: resizeBrowser,
    onSuccess: (result) => {
      setDevicePickerOpen(false);
      mutationSucceeded(result.state);
    },
    onError: (error) => {
      setFillViewportScope(null);
      setAutomaticDensityFailureScope(panelScope);
      mutationFailed(error);
    },
  });
  const deviceMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: applyDevicePreset,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  // Upstream's settlement gate protects discrete key controls and native text fallback.
  // Continuous gestures retain their own ordered channel without waiting per event.
  const settleLegacyInput = () => {
    inputLifecycle.settle();
    setLegacyInputBusy(true);
  };
  const inputMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: sendBrowserInput,
    onSuccess: (result) => {
      settleLegacyInput();
      mutationSucceeded(result.state);
    },
    onError: (error) => {
      settleLegacyInput();
      mutationFailed(error);
    },
  });

  const densityControl = useBrowserCaptureDensity({
    identity: JSON.stringify([host.id, workspaceId, viewerToken, controlToken]),
    current: () => {
      const current = stateRef.current;
      const viewer = activeViewerTokenRef.current;
      if (viewingExpired || !current || !viewer || !controlToken || current.controller !== "self")
        return null;
      return {
        state: current,
        context: {
          viewerToken: viewer,
          controlToken,
          expected: {
            sessionId: current.sessionId,
            navigationGeneration: current.navigationGeneration,
            viewportGeneration: current.viewportGeneration,
            ...(current.runtimeId ? { runtimeId: current.runtimeId } : {}),
            ...(current.bridgeEpoch !== undefined ? { bridgeEpoch: current.bridgeEpoch } : {}),
          },
        },
      };
    },
    change: setCaptureDensity,
    beforeChange: () => inputLifecycle.bump(),
    onSuccess: mutationSucceeded,
    onError: (error) => {
      setAutomaticDensityFailureScope(panelScope);
      setFillViewportScope(null);
      mutationFailed(error);
    },
  });

  const anyMutationPending =
    acquireMutation.isPending ||
    releaseMutation.isPending ||
    navigateMutation.isPending ||
    resizeMutation.isPending ||
    densityControl.pending ||
    deviceMutation.isPending ||
    inputMutation.isPending ||
    controlRequestPending ||
    closePending;
  const viewingExpired = isExpiredBrowserViewerError(captureQuery.error);
  useEffect(() => {
    if (isBrowserClosedError(captureQuery.error)) setBrowserClosed(true);
  }, [captureQuery.error]);
  const canControl = Boolean(
    viewerToken &&
      controlToken &&
      state?.controller === "self" &&
      (!selectedTabId || state.tabId === selectedTabId) &&
      !viewingExpired,
  );
  const frontLayer = buffer.front === null ? null : buffer.layers[buffer.front];
  const currentFrame =
    (frame &&
    state &&
    frontLayer?.candidate.viewerToken === viewerToken &&
    isFrameCurrent(frame, state)
      ? frame
      : null);
  useEffect(() => {
    const candidate = frontLayer?.candidate;
    if (!frame || !candidate || candidate.mutationEpoch !== inputLifecycle.epoch)
      return;
    inputLifecycle.accept(candidate.mutationEpoch, frame);
    publishAdmittedPaint(frame.frameId, candidate.mutationEpoch);
    setLegacyInputBusy(inputLifecycle.busy);
  }, [frame, frontLayer, inputLifecycle]);
  const canSendInput =
    canControl && Boolean(currentFrame) && !inputMutation.isPending && !legacyInputBusy;

  // Layout belongs to the decoded front frame. A denser capture adds detail,
  // not a larger 100% layout; scale never writes to the workspace browser state.
  const visualFrame = frame;
  const canvasLayout = useMemo(
    () =>
      visualFrame
        ? getBrowserCanvasLayout(
            containerSize,
            visualFrame,
            frontLayer?.candidate.viewport ?? state?.viewport ?? visualFrame,
            scaleMode,
          )
        : null,
    [
      containerSize,
      visualFrame,
      frontLayer,
      state?.viewport,
      scaleMode,
    ],
  );
  const displayRect = canvasLayout?.frameRect ?? null;

  const controlContext = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    const current = stateRef.current;
    if (
      viewingExpired ||
      !viewer ||
      !controlToken ||
      !current ||
      current.controller !== "self" ||
      (selectedTabId && current.tabId !== selectedTabId)
    )
      return null;
    return {
      viewerToken: viewer,
      controlToken,
      expected: {
        sessionId: current.sessionId,
        navigationGeneration: current.navigationGeneration,
        viewportGeneration: current.viewportGeneration,
      },
    };
  }, [controlToken, viewingExpired, selectedTabId]);

  const inputContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    const targetFrame = frameRef.current;
    if (
      !context ||
      !current ||
      !targetFrame ||
      !isFrameCurrent(targetFrame, current) ||
      frontLayer?.candidate.viewerToken !== context.viewerToken
    ) {
      return null;
    }
    return {
      ...context,
      target: {
        frameId: targetFrame.frameId,
        navigationGeneration: targetFrame.navigationGeneration,
        viewportGeneration: targetFrame.viewportGeneration,
      },
    };
  }, [controlContext, frontLayer]);

  const requireControlContext = useCallback(() => {
    const context = controlContext();
    if (!context) {
      setOperationError("Take control before changing the browser.");
      return null;
    }
    return context;
  }, [controlContext]);

  const requireInputContext = useCallback(() => {
    const context = inputContext();
    if (!context) {
      setOperationError("A current frame and active control lease are required for browser input.");
      refreshCapture();
      return null;
    }
    return context;
  }, [inputContext, refreshCapture]);

  const sendEvent = useCallback(
    (event: BrowserInputEvent) => {
      const context = requireInputContext();
      if (!context || inputMutation.isPending || !inputLifecycle.begin()) return;
      setLegacyInputBusy(true);
      inputMutation.mutate({ ...context, event });
    },
    [inputMutation, requireInputContext],
  );

  const liveInputEnabled =
    canSendInput &&
    !navigateMutation.isPending &&
    !resizeMutation.isPending &&
    !deviceMutation.isPending &&
    !releaseMutation.isPending &&
    !acquireMutation.isPending &&
    toolbarMenu === null;
  /** Existing channels retain control incarnation while their next frame decodes. */
  const gestureControlContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    if (!mountedRef.current || !context || !current?.runtimeId || current.bridgeEpoch === undefined)
      return null;
    return {
      ...context,
      expected: {
        ...context.expected,
        runtimeId: current.runtimeId,
        bridgeEpoch: current.bridgeEpoch,
      },
    };
  }, [controlContext]);

  // Forward physical mouse events and genuine touch on every remote preset.
  const canvasInput = useBrowserCanvasInput({
    authority: () => {
      const input = inputContext();
      const context = gestureControlContext();
      return input && context ? { ...context, target: input.target } : null;
    },
    controlAuthority: gestureControlContext,
    transport: { begin: beginBrowserGesture, update: updateBrowserGesture, end: endBrowserGesture },
    ownershipKey: JSON.stringify([
      viewerToken,
      controlToken,
      state?.sessionId,
      state?.runtimeId,
      state?.bridgeEpoch,
      state?.navigationGeneration,
      state?.viewportGeneration,
      displayRect?.width,
      displayRect?.height,
      containerSize.width,
      containerSize.height,
      scaleMode,
      liveInputEnabled,
    ]),
    decodedFrameId: admittedPaint?.epoch === inputLifecycle.epoch ? admittedPaint.frameId : null,
    enabled: liveInputEnabled,
    displaySize: displayRect,
    viewport: state?.viewport ?? null,
    onState: acceptState,
    onError: mutationFailed,
    onFinish: refreshCapture,
    onPoint: (point) => {
      lastPointRef.current = { x: point.x, y: point.y };
    },
    onActivity: handleInputActivity,
    onInputAcknowledged: () => {
      // Pixels requested before the host acknowledged this input cannot authorize
      // the next press, even when their request began after the local press.
      inputLifecycle.bump();
    },
    onInputBoundary: () => {
      inputLifecycle.bump();
    },
  });

  const composeOwnershipKey = JSON.stringify([
    viewerToken,
    controlToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  const composeDocumentKey = JSON.stringify([
    viewerToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  // Touch-first surfaces (native and compact web) get the explicit draft; desktop web types on the canvas.
  const composeAvailable = layout.platform !== "web" || layout.compact;
  const requestCompose = (kind: "compose" | "commit") => {
    if (!canSendInput) return;
    nextComposeRequest.current += 1;
    closeToolbarMenu(false);
    setComposeRequest({ id: nextComposeRequest.current, kind, ownershipKey: composeOwnershipKey });
  };
  const composeRequestHandled = useCallback((id: number) => {
    setComposeRequest((current) => (current?.id === id ? null : current));
  }, []);

  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);

  const takeControl = useCallback(
    (takeover: boolean) => {
      if (!viewerToken || acquireMutation.isPending) return;
      inputLifecycle.bump();
      acquireMutation.mutate({ viewerToken, takeover });
    },
    [acquireMutation, viewerToken],
  );

  /** Ask for authority before running an action, preserving its exact tab and page basis. */
  const requestControlled = (label: string, run: () => void, needsFrame = false) => {
    if (anyMutationPending || controlRequestPendingRef.current) return;
    if (controlContext()) {
      run();
      return;
    }
    const current = stateRef.current;
    const viewer = activeViewerTokenRef.current;
    if (!current || !viewer || (selectedTabId && current.tabId !== selectedTabId) || viewingExpired)
      return;
    setControlRequest({
      label,
      basis: controlRequestBasis(
        panelScope,
        viewer,
        current,
        controllerObservationRevision.current,
      ),
      needsFrame,
      run,
    });
  };

  const requestIsCurrent = useCallback(
    (basis: ControlRequestBasis) =>
      !closedViewRef.current &&
      (!selectedTabIdRef.current || selectedTabIdRef.current === basis.tabId) &&
      isControlRequestCurrent(
        basis,
        panelScopeRef.current,
        activeViewerTokenRef.current,
        stateRef.current,
        controllerObservationRevision.current,
      ),
    [],
  );

  /** Acquire once, then let the committed controlled render run the queued action once. */
  const confirmControlRequest = async () => {
    const request = controlRequest;
    if (!request || controlRequestPendingRef.current) return;
    const current = stateRef.current;
    if (!requestIsCurrent(request.basis)) {
      setControlRequest(null);
      setOperationError("The browser changed. Select the action again.");
      return;
    }

    controlRequestPendingRef.current = true;
    setControlRequestPending(true);
    setOperationError(null);
    try {
      inputLifecycle.bump();
      const result = await acquireControl({
        viewerToken: request.basis.viewerToken,
        takeover: current?.controller === "other",
      });
      if (!mountedRef.current || !requestIsCurrent(request.basis)) {
        await releaseControl({
          viewerToken: request.basis.viewerToken,
          controlToken: result.controlToken,
        }).catch(() => undefined);
        return;
      }
      setControlRequest(null);
      if (!acceptState(result.state)) {
        await releaseControl({
          viewerToken: request.basis.viewerToken,
          controlToken: result.controlToken,
        }).catch(() => undefined);
        setOperationError("The browser changed. Select the action again.");
        return;
      }
      setControlToken(result.controlToken);
      refreshCapture();
      if (
        requestIsCurrent(request.basis) &&
        isControlRequestCurrent(
          request.basis,
          panelScopeRef.current,
          activeViewerTokenRef.current,
          result.state,
          controllerObservationRevision.current,
        )
      ) {
        setPendingControlAction(request);
      } else {
        setOperationError("The browser changed. Select the action again.");
      }
    } catch (error) {
      setControlRequest(null);
      mutationFailed(error);
    } finally {
      controlRequestPendingRef.current = false;
      if (mountedRef.current) setControlRequestPending(false);
    }
  };

  useEffect(() => {
    if (!pendingControlAction || controlRequestPending) return;
    if (!requestIsCurrent(pendingControlAction.basis)) {
      setPendingControlAction(null);
      setOperationError("The browser changed. Select the action again.");
      return;
    }
    if (
      !canControl ||
      (pendingControlAction.needsFrame &&
        (!canSendInput || admittedPaint?.epoch !== inputLifecycle.epoch))
    )
      return;
    setPendingControlAction(null);
    pendingControlAction.run();
  }, [
    pendingControlAction,
    controlRequestPending,
    canControl,
    canSendInput,
    admittedPaint,
    state,
    requestIsCurrent,
  ]);

  const release = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    if (
      !viewer ||
      !controlToken ||
      stateRef.current?.controller !== "self" ||
      releaseMutation.isPending
    ) {
      return;
    }
    inputLifecycle.bump();
    releaseMutation.mutate({ viewerToken: viewer, controlToken });
  }, [controlToken, releaseMutation]);

  const navigate = useCallback(
    (action: "back" | "forward" | "reload" | "goto", url?: string) => {
      const context = requireControlContext();
      if (!context || navigateMutation.isPending) return;
      if (action === "goto") {
        const nextUrl = url?.trim();
        if (!nextUrl) {
          setOperationError("Enter an address to navigate.");
          return;
        }
        inputLifecycle.bump();
        navigateMutation.mutate({ ...context, action: { kind: "goto", url: nextUrl } });
        return;
      }
      inputLifecycle.bump();
      navigateMutation.mutate({ ...context, action: { kind: action } });
    },
    [navigateMutation, requireControlContext],
  );

  const applyViewport = useCallback(() => {
    const context = requireControlContext();
    if (!context || resizeMutation.isPending) return;
    const width = Number(viewportWidth);
    const height = Number(viewportHeight);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_VIEWPORT.width ||
      width > MAX_VIEWPORT.width ||
      height < MIN_VIEWPORT.height ||
      height > MAX_VIEWPORT.height
    ) {
      setOperationError(
        `Viewport must be ${MIN_VIEWPORT.width}–${MAX_VIEWPORT.width} × ${MIN_VIEWPORT.height}–${MAX_VIEWPORT.height}.`,
      );
      return;
    }
    inputLifecycle.bump();
    setFillViewportScope(null);
    resizeMutation.mutate({ ...context, viewport: { width, height } });
  }, [requireControlContext, resizeMutation, viewportHeight, viewportWidth]);

  const fillViewportLimitDensity = densityMode === "auto" ? 1 : (state?.captureScale ?? 1);
  const fillTarget = getFillViewportResolution(containerSize, fillViewportLimitDensity);

  /** Enable following and resize using current geometry after control acquisition. */
  const fillViewport = useCallback(() => {
    const context = requireControlContext();
    if (!context || resizeMutation.isPending) return;
    const viewport = fillTarget;
    if (!viewport) {
      setOperationError(
        "The visible browser area is outside the supported resolution range at the current capture density.",
      );
      return;
    }
    inputLifecycle.bump();
    setFillViewportScope(panelScope);
    setScaleMode("fit");
    const captureDensity =
      densityMode === "auto"
        ? getAutomaticCaptureDensity(viewport, containerSize, screenPixelRatio, "fit")
        : null;
    resizeMutation.mutate({
      ...context,
      viewport,
      preserveEmulation: true,
      ...(captureDensity === null ? {} : { captureDensity }),
    });
  }, [
    requireControlContext,
    resizeMutation,
    containerSize,
    inputLifecycle,
    panelScope,
    fillTarget,
    densityMode,
    screenPixelRatio,
  ]);

  useBrowserFillViewport({
    identity: mutationIdentity,
    enabled: fillViewportEnabled,
    canResize: canControl && !activeInput && !anyMutationPending && state?.status === "ready",
    target: fillTarget,
    viewport: state?.viewport ?? null,
    apply: () => {
      if (!activeInputRef.current) fillViewport();
    },
  });

  const followingNeedsResize =
    fillViewportEnabled &&
    (fillTarget?.width !== state?.viewport.width || fillTarget?.height !== state?.viewport.height);
  useBrowserAutoCaptureDensity({
    identity: mutationIdentity,
    enabled: automaticDensityEnabled,
    canChange:
      canControl &&
      !activeInput &&
      !anyMutationPending &&
      !followingNeedsResize &&
      state?.status === "ready",
    target: state
      ? getAutomaticCaptureDensity(state.viewport, containerSize, screenPixelRatio, scaleMode)
      : null,
    currentDensity: state?.captureScale ?? 1,
    apply: (density) => {
      if (!activeInputRef.current) densityControl.select(density);
    },
  });

  const selectDevicePreset = useCallback(
    (presetId: DevicePresetId) => {
      const context = requireControlContext();
      if (!context || deviceMutation.isPending) return;
      inputLifecycle.bump();
      setFillViewportScope(null);
      setDevicePickerOpen(false);
      deviceMutation.mutate({ ...context, presetId });
    },
    [deviceMutation, requireControlContext],
  );

  const applyEmulationSelection = useCallback(
    (selection: EmulationSelection) => {
      const context = requireControlContext();
      if (!context || anyMutationPending) return;
      inputLifecycle.bump();
      deviceMutation.mutate({ ...context, ...selection });
    },
    [requireControlContext, anyMutationPending, inputLifecycle, deviceMutation],
  );
  const emulation = useBrowserEmulationMode({
    identity: JSON.stringify([host.id, workspaceId]),
    platform: layout.platform,
    state,
    canControl,
    pending: anyMutationPending || Boolean(pendingControlAction),
    apply: applyEmulationSelection,
  });

  const reconnect = useCallback(() => {
    if (attachQuery.isFetching) return;
    inputLifecycle.bump();
    // Immediately revoke local input while the viewing-only reattachment awaits.
    activeViewerTokenRef.current = null;
    setReconnecting(true);
    setControlToken(null);
    setOperationError(null);
    void attachQuery.refetch({ cancelRefetch: false }).then((result) => {
      if (!result.error) setReconnecting(false);
    });
  }, [attachQuery.isFetching, attachQuery.refetch]);

  /** Add a page to the shared profile and select it only for this panel. */
  const createBrowserTab = async () => {
    const viewerToken = activeViewerTokenRef.current;
    if (!viewerToken || tabMutationPending) return;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      const created = await createTab({ viewerToken });
      // A pre-creation list can otherwise undo selection through the missing-tab
      // fallback. Cancel its receipt and include the confirmed blank page first.
      await queryClient.cancelQueries({ queryKey: tabsQueryKey, exact: true });
      if (
        !mountedRef.current ||
        panelScopeRef.current !== panelScope ||
        activeViewerTokenRef.current !== viewerToken
      ) {
        return;
      }
      queryClient.setQueryData<Awaited<ReturnType<typeof listTabs>>>(tabsQueryKey, (previous) => {
        if (previous?.tabs.some((tab) => tab.id === created.tabId)) return previous;
        return {
          tabs: [
            ...(previous?.tabs ?? []),
            {
              id: created.tabId,
              title: "",
              url: "about:blank",
              viewerCount: 0,
              controllerLabel: null,
            },
          ],
        };
      });
      setSelectedTabId(created.tabId);
      void tabsQuery.refetch();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setTabMutationPending(false);
    }
  };

  /** Close only the controlled page; other tabs and their viewers stay attached. */
  const confirmCloseSelectedTab = async () => {
    const viewerToken = activeViewerTokenRef.current;
    const tabId = selectedTabId ?? stateRef.current?.tabId;
    if (!viewerToken || !controlToken || !tabId || tabMutationPending) return;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      await closeTab({ viewerToken, controlToken, tabId });
      setTabCloseConfirmationOpen(false);
      const fallback = tabsQuery.data?.tabs.find((tab) => tab.id !== tabId);
      setSelectedTabId(fallback?.id ?? null);
      void tabsQuery.refetch();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setTabMutationPending(false);
    }
  };

  /** Confirmed close ends every viewer's runtime and immediately drops this panel's media. */
  const confirmCloseBrowser = async () => {
    const current = stateRef.current;
    const viewerToken = activeViewerTokenRef.current;
    if (!current?.runtimeId || !viewerToken || !controlToken || closePending) return;
    setClosePending(true);
    setOperationError(null);
    try {
      await closeBrowser({
        viewerToken,
        controlToken,
        sessionId: current.sessionId,
        runtimeId: current.runtimeId,
      });
      if (panelScopeRef.current !== panelScope) return;
      inputLifecycle.bump();
      activeViewerTokenRef.current = null;
      stateRef.current = null;
      frameRef.current = null;
      reset();
      setState(null);
      setControlToken(null);
      setBrowserClosed(true);
      setCloseConfirmationOpen(false);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setClosePending(false);
    }
  };

  // Queued actions always resolve through this render's scoped mutation callbacks.
  // A callback captured before acquisition must never reuse its old control identity.
  controlledActionsRef.current = {
    navigate,
    applyViewport,
    fillViewport,
    selectDevicePreset,
    changeDensity: (value) => {
      setDensitySelection({ scope: panelScope, mode: value });
      setAutomaticDensityFailureScope(null);
      if (value !== "auto") densityControl.select(value);
    },
    toggleEmulation: emulation.toggle,
    sendKey: (key) => sendEvent({ kind: "key", key }),
    openCompose: requestCompose,
    closeTab: () => setTabCloseConfirmationOpen(true),
    closeBrowser: () => setCloseConfirmationOpen(true),
    confirmCloseTab: () => void confirmCloseSelectedTab(),
    confirmCloseBrowser: () => void confirmCloseBrowser(),
  };

  /** Explicit user action is the only way to clear the server's closed fence. */
  const reopenClosedBrowser = async () => {
    if (reopenPending) return;
    setReopenPending(true);
    setOperationError(null);
    try {
      await reopenBrowser({ workspaceId });
      createPermit.current = true;
      if (panelScopeRef.current !== panelScope) return;
      setBrowserClosed(false);
      reconnect();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setReopenPending(false);
    }
  };

  useBrowserViewerRecovery({
    identity: JSON.stringify([host.id, workspaceId]),
    viewerToken,
    failedViewerToken: viewerToken,
    captureError: captureQuery.error,
    pending: reconnecting || attachQuery.isFetching,
    reconnect,
  });

  // Expiry belongs to the viewing-only recovery path, not an action failure.
  // A failed reattachment still surfaces its attachQuery error and manual retry.
  const connectionError =
    attachQuery.error ?? (viewingExpired ? null : captureQuery.error);
  const recoveryError =
    state?.recoveryState === "runtime-unavailable"
      ? (state.error ?? "Browser runtime unavailable.")
      : null;
  const visibleError =
    operationError ??
    recoveryError ??
    state?.error ??
    (connectionError ? errorMessage(connectionError) : null) ??
    (tabsQuery.error ? errorMessage(tabsQuery.error) : null);
  const statusColor =
    state?.status === "ready"
      ? theme.colors.statusSuccess
      : state?.status === "error"
        ? theme.colors.statusDanger
        : theme.colors.statusWarning;
  const statusLabel =
    state?.status === "ready" ? "Ready" : state?.status === "error" ? "Error" : "Starting";
  const activeDevicePreset = state?.devicePresetId
    ? DEVICE_PRESETS.find(({ id }) => id === state.devicePresetId)
    : null;
  const selectedResolutionPresetId = fillViewportEnabled ? null : matchingResolutionPresetId(state);
  const fillViewportResolution = fillTarget;
  const fillViewportDetail = fillViewportResolution
    ? `${fillViewportResolution.width} × ${fillViewportResolution.height}`
    : `Requires ${MIN_VIEWPORT.width}–${Math.floor(MAX_VIEWPORT.width / fillViewportLimitDensity)} × ${MIN_VIEWPORT.height}–${Math.floor(MAX_VIEWPORT.height / fillViewportLimitDensity)} at current capture density`;
  let deviceLabel = `${emulation.mode === "mobile" ? "Mobile" : "Desktop"} · custom display`;
  if (fillViewportEnabled) {
    deviceLabel = "Fill viewport";
  } else if (selectedResolutionPresetId) {
    deviceLabel = activeDevicePreset?.label ?? "Custom display";
  }
  const transportLabel = frame?.transport === "cdp-screencast" ? "CDP JPEG" : "JPEG";
  const summaryFrame = currentFrame;
  const frameSummary = summaryFrame
    ? layout.compact
      ? `${summaryFrame.width}×${summaryFrame.height} · ${transportLabel}`
      : `${summaryFrame.width} × ${summaryFrame.height} · ${Math.ceil((frame?.byteLength ?? 0) / BYTES_PER_KIBIBYTE)} KB · ${transportLabel} · ${deviceLabel}`
    : state
      ? `${state.viewport.width} × ${state.viewport.height} canonical`
      : "No frame";

  let controlAction: ReactNode = null;
  if (state?.controller === "self" && controlToken) {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label={layout.compact ? "Return" : "Return to agent"}
        accessibilityLabel="Return to agent"
        icon="LogOut"
        large
        disabled={anyMutationPending}
        onPress={release}
      />
    );
  } else if (state?.controller === "other") {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label={layout.compact ? "Control" : "Take control"}
        accessibilityLabel="Take over"
        icon="Crown"
        large
        danger
        disabled={!viewerToken || anyMutationPending}
        onPress={() => takeControl(true)}
      />
    );
  } else {
    controlAction = (
      <ControlButton
        styles={styles}
        theme={theme}
        label={layout.compact ? "Control" : "Take control"}
        accessibilityLabel={state?.controller === "self" ? "Reacquire" : "Take control"}
        icon="MousePointer2"
        large
        primary
        disabled={!viewerToken || anyMutationPending}
        onPress={() => takeControl(false)}
      />
    );
  }

  const interactionStyle = displayRect
    ? [
        styles.interactionLayer,
        {
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
        },
      ]
    : styles.interactionLayer;

  if (closedView) {
    return (
      <View style={styles.screen}>
        <CanvasPlaceholder
          styles={styles}
          theme={theme}
          title="Workspace browser closed"
          detail="The browser was closed for everyone. Its saved site data is available when you reopen it."
        >
          <ControlButton
            styles={styles}
            theme={theme}
            label={reopenPending ? "Opening…" : "Open workspace browser"}
            icon="PanelsTopLeft"
            primary
            large
            disabled={reopenPending}
            onPress={() => void reopenClosedBrowser()}
          />
        </CanvasPlaceholder>
        {operationError ? (
          <ErrorNotice styles={styles} theme={theme} message={operationError} />
        ) : null}
      </View>
    );
  }

  return (
    <View
      ref={paneRef}
      collapsable={false}
      style={styles.screen}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPaneSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
      <BrowserTabs
        styles={styles}
        theme={theme}
        tabs={tabsQuery.data?.tabs ?? []}
        selectedId={selectedTabId ?? state?.tabId ?? null}
        selectedState={state}
        statusColor={statusColor}
        statusLabel={statusLabel}
        controlAction={controlAction}
        canCreate={
          Boolean(viewerToken) &&
          !tabMutationPending &&
          (tabsQuery.data?.tabs.length ?? 0) < MAX_BROWSER_TABS
        }
        canClose={
          Boolean(viewerToken) && !tabMutationPending && (tabsQuery.data?.tabs.length ?? 0) > 1
        }
        onSelect={setSelectedTabId}
        onCreate={() => void createBrowserTab()}
        onClose={() =>
          requestControlled("close this tab", () => controlledActionsRef.current?.closeTab())
        }
      />

      <View style={styles.chrome}>
        <View style={styles.addressRow}>
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Back"
            icon="ArrowLeft"
            disabled={!viewerToken || !state?.canGoBack || anyMutationPending}
            onPress={() =>
              requestControlled("go back", () => controlledActionsRef.current?.navigate("back"))
            }
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Forward"
            icon="ArrowRight"
            disabled={!viewerToken || !state?.canGoForward || anyMutationPending}
            onPress={() =>
              requestControlled("go forward", () =>
                controlledActionsRef.current?.navigate("forward"),
              )
            }
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Reload"
            icon="RotateCw"
            disabled={!viewerToken || anyMutationPending}
            onPress={() =>
              requestControlled("reload the page", () =>
                controlledActionsRef.current?.navigate("reload"),
              )
            }
          />
          <Field
            styles={styles}
            theme={theme}
            value={addressDraft}
            accessibilityLabel="Browser address"
            selectTextOnFocus
            placeholder="Enter a URL"
            editable={Boolean(viewerToken) && !navigateMutation.isPending}
            dimWhenReadOnly={false}
            keyboardType="url"
            maxLength={MAX_URL_LENGTH}
            returnKeyType="go"
            style={[styles.addressInput, styles.chromeAddressInput]}
            onChangeText={setAddressDraft}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onSubmit={() => {
              const target = addressDraft;
              requestControlled("open this address", () =>
                controlledActionsRef.current?.navigate("goto", target),
              );
            }}
          />
          <View ref={actionsAnchorRef} collapsable={false}>
            <ChromeIconButton
              styles={styles}
              theme={theme}
              label="Browser menu"
              icon="EllipsisVertical"
              selected={toolbarMenu === "actions"}
              expanded={toolbarMenu === "actions"}
              onPress={() => toggleToolbarMenu("actions")}
            />
          </View>
        </View>
      </View>

      {runtimeNotice || visibleError || state?.notice ? (
        <ErrorNotice
          styles={styles}
          theme={theme}
          message={runtimeNotice ?? visibleError ?? state?.notice ?? ""}
          action={connectionError || reconnecting ? "Reconnect" : undefined}
          onAction={connectionError || reconnecting ? reconnect : undefined}
          actionDisabled={attachQuery.isFetching}
        />
      ) : null}

      <View style={styles.canvasShell}>
        <BrowserCanvasViewport
          mode={scaleMode}
          style={styles.canvas}
          contentSize={canvasLayout?.contentSize ?? containerSize}
          localPanEnabled={layout.platform === "web" || !canControl}
          onLayout={handleCanvasLayout}
        >
          {buffer.layers.map((layer, slot) => {
            if (!layer) return null;
            const rect = getBrowserCanvasLayout(
              containerSize,
              layer.candidate.frame,
              layer.candidate.viewport ?? state?.viewport ?? layer.candidate.frame,
              scaleMode,
            )?.frameRect;
            if (!rect) return null;
            const visible = slot === buffer.front;
            return (
              <BrowserFrameImage
                key={layer.ticket}
                ticket={layer.ticket}
                visible={visible}
                label={state?.title ? `Workspace browser: ${state.title}` : "Workspace browser frame"}
                settled={settled}
                retry={retryFrameCapture}
                source={layer.source}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                cornerRadius={0}
              />
            );
          })}
          {currentFrame && displayRect ? (
            <View
              ref={canvasInput.canvasRef}
              {...canvasInput.panHandlers}
              accessible={false}
              pointerEvents={liveInputEnabled ? "auto" : "none"}
              style={interactionStyle}
            />
          ) : imageError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Frame could not be displayed"
              detail="The JPEG frame was received but the client could not decode it. Capture will continue."
            />
          ) : connectionError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Connection failed"
              detail="Reconnect to attach a fresh viewer and resume frame capture."
            />
          ) : state?.recoveryState === "runtime-unavailable" || state?.status === "error" ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Browser unavailable"
              detail={state.error ?? "The browser runtime is temporarily unavailable."}
            />
          ) : (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title={
                attachQuery.isPending || reconnecting
                  ? "Connecting to workspace browser"
                  : "Waiting for frame"
              }
              detail="The browser remains active in this workspace when viewers detach."
              loading={attachQuery.isPending || reconnecting || captureQuery.isFetching}
            />
          )}
        </BrowserCanvasViewport>

      </View>

      {composeAvailable ? (
        <ComposeTextControls
          styles={styles}
          theme={theme}
          composeText={canvasInput.composeText}
          cancelInput={canvasInput.cancel}
          enabled={canSendInput}
          ownershipKey={composeOwnershipKey}
          documentKey={composeDocumentKey}
          request={composeRequest}
          onRequestHandled={composeRequestHandled}
          canRequestControl={Boolean(viewerToken) && !canControl}
          onRequestControlForCompose={() =>
            requestControlled(
              "insert the composed text",
              () => controlledActionsRef.current?.openCompose("commit"),
              true,
            )
          }
        />
      ) : null}

      <Modal
        title="Resolution and quality"
        icon={<Icon name="Smartphone" size={18} color={theme.colors.foreground} />}
        open={devicePickerOpen}
        onOpenChange={setDevicePickerOpen}
      >
        <Modal.Content>
          <View style={styles.deviceModalContent}>
            <BrowserResolutionPicker
              theme={theme}
              groups={groupResolutionPresets()}
              selectedPresetId={selectedResolutionPresetId}
              fillViewportResolution={fillViewportResolution}
              fillViewportSelected={fillViewportEnabled}
              fillViewportDetail={fillViewportDetail}
              onFillViewport={() =>
                requestControlled("fill the browser viewport", () =>
                  controlledActionsRef.current?.fillViewport(),
                )
              }
              favoritePresetIds={preferences.favoritePresetIds}
              selectDisabled={!viewerToken || anyMutationPending}
              favoriteDisabled={preferences.disabled}
              density={state?.captureScale ?? 1}
              densityMode={densityMode}
              viewport={state?.viewport ?? null}
              onDensityChange={(density) => {
                requestControlled("change capture density", () =>
                  controlledActionsRef.current?.changeDensity(density),
                );
              }}
              captureQuality={preferences.captureQuality}
              onSelect={(id) =>
                requestControlled("change the browser resolution", () =>
                  controlledActionsRef.current?.selectDevicePreset(id),
                )
              }
              onToggleFavorite={(id) => {
                void preferences.toggleFavorite(id);
              }}
              onQualityChange={(quality) => {
                void preferences.changeQuality(quality);
              }}
            />
            {preferences.error ? (
              <View style={styles.controlStrip}>
                <Text accessibilityRole="alert" style={styles.mutedText}>
                  {preferences.error}
                </Text>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Reload preferences"
                  onPress={preferences.reload}
                />
              </View>
            ) : null}
            <Text style={styles.stripLabel}>Custom viewport</Text>
            {visibleError ? (
              <ErrorNotice styles={styles} theme={theme} message={visibleError} />
            ) : null}
            <View style={styles.customViewportRow}>
              <Field
                styles={styles}
                theme={theme}
                value={viewportWidth}
                accessibilityLabel="Canonical viewport width"
                editable={Boolean(viewerToken) && !resizeMutation.isPending}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={4}
                selectTextOnFocus
                style={styles.viewportField}
                onChangeText={setViewportWidth}
                onSubmit={() =>
                  requestControlled("resize the browser", () =>
                    controlledActionsRef.current?.applyViewport(),
                  )
                }
              />
              <Text style={styles.multiply}>×</Text>
              <Field
                styles={styles}
                theme={theme}
                value={viewportHeight}
                accessibilityLabel="Canonical viewport height"
                editable={Boolean(viewerToken) && !resizeMutation.isPending}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={4}
                selectTextOnFocus
                style={styles.viewportField}
                onChangeText={setViewportHeight}
                onSubmit={() =>
                  requestControlled("resize the browser", () =>
                    controlledActionsRef.current?.applyViewport(),
                  )
                }
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Apply"
                disabled={!viewerToken || anyMutationPending}
                onPress={() =>
                  requestControlled("resize the browser", () =>
                    controlledActionsRef.current?.applyViewport(),
                  )
                }
              />
            </View>
            <Text style={styles.devicePresetDetail}>
              Presets change viewport, touch behavior, and user agent. Rendering remains Chromium.
            </Text>
          </View>
        </Modal.Content>
      </Modal>
      <Modal
        title="Close browser tab?"
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={tabCloseConfirmationOpen}
        onOpenChange={(open) => {
          if (!tabMutationPending) setTabCloseConfirmationOpen(open);
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={tabMutationPending}
                  onPress={() => setTabCloseConfirmationOpen(false)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label={tabMutationPending ? "Closing…" : "Close tab"}
                  danger
                  disabled={!viewerToken || tabMutationPending}
                  onPress={() =>
                    requestControlled("close this tab", () =>
                      controlledActionsRef.current?.confirmCloseTab(),
                    )
                  }
                />
              </>
            }
          >
            This removes the tab for everyone viewing it, including agents. Other tabs stay open.
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <Modal
        title="Close workspace browser?"
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={closeConfirmationOpen}
        onOpenChange={(open) => {
          if (!closePending) setCloseConfirmationOpen(open);
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={closePending}
                  onPress={() => setCloseConfirmationOpen(false)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label={closePending ? "Closing…" : "Close browser"}
                  disabled={!viewerToken || closePending}
                  onPress={() =>
                    requestControlled("close the workspace browser", () =>
                      controlledActionsRef.current?.confirmCloseBrowser(),
                    )
                  }
                />
              </>
            }
          >
            This closes the browser for every viewer and agent in this workspace. The saved site
            data stays available when someone explicitly reopens it.
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <BrowserControlDialog
        styles={styles}
        theme={theme}
        state={state}
        request={controlRequest}
        pending={controlRequestPending}
        available={Boolean(viewerToken)}
        onCancel={() => setControlRequest(null)}
        onConfirm={() => void confirmControlRequest()}
      />
      {toolbarMenu ? (
        <BrowserToolbarMenu
          key={toolbarMenu}
          theme={theme}
          compact={layout.compact}
          title={toolbarMenu === "display" ? "Display options" : "Browser menu"}
          paneRef={paneRef}
          paneSize={paneSize}
          anchorRef={actionsAnchorRef}
          preferredHeight={
            toolbarMenu === "display"
              ? 300 + preferences.favoritePresetIds.length * (layout.compact ? 44 : 36)
              : composeAvailable
                ? 220
                : 132
          }
          onClose={() => closeToolbarMenu()}
          shouldRestoreFocus={() => menuRestoreFocus.current}
          onSubmenuOpen={() => {
            if (canSendInput) setKeysSubmenuOpen(true);
          }}
          submenu={
            toolbarMenu === "actions" && keysSubmenuOpen
              ? {
                  title: "Send keys",
                  anchorRef: keysAnchorRef,
                  preferredHeight: 40 + SPECIAL_KEYS.length * (layout.compact ? 44 : 36),
                  onBack: () => setKeysSubmenuOpen(false),
                  children: SPECIAL_KEYS.map(({ key, label }) => (
                    <BrowserMenuItem
                      key={key}
                      theme={theme}
                      compact={layout.compact}
                      label={label}
                      disabled={!viewerToken || (canControl && !canSendInput)}
                      onPress={() => {
                        closeToolbarMenu();
                        requestControlled(
                          `send ${label}`,
                          () => controlledActionsRef.current?.sendKey(key),
                          true,
                        );
                      }}
                    />
                  )),
                }
              : undefined
          }
        >
          {toolbarMenu === "display" ? (
            <>
              <BrowserMenuHeading theme={theme}>View size</BrowserMenuHeading>
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Fit to panel"
                icon="Minimize"
                selected={scaleMode === "fit"}
                onPress={() => {
                  closeToolbarMenu();
                  setScaleMode("fit");
                }}
              />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Actual size (100%)"
                icon="Maximize"
                selected={scaleMode === "actual"}
                onPress={() => {
                  closeToolbarMenu();
                  setScaleMode("actual");
                }}
              />
              {layout.platform !== "web" && scaleMode === "actual" ? (
                <Text
                  style={[styles.devicePresetDetail, { paddingHorizontal: 12, paddingVertical: 4 }]}
                >
                  Release control to pan this view. While controlling, swipes go to the page.
                </Text>
              ) : null}
              <BrowserMenuSeparator theme={theme} />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Fill viewport"
                icon="Maximize"
                selected={fillViewportEnabled}
                disabled={!viewerToken || anyMutationPending || !fillViewportResolution}
                onPress={() => {
                  closeToolbarMenu();
                  requestControlled("fill the browser viewport", () =>
                    controlledActionsRef.current?.fillViewport(),
                  );
                }}
              />
              <Text
                style={[styles.devicePresetDetail, { paddingHorizontal: 12, paddingVertical: 4 }]}
              >
                {fillViewportDetail}
              </Text>
              <BrowserMenuSeparator theme={theme} />
              <Text style={styles.devicePresetDetail}>{frameSummary}</Text>
              <BrowserMenuHeading theme={theme}>Favorite resolutions</BrowserMenuHeading>
              {preferences.favoritePresetIds.length === 0 ? (
                <Text
                  style={[styles.devicePresetDetail, { paddingHorizontal: 12, paddingVertical: 4 }]}
                >
                  Star resolutions in the full list to add them here.
                </Text>
              ) : (
                preferences.favoritePresetIds.map((id) => {
                  const preset = DEVICE_PRESETS.find((item) => item.id === id);
                  return preset ? (
                    <BrowserMenuItem
                      key={id}
                      theme={theme}
                      compact={layout.compact}
                      label={preset.label}
                      icon={preset.isMobile ? "Smartphone" : "Monitor"}
                      selected={selectedResolutionPresetId === id}
                      disabled={!viewerToken || anyMutationPending}
                      onPress={() => {
                        closeToolbarMenu();
                        requestControlled("change the browser resolution", () =>
                          controlledActionsRef.current?.selectDevicePreset(id),
                        );
                      }}
                    />
                  ) : null;
                })
              )}
              <BrowserMenuSeparator theme={theme} />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="All resolutions and quality"
                icon="Settings2"
                onPress={() => {
                  closeToolbarMenu(false);
                  setDevicePickerOpen(true);
                }}
              />
            </>
          ) : (
            <>
              <BrowserMenuItem theme={theme} compact={layout.compact} label="Display options" icon="Monitor"
                onPress={() => setToolbarMenu("display")} />
              <BrowserMenuItem theme={theme} compact={layout.compact}
                label={`${emulation.mode === "mobile" ? "Disable" : "Enable"} mobile emulation`} icon="Smartphone"
                disabled={!viewerToken || anyMutationPending} onPress={() => {
                  closeToolbarMenu();
                  requestControlled("change mobile emulation", () => controlledActionsRef.current?.toggleEmulation());
                }} />
              {onWatchExternal ? <BrowserMenuItem theme={theme} compact={layout.compact}
                label="Watch external browser" icon="Eye" onPress={onWatchExternal} /> : null}
              <BrowserMenuSeparator theme={theme} />
              {composeAvailable ? (
                <BrowserMenuItem
                  theme={theme}
                  compact={layout.compact}
                  label="Compose text"
                  icon="Pencil"
                  disabled={!viewerToken || (canControl && !canSendInput)}
                  onPress={() => {
                    closeToolbarMenu();
                    requestControlled(
                      "compose browser text",
                      () => controlledActionsRef.current?.openCompose("compose"),
                      true,
                    );
                  }}
                />
              ) : null}
              <View ref={keysAnchorRef}>
                <BrowserMenuItem
                  theme={theme}
                  compact={layout.compact}
                  label="Send keys"
                  icon="Keyboard"
                  expanded={keysSubmenuOpen}
                  disabled={!viewerToken || (canControl && !canSendInput)}
                  onPress={() =>
                    requestControlled("send browser keys", () => setKeysSubmenuOpen(true))
                  }
                />
              </View>
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Reconnect viewer"
                icon="RotateCw"
                disabled={attachQuery.isFetching}
                onPress={() => {
                  closeToolbarMenu();
                  reconnect();
                }}
              />
              <BrowserMenuSeparator theme={theme} />
              <BrowserMenuItem
                theme={theme}
                compact={layout.compact}
                label="Close workspace browser"
                icon="X"
                disabled={!viewerToken || anyMutationPending}
                onPress={() => {
                  closeToolbarMenu(false);
                  requestControlled("close the workspace browser", () =>
                    controlledActionsRef.current?.closeBrowser(),
                  );
                }}
              />
            </>
          )}
        </BrowserToolbarMenu>
      ) : null}
    </View>
  );
}
