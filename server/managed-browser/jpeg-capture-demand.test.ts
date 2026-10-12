import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createJpegCaptureDemand, JPEG_CAPTURE_IDLE_MS } from "./jpeg-capture-demand";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const retire = vi.fn(async () => {});
  const onError = vi.fn();
  const demand = createJpegCaptureDemand({ now: () => Date.now(), retire, onError });
  return { demand, retire, onError };
}
it("no viewer/video-only activity allocates a timer; completed reads renew beyond startup polling", async () => {
  const { demand, retire } = setup();
  const transition = demand.pin(false);
  transition();
  expect(vi.getTimerCount()).toBe(0);
  const release = demand.pin();
  release();
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(1500);
    const releaseNext = demand.pin();
    releaseNext();
  }
  expect(retire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("slow read/start remains pinned across the entire await, and renewal queues after retirement", async () => {
  const { demand, retire } = setup();
  const release = demand.pin();
  await vi.advanceTimersByTimeAsync(10000);
  expect(retire).not.toHaveBeenCalled();
  release();
  const stop = Promise.withResolvers<void>();
  retire.mockImplementationOnce(() => stop.promise);
  await vi.advanceTimersByTimeAsync(JPEG_CAPTURE_IDLE_MS);
  const nextRelease = demand.pin();
  const started = vi.fn(async () => {});
  const start = demand.serialize(started);
  await Promise.resolve();
  expect(started).not.toHaveBeenCalled();
  stop.resolve();
  await start;
  expect(started).toHaveBeenCalledTimes(1);
  nextRelease();
});
it("non-image transitions protect but never renew old demand", async () => {
  const { demand, retire } = setup();
  demand.pin()();
  await vi.advanceTimersByTimeAsync(2000);
  const transition = demand.pin(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(retire).not.toHaveBeenCalled();
  transition();
  await vi.advanceTimersByTimeAsync(1);
  expect(retire).toHaveBeenCalledTimes(1);
});
it("explicit cancellation, failed retire and shutdown do not rearm or replay", async () => {
  const { demand, retire, onError } = setup();
  const release = demand.pin();
  demand.cancel();
  release();
  await vi.advanceTimersByTimeAsync(10000);
  expect(retire).not.toHaveBeenCalled();
  retire.mockRejectedValueOnce(new Error("uncertain stop"));
  demand.pin()();
  await vi.advanceTimersByTimeAsync(10000);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  demand.pin()();
  demand.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(() => demand.pin()).toThrow("closed");
});
