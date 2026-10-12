/**
 * Encoded browser-tab video over the existing authenticated Paseo RPC transport.
 * Opt-in on the daemon and decoded by WebCodecs on the web; every other client retains JPEG.
 * Packets never grant control; only a decoded
 * presentation with current browser authority can provide an input target.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { browserFrameSchema, browserStateSchema } from "./browser";
import { videoBitrateSchema, videoFrameRateSchema } from "./video-settings";
import { MAX_VIEWPORT } from "./viewport-limits";

export const VIDEO_MAX_PACKET_BYTES = 2 * 1024 * 1024;
export const VIDEO_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const VIDEO_MAX_BATCH_PACKETS = 32;
export const VIDEO_MAX_WAIT_MS = 500;
export const VIDEO_FRAME_RATE = 30;
/** Maximum future source-clock skew admitted by the calibrated native capture. */
export const VIDEO_SOURCE_CLOCK_TOLERANCE_MS = 50;

const opaqueIdSchema = browserFrameSchema.shape.frameId;
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base64PacketSchema = z
  .string()
  .min(1)
  .max(Math.ceil(VIDEO_MAX_PACKET_BYTES / 3) * 4);

/** Geometry and generation shared by JPEG and decoded video input admission. */
export const browserFrameAuthoritySchema = browserFrameSchema.omit({
  mimeType: true,
  transport: true,
  dataBase64: true,
  byteLength: true,
});
export type BrowserFrameAuthority = z.infer<typeof browserFrameAuthoritySchema>;

/** Native encoded output; timestamps are source VideoFrame microseconds, not wall-clock time. */
export const nativeVideoPacketSchema = z.object({
  streamId: opaqueIdSchema,
  captureGeneration: sequenceSchema,
  sequence: sequenceSchema,
  timestampUs: sequenceSchema,
  type: z.enum(["key", "delta"]),
  codec: z.string().min(1).max(64),
  width: z.number().int().positive().max(MAX_VIEWPORT.width),
  height: z.number().int().positive().max(MAX_VIEWPORT.height),
  descriptionBase64: z.string().max(16_384).optional(),
  dataBase64: base64PacketSchema,
  capturedAt: z.string().datetime(),
});
export type NativeVideoPacket = z.infer<typeof nativeVideoPacketSchema>;

export const browserVideoPacketSchema = nativeVideoPacketSchema.extend({
  frame: browserFrameAuthoritySchema,
  /** False when the host refused this capture as an input receipt (it predates
   * acknowledged input). It may still be painted. Absent from older hosts. */
  actionable: z.boolean().optional(),
});
export type BrowserVideoPacket = z.infer<typeof browserVideoPacketSchema>;

export const readBrowserVideoRpc = defineRpc({
  name: "daemon-link.browser.managed.video.read",
  input: z.object({
    viewerToken: opaqueIdSchema,
    quality: z.enum(["low", "medium", "high"]).default("high"),
    bitrate: videoBitrateSchema.optional(),
    fps: videoFrameRateSchema.optional(),
    streamId: opaqueIdSchema.nullable().default(null),
    afterSequence: sequenceSchema.default(0),
    requestKeyFrame: z.boolean().default(false),
    waitMs: z.number().int().min(0).max(VIDEO_MAX_WAIT_MS).default(250),
  }),
  output: z.object({
    state: browserStateSchema,
    status: z.enum(["ready", "waiting", "reset", "unsupported"]),
    streamId: opaqueIdSchema.nullable(),
    packets: z.array(browserVideoPacketSchema).max(VIDEO_MAX_BATCH_PACKETS),
    reason: z.string().max(256).optional(),
    reasonCode: z.enum(["encoder-capacity", "video-disabled"]).optional(),
  }),
});
export type BrowserVideoReadInput = z.infer<typeof readBrowserVideoRpc.input>;
export type BrowserVideoReadReply = z.infer<typeof readBrowserVideoRpc.output>;
