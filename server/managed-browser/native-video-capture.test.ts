import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ helper: null as unknown }));
vi.mock("./cdp", async () => {
  const actual = await vi.importActual<typeof import("./cdp")>("./cdp");
  return { ...actual, attachToTarget: vi.fn(async () => fixtures.helper) };
});

import type { CdpConnection } from "./cdp";
import { NativeVideoCapture } from "./native-video-capture";

class Helper extends EventEmitter {
  expressions: string[] = [];
  detached = 0;
  async send(method: string, params: Record<string, unknown> = {}) {
    if (method === "Performance.getMetrics")
      return { metrics: [{ name: "Timestamp", value: performance.now() / 1000 }] };
    if (method === "Runtime.evaluate") this.expressions.push(String(params.expression));
    return { result: { value: { codec: "vp8" } } };
  }
  async detach() {
    this.detached++;
  }
}
function setup(now?: () => number) {
  const helper = new Helper();
  fixtures.helper = helper;
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  const connection = {
    isOpen: true,
    send: vi.fn(async (method: string, params: Record<string, unknown>) => {
      commands.push({ method, params });
      return { targetId: "owned-hidden" };
    }),
  };
  let current = true;
  const capture = new NativeVideoCapture({
    connection: connection as unknown as CdpConnection,
    targetId: "exact-source",
    width: 1280,
    height: 800,
    isCurrent: () => current,
    ...(now ? { now } : {}),
  });
  return {
    capture,
    helper,
    commands,
    replace: () => {
      current = false;
    },
  };
}
const sourcePacket = (streamId: string, sequence = 1, generation = 1, ageMs = 0) => ({
  streamId,
  sequence,
  captureGeneration: generation,
  timestampUs: Math.floor((performance.now() - ageMs) * 1000),
  type: "key",
  codec: "vp8",
  width: 1280,
  height: 800,
  dataBase64: Buffer.from("native").toString("base64"),
});
describe("trusted exact-tab capture", () => {
  beforeEach(() => {
    fixtures.helper = null;
  });
  it("classifies stopped and exact-size source failures without trusting remote error text", async () => {
    const { capture, helper } = setup();
    try {
      await capture.read({ quality: "high", waitMs: 0 });
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify({ error: "Private remote data", reasonCode: "unknown" }),
      });
      expect(capture.sourceFailure).toBe("source-stopped");
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify({ error: "Private remote data", reasonCode: "source-dimensions" }),
      });
      expect(capture.sourceFailure).toBe("source-dimensions");
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify({ error: "Later generic source fault" }),
      });
      expect(capture.sourceFailure).toBe("source-dimensions");
      expect(await capture.read({ quality: "high", waitMs: 0 })).toMatchObject({
        status: "unsupported",
        reason: "Native video dimensions do not match the configured viewport",
      });
    } finally {
      await capture.stop();
    }
  });
  it("retains permanent dimensions and its safe reason through a later reset fault", async () => {
    const { capture, helper } = setup();
    try {
      await capture.read({ quality: "high", waitMs: 0 });
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify({ error: "Private remote data", reasonCode: "source-dimensions" }),
      });
      const send = helper.send.bind(helper);
      const resetFailed = Promise.withResolvers<void>();
      helper.send = async (method, params = {}) => {
        if (
          method === "Runtime.evaluate" &&
          String(params.expression).startsWith("resetCapture(")
        ) {
          resetFailed.resolve();
          throw new Error("Private reset error");
        }
        return send(method, params);
      };
      capture.invalidateQueuedFrames();
      await resetFailed.promise;
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(capture.sourceFailure).toBe("source-dimensions");
      expect(await capture.read({ quality: "high", waitMs: 0 })).toMatchObject({
        status: "unsupported",
        reason: "Native video dimensions do not match the configured viewport",
      });
      expect(capture.sourceFailure).toBe("source-dimensions");
    } finally {
      await capture.stop();
    }
  });
  it("keeps a dimension notification permanent when the pending startup later fails", async () => {
    const { capture, helper } = setup();
    const send = helper.send.bind(helper);
    helper.send = async (method, params = {}) => {
      if (method === "Runtime.evaluate" && String(params.expression).startsWith("startCapture(")) {
        helper.emit("Runtime.bindingCalled", {
          name: "nativeVideoPacket",
          payload: JSON.stringify({
            error: "Private remote data",
            reasonCode: "source-dimensions",
          }),
        });
        throw new Error("Startup response was lost");
      }
      return send(method, params);
    };
    try {
      expect((await capture.read({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
      expect(capture.sourceFailure).toBe("source-dimensions");
      expect(helper.detached).toBe(1);
    } finally {
      await capture.stop();
    }
  });
  it("classifies reset failure as source-wide so the runtime can retire it", async () => {
    const { capture, helper } = setup();
    try {
      await capture.read({ quality: "high", waitMs: 0 });
      const send = helper.send.bind(helper);
      helper.send = async (method, params = {}) => {
        if (
          method === "Runtime.evaluate" &&
          String(params.expression).startsWith("resetCapture(")
        ) {
          throw new Error("Private CDP diagnostic");
        }
        return send(method, params);
      };
      capture.invalidateQueuedFrames();
      await vi.waitFor(() => expect(capture.sourceFailure).toBe("source-reset"));
      expect(await capture.read({ quality: "high", waitMs: 0 })).toMatchObject({
        status: "unsupported",
        reason: "Native tab video reset failed",
      });
    } finally {
      await capture.stop();
    }
  });
  it("creates an owned hidden helper and maps only the exact target", async () => {
    const { capture, helper, commands } = setup();
    await capture.read({ quality: "high", waitMs: 0 });
    expect(commands[0]?.params).toMatchObject({ hidden: true, background: true });
    expect(
      helper.expressions.some((expression) =>
        expression.startsWith('startCapture("exact-source",1280,800,'),
      ),
    ).toBe(true);
    await capture.stop();
    expect(helper.detached).toBe(1);
    expect(commands.at(-1)?.params).toEqual({ targetId: "owned-hidden" });
  });
  it("late, wrong-size and wrong-generation receipts do not become fresh packets", async () => {
    const { capture, helper } = setup();
    const initial = await capture.read({ quality: "high", waitMs: 0 });
    const id = initial.streamId!;
    const publish = (packet: unknown) =>
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify(packet),
      });
    publish(sourcePacket(id, 1, 1, 1200));
    publish({ ...sourcePacket(id, 2), width: 640 });
    publish(sourcePacket(id, 3, 0));
    expect((await capture.read({ quality: "high", waitMs: 0 })).packets).toEqual([]);
    publish(sourcePacket(id, 4));
    expect((await capture.read({ quality: "high", waitMs: 0 })).packets[0]?.sequence).toBe(4);
    await capture.stop();
  });
  it("quality encoders remain independent and a source barrier revokes both queues", async () => {
    const { capture, helper } = setup();
    const high = await capture.read({ quality: "high", waitMs: 0 });
    const low = await capture.read({ quality: "low", waitMs: 0 });
    expect(high.streamId).not.toBe(low.streamId);
    expect(helper.expressions.filter((x) => x.startsWith("startCapture(")).length).toBe(1);
    helper.emit("Runtime.bindingCalled", {
      name: "nativeVideoPacket",
      payload: JSON.stringify(sourcePacket(high.streamId!)),
    });
    capture.invalidateQueuedFrames();
    expect((await capture.read({ quality: "high", waitMs: 0 })).packets).toEqual([]);
    expect(helper.expressions.some((x) => x.startsWith("resetCapture(2,"))).toBe(true);
    await capture.stop();
  });
  it("joining decoder requests a key only on its quality encoder", async () => {
    const { capture, helper } = setup();
    const high = await capture.read({ quality: "high", waitMs: 0 });
    await capture.read({ quality: "low", waitMs: 0, requestKeyFrame: true });
    expect(helper.expressions).toContain('requestKeyFrame("2000000:30")');
    expect(helper.expressions).not.toContain('requestKeyFrame("12000000:30")');
    expect(helper.expressions.some((x) => x.startsWith("resetCapture("))).toBe(false);
    expect((await capture.read({ quality: "high", waitMs: 0 })).streamId).toBe(high.streamId);
    await capture.stop();
  });
  it("requests recovery on only the broken cohort, coalesces demand and retries after the wait bound", async () => {
    let now = 0;
    const { capture, helper } = setup(() => now);
    try {
      const high = await capture.read({ quality: "high", waitMs: 0 });
      await capture.read({ quality: "low", waitMs: 0 });
      const publish = (packet: unknown) =>
        helper.emit("Runtime.bindingCalled", {
          name: "nativeVideoPacket",
          payload: JSON.stringify(packet),
        });
      publish(sourcePacket(high.streamId!, 1));
      publish({ ...sourcePacket(high.streamId!, 3), type: "delta" });
      expect(
        (await capture.read({ quality: "high", afterSequence: 1, waitMs: 0 })).packets,
      ).toEqual([]);
      await capture.read({ quality: "high", afterSequence: 1, waitMs: 0 });
      const requests = () => helper.expressions.filter((x) => x.startsWith("requestKeyFrame("));
      expect(requests()).toEqual(['requestKeyFrame("12000000:30")']);

      now += 500;
      await capture.read({ quality: "high", afterSequence: 1, waitMs: 0 });
      expect(requests()).toHaveLength(2);
      publish(sourcePacket(high.streamId!, 1)); // Duplicate old key cannot clear pending recovery.
      await capture.read({ quality: "high", afterSequence: 1, waitMs: 0 });
      expect(requests()).toHaveLength(2);

      publish(sourcePacket(high.streamId!, 4));
      expect(
        (await capture.read({ quality: "high", afterSequence: 1, waitMs: 0 })).packets[0]?.sequence,
      ).toBe(4);
      await capture.read({ quality: "high", afterSequence: 4, waitMs: 0 });
      expect(requests()).toHaveLength(2);
      expect(helper.expressions.filter((x) => x.startsWith("startCapture("))).toHaveLength(1);
      expect(helper.expressions.some((x) => x.startsWith("resetCapture("))).toBe(false);
    } finally {
      await capture.stop();
    }
  });
  it("asks for a fresh key when a gap appears during its bounded wait", async () => {
    const { capture, helper } = setup();
    try {
      const initial = await capture.read({ quality: "high", waitMs: 0 });
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify(sourcePacket(initial.streamId!, 1)),
      });
      const pending = capture.read({ quality: "high", afterSequence: 1, waitMs: 500 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      helper.emit("Runtime.bindingCalled", {
        name: "nativeVideoPacket",
        payload: JSON.stringify({ ...sourcePacket(initial.streamId!, 3), type: "delta" }),
      });
      expect((await pending).packets).toEqual([]);
      expect(helper.expressions).toContain('requestKeyFrame("12000000:30")');
    } finally {
      await capture.stop();
    }
  });
  it("one encoder failure refuses only that quality, retaining another exact source stream", async () => {
    const { capture, helper } = setup();
    const high = await capture.read({ quality: "high", waitMs: 0 });
    const low = await capture.read({ quality: "low", waitMs: 0 });
    helper.emit("Runtime.bindingCalled", {
      name: "nativeVideoPacket",
      payload: JSON.stringify({ error: "bounded", streamId: high.streamId }),
    });
    helper.emit("Runtime.bindingCalled", {
      name: "nativeVideoPacket",
      payload: JSON.stringify(sourcePacket(low.streamId!)),
    });
    expect((await capture.read({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
    expect(capture.sourceFailure).toBeNull();
    const surviving = await capture.read({ quality: "low", waitMs: 0 });
    expect(surviving.status).toBe("ready");
    expect(surviving.packets[0]?.streamId).toBe(low.streamId);
    expect(helper.expressions.filter((x) => x.startsWith("startCapture(")).length).toBe(1);
    await capture.stop();
  });
  it("attachment replacement during a waiting read releases it without old pixels", async () => {
    const { capture, replace } = setup();
    await capture.read({ quality: "high", waitMs: 0 });
    const waiting = capture.read({ quality: "high", waitMs: 500 });
    replace();
    await capture.stop();
    expect((await waiting).packets).toEqual([]);
  });
  it("waits for the helper document to load before invoking its capture entry point", async () => {
    const { capture, helper } = setup();
    await capture.read({ quality: "high", waitMs: 0 });
    const ready = helper.expressions.findIndex(
      (value) => value.includes("startCapture") && value.includes("load"),
    );
    const start = helper.expressions.findIndex((value) => value.startsWith("startCapture("));
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(ready);
    await capture.stop();
  });
  it("does not call a capture entry point the helper document never defined", async () => {
    const { capture, helper } = setup();
    const original = helper.send.bind(helper);
    helper.send = async (method, params = {}) => {
      if (method === "Runtime.evaluate" && String(params.expression).includes("addEventListener"))
        return { result: { value: false } } as never;
      return original(method, params);
    };
    expect((await capture.read({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
    expect(capture.sourceFailure).toBe("startup");
    expect(helper.expressions.some((value) => value.startsWith("startCapture("))).toBe(false);
    await capture.stop();
  });
  it("cleanup still closes the owned target when acquisition fails", async () => {
    const { capture, helper, commands } = setup();
    helper.send = async (method) => {
      if (method === "Performance.getMetrics") return { metrics: [] } as never;
      return {} as never;
    };
    expect((await capture.read({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
    expect(capture.sourceFailure).toBe("startup");
    expect(commands.some((command) => command.method === "Target.closeTarget")).toBe(true);
    await capture.stop();
  });
  it("a stop during awaited helper initialization closes the late target without starting a track", async () => {
    const helper = new Helper();
    fixtures.helper = helper;
    const creation = Promise.withResolvers<{ targetId: string }>();
    const send = vi.fn(async (method: string) => {
      if (method === "Target.createTarget") return creation.promise;
      return {};
    });
    const capture = new NativeVideoCapture({
      connection: { isOpen: true, send } as unknown as CdpConnection,
      targetId: "exact-source",
      width: 1280,
      height: 800,
      isCurrent: () => true,
    });
    const stopping = capture.stop();
    creation.resolve({ targetId: "late-owned-target" });
    await stopping;
    expect(send).toHaveBeenCalledWith(
      "Target.closeTarget",
      { targetId: "late-owned-target" },
      { mutation: true },
    );
    expect(helper.expressions.some((expression) => expression.startsWith("startCapture("))).toBe(
      false,
    );
    expect((await capture.read({ quality: "high", waitMs: 0 })).status).toBe("unsupported");
  });
});

it("refuses a fourth active settings cohort without disrupting any existing stream", async () => {
  const { capture, helper } = setup();
  try {
    const first = await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    const second = await capture.read({ bitrate: 24_000_000, fps: 60, waitMs: 0 });
    const third = await capture.read({ bitrate: 2_000_000, fps: 15, waitMs: 0 });
    const fourth = await capture.read({ bitrate: 5_000_000, fps: 30, waitMs: 0 });
    expect(fourth.status).toBe("unsupported");
    expect(fourth.reason).toContain("Three video profiles");
    expect(fourth.reasonCode).toBe("encoder-capacity");
    expect(new Set([first.streamId, second.streamId, third.streamId]).size).toBe(3);
    expect(helper.expressions.filter((value) => value.startsWith("addEncoder("))).toHaveLength(3);
    expect(helper.expressions.filter((value) => value.startsWith("removeEncoder("))).toHaveLength(
      0,
    );
    expect((await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 })).streamId).toBe(
      first.streamId,
    );
  } finally {
    await capture.stop();
  }
});
it("evicts only idle cohorts, creates a fresh stream, and releases retained bytes", async () => {
  let now = 0;
  const { capture, helper } = setup(() => now);
  try {
    const old = await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    await capture.read({ bitrate: 24_000_000, fps: 60, waitMs: 0 });
    now = 1500;
    const active = await capture.read({ bitrate: 2_000_000, fps: 15, waitMs: 0 });
    now = 2500;
    const replacement = await capture.read({ bitrate: 5_000_000, fps: 30, waitMs: 0 });
    expect(replacement.status).not.toBe("unsupported");
    expect(helper.expressions).toContain('removeEncoder("12000000:30")');
    expect(helper.expressions).toContain('removeEncoder("24000000:60")');
    expect(helper.expressions).not.toContain('removeEncoder("2000000:15")');
    expect((await capture.read({ bitrate: 2_000_000, fps: 15, waitMs: 0 })).streamId).toBe(
      active.streamId,
    );
    const returned = await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    expect(returned.streamId).not.toBe(old.streamId);
    expect(helper.expressions.filter((value) => value.startsWith("startCapture("))).toHaveLength(1);
  } finally {
    await capture.stop();
  }
});
it("parallel distinct admissions never allocate more than three encoders", async () => {
  const { capture, helper } = setup();
  try {
    const results = await Promise.all(
      [15, 30, 60].map((fps) => capture.read({ bitrate: 12_000_000, fps, waitMs: 0 })),
    );
    const extra = await capture.read({ bitrate: 24_000_000, fps: 60, waitMs: 0 });
    expect(results.every((value) => value.status !== "unsupported")).toBe(true);
    expect(extra.status).toBe("unsupported");
    expect(helper.expressions.filter((value) => value.startsWith("addEncoder("))).toHaveLength(3);
  } finally {
    await capture.stop();
  }
});

it("cleans up an idle encoder without requiring a later viewer or restarting the source", async () => {
  vi.useFakeTimers();
  let now = 0;
  const { capture, helper } = setup(() => now);
  try {
    await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    now = 3000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(helper.expressions).toContain('removeEncoder("12000000:30")');
    expect(helper.expressions).toContain("stopCapture()");
    expect(capture.idleExpired).toBe(true);
    expect(helper.detached).toBe(1);
    expect(helper.expressions.filter((value) => value.startsWith("startCapture("))).toHaveLength(1);
  } finally {
    await capture.stop();
    vi.useRealTimers();
  }
});
it("an active awaiting read protects its cohort while unused profiles expire", async () => {
  vi.useFakeTimers();
  let now = 0;
  const { capture, helper } = setup(() => now);
  const blocked = Promise.withResolvers<void>();
  try {
    await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    await capture.read({ bitrate: 2_000_000, fps: 15, waitMs: 0 });
    const original = helper.send.bind(helper);
    helper.send = async (method, params = {}) => {
      if (method === "Runtime.evaluate" && params.expression === 'touchEncoder("12000000:30")')
        await blocked.promise;
      return original(method, params);
    };
    const pending = capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    now = 5000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(helper.expressions).not.toContain('removeEncoder("12000000:30")');
    expect(helper.expressions).toContain('removeEncoder("2000000:15")');
    blocked.resolve();
    await pending;
  } finally {
    blocked.resolve();
    await capture.stop();
    vi.useRealTimers();
  }
});

it("pins a delayed newly allocated cohort before releasing admission to queued idle cleanup", async () => {
  vi.useFakeTimers();
  let now = 0;
  const { capture, helper } = setup(() => now);
  const allocation = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const original = helper.send.bind(helper);
  helper.send = async (method, params = {}) => {
    if (method === "Runtime.evaluate" && String(params.expression).startsWith("addEncoder(")) {
      published.resolve();
      await allocation.promise;
    }
    if (method === "Runtime.evaluate" && String(params.expression).startsWith("touchEncoder("))
      await reading.promise;
    return original(method, params);
  };
  try {
    const pending = capture.read({ bitrate: 24_000_000, fps: 60, waitMs: 0 });
    await published.promise;
    now = 5000;
    await vi.advanceTimersByTimeAsync(1000);
    allocation.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(helper.expressions).not.toContain('removeEncoder("24000000:60")');
    expect(capture.idleExpired).toBe(false);
    now = 10000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(helper.expressions).not.toContain('removeEncoder("24000000:60")');
    expect(capture.idleExpired).toBe(false);
    reading.resolve();
    await pending;
  } finally {
    allocation.resolve();
    reading.resolve();
    await capture.stop();
    vi.useRealTimers();
  }
});

it("pins source demand before a slow helper startup exceeds the idle interval", async () => {
  vi.useFakeTimers();
  let now = 0;
  const { capture, helper } = setup(() => now);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = helper.send.bind(helper);
  helper.send = async (method, params = {}) => {
    if (method === "Performance.getMetrics") {
      started.resolve();
      await release.promise;
    }
    return original(method, params);
  };
  try {
    const pending = capture.read({ bitrate: 24_000_000, fps: 60, waitMs: 0 });
    await started.promise;
    now = 5000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(capture.idleExpired).toBe(false);
    expect(helper.detached).toBe(0);
    release.resolve();
    expect((await pending).status).not.toBe("unsupported");
    expect(helper.expressions.filter((value) => value.startsWith("addEncoder("))).toHaveLength(1);
  } finally {
    release.resolve();
    await capture.stop();
    vi.useRealTimers();
  }
});

it("keeps idle teardown single-flight while native cleanup is slow", async () => {
  vi.useFakeTimers();
  let now = 0;
  const { capture, helper } = setup(() => now);
  const blocked = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const original = helper.send.bind(helper);
  let removalCalls = 0;
  helper.send = async (method, params = {}) => {
    if (method === "Runtime.evaluate" && String(params.expression).startsWith("removeEncoder(")) {
      removalCalls += 1;
      started.resolve();
      await blocked.promise;
    }
    return original(method, params);
  };
  try {
    await capture.read({ bitrate: 12_000_000, fps: 30, waitMs: 0 });
    now = 3000;
    await vi.advanceTimersByTimeAsync(1000);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(removalCalls).toBe(1);
    expect(helper.detached).toBe(0);
    blocked.resolve();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(capture.idleExpired).toBe(true);
    expect(helper.detached).toBe(1);
    expect(helper.expressions.filter((value) => value === "stopCapture()")).toHaveLength(1);
  } finally {
    blocked.resolve();
    await capture.stop();
    vi.useRealTimers();
  }
});
