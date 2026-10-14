/**
 * Owns bounded video decode/presentation and correlates each rendered source
 * timestamp with its server-issued input authority. The web adapter supplies
 * codecs and drawing; this module has no DOM globals and remains Hermes-safe.
 */
import type { BrowserVideoPacket } from "../../shared/managed-browser/browser-video";

export interface DecodedBrowserVideoFrame {
  readonly timestamp: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}
export interface BrowserVideoCodec {
  readonly decodeQueueSize: number;
  configure(config: {
    codec: string;
    codedWidth: number;
    codedHeight: number;
    description?: Uint8Array;
    optimizeForLatency: boolean;
  }): void;
  decode(chunk: unknown): void;
  close(): void;
}
export interface BrowserVideoDecodeEnvironment {
  createDecoder(callbacks: {
    output(frame: DecodedBrowserVideoFrame): void;
    error(error: unknown): void;
    /** Native queue capacity can free without producing a frame. */
    dequeue(): void;
  }): BrowserVideoCodec;
  /** Native bridges already carry base64; avoid decoding and re-encoding each packet in Hermes. */
  createEncodedChunk?(input: {
    type: "key" | "delta";
    timestamp: number;
    dataBase64: string;
  }): unknown;
  createChunk(input: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): unknown;
  decodeBase64(data: string): Uint8Array;
  /** Schedule a draw on the next local paint; return an idempotent cancellation. */
  scheduleDraw(draw: () => void): () => void;
  draw(frame: DecodedBrowserVideoFrame): void | Promise<void>;
}
export interface BrowserVideoDecoderOptions {
  environment: BrowserVideoDecodeEnvironment;
  isCurrent(packet: BrowserVideoPacket, mutationEpoch: number): boolean;
  /** Optional exact current source/document/geometry check, independent of a
   * local press epoch. Allows continuous visual decode without granting input. */
  isSourceCurrent?(packet: BrowserVideoPacket): boolean;
  /** Carries the original read epoch; caller separately admits input authority. */
  onPresented(packet: BrowserVideoPacket, mutationEpoch: number): void;
  onNeedKeyFrame(): void;
  onError(error: unknown): void;
}

const MAX_PENDING_FRAMES = 64;
const MAX_DECODE_QUEUE = 4;
const MAX_BUFFERED_BASE64_CHARACTERS = 8 * 1024 * 1024;

/** Decode a bounded continuous source chain. A caller opting into source-only
 * visuals must keep the original epoch when separately admitting input. */
