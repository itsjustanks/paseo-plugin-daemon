/** Local mode defaults and remembered behavior profiles, independent of shared display size. */

import type { BrowserState } from "../../shared/managed-browser/browser";
import { DEVICE_PRESETS, type DevicePresetId } from "../../shared/managed-browser/device-presets";

export type BrowserEmulationMode = "desktop" | "mobile";
export type EmulationSelection = { presetId: DevicePresetId; preserveDisplay: true };
interface LocalDevice {
  platform: "ios" | "android" | "web";
  userAgent?: string;
  mobile?: boolean;
  maxTouchPoints?: number;
}

/** Compact layout can mean a narrow desktop window, so it never determines device identity. */
export function localEmulationMode(device: LocalDevice): BrowserEmulationMode {
  if (device.platform !== "web") return "mobile";
  if (
    device.mobile === true ||
    (/Macintosh/i.test(device.userAgent ?? "") && (device.maxTouchPoints ?? 0) > 1) ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent ?? "")
  )
    return "mobile";
  return "desktop";
}

/** Browser hints are local presentation facts, not remote browser or authentication data. */
export function readLocalDevice(platform: LocalDevice["platform"]): LocalDevice {
  const browser = globalThis as unknown as {
    navigator?: {
      userAgent?: string;
      maxTouchPoints?: number;
      userAgentData?: { mobile?: boolean };
    };
  };
  const userAgent = browser.navigator?.userAgent;
  const mobile = browser.navigator?.userAgentData?.mobile;
  const maxTouchPoints = browser.navigator?.maxTouchPoints;
  return {
    platform,
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(mobile === undefined ? {} : { mobile }),
    ...(maxTouchPoints === undefined ? {} : { maxTouchPoints }),
  };
}

/** The configured profile defines behavior even when its native dimensions are overridden. */
export function selectionMode(presetId: DevicePresetId | null): BrowserEmulationMode {
  return DEVICE_PRESETS.find((preset) => preset.id === presetId)?.isMobile ? "mobile" : "desktop";
}

/** A profile ID alone must not check a resolution that differs from the actual display. */
export function matchingResolutionPresetId(
  state: Pick<BrowserState, "devicePresetId" | "viewport" | "captureScale"> | null,
): DevicePresetId | null {
  if (!state) return null;
  const preset = DEVICE_PRESETS.find((item) => item.id === state.devicePresetId);
  return preset &&
    preset.viewport.width === state.viewport.width &&
    preset.viewport.height === state.viewport.height &&
    preset.captureScale === state.captureScale
    ? preset.id
    : null;
}

/** One device default per mounted host/workspace; later explicit choices survive releasing control. */
export function createEmulationChoices(device: LocalDevice) {
  const defaultMode = localEmulationMode(device);
  const mobilePreset: DevicePresetId =
    device.platform === "ios" ||
    /iPhone|iPad|iPod/i.test(device.userAgent ?? "") ||
    (/Macintosh/i.test(device.userAgent ?? "") && (device.maxTouchPoints ?? 0) > 1)
      ? "iphone-15-pro"
      : "pixel-7-sharp";
  let initialized = false;
  const profiles: Record<BrowserEmulationMode, DevicePresetId> = {
    desktop: "desktop-chrome",
    mobile: mobilePreset,
  };
  return {
    remember(presetId: DevicePresetId | null) {
      if (presetId) profiles[selectionMode(presetId)] = presetId;
    },
    claimDefault(currentMode: BrowserEmulationMode): EmulationSelection | null {
      if (initialized) return null;
      initialized = true;
      return currentMode === defaultMode
        ? null
        : { presetId: profiles[defaultMode], preserveDisplay: true };
    },
    toggle(currentMode: BrowserEmulationMode): EmulationSelection {
      return {
        presetId: profiles[currentMode === "mobile" ? "desktop" : "mobile"],
        preserveDisplay: true,
      };
    },
  };
}
