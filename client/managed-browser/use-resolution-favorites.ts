/**
 * Revisioned host favorites. Stars use the same settings/CAS service as neighboring
 * plugins; conflicts stay visible until reload, and no write is replayed. An old
 * host's completion cannot clear a newer host's pending action or expose its error.
 */
import { useSettings } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import {
  type BrowserDisplayPreferences,
  browserDisplayPreferences,
} from "../../shared/managed-browser/browser-display-preferences";
import { DEFAULT_CAPTURE_QUALITY } from "../../shared/managed-browser/capture-settings";
import type { DevicePresetId } from "../../shared/managed-browser/device-presets";
import {
  normalizeResolutionFavorites,
  orderedResolutionFavorites,
  toggleResolutionFavorite,
} from "../../shared/managed-browser/resolution-menu";
import { DEFAULT_VIDEO_BITRATE, DEFAULT_VIDEO_FPS } from "../../shared/managed-browser/video-settings";

/** Call with the surface's host.id; persistence itself is scoped by Paseo. */
export function useResolutionFavorites(hostId: string) {
  const settings = useSettings(browserDisplayPreferences);
  const currentHost = useRef(hostId);
  currentHost.current = hostId;
  const pending = useRef<{ hostId: string } | null>(null);
  const [pendingHost, setPendingHost] = useState<string | null>(null);
  const saving = settings.saving || pendingHost === hostId;
  const disabled = settings.status !== "ready" || saving;
  const favoritePresetIds =
    settings.status === "ready"
      ? orderedResolutionFavorites(settings.values.favoritePresetIds)
      : [];
  const error =
    settings.status === "error" || settings.status === "invalid"
      ? settings.error
      : settings.saveError;

  const savePreferences = async (
    update: (values: BrowserDisplayPreferences) => BrowserDisplayPreferences,
  ): Promise<boolean> => {
    if (
      currentHost.current !== hostId ||
      settings.status !== "ready" ||
      settings.saving ||
      pending.current?.hostId === hostId
    )
      return false;
    const operation = { hostId };
    pending.current = operation;
    setPendingHost(hostId);
    try {
      const saved = await settings.save(update(settings.values), settings.revision);
      return currentHost.current === hostId && saved;
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setPendingHost(null);
      }
    }
  };

  return {
    favoritePresetIds,
    captureQuality:
      settings.status === "ready" ? settings.values.captureQuality : DEFAULT_CAPTURE_QUALITY,
    loading: settings.status === "loading",
    saving,
    disabled,
    error,
    toggleFavorite: (id: DevicePresetId) => {
      if (normalizeResolutionFavorites([id]).length === 0) return Promise.resolve(false);
      return savePreferences((values) => ({
        ...values,
        favoritePresetIds: toggleResolutionFavorite(values.favoritePresetIds, id),
      }));
    },
    changeQuality: (captureQuality: BrowserDisplayPreferences["captureQuality"]) =>
      savePreferences((values) => ({ ...values, captureQuality })),
    reload: settings.reload,
    resetPreferences: settings.reset,
  };
}
