// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonPort } from "../../client/cross-daemon/peer-sync.client";
import { registerDaemon, requestPeerSync } from "../../client/cross-daemon/sync-scheduler.client";

function countingPort() {
  const port: DaemonPort = {
    describe: vi.fn(async () => ({ serverId: "srv_tower", switchedOn: false, member: null })),
    setPeers: vi.fn(async () => {}),
    listPeers: vi.fn(async () => []),
    status: async () => ({ serverId: "srv_tower", switchedOn: false, available: true }),
    setSwitch: vi.fn(async () => {}),
  };
  return port;
}

describe("sync scheduler", () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it("syncs once for a burst of daemons registering together, as when the app connects to every host", async () => {
    const tower = countingPort();
    const mac = countingPort();
    cleanups.push(registerDaemon(tower), registerDaemon(mac));
    requestPeerSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tower.describe).toHaveBeenCalledTimes(1);
    expect(mac.describe).toHaveBeenCalledTimes(1);
  });

  it("syncs again every minute while the app stays open, so a switch changed elsewhere spreads", async () => {
    const tower = countingPort();
    cleanups.push(registerDaemon(tower));
    await vi.advanceTimersByTimeAsync(1_000 + 60_000);
    expect(tower.describe).toHaveBeenCalledTimes(2);
  });

  it("never runs two syncs at once, and runs one more after a sync that a request arrived during", async () => {
    let finishDescribe = () => {};
    const slow: DaemonPort = {
      describe: vi.fn(
        () => new Promise<{ serverId: string; switchedOn: boolean; member: null }>((resolve) => {
          finishDescribe = () => resolve({ serverId: "srv_slow", switchedOn: false, member: null });
        }),
      ),
      setPeers: vi.fn(async () => {}),
      listPeers: vi.fn(async () => []),
      status: async () => ({ serverId: "srv_tower", switchedOn: false, available: true }),
    setSwitch: vi.fn(async () => {}),
    };
    cleanups.push(registerDaemon(slow));
    await vi.advanceTimersByTimeAsync(1_000);
    requestPeerSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slow.describe).toHaveBeenCalledTimes(1);
    finishDescribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.describe).toHaveBeenCalledTimes(2);
    finishDescribe();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("starts later rounds for responding computers after another computer times out", async () => {
    const good = countingPort();
    const stuck = countingPort();
    stuck.describe = vi.fn(() => new Promise<never>(() => {}));
    cleanups.push(registerDaemon(good), registerDaemon(stuck));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(good.setPeers).toHaveBeenCalledTimes(1);
    requestPeerSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(good.describe).toHaveBeenCalledTimes(2);
    expect(good.setPeers).toHaveBeenCalledTimes(2);
    expect(stuck.describe).toHaveBeenCalledTimes(1);
  });

  it("stops syncing a daemon once its plugin instance is disposed", async () => {
    const tower = countingPort();
    registerDaemon(tower)();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tower.describe).not.toHaveBeenCalled();
  });
});
