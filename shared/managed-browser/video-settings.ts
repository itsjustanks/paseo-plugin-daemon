/** Bounded viewer encoder profiles. Settings affect encoded output only, never
 * page layout, pixel density, control ownership or another viewer's encoder. */
import { z } from "zod";
export const VIDEO_BITRATES = [2_000_000, 5_000_000, 12_000_000, 24_000_000] as const;
export const VIDEO_FRAME_RATES = [15, 30, 60] as const;
export const DEFAULT_VIDEO_BITRATE = 12_000_000;
export const DEFAULT_VIDEO_FPS = 30;
export const VIDEO_ENCODER_LIMIT = 3;
export const VIDEO_ENCODER_IDLE_MS = 2_000;
export const videoBitrateSchema = z.union(VIDEO_BITRATES.map((value) => z.literal(value)));
export const videoFrameRateSchema = z.union(VIDEO_FRAME_RATES.map((value) => z.literal(value)));
export const videoEncoderSettingsSchema = z.object({
  bitrate: videoBitrateSchema,
  fps: videoFrameRateSchema,
});
export type VideoEncoderSettings = z.infer<typeof videoEncoderSettingsSchema>;
const LEGACY_BITRATES = { low: 2_000_000, medium: 5_000_000, high: 12_000_000 } as const;
/** Legacy profile callers retain their exact bitrate; new callers supply explicit
 * bounded values. Unknown values fail before allocating a helper or encoder. */
export function resolveVideoEncoderSettings(input: {
  quality?: "low" | "medium" | "high";
  bitrate?: number;
  fps?: number;
}): VideoEncoderSettings {
  return videoEncoderSettingsSchema.parse({
    bitrate: input.bitrate ?? LEGACY_BITRATES[input.quality ?? "high"],
    fps: input.fps ?? DEFAULT_VIDEO_FPS,
  });
}
/** Canonical key includes both encoder settings, avoiding bitrate/FPS aliasing. */
export function videoEncoderKey(settings: VideoEncoderSettings): string {
  const value = videoEncoderSettingsSchema.parse(settings);
  return `${value.bitrate}:${value.fps}`;
}
