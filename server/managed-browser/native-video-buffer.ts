/** Bounded per-encoder packet history. Gaps return a fresh keyframe, never a broken delta chain. */
import {
  VIDEO_MAX_BATCH_BYTES,
  VIDEO_MAX_BATCH_PACKETS,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../../shared/managed-browser/browser-video";
import type { RuntimeVideoPacket } from "./native-video-packet";
export const NATIVE_VIDEO_MAX_AGE_MS = 1000;
const MAX_RING_BYTES = 8 * 1024 * 1024;
export interface VideoSourceClock {
  sourceMs: number;
  monotonicMs: number;
}
/** Map Chromium TimeTicks into Node elapsed time and validate source age.
 * Wall-clock corrections affect outward metadata only, never retained freshness. */
export function videoSourceTime(
  timestampUs: number,
  clock: VideoSourceClock,
  nowMonotonicMs: number,
  nowWallMs: number,
): Pick<RuntimeVideoPacket, "capturedAt" | "capturedAtMonotonicMs"> | null {
  const elapsedMs = timestampUs / 1000 - clock.sourceMs;
  const capturedAtMonotonicMs = clock.monotonicMs + elapsedMs;
  const ageMs = nowMonotonicMs - capturedAtMonotonicMs;
  if (
    !Number.isFinite(ageMs) ||
    ageMs < -VIDEO_SOURCE_CLOCK_TOLERANCE_MS ||
    ageMs > NATIVE_VIDEO_MAX_AGE_MS
  )
    return null;
  // Wall time is presentation metadata only. Calibrating it once would make
  // NTP/WSL clock corrections turn fresh pixels into future or expired frames.
  return {
    capturedAt: new Date(nowWallMs - ageMs).toISOString(),
    capturedAtMonotonicMs,
  };
}
/** Retain source receipts with dependency-safe cursors. Read clocks are Node elapsed milliseconds. */
export function createNativeVideoBuffer() {
  let packets: RuntimeVideoPacket[] = [];
  let bytes = 0;
  let lastSequence = 0;
  let needsKey = true;
  const size = (packet: RuntimeVideoPacket) => Buffer.byteLength(packet.dataBase64, "base64");
  return {
    /** Caller already validated identity/source age. A missing sequence suppresses dependent deltas. */
    add(packet: RuntimeVideoPacket): boolean {
      if (packet.sequence <= lastSequence) return false;
      if (lastSequence && packet.sequence !== lastSequence + 1) needsKey = true;
      lastSequence = packet.sequence;
      if (needsKey && packet.type !== "key") return false;
      if (packet.type === "key") needsKey = false;
      packets.push(packet);
      bytes += size(packet);
      while (packets.length > VIDEO_MAX_BATCH_PACKETS || bytes > MAX_RING_BYTES) {
        const removed = packets.shift();
        if (removed) bytes -= size(removed);
      }
      return true;
    },
    clear(): void {
      packets = [];
      bytes = 0;
      needsKey = true;
    },
    /** Ask for a fresh key only when this reader cannot recover its retained chain.
     * No observed packet yet and an up-to-date decoder waiting for its next delta
     * are ordinary waiting, not reasons to generate repeated recovery keys. */
    needsKeyFrame(afterSequence: number, nowMonotonicMs: number): boolean {
      if (!lastSequence) return false;
      if (needsKey) return true;
      const fresh = packets.filter(
        (packet) =>
          nowMonotonicMs - packet.capturedAtMonotonicMs >= -VIDEO_SOURCE_CLOCK_TOLERANCE_MS &&
          nowMonotonicMs - packet.capturedAtMonotonicMs <= NATIVE_VIDEO_MAX_AGE_MS,
      );
      const first = fresh[0];
      if (!first) return afterSequence < lastSequence;
      if (afterSequence === 0 || afterSequence < first.sequence - 1) {
        return !fresh.some((packet) => packet.type === "key");
      }
      return false;
    },
    /** Returning no packet is honest when all retained source receipts are older than one second. */
    read(afterSequence: number, nowMonotonicMs: number): RuntimeVideoPacket[] {
      let candidates = packets.filter(
        (packet) =>
          nowMonotonicMs - packet.capturedAtMonotonicMs >= -VIDEO_SOURCE_CLOCK_TOLERANCE_MS &&
          nowMonotonicMs - packet.capturedAtMonotonicMs <= NATIVE_VIDEO_MAX_AGE_MS,
      );
      const first = candidates[0];
      if (!first) return [];
      candidates = candidates.filter((packet) => packet.sequence > afterSequence);
      // An independently decodable newer key supersedes all earlier pictures.
      // Catch up before serialization/transport instead of sending a stale GOP.
      // Never skip an arbitrary delta: its successor can depend on that picture.
      const keyIndex = candidates.findLastIndex((packet) => packet.type === "key");
      if (keyIndex >= 0) {
        candidates = candidates.slice(keyIndex);
      } else if (afterSequence < first.sequence - 1 || afterSequence === 0) {
        return [];
      }
      let batchBytes = 0;
      const batch: RuntimeVideoPacket[] = [];
      for (const packet of candidates) {
        const packetBytes = size(packet);
        if (batchBytes + packetBytes > VIDEO_MAX_BATCH_BYTES) break;
        batchBytes += packetBytes;
        batch.push(packet);
      }
      return batch;
    },
  };
}
