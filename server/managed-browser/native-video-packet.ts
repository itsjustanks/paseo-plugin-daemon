/** Private supervisor receipts share one Node monotonic clock domain. */
import { z } from "zod";
import { nativeVideoPacketSchema } from "../../shared/managed-browser/browser-video";

/** The native capture owns this timestamp; it is removed before public RPC output. */
export const runtimeVideoPacketSchema = nativeVideoPacketSchema.extend({
  capturedAtMonotonicMs: z.number().finite(),
});
export type RuntimeVideoPacket = z.infer<typeof runtimeVideoPacketSchema>;
