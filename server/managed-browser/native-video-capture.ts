import { setTimeout, clearTimeout, setInterval, clearInterval } from "./node-timers";
/**
 * Exact-tab native video acquisition, independently consumed from the input queue.
 * The helper is a trusted hidden extension page, controlled only through its own
 * CDP session. Receipts preserve native source age, never binding-arrival freshness.
 * Stop/replacement revokes pending starts, callbacks, reads, and every encoder.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  type NativeVideoPacket,
  VIDEO_MAX_WAIT_MS,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../../shared/managed-browser/browser-video";
import {
  resolveVideoEncoderSettings,
  VIDEO_ENCODER_IDLE_MS,
  VIDEO_ENCODER_LIMIT,
  type VideoEncoderSettings,
  videoEncoderKey,
} from "../../shared/managed-browser/video-settings";
import { attachToTarget, type CdpConnection, type CdpSession, CdpUnavailableError } from "./cdp";
import {
  createNativeVideoBuffer,
  type VideoSourceClock,
  videoSourceTime,
} from "./native-video-buffer";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";
import { type RuntimeVideoPacket, runtimeVideoPacketSchema } from "./native-video-packet";
import type { VideoSourceFailureCode } from "./video-source-recovery";
export type NativeVideoQuality = "low" | "medium" | "high";
export interface NativeVideoRead {
  status: "ready" | "waiting" | "reset" | "unsupported";
  streamId: string | null;
  packets: RuntimeVideoPacket[];
  reason?: string;
  reasonCode?: "encoder-capacity" | "video-disabled";
}
interface EncoderState {
  streamId: string;
  buffer: ReturnType<typeof createNativeVideoBuffer>;
  ready: Promise<void>;
  failure: string | null;
  lastRequestedAt: number;
  activeReads: number;
  /** Coalesce recovery demand while a key is pending; retry only after a bounded wait. */
  keyRequestedAt: number;
}
class VideoEncoderLimitError extends Error {}
interface Evaluation<T> {
  result?: { value?: T };
  exceptionDetails?: unknown;
}
export interface NativeVideoCaptureOptions {
  connection: CdpConnection;
  targetId: string;
  width: number;
  height: number;
  /** Exact owning attachment, including retained emulation, must still be current. */
  isCurrent(): boolean;
  /** Local monotonic time for cohort expiry, separate from native frame timestamps. */
  now?(): number;
}
const HELPER_READY_EXPRESSION = `new Promise((resolve) => {
  if (document.readyState === "complete") resolve();
  else addEventListener("load", () => resolve(), { once: true });
}).then(() => typeof startCapture === "function")`;

