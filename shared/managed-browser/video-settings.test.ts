import { expect, it } from "vitest";
import { captureBrowserRpc } from "./browser";
import {
  browserDisplayPreferences,
  browserDisplayPreferencesSchema,
} from "./browser-display-preferences";
import { readBrowserVideoRpc } from "./browser-video";
import { JPEG_QUALITY } from "./capture-settings";
import { resolveVideoEncoderSettings, videoEncoderKey } from "./video-settings";

it("retains current defaults and migrates the old coupled quality without losing favorites", () => {
  expect(resolveVideoEncoderSettings({})).toEqual({ bitrate: 12_000_000, fps: 30 });
  const migrated = browserDisplayPreferences.migrate?.(
    { captureQuality: "low", favoritePresetIds: ["pixel-7-sharp"] },
    1,
  );
  expect(browserDisplayPreferencesSchema.parse(migrated)).toEqual({
    captureQuality: "low",
    videoBitrate: 2_000_000,
    videoFps: 30,
    favoritePresetIds: ["pixel-7-sharp"],
  });
});
it("accepts explicit JPEG100 and video24Mbps60fps, and refuses arbitrary settings", () => {
  const viewerToken = "v".repeat(32);
  expect(captureBrowserRpc.input.parse({ viewerToken, quality: "maximum" }).quality).toBe(
    "maximum",
  );
  expect(JPEG_QUALITY.maximum).toBe(100);
  expect(
    readBrowserVideoRpc.input.parse({ viewerToken, bitrate: 24_000_000, fps: 60 }),
  ).toMatchObject({ bitrate: 24_000_000, fps: 60 });
  for (const invalid of [{ bitrate: 25_000_000 }, { fps: 120 }, { fps: NaN }, { bitrate: 0 }])
    expect(readBrowserVideoRpc.input.safeParse({ viewerToken, ...invalid }).success).toBe(false);
  expect(videoEncoderKey(resolveVideoEncoderSettings({ bitrate: 24_000_000, fps: 15 }))).toBe(
    "24000000:15",
  );
});
