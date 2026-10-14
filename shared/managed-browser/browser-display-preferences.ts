/**
 * Host-persisted display favorites through Paseo's settings service. These values
 * affect viewing quality and picker convenience, never input ownership, page
 * navigation, emulation or pixel density. Version1 migration retains the bitrate
 * formerly coupled to JPEG quality.
 * Retired IDs remain parseable; the current catalogue prunes them at the view.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_CAPTURE_QUALITY } from "./capture-settings";
import { DEVICE_PRESETS } from "./device-presets";
import {
  resolveVideoEncoderSettings,
  videoBitrateSchema,
  videoFrameRateSchema,
} from "./video-settings";

export const browserDisplayPreferencesSchema = z.object({
  captureQuality: z.enum(["low", "medium", "high", "maximum"]).default(DEFAULT_CAPTURE_QUALITY),
  videoBitrate: videoBitrateSchema.default(12_000_000),
  videoFps: videoFrameRateSchema.default(30),
  favoritePresetIds: z.array(z.string().min(1).max(128)).max(DEVICE_PRESETS.length).default([]),
});

export type BrowserDisplayPreferences = z.output<typeof browserDisplayPreferencesSchema>;

/** One revisioned document per plugin host, shared across that host's panels. */
export const browserDisplayPreferences = defineSettings({
  id: "browser-display-preferences",
  scope: "host",
  version: 2,
  migrate(values, fromVersion) {
    if (fromVersion !== 1 || !values || typeof values !== "object") return values;
    const previous = values as Record<string, unknown>;
    const quality =
      previous.captureQuality === "low" || previous.captureQuality === "medium"
        ? previous.captureQuality
        : "high";
    return {
      ...previous,
      videoBitrate: resolveVideoEncoderSettings({ quality }).bitrate,
      videoFps: 30,
    };
  },
  schema: browserDisplayPreferencesSchema,
});