export class NativeVideoCapture {
  private helper: CdpSession | null = null;
  private helperTargetId: string | null = null;
  private readonly encoders = new Map<string, EncoderState>();
  private encoderChanges: Promise<void> = Promise.resolve();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private idleMaintenance: Promise<void> | null = null;
  private readonly waiters = new Set<() => void>();
  private clock: VideoSourceClock | null = null;
  private stopped = false;
  private idleStopped = false;
  private closing: Promise<void> | null = null;
  private lastDemandAt: number;
  private pendingSourceReads = 0;
  private generation = 1;
  private failure: string | null = null;
  private failureCode: VideoSourceFailureCode | null = null;
  private readonly ready: Promise<void>;
  constructor(private readonly options: NativeVideoCaptureOptions) {
    this.lastDemandAt = this.now();
    this.ready = this.start();
    this.idleTimer = setInterval(() => {
      // Slow codec allocation/teardown must not queue a maintenance task per tick.
      if (this.idleMaintenance || this.stopped) return;
      const maintenance = this.serializeEncoderChange(async () => {
        if (this.stopped) return;
        await this.pruneIdleEncoders();
        if (
          !this.encoders.size &&
          !this.pendingSourceReads &&
          this.now() - this.lastDemandAt > VIDEO_ENCODER_IDLE_MS
        ) {
          // JPEG leases must not keep a 60fps native track alive without a video
          // consumer. Runtime readVideo can reacquire through its existing fence.
          this.idleStopped = true;
          await this.stop();
        }
      });
      this.idleMaintenance = maintenance;
      void maintenance
        .finally(() => {
          if (this.idleMaintenance === maintenance) this.idleMaintenance = null;
        })
        .catch(() => undefined);
    }, 1_000);
    this.idleTimer.unref();
    // Reads expose a safe unsupported reason; an abandoned start must not reject globally.
    void this.ready.catch(() => {
      this.recordSourceFailure("startup");
    });
  }
  /** Source faults carry only fixed private classifications and safe reasons.
   * A proven pixel mismatch cannot become retryable because a later cleanup,
   * startup or reset error arrives after its original failure notification. */
  private recordSourceFailure(code: VideoSourceFailureCode): void {
    if (this.failureCode === "source-dimensions") {
      return;
    }
    this.failureCode = code;
    const reasons: Record<VideoSourceFailureCode, string> = {
      startup: "Native tab video is unavailable",
      "source-stopped": "Native tab video stopped",
      "source-reset": "Native tab video reset failed",
      "source-dimensions": "Native video dimensions do not match the configured viewport",
    };
    this.failure = reasons[code];
    this.wake();
  }
  private assertCurrent(): void {
    if (this.stopped || !this.options.connection.isOpen || !this.options.isCurrent()) {
      throw new CdpUnavailableError("Native video attachment changed");
    }
  }
  private async evaluate<T>(expression: string): Promise<T> {
    this.assertCurrent();
    const helper = this.helper;
    if (!helper) throw new CdpUnavailableError("Native video helper is unavailable");
    const result = await helper.send<Evaluation<T>>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    this.assertCurrent();
    if (result.exceptionDetails) throw new Error("Native video helper rejected acquisition");
    return result.result?.value as T;
  }
  private async start(): Promise<void> {
    try {
      this.assertCurrent();
      const created = await this.options.connection.send<{ targetId: string }>(
        "Target.createTarget",
        {
          url: `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/recorder.html`,
          background: true,
          hidden: true,
        },
        { mutation: true },
      );
      this.helperTargetId = created.targetId;
      this.assertCurrent();
      this.helper = await attachToTarget(this.options.connection, created.targetId);
      this.assertCurrent();
      await this.helper.send("Runtime.enable");
      await this.helper.send("Runtime.addBinding", { name: "nativeVideoPacket" });
      await this.helper.send("Performance.enable");
      this.helper.on("Runtime.bindingCalled", this.onPacket);
      const before = performance.now();
      const metrics = await this.helper.send<{ metrics: { name: string; value: number }[] }>(
        "Performance.getMetrics",
      );
      const after = performance.now();
      const timestamp = metrics.metrics.find((metric) => metric.name === "Timestamp")?.value;
      if (timestamp === undefined || after - before > VIDEO_SOURCE_CLOCK_TOLERANCE_MS * 2)
        throw new Error("Native video source clock is unavailable");
      this.clock = {
        sourceMs: timestamp * 1000,
        monotonicMs: (before + after) / 2,
      };
      // The recorder is a classic script in the helper document. Runtime.evaluate can
      // arrive while that document is still loading, before startCapture exists;
      // wait for the document's own load event instead of failing acquisition.
      const loaded = await this.evaluate<boolean>(HELPER_READY_EXPRESSION);
      if (!loaded) throw new Error("Native video helper did not load");
      await this.evaluate(
        `startCapture(${JSON.stringify(this.options.targetId)},${this.options.width},${this.options.height},${this.generation})`,
      );
    } catch (error) {
      await this.closeHelper();
      throw error;
    }
  }
  private readonly onPacket = (event: { name: string; payload: string }): void => {
    if (event.name !== "nativeVideoPacket" || event.payload.length > 3_000_000) return;
    let value: unknown;
    try {
      value = JSON.parse(event.payload);
    } catch {
      return;
    }
    if (value && typeof value === "object" && "error" in value) {
      const streamId = "streamId" in value ? value.streamId : null;
      const encoder =
        typeof streamId === "string"
          ? [...this.encoders.values()].find((state) => state.streamId === streamId)
          : null;
      if (encoder) encoder.failure = "Native video quality is unavailable";
      else if (!streamId) {
        const code =
          "reasonCode" in value && value.reasonCode === "source-dimensions"
            ? "source-dimensions"
            : "source-stopped";
        this.recordSourceFailure(code);
      }
      this.wake();
      return;
    }
    const raw = value as Partial<NativeVideoPacket>;
    // Ack only this hidden session. Even a refused stale packet must release producer pressure.
    if (typeof raw.streamId === "string" && Number.isSafeInteger(raw.sequence)) {
      void this.helper
        ?.send("Runtime.evaluate", {
          expression: `acknowledge(${JSON.stringify(raw.streamId)},${raw.sequence})`,
        })
        .catch(() => undefined);
    }
    if (
      this.stopped ||
      !this.options.isCurrent() ||
      !this.clock ||
      raw.captureGeneration !== this.generation
    )
      return;
    const sourceTime =
      typeof raw.timestampUs === "number"
        ? videoSourceTime(raw.timestampUs, this.clock, performance.now(), Date.now())
        : null;
    if (!sourceTime) return;
    const packet = runtimeVideoPacketSchema.safeParse({ ...raw, ...sourceTime });
    if (
      !packet.success ||
      packet.data.width !== this.options.width ||
      packet.data.height !== this.options.height
    )
      return;
    const encoder = [...this.encoders.values()].find(
      (state) => state.streamId === packet.data.streamId,
    );
    if (!encoder) return;
    const accepted = encoder.buffer.add(packet.data);
    if (accepted && packet.data.type === "key") encoder.keyRequestedAt = -Infinity;
    this.wake();
  };
  private wake(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  /** Serialize allocation/eviction only. Input and packet reads retain their own lanes. */
  private async serializeEncoderChange<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.encoderChanges;
    const complete = Promise.withResolvers<void>();
    this.encoderChanges = complete.promise;
    await previous;
    try {
      return await operation();
    } finally {
      complete.resolve();
    }
  }
  /** An idle cohort owns no active reader. Removal releases helper encoder and
   * its retained bytes without restarting the track or another live cohort. */
  private async pruneIdleEncoders(): Promise<void> {
    for (const [key, state] of this.encoders) {
      if (state.activeReads || this.now() - state.lastRequestedAt <= VIDEO_ENCODER_IDLE_MS)
        continue;
      await this.evaluate(`removeEncoder(${JSON.stringify(key)})`);
      if (this.encoders.get(key) === state) this.encoders.delete(key);
      state.buffer.clear();
    }
  }
  private async ensureEncoder(settings: VideoEncoderSettings): Promise<EncoderState> {
    this.lastDemandAt = this.now();
    await this.ready;
    this.assertCurrent();
    return this.serializeEncoderChange(async () => {
      this.assertCurrent();
      const key = videoEncoderKey(settings);
      // Touch the requested cohort before pruning; a resuming viewer can reuse
      // its decoder stream if no other admission has already removed that cohort.
      let state = this.encoders.get(key);
      if (state) state.lastRequestedAt = this.now();
      await this.pruneIdleEncoders();
      if (!state) {
        if (this.encoders.size >= VIDEO_ENCODER_LIMIT) throw new VideoEncoderLimitError();
        state = {
          streamId: randomUUID(),
          buffer: createNativeVideoBuffer(),
          ready: Promise.resolve(),
          failure: null,
          lastRequestedAt: this.now(),
          activeReads: 0,
          keyRequestedAt: -Infinity,
        };
        this.encoders.set(key, state);
        const created = state;
        state.ready = this.evaluate(
          `addEncoder(${JSON.stringify(key)},${JSON.stringify(state.streamId)},${settings.bitrate},${settings.fps})`,
        ).then(() => undefined);
        try {
          await state.ready;
        } catch (error) {
          // A timeout does not cancel helper JavaScript. Fence this exact pending
          // allocation before admitting a replacement, without touching peers.
          await this.evaluate(`removeEncoder(${JSON.stringify(key)})`).catch(() => undefined);
          if (this.encoders.get(key) === created) this.encoders.delete(key);
          throw error;
        }
      } else {
        await state.ready;
      }
      this.assertCurrent();
      state.lastRequestedAt = this.now();
      this.lastDemandAt = this.now();
      state.activeReads += 1;
      return state;
    });
  }
  /** Per-cohort recovery never resets the source, peer encoder or sequence.
   * Reserve the request before CDP await so overlapping readers share it. */
  private async requestRecoveryKey(key: string, state: EncoderState): Promise<boolean> {
    const now = this.now();
    if (now - state.keyRequestedAt < VIDEO_MAX_WAIT_MS) return false;
    state.keyRequestedAt = now;
    await this.evaluate(`requestKeyFrame(${JSON.stringify(key)})`);
    return true;
  }

