/**
 * Trusted extension-page program. It captures one exact tab, never reads site DOM,
 * and shares a bounded native track among at most three independent encoders.
 * Binding acknowledgements limit outstanding packets; a dropped output forces a
 * new keyframe before another delta can be forwarded.
 */
import { VIDEO_MAX_PACKET_BYTES } from "../../shared/managed-browser/browser-video";
import { FRAME_MAX_BYTES } from "../../shared/managed-browser/capture-settings";

export const NATIVE_SNAPSHOT_MAX_TIMEOUT_MS = 1_500;

export const NATIVE_VIDEO_EXTENSION_SOURCE = `
let capture = null;
const encoders = new Map();
const pendingEncoders = new Map();
// One reserved snapshot job and one reusable canvas, across capture restarts.
// The reservation outlives cancellation until an unabortable conversion settles.
let snapshotJob = null;
let snapshotCanvas = null;
const SNAPSHOT_MAX_BYTES = ${FRAME_MAX_BYTES};
const SNAPSHOT_MAX_TIMEOUT_MS = ${NATIVE_SNAPSHOT_MAX_TIMEOUT_MS};
function snapshotSlotState() {
  return { reserved: snapshotJob !== null };
}
function settleSnapshot(job, value) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  job.resolve(Object.assign({ token: job.token }, value));
}
function releaseSnapshot(job) {
  if (snapshotJob === job) snapshotJob = null;
}
/** Refuse publication now. A selected job keeps the slot until its conversion settles. */
function cancelSnapshot(status) {
  const job = snapshotJob;
  if (!job) return;
  job.cancelled = true;
  settleSnapshot(job, { status });
  if (!job.selected) releaseSnapshot(job);
}
/** Arm one request for the next current-generation source frame at or after its floor. */
function captureSnapshot(token, quality, maxBytes, minimumTimestampUs, generation, timeoutMs) {
  return new Promise((resolve) => {
    const reply = (status) => resolve({ token, status });
    if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) return reply("unsupported");
    if (typeof OffscreenCanvas !== "function") return reply("unsupported");
    if (snapshotJob) return reply("busy");
    if (!capture || capture.stopped) return reply("stopped");
    if (!Number.isInteger(generation) || generation < capture.generation) return reply("stale");
    if (!Number.isFinite(minimumTimestampUs) || !Number.isFinite(quality) || !Number.isFinite(maxBytes))
      return reply("unsupported");
    const bounded = Math.max(1, Math.min(100, Math.round(quality)));
    const job = {
      token,
      ladder: [...new Set([bounded, 85, 65, 45, 25].filter((value) => value <= bounded))].slice(0, 3),
      cap: Math.min(SNAPSHOT_MAX_BYTES, Math.max(1, Math.floor(maxBytes))),
      floor: Math.max(minimumTimestampUs, capture.minimumTimestampUs),
      generation,
      source: capture,
      selected: false,
      cancelled: false,
      settled: false,
      resolve,
      timer: null,
    };
    snapshotJob = job;
    job.timer = setTimeout(() => {
      if (job.settled) return;
      job.cancelled = true;
      settleSnapshot(job, { status: "timeout" });
      if (!job.selected) releaseSnapshot(job);
    }, Math.max(1, Math.min(SNAPSHOT_MAX_TIMEOUT_MS, Number(timeoutMs) || 1)));
  });
}
/** Draw synchronously from a short-lived clone, then convert outside the capture loop. */
function selectSnapshot(job, encodingFrame, timestampUs, width, height) {
  job.selected = true;
  let canvas;
  try {
    if (!snapshotCanvas || snapshotCanvas.width !== width || snapshotCanvas.height !== height)
      snapshotCanvas = new OffscreenCanvas(width, height);
    canvas = snapshotCanvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Snapshot canvas is unavailable");
    const clone = encodingFrame.clone();
    try {
      context.drawImage(clone, 0, 0, width, height);
    } finally {
      clone.close();
    }
  } catch {
    job.cancelled = true;
    settleSnapshot(job, { status: "unsupported" });
    releaseSnapshot(job);
    return;
  }
  void encodeSnapshot(job, canvas, timestampUs, width, height);
}
async function encodeSnapshot(job, canvas, timestampUs, width, height) {
  try {
    for (const quality of job.ladder) {
      if (job.cancelled) return;
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
      if (job.cancelled) return;
      if (blob.type !== "image/jpeg" || blob.size > job.cap) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (job.cancelled) return;
      if (bytes.length < 1 || bytes.length > job.cap) continue;
      settleSnapshot(job, {
        status: "ready",
        generation: job.generation,
        timestampUs,
        width,
        height,
        byteLength: bytes.length,
        dataBase64: bytes64(bytes),
      });
      return;
    }
    settleSnapshot(job, { status: "too-large" });
  } catch {
    settleSnapshot(job, { status: "unsupported" });
  } finally {
    job.cancelled = true;
    releaseSnapshot(job);
    // A stop during conversion left this canvas for the settling job. Release it
    // now only if no capture restarted and no newer job owns the slot.
    if (!capture && !snapshotJob && snapshotCanvas === canvas) snapshotCanvas = null;
  }
}
const bytes64 = (bytes) => {
  // Native byte conversion avoids constructing/copying a large binary string.
  // Retain the bounded legacy path for browsers without the newer byte API.
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
};
/** Revoke the source, codecs and pending allocations before awaiting reader cleanup. */
async function stopCapture() {
  const previous = capture;
  capture = null;
  cancelSnapshot("stopped");
  // A still-converting job keeps its own canvas reference and the global reservation.
  if (!snapshotJob) snapshotCanvas = null;
  pendingEncoders.clear();
  if (!previous) return;
  previous.stopped = true;
  for (const encoder of encoders.values()) {
    try {
      encoder.encoder.close();
    } catch {}
  }
  encoders.clear();
  for (const track of previous.stream.getTracks()) track.stop();
  await previous.reader.cancel().catch(() => {});
  await previous.loop.catch(() => {});
}
/** Preserve requested geometry across Chromium's even-aligned YUV capture.
 * Only the known one-pixel rounding is resampled by VideoEncoder. Other source
 * changes remain failures; cloning retains the source timestamp and lifetime.
 */
function frameForViewport(frame, width, height) {
  if (frame.displayWidth === width && frame.displayHeight === height) return frame;
  if (
    !["I420", "NV12"].includes(frame.format) ||
    frame.displayWidth !== (width & ~1) ||
    frame.displayHeight !== (height & ~1)
  ) return null;
  return new VideoFrame(frame, { displayWidth: width, displayHeight: height });
}
/** Start one exact tab at physical pixel dimensions; generation fences previously queued frames. */
async function startCapture(targetId, width, height, generation) {
  await stopCapture();
  let stream;
  try {
    const targets = await chrome.debugger.getTargets();
    const matched = targets.filter(
      (target) =>
        target.id === targetId && target.type === "page" && Number.isInteger(target.tabId),
    );
    if (matched.length !== 1) throw new Error("Exact capture target is unavailable");
    const sourceId = await chrome.tabCapture.getMediaStreamId({ targetTabId: matched[0].tabId });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: sourceId,
          maxWidth: width,
          maxHeight: height,
          minFrameRate: 1,
          maxFrameRate: 60,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    const current = {
      stream,
      reader,
      width,
      height,
      generation,
      minimumTimestampUs: -Infinity,
      stopped: false,
      loop: null,
    };
    capture = current;
    current.loop = (async () => {
      try {
        while (capture === current && !current.stopped) {
          const { value: frame, done } = await reader.read();
          if (done) {
            if (capture === current && !current.stopped)
              nativeVideoPacket(JSON.stringify({ error: "Native video capture stopped" }));
            break;
          }
          let encodingFrame = null;
          try {
            if (capture !== current || current.stopped) break;
            if (frame.timestamp < current.minimumTimestampUs) continue;
            encodingFrame = frameForViewport(frame, width, height);
            if (!encodingFrame) {
              // Only native YUV even-alignment is correctable. Keep unexpected
              // source geometry terminal without changing viewport or density.
              nativeVideoPacket(
                JSON.stringify({
                  error: "Native video dimensions changed",
                  reasonCode: "source-dimensions",
                }),
              );
              break;
            }
            const job = snapshotJob;
            if (
              job &&
              !job.selected &&
              !job.cancelled &&
              job.source === current &&
              current.generation === job.generation &&
              frame.timestamp >= job.floor
            )
              selectSnapshot(job, encodingFrame, frame.timestamp, width, height);
            for (const state of encoders.values()) {
              if (state.failed || performance.now() - state.lastRequestedAt > 2000) continue;
              if (state.pending.size >= 2 || state.encoder.encodeQueueSize >= 2) {
                // This source frame was never encoded, so skipping it does not
                // lose a codec dependency. Keep already queued output usable.
                // The output callback below still forces recovery if it must
                // discard an actual encoded chunk.
                continue;
              }
              // Source timestamps are integer microseconds. Allow one microsecond
              // of rounding so genuine 30fps timestamps do not become 15fps.
              const minimumIntervalUs = 1000000 / state.configuration.framerate;
              // Recovery uses the next fresh frame even inside the ordinary FPS interval.
              // Producer/encoder backlog checks above still apply to forced keys.
              if (
                !state.forceKey &&
                frame.timestamp - state.lastEncodedTimestampUs < minimumIntervalUs - 1
              )
                continue;
              state.lastEncodedTimestampUs = frame.timestamp;
              state.frameGenerations.set(frame.timestamp, current.generation);
              while (state.frameGenerations.size > 4)
                state.frameGenerations.delete(state.frameGenerations.keys().next().value);
              const keyFrame =
                state.forceKey || frame.timestamp - state.lastKeyTimestamp >= 1000000;
              try {
                state.encoder.encode(encodingFrame, { keyFrame });
              } catch {
                // A synchronous codec rejection belongs to this cohort, just
                // like its asynchronous error callback. Healthy peers keep the track.
                state.failed = true;
                try {
                  state.encoder.close();
                } catch {}
                state.frameGenerations.clear();
                nativeVideoPacket(
                  JSON.stringify({
                    error: "Native video encoder stopped",
                    streamId: state.streamId,
                  }),
                );
                continue;
              }
              if (keyFrame) state.lastKeyTimestamp = frame.timestamp;
              state.forceKey = false;
            }
          } finally {
            if (encodingFrame && encodingFrame !== frame) encodingFrame.close();
            frame.close();
          }
        }
      } catch {
        if (capture === current)
          nativeVideoPacket(JSON.stringify({ error: "Native video capture stopped" }));
      }
    })();
    return { width, height, settings: track.getSettings() };
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}
/** Allocate a cohort selected by its stable quality/configuration key. Bitrate is bits per second,
 * fps is the requested frame ceiling. Reserve capacity before asynchronous codec probes. */
async function addEncoder(quality, streamId, bitrate, fps) {
  if (!capture) throw new Error("Native capture is not running");
  const bitrates = { low: 2000000, medium: 5000000, high: 12000000 };
  bitrate ??= bitrates[quality];
  fps ??= 30;
  if (![2000000, 5000000, 12000000, 24000000].includes(bitrate) || ![15, 30, 60].includes(fps))
    throw new Error("Unknown video settings");
  const existing = encoders.get(quality);
  if (existing) {
    if (
      existing.streamId !== streamId ||
      existing.configuration.bitrate !== bitrate ||
      existing.configuration.framerate !== fps
    )
      throw new Error("Encoder identity changed");
    touchEncoder(quality);
    return { codec: existing.codec };
  }
  const pending = pendingEncoders.get(quality);
  if (pending) {
    if (pending.streamId !== streamId || pending.bitrate !== bitrate || pending.fps !== fps)
      throw new Error("Encoder allocation identity changed");
    return pending.promise;
  }
  if (encoders.size + pendingEncoders.size >= 3) throw new Error("Native encoder limit reached");
  // Reserve before any codec probe. A timed-out CDP request can continue in this
  // page, so host-side serialization alone cannot enforce the encoder ceiling.
  const source = capture;
  const reservation = { streamId, bitrate, fps, promise: null };
  pendingEncoders.set(quality, reservation);
  const assertAllocation = () => {
    if (capture !== source || source.stopped || pendingEncoders.get(quality) !== reservation)
      throw new Error("Native encoder allocation changed");
  };
  reservation.promise = (async () => {
    let state = null;
    try {
      let configuration;
      for (const codec of ["avc1.420033", "vp8"]) {
        const candidate = {
          codec,
          width: source.width,
          height: source.height,
          bitrate,
          framerate: fps,
          latencyMode: "realtime",
          hardwareAcceleration: "no-preference",
          ...(codec.startsWith("avc") ? { avc: { format: "annexb" } } : {}),
        };
        const support = await VideoEncoder.isConfigSupported(candidate);
        assertAllocation();
        if (support.supported) {
          configuration = candidate;
          break;
        }
      }
      if (!configuration) throw new Error("Native encoder is unavailable");
      state = {
        streamId,
        codec: configuration.codec,
        sequence: 0,
        pending: new Set(),
        forceKey: true,
        lastKeyTimestamp: -Infinity,
        lastEncodedTimestampUs: -Infinity,
        lastRequestedAt: performance.now(),
        needsKey: true,
        configuration,
        frameGenerations: new Map(),
        failed: false,
        encoder: null,
      };
      state.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (!capture || encoders.get(quality) !== state || state.failed) return;
          const generation = state.frameGenerations.get(chunk.timestamp);
          state.frameGenerations.delete(chunk.timestamp);
          if (chunk.byteLength > ${VIDEO_MAX_PACKET_BYTES}) {
            state.failed = true;
            try {
              state.encoder.close();
            } catch {}
            nativeVideoPacket(
              JSON.stringify({ error: "Native video quality exceeds its packet bound", streamId }),
            );
            return;
          }
          if (generation !== capture.generation || state.pending.size >= 2) {
            state.forceKey = true;
            state.needsKey = true;
            return;
          }
          if (state.needsKey && chunk.type !== "key") return;
          if (chunk.type === "key") state.needsKey = false;
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          const sequence = ++state.sequence;
          state.pending.add(sequence);
          const description = metadata.decoderConfig && metadata.decoderConfig.description;
          nativeVideoPacket(
            JSON.stringify({
              streamId,
              captureGeneration: generation,
              sequence,
              timestampUs: chunk.timestamp,
              type: chunk.type,
              codec: state.codec,
              width: capture.width,
              height: capture.height,
              ...(description ? { descriptionBase64: bytes64(new Uint8Array(description)) } : {}),
              dataBase64: bytes64(bytes),
            }),
          );
        },
        error: () => {
          state.failed = true;
          nativeVideoPacket(JSON.stringify({ error: "Native video encoder stopped", streamId }));
        },
      });
      state.encoder.configure(configuration);
      assertAllocation();
      pendingEncoders.delete(quality);
      encoders.set(quality, state);
      return { codec: state.codec };
    } catch (error) {
      try {
        state?.encoder?.close();
      } catch {}
      throw error;
    } finally {
      if (pendingEncoders.get(quality) === reservation) pendingEncoders.delete(quality);
    }
  })();
  return reservation.promise;
}
/** Cancel an uncertain allocation and release only the selected cohort. */
function removeEncoder(quality) {
  // Cancel uncertain pending allocation before its async support probe returns.
  pendingEncoders.delete(quality);
  const state = encoders.get(quality);
  if (!state) return;
  encoders.delete(quality);
  try {
    state.encoder.close();
  } catch {}
  state.pending.clear();
  state.frameGenerations.clear();
}
/** Renew viewing demand without allocating or resetting a codec. */
function touchEncoder(quality) {
  const state = encoders.get(quality);
  if (state) state.lastRequestedAt = performance.now();
}
/** Request the next eligible independent picture while preserving healthy in-flight deltas. */
function requestKeyFrame(quality) {
  const state = encoders.get(quality);
  if (state) {
    state.lastRequestedAt = performance.now();
    // Joining/recovering viewers need an additional key, but healthy viewers
    // can keep consuming an intact in-flight chain until that key is encoded.
    // Preserve any existing needsKey from actual output loss or source reset.
    state.forceKey = true;
  }
}
/** Release producer pressure for this exact stream/sequence, including refused stale packets. */
function acknowledge(streamId, sequence) {
  for (const state of encoders.values())
    if (state.streamId === streamId) state.pending.delete(sequence);
}
/** Fence pre-transition output using source-clock microseconds without replacing the track. */
function resetCapture(generation, minimumTimestampUs) {
  if (!capture) return;
  if (generation < capture.generation) return;
  capture.generation = generation;
  capture.minimumTimestampUs = minimumTimestampUs;
  // An older request is stale. A request already issued for this new generation
  // (reset still in flight) keeps waiting, with the stronger floor applied.
  const job = snapshotJob;
  if (job && job.generation < generation) cancelSnapshot("stale");
  else if (job && !job.selected) job.floor = Math.max(job.floor, minimumTimestampUs);
  for (const state of encoders.values()) {
    if (state.failed) continue;
    state.forceKey = true;
    state.needsKey = true;
    state.frameGenerations.clear();
    state.pending.clear();
    // reset cancels outstanding pre-navigation encoding, preserving the track.
    state.encoder.reset();
    state.encoder.configure(state.configuration);
  }
}
`;
