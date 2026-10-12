/** Delayed maintenance replies cannot duplicate heartbeats or revive a retired lease. */
import { expect, it, vi } from "vitest";
import { SupervisorClient } from "./supervisor-client";

type HeartbeatHarness = {
  socket: object;
  epoch: number;
  lease: unknown;
  send: ReturnType<typeof vi.fn>;
  handleClose: ReturnType<typeof vi.fn>;
  armHeartbeat(intervalMs: number): void;
  clearHeartbeat(): void;
};

function createHarness() {
  const client = new SupervisorClient({
    bridgeId: "owned-heartbeat-test",
  }) as unknown as HeartbeatHarness;
  client.socket = {};
  client.epoch = 1;
  client.send = vi.fn();
  client.handleClose = vi.fn();
  return client;
}

it("keeps one heartbeat in flight without changing the lease deadline", async () => {
  vi.useFakeTimers();
  const client = createHarness();
  let resolve!: (value: unknown) => void;
  const held = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  client.send.mockReturnValue(held);
  client.lease = { epoch: 1, expiresAt: 30_000 };
  try {
    client.armHeartbeat(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.lease).toEqual({ epoch: 1, expiresAt: 30_000 });
    resolve({ epoch: 1, expiresAt: 40_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.handleClose).not.toHaveBeenCalled();
  } finally {
    client.clearHeartbeat();
    vi.useRealTimers();
  }
});

it.each(["resolve", "reject"])(
  "ignores an obsolete heartbeat %s after socket replacement",
  async (result) => {
    vi.useFakeTimers();
    const client = createHarness();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    client.send.mockReturnValue(
      new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }),
    );
    try {
      client.armHeartbeat(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      client.socket = {};
      client.epoch = 2;
      client.lease = { epoch: 2 };
      if (result === "resolve") resolve({ epoch: 1 });
      else reject(new Error("old socket failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.epoch).toBe(2);
      expect(client.lease).toEqual({ epoch: 2 });
      expect(client.handleClose).not.toHaveBeenCalled();
    } finally {
      client.clearHeartbeat();
      vi.useRealTimers();
    }
  },
);