  /**
   * After bounded CDP initialization, frame waiting is at most 500ms. Startup uses
   * the existing CDP command timeout. No mutation serialization, stale receipt
   * renewal, or screenshot fallback is performed here.
   */
  async read(input: {
    quality?: NativeVideoQuality;
    bitrate?: number;
    fps?: number;
    streamId?: string | null;
    afterSequence?: number;
    waitMs?: number;
    requestKeyFrame?: boolean;
  }): Promise<NativeVideoRead> {
    let ownedState: EncoderState | null = null;
    let sourcePinned = false;
    try {
      const settings = resolveVideoEncoderSettings(input);
      // A valid requested read pins source setup itself, before ready/encoder
      // awaits. Slow authenticated acquisition must not idle-expire underneath it.
      this.pendingSourceReads += 1;
      sourcePinned = true;
      const key = videoEncoderKey(settings);
      const state = await this.ensureEncoder(settings);
      ownedState = state;
      const reset =
        input.streamId !== undefined &&
        input.streamId !== null &&
        input.streamId !== state.streamId;
      const after = reset ? 0 : (input.afterSequence ?? 0);
      const needsKey =
        input.requestKeyFrame || state.buffer.needsKeyFrame(after, performance.now());
      const requested = needsKey && (await this.requestRecoveryKey(key, state));
      if (!requested) await this.evaluate(`touchEncoder(${JSON.stringify(key)})`);
      let packets = state.buffer.read(after, performance.now());
      const waitMs = Math.min(VIDEO_MAX_WAIT_MS, Math.max(0, input.waitMs ?? 250));
      if (!packets.length && waitMs && !this.failure && !state.failure) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            this.waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, waitMs);
          this.waiters.add(wake);
        });
        this.assertCurrent();
        packets = state.buffer.read(after, performance.now());
        // A gap can arrive while the reader waits. Request recovery before
        // returning waiting, rather than depending on the next periodic GOP.
        if (
          !packets.length &&
          !state.failure &&
          state.buffer.needsKeyFrame(after, performance.now())
        ) {
          await this.requestRecoveryKey(key, state);
        }
      }
      if (this.failure || state.failure)
        return {
          status: "unsupported",
          streamId: state.streamId,
          packets: [],
          reason: this.failure ?? state.failure ?? "Native video quality is unavailable",
        };
      return {
        status: packets.length ? (reset ? "reset" : "ready") : "waiting",
        streamId: state.streamId,
        packets,
      };
    } catch (error) {
      return {
        status: "unsupported",
        streamId: null,
        packets: [],
        ...(error instanceof VideoEncoderLimitError
          ? { reasonCode: "encoder-capacity" as const }
          : {}),
        reason:
          error instanceof VideoEncoderLimitError
            ? "Three video profiles are active. Using JPEG for this viewer."
            : "Native tab video is unavailable",
      };
    } finally {
      if (ownedState) ownedState.activeReads -= 1;
      if (sourcePinned) {
        this.pendingSourceReads -= 1;
        this.lastDemandAt = this.now();
      }
    }
  }
  /** Document/action boundary only. Live pointer samples must not call this operation. */
  invalidateQueuedFrames(): void {
    if (this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    const clock = this.clock;
    const minimumTimestampUs = clock
      ? Math.ceil((clock.sourceMs + performance.now() - clock.monotonicMs) * 1000)
      : 0;
    for (const state of this.encoders.values()) state.buffer.clear();
    this.wake();
    void this.ready
      .then(async () => {
        if (!this.stopped) await this.evaluate(`resetCapture(${generation},${minimumTimestampUs})`);
      })
      .catch(() => {
        this.recordSourceFailure("source-reset");
      });
  }
  /** Private source-wide classification. Cohort errors deliberately do not
   * appear here: recovering one encoder must not retire healthy peer encoders. */
  get sourceFailure(): VideoSourceFailureCode | null {
    return this.failureCode;
  }
  /** Automatic no-consumer retirement, independent of source-fault recovery. */
  get idleExpired(): boolean {
    return this.idleStopped;
  }
  /** Idempotent cleanup revokes admission immediately, then closes only the owned helper target. */
  async stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.wake();
    this.closing = (async () => {
      await this.ready.catch(() => undefined);
      await this.closeHelper();
    })();
    return this.closing;
  }
  private async closeHelper(): Promise<void> {
    const helper = this.helper;
    this.helper = null;
    helper?.off("Runtime.bindingCalled", this.onPacket);
    if (helper && this.options.connection.isOpen) {
      await helper
        .send("Runtime.evaluate", { expression: "stopCapture()", awaitPromise: true })
        .catch(() => undefined);
      await helper.detach().catch(() => undefined);
    }
    const targetId = this.helperTargetId;
    this.helperTargetId = null;
    if (targetId && this.options.connection.isOpen) {
      await this.options.connection
        .send("Target.closeTarget", { targetId }, { mutation: true })
        .catch(() => undefined);
    }
    this.encoders.clear();
  }
}