export function createBrowserVideoDecoder(options: BrowserVideoDecoderOptions) {
  const { environment } = options;
  const canPresent = (packet: BrowserVideoPacket, epoch: number) =>
    options.isSourceCurrent ? options.isSourceCurrent(packet) : options.isCurrent(packet, epoch);
  let closed = false;
  let codec: BrowserVideoCodec | null = null;
  let decoderGeneration = 0;
  let streamKey: string | null = null;
  let sequence = 0;
  let lastPresentedTimestamp = -1;
  let scheduled: (() => void) | null = null;
  let painting = false;
  let paint: { frame: DecodedBrowserVideoFrame; packet: BrowserVideoPacket; epoch: number } | null =
    null;
  const pending = new Map<number, { packet: BrowserVideoPacket; epoch: number }>();
  const queued: { packet: BrowserVideoPacket; epoch: number }[] = [];
  let bufferedCharacters = 0;
  let draining = false;

  const reset = () => {
    decoderGeneration += 1;
    scheduled?.();
    scheduled = null;
    paint?.frame.close();
    paint = null;
    pending.clear();
    queued.length = 0;
    bufferedCharacters = 0;
    try {
      codec?.close();
    } catch {
      /* Closing an errored decoder is best-effort. */
    }
    codec = null;
    streamKey = null;
    sequence = 0;
    lastPresentedTimestamp = -1;
  };

  const fail = (error: unknown) => {
    if (closed) return;
    reset();
    options.onError(error);
  };

  /** Preserve the dependency chain while the native decoder is busy. Both actual
   * output and dequeue wake this bounded FIFO; no timer or repeated key reset is
   * needed merely because a relay delivered a normal packet batch at once. */
  const drain = () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (codec && codec.decodeQueueSize < MAX_DECODE_QUEUE && queued.length) {
        const entry = queued.shift()!;
        if (!canPresent(entry.packet, entry.epoch)) {
          reset();
          options.onNeedKeyFrame();
          return;
        }
        pending.set(entry.packet.timestampUs, entry);
        let chunk: unknown;
        if (environment.createEncodedChunk) {
          chunk = environment.createEncodedChunk({
            type: entry.packet.type,
            timestamp: entry.packet.timestampUs,
            dataBase64: entry.packet.dataBase64,
          });
        } else {
          chunk = environment.createChunk({
            type: entry.packet.type,
            timestamp: entry.packet.timestampUs,
            data: environment.decodeBase64(entry.packet.dataBase64),
          });
        }
        codec.decode(chunk);
      }
    } catch (error) {
      fail(error);
    } finally {
      draining = false;
    }
  };

  const output = (frame: DecodedBrowserVideoFrame, generation: number) => {
    if (generation !== decoderGeneration) {
      frame.close();
      return;
    }
    const entry = pending.get(frame.timestamp);
    pending.delete(frame.timestamp);
    if (entry) bufferedCharacters -= entry.packet.dataBase64.length;
    drain();
    if (
      closed ||
      generation !== decoderGeneration ||
      !entry ||
      !canPresent(entry.packet, entry.epoch) ||
      frame.timestamp <= lastPresentedTimestamp
    ) {
      frame.close();
      return;
    }
    if (frame.displayWidth !== entry.packet.width || frame.displayHeight !== entry.packet.height) {
      frame.close();
      fail(new Error("Decoded video dimensions do not match the current browser view."));
      return;
    }
    if (paint && frame.timestamp <= paint.frame.timestamp) {
      frame.close();
      return;
    }
    // Keep only the newest decoded frame while the local compositor is delayed.
    paint?.frame.close();
    paint = { frame, packet: entry.packet, epoch: entry.epoch };
    schedulePaint();
  };

  /** Native paint crosses an asynchronous bridge. Serialize presentations so a
   * newer frame cannot replace the pixels while an older receipt is admitted. */
  const schedulePaint = () => {
    if (scheduled || painting || !paint || closed) return;
    const generation = decoderGeneration;
    scheduled = environment.scheduleDraw(() => {
      scheduled = null;
      const selected = paint;
      paint = null;
      if (!selected) return;
      const complete = () => {
        if (
          !closed &&
          generation === decoderGeneration &&
          canPresent(selected.packet, selected.epoch)
        ) {
          lastPresentedTimestamp = selected.frame.timestamp;
          options.onPresented(selected.packet, selected.epoch);
        }
      };
      const release = () => {
        selected.frame.close();
        painting = false;
        schedulePaint();
      };
      try {
        if (
          closed ||
          generation !== decoderGeneration ||
          !canPresent(selected.packet, selected.epoch)
        ) {
          release();
          return;
        }
        const result = environment.draw(selected.frame);
        if (!result) {
          complete();
          release();
          return;
        }
        painting = true;
        void (async () => {
          try {
            await result;
            complete();
          } catch (error) {
            if (!closed && generation === decoderGeneration) fail(error);
          } finally {
            release();
          }
        })();
      } catch (error) {
        if (generation === decoderGeneration) fail(error);
        release();
      }
    });
  };

  return {
    /** Returns false when a new keyframe is needed; never feeds a decoder an unknown delta chain. */
    receive(packet: BrowserVideoPacket, mutationEpoch: number): boolean {
      if (closed || !canPresent(packet, mutationEpoch)) return false;
      const identity = JSON.stringify([
        packet.streamId,
        packet.captureGeneration,
        packet.codec,
        packet.width,
        packet.height,
        packet.frame.sessionId,
        packet.frame.runtimeId,
        packet.frame.captureEpoch,
        packet.frame.navigationGeneration,
        packet.frame.viewportGeneration,
      ]);
      if (streamKey !== identity) reset();
      if (codec && packet.sequence <= sequence) return true;
      // A complete new key can replace unsubmitted old pictures under decode
      // pressure. Preserve the visible canvas and original receipt/epoch checks;
      // a delta can never perform this catch-up because it needs its old chain.
      if (codec && packet.type === "key" && queued.length > 0) reset();
      if (
        (codec && packet.sequence !== sequence + 1) ||
        pending.size + queued.length >= MAX_PENDING_FRAMES ||
        bufferedCharacters + packet.dataBase64.length > MAX_BUFFERED_BASE64_CHARACTERS
      ) {
        reset();
      }
      if (!codec && packet.type !== "key") {
        options.onNeedKeyFrame();
        return false;
      }
      try {
        if (!codec) {
          const generation = decoderGeneration;
          codec = environment.createDecoder({
            output: (frame) => output(frame, generation),
            error: (error) => {
              if (generation === decoderGeneration) fail(error);
            },
            dequeue: () => {
              if (generation === decoderGeneration) drain();
            },
          });
          codec.configure({
            codec: packet.codec,
            codedWidth: packet.width,
            codedHeight: packet.height,
            ...(packet.descriptionBase64
              ? { description: environment.decodeBase64(packet.descriptionBase64) }
              : {}),
            optimizeForLatency: true,
          });
          streamKey = identity;
        }
        sequence = packet.sequence;
        bufferedCharacters += packet.dataBase64.length;
        queued.push({ packet, epoch: mutationEpoch });
        drain();
        return codec !== null;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    reset,
    close() {
      if (closed) return;
      closed = true;
      reset();
    },
  };
}
