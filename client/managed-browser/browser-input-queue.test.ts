import { describe, expect, it, vi } from "vitest";
import type { BrowserGestureEvent, BrowserState } from "../../shared/managed-browser/browser";
import { createBrowserCanvasInput } from "./browser-canvas-input";
import {
  type BrowserGestureAuthority,
  type BrowserGestureControl,
  type BrowserGestureTransport,
  createBrowserInputQueue,
} from "./browser-input-queue";

const authority: BrowserGestureAuthority = {
  viewerToken: "viewer",
  controlToken: "control",
  expected: {
    sessionId: "session",
    runtimeId: "runtime",
    bridgeEpoch: 1,
    navigationGeneration: 1,
    viewportGeneration: 1,
  },
  target: {
    frameId: "decoded-front",
    navigationGeneration: 1,
    viewportGeneration: 1,
  },
};
const freshAuthority: BrowserGestureAuthority = {
  ...authority,
  target: { ...authority.target, frameId: "fresh-front" },
};
const state = { captureScale: 1 } as BrowserState;
const point = (x: number) => ({ x, y: 1, width: 800, height: 600 });
const move = (x: number): BrowserGestureEvent => ({
  kind: "move",
  point: point(x),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    resolve,
    reject,
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture(
  waitForFrame?: (afterFrameId: string, maxWaitMs?: number) => Promise<void>,
  separateControl = false,
) {
  let current: BrowserGestureAuthority | null = authority;
  let control: BrowserGestureControl | null = authority;
  const sent: Parameters<BrowserGestureTransport["update"]>[0][] = [];
  const ended: Parameters<BrowserGestureTransport["end"]>[0][] = [];
  const errors: unknown[] = [];
  const cursors: unknown[] = [];
  const navigationCompleted: boolean[] = [];
  const acknowledgements: string[] = [];
  const states: BrowserState[] = [];
  let projectState: ((state: BrowserState) => void) | null = null;
  let finished = 0;
  const beginGate = deferred<Awaited<ReturnType<BrowserGestureTransport["begin"]>>>();
  const transport: BrowserGestureTransport = {
    begin: async () => await beginGate.promise,
    update: async (input) => {
      sent.push(input);
      return {
        state,
        gestureId: input.gestureId,
        nextSequence: input.sequence + 1,
        cursor: "pointer",
      };
    },
    end: async (input) => {
      ended.push(input);
      return { state, cursor: null };
    },
  };
  const queue = createBrowserInputQueue({
    transport,
    authority: () => current,
    ...(separateControl ? { controlAuthority: () => control } : {}),
    onState: (next) => {
      states.push(next);
      projectState?.(next);
    },
    onCursor: (cursor) => cursors.push(cursor),
    onError: (error) => errors.push(error),
    onFinish: () => {
      finished += 1;
    },
    onNavigationComplete: () => navigationCompleted.push(true),
    onAcknowledged: () => acknowledgements.push("ack"),
    ...(waitForFrame ? { waitForFrame } : {}),
  });
  return {
    queue,
    sent,
    ended,
    errors,
    cursors,
    beginGate,
    transport,
    navigationCompleted,
    acknowledgements,
    states,
    finishes: () => finished,
    projectState(callback: (state: BrowserState) => void) {
      projectState = callback;
    },
    changeControl(next: BrowserGestureControl | null) {
      control = next;
    },
    changeAuthority(next: BrowserGestureAuthority | null) {
      current = next;
    },
  };
}

describe("bounded browser input queue", () => {
  it("never sends orphan moves after a canvas touch starts without decoded-frame authority", async () => {
    const f = fixture(undefined, true);
    const input = createBrowserCanvasInput({
      enabled: () => true,
      viewport: () => ({ width: 800, height: 600 }),
      enqueue: f.queue.enqueue,
      finish: f.queue.finish,
      cancel: f.queue.cancel,
      onPoint: vi.fn(),
      onActivity: vi.fn(),
    });
    const contact = { ...point(10), id: 0 };
    f.changeAuthority(null);
    expect(input.touch("start", [contact])).toBe(false);
    f.changeAuthority(authority);
    input.touch("move", [{ ...contact, x: 30 }]);
    input.touch("end", []);
    input.touch("start", [contact]);
    f.beginGate.resolve({ state, gestureId: "fresh-touch", nextSequence: 1 });
    await flush();
    expect(f.sent.map(({ event }) => event)).toEqual([
      { kind: "touch", type: "start", points: [contact] },
    ]);
    expect(f.errors).toEqual([]);
    input.touch("end", []);
    await flush();
    f.queue.finish();
    await flush();
  });

  it("completes acknowledged Enter navigation before state projection revokes the decoded frame", async () => {
    const f = fixture();
    const next: BrowserState = {
      ...state,
      status: "ready",
      controller: "self",
      sessionId: "session",
      runtimeId: "runtime",
      bridgeEpoch: 1,
      viewportGeneration: 1,
      navigationGeneration: 2,
    };
    f.projectState((reply) => {
      if (reply.navigationGeneration === 2) f.changeAuthority(null);
    });
    f.transport.update = async (input) => {
      f.sent.push(input);
      return {
        state: next,
        gestureId: input.gestureId,
        nextSequence: input.sequence + 1,
        cursor: null,
        completion: "navigation",
      };
    };
    f.queue.enqueue({
      kind: "key",
      type: "down",
      key: "Enter",
      code: "Enter",
      modifiers: 0,
      repeat: false,
    });
    f.queue.enqueue({
      kind: "key",
      type: "up",
      key: "Enter",
      code: "Enter",
      modifiers: 0,
      repeat: false,
    });
    f.queue.enqueue({ kind: "text", text: "never type on the destination" });
    f.queue.finish();
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect(f.ended).toEqual([]);
    expect(f.navigationCompleted).toEqual([true]);
    expect(f.finishes()).toBe(1);
    expect(f.cursors.at(-1)).toBeNull();
  });

  it("keeps the acknowledged click release but drops later old-page wheel and end", async () => {
    const f = fixture();
    f.transport.update = async (input) => {
      f.sent.push(input);
      if (input.event.kind !== "up") {
        return {
          state,
          gestureId: input.gestureId,
          nextSequence: input.sequence + 1,
          cursor: null,
        };
      }
      return {
        state: {
          ...state,
          status: "ready",
          controller: "self",
          sessionId: "session",
          runtimeId: "runtime",
          bridgeEpoch: 1,
          viewportGeneration: 1,
          navigationGeneration: 2,
        },
        gestureId: input.gestureId,
        nextSequence: input.sequence + 1,
        cursor: null,
        completion: "navigation",
      };
    };
    f.projectState((reply) => {
      if (reply.navigationGeneration === 2) f.changeAuthority(null);
    });
    f.queue.enqueue({ kind: "down", point: point(1), button: "left", clickCount: 1 });
    f.queue.enqueue({ kind: "up", point: point(1), button: "left", clickCount: 1 });
    f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 10 });
    f.queue.finish();
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(f.sent.map((input) => input.event.kind)).toEqual(["down", "up"]);
    expect(f.errors).toEqual([]);
    expect(f.navigationCompleted).toEqual([true]);
    expect(f.ended).toEqual([]);
  });

  it("does not grant navigation completion for changed runtime, bridge, viewport, controller or sequence", async () => {
    const next: BrowserState = {
      ...state,
      status: "ready",
      controller: "self",
      sessionId: "session",
      runtimeId: "runtime",
      bridgeEpoch: 1,
      viewportGeneration: 1,
      navigationGeneration: 2,
    };
    for (const altered of [
      { sessionId: "another-session" },
      { runtimeId: "another-runtime" },
      { bridgeEpoch: 2 },
      { viewportGeneration: 2 },
      { controller: "other" as const },
      { navigationGeneration: 1 },
      { status: "error" as const },
    ]) {
      const f = fixture();
      f.transport.update = async (input) => {
        f.sent.push(input);
        return {
          state: { ...next, ...altered },
          gestureId: input.gestureId,
          nextSequence: input.sequence + 1,
          cursor: null,
          completion: "navigation",
        };
      };
      f.queue.enqueue(move(1));
      f.queue.enqueue(move(2));
      f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
      await flush();
      expect(f.navigationCompleted).toEqual([]);
      expect(f.sent).toHaveLength(1);
      expect(f.errors).toHaveLength(1);
      expect(f.ended).toHaveLength(1);
    }
    const sequence = fixture();
    sequence.transport.update = async (input) => ({
      state: next,
      gestureId: input.gestureId,
      nextSequence: input.sequence + 2,
      cursor: null,
      completion: "navigation",
    });
    sequence.queue.enqueue(move(1));
    sequence.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(sequence.errors).toHaveLength(1);
    expect(sequence.navigationCompleted).toEqual([]);
  });

  it("unmarked navigation and replacement control retain the existing context rejection", async () => {
    const f = fixture();
    const next: BrowserState = { ...state, navigationGeneration: 2 };
    f.projectState((reply) => {
      if (reply.navigationGeneration === 2) f.changeAuthority(null);
    });
    f.transport.update = async (input) => ({
      state: next,
      gestureId: input.gestureId,
      nextSequence: input.sequence + 1,
      cursor: null,
    });
    f.queue.enqueue(move(1));
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(f.errors).toHaveLength(1);
    expect(f.navigationCompleted).toEqual([]);

    const changed = fixture();
    changed.transport.update = async (input) => {
      changed.changeAuthority({ ...authority, controlToken: "replacement" });
      return {
        state: {
          ...next,
          status: "ready",
          controller: "self",
          sessionId: "session",
          runtimeId: "runtime",
          bridgeEpoch: 1,
          viewportGeneration: 1,
        },
        gestureId: input.gestureId,
        nextSequence: input.sequence + 1,
        cursor: null,
        completion: "navigation",
      };
    };
    changed.queue.enqueue(move(1));
    changed.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(changed.navigationCompleted).toEqual([]);
    expect(changed.states).toEqual([state]);
    expect(changed.ended).toHaveLength(1);
  });
  it("coalesces only motion and wheel distance while keeping press/release sequence", async () => {
    const f = fixture();
    f.queue.enqueue(move(1));
    for (let i = 2; i < 100; i++) f.queue.enqueue(move(i));
    f.queue.enqueue({
      kind: "down",
      point: point(99),
      button: "left",
      clickCount: 1,
    });
    f.queue.enqueue({ kind: "scroll", point: point(99), deltaX: 2, deltaY: 5 });
    f.queue.enqueue({
      kind: "scroll",
      point: point(100),
      deltaX: 3,
      deltaY: 7,
    });
    f.queue.enqueue({
      kind: "up",
      point: point(100),
      button: "left",
      clickCount: 1,
    });
    f.queue.finish();
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(f.sent.map((input) => input.event.kind)).toEqual([
      "move",
      "move",
      "down",
      "scroll",
      "up",
    ]);
    expect(f.sent.map((input) => input.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(f.sent[2]?.target).toEqual(authority.target);
    expect(f.sent[0]?.target).toBeUndefined();
    expect(f.sent[3]?.event).toMatchObject({ deltaX: 5, deltaY: 12 });
    expect(f.ended[0]).toMatchObject({ sequence: 6, cancel: false });
    expect(f.errors).toEqual([]);
  });

  it("keeps touch-ID edges through 60Hz motion and partial release", async () => {
    const f = fixture();
    const touch = (
      type: "start" | "move" | "end",
      ids: number[],
      x: number,
    ): BrowserGestureEvent => ({
      kind: "touch",
      type,
      points: ids.map((id) => ({ ...point(x + id), id })),
    });
    f.queue.enqueue(touch("start", [0], 1));
    f.queue.enqueue(touch("start", [0, 1], 2));
    for (let i = 0; i < 180; i++) f.queue.enqueue(touch("move", [0, 1], i));
    f.queue.enqueue(touch("move", [1], 181));
    f.queue.enqueue(touch("end", [], 182));
    f.queue.finish();
    f.beginGate.resolve({ state, gestureId: "touch-channel", nextSequence: 1 });
    await flush();
    expect(
      f.sent.map((input) =>
        input.event.kind === "touch"
          ? [input.event.type, input.event.points.map((point) => point.id)]
          : null,
      ),
    ).toEqual([
      ["start", [0]],
      ["start", [0, 1]],
      ["move", [0, 1]],
      ["move", [1]],
      ["end", []],
    ]);
    expect(f.sent[0]?.target).toEqual(authority.target);
    expect(f.sent[1]?.target).toBeUndefined();
    expect(f.errors).toEqual([]);
  });

  it("revokes late begin replies on lease replacement and never sends queued presses", async () => {
    const f = fixture();
    f.queue.enqueue({
      kind: "down",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    f.changeAuthority({ ...authority, controlToken: "replacement" });
    f.queue.cancel();
    f.beginGate.resolve({ state, gestureId: "obsolete", nextSequence: 1 });
    await flush();
    expect(f.sent).toEqual([]);
    expect(f.ended[0]).toMatchObject({ gestureId: "obsolete", cancel: true });
    expect(f.cursors.filter(Boolean)).toEqual([]);
  });

  it("does not replay an unknown update and cancels with original identity", async () => {
    const f = fixture();
    let attempts = 0;
    f.transport.update = async () => {
      attempts++;
      throw new Error("Unknown outcome");
    };
    f.queue.enqueue({
      kind: "down",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    f.queue.enqueue(move(2));
    f.queue.enqueue({
      kind: "up",
      point: point(2),
      button: "left",
      clickCount: 1,
    });
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(attempts).toBe(1);
    expect(f.ended[0]).toMatchObject({ gestureId: "owned", cancel: true });
    expect(f.errors).toHaveLength(1);
  });

  it("holds at one in-flight update and never publishes a late cursor into a new generation", async () => {
    const f = fixture();
    const updateGate = deferred<Awaited<ReturnType<BrowserGestureTransport["update"]>>>();
    let attempts = 0;
    f.transport.update = async () => {
      attempts++;
      return await updateGate.promise;
    };
    f.queue.enqueue(move(1));
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    f.queue.enqueue(move(2));
    f.changeAuthority({
      ...authority,
      expected: { ...authority.expected, viewportGeneration: 2 },
    });
    f.queue.cancel();
    updateGate.resolve({
      state,
      gestureId: "owned",
      nextSequence: 2,
      cursor: "text",
    });
    await flush();
    expect(attempts).toBe(1);
    expect(f.cursors.filter(Boolean)).toEqual([]);
    expect(f.ended[0]).toMatchObject({ sequence: 2, cancel: true });
  });

  it("changes hover mouse to touch without discarding the first unsent touch", async () => {
    const f = fixture();
    const began: string[] = [];
    f.transport.begin = async (input) => {
      began.push(input.pointerKind);
      return { state, gestureId: `channel-${began.length}`, nextSequence: 1 };
    };
    f.queue.enqueue(move(1));
    await flush();
    f.queue.enqueue({
      kind: "touch",
      type: "start",
      points: [{ ...point(2), id: 7 }],
    });
    await flush();
    expect(began).toEqual(["mouse", "touch"]);
    expect(f.ended[0]).toMatchObject({ gestureId: "channel-1", cancel: false });
    expect(f.sent[1]).toMatchObject({
      gestureId: "channel-2",
      event: { type: "start" },
    });
    expect(f.errors).toEqual([]);
  });

  it("waits for actual decoded pixels between independent presses, never for a held second finger", async () => {
    const frame = deferred<void>();
    const waited: string[] = [];
    const f = fixture(async (id) => {
      waited.push(id);
      await frame.promise;
    });
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 20 });
    await flush();
    f.queue.enqueue({
      kind: "down",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    f.queue.enqueue({
      kind: "up",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    await flush();
    expect(f.sent.map((input) => input.event.kind)).toEqual(["scroll"]);
    expect(waited).toEqual(["decoded-front"]);
    f.changeAuthority({
      ...authority,
      target: { ...authority.target, frameId: "new-front" },
    });
    frame.resolve();
    await flush();
    expect(f.sent[1]?.target?.frameId).toBe("new-front");
    expect(f.sent.map((input) => input.event.kind)).toEqual(["scroll", "down", "up"]);
    expect(f.errors).toEqual([]);
  });

  it("drains queued mouseup then leave before normal cleanup without fresh-frame waits", async () => {
    const waits: string[] = [];
    const f = fixture(async (id) => {
      waits.push(id);
    });
    f.queue.enqueue({
      kind: "down",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    f.queue.enqueue({
      kind: "up",
      point: point(1),
      button: "left",
      clickCount: 1,
    });
    f.queue.finish();
    f.queue.enqueue({ kind: "leave" });
    f.queue.finish();
    f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
    await flush();
    expect(f.sent.map((input) => input.event.kind)).toEqual(["down", "up", "leave"]);
    expect(f.ended).toHaveLength(1);
    expect(f.ended[0]?.cancel).toBe(false);
    expect(waits).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  it("refreshes only a known unadmitted begin, then sends the pending wheel once", async () => {
    const f = fixture(async () => {
      f.changeAuthority({
        ...authority,
        target: { ...authority.target, frameId: "post-scroll-decoded" },
      });
    });
    let begins = 0;
    f.transport.begin = async () => {
      begins += 1;
      return begins === 1
        ? { state, admission: "stale-frame" }
        : { state, gestureId: "owned", nextSequence: 1 };
    };
    f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 20 });
    await flush();
    expect(begins).toBe(2);
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });

  it("does not retry begin or update after transport error or uncertain physical publication", async () => {
    for (const failure of ["begin", "update"] as const) {
      const f = fixture(async () => {
        throw new Error("Must not wait/retry");
      });
      let begins = 0;
      let updates = 0;
      f.transport.begin = async () => {
        begins += 1;
        if (failure === "begin") throw new Error("Outcome unknown");
        return { state, gestureId: "owned", nextSequence: 1 };
      };
      f.transport.update = async () => {
        updates += 1;
        throw new Error("Outcome unknown");
      };
      f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 20 });
      await flush();
      expect(begins).toBe(1);
      expect(updates).toBe(failure === "begin" ? 0 : 1);
      expect(f.errors).toHaveLength(1);
    }
  });

  it("bounds stale admission and refuses replacement control while waiting for decode", async () => {
    const f = fixture(async () => {
      f.changeAuthority({
        ...authority,
        target: { ...authority.target, frameId: String(++front) },
      });
    });
    let front = 0;
    let begins = 0;
    f.transport.begin = async () => {
      begins += 1;
      return { state, admission: "stale-frame" };
    };
    f.queue.enqueue(move(1));
    await flush();
    expect(begins).toBe(3);
    expect(f.sent).toHaveLength(0);
    expect(f.errors).toHaveLength(1);
    const changed = fixture(async () => {
      changed.changeAuthority({ ...authority, controlToken: "replacement" });
    });
    let changedBegins = 0;
    changed.transport.begin = async () => {
      changedBegins += 1;
      return { state, admission: "stale-frame" };
    };
    changed.queue.enqueue(move(1));
    await flush();
    expect(changedBegins).toBe(1);
    expect(changed.sent).toHaveLength(0);
  });

  it("shares one four-second admission wait budget across stale decoder handoffs", async () => {
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const budgets: number[] = [];
      const f = fixture(async (_id, budget) => {
        budgets.push(budget!);
        clock += budgets.length === 1 ? 3_000 : 1_001;
        f.changeAuthority({
          ...authority,
          target: { ...authority.target, frameId: String(clock) },
        });
      });
      let begins = 0;
      f.transport.begin = async () => {
        begins += 1;
        return { state, admission: "stale-frame" };
      };
      f.queue.enqueue(move(1));
      await flush();
      expect(budgets).toEqual([4_000, 1_000]);
      expect(begins).toBe(2);
      expect(f.sent).toHaveLength(0);
      expect(f.errors).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("does not begin under replacement control after the initial invalidated-frame wait", async () => {
    const f = fixture(async () => {
      f.changeAuthority({ ...authority, controlToken: "replacement" });
    });
    let begins = 0;
    f.transport.begin = async () => {
      begins += 1;
      return { state, gestureId: "owned", nextSequence: 1 };
    };
    f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 20 });
    await flush();
    f.queue.finish();
    await flush();
    f.queue.enqueue(move(1));
    await flush();
    expect(begins).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });
});

it("keeps keyboard repeat/Unicode edges ordered and a held modifier alive across mouse release", async () => {
  const f = fixture();
  const key = {
    kind: "key",
    type: "down",
    key: "Control",
    code: "ControlLeft",
    modifiers: 2,
    repeat: false,
  } as const;
  f.queue.enqueue(key);
  f.queue.enqueue({ kind: "down", point: point(1), button: "left", clickCount: 1 });
  f.queue.enqueue({ kind: "up", point: point(1), button: "left", clickCount: 1 });
  f.queue.finish();
  f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
  await flush();
  expect(f.ended).toEqual([]);
  f.queue.enqueue({ ...key, type: "up", modifiers: 0 });
  f.queue.enqueue({
    kind: "key",
    type: "down",
    key: "é",
    code: "KeyE",
    modifiers: 0,
    repeat: false,
  });
  f.queue.enqueue({
    kind: "key",
    type: "down",
    key: "é",
    code: "KeyE",
    modifiers: 0,
    repeat: true,
  });
  f.queue.enqueue({ kind: "key", type: "up", key: "é", code: "KeyE", modifiers: 0, repeat: false });
  f.queue.enqueue({ kind: "text", text: "漢字\n😀" });
  f.queue.finish();
  await flush();
  expect(f.sent.map((input) => input.event.kind)).toEqual([
    "key",
    "down",
    "up",
    "key",
    "key",
    "key",
    "key",
    "text",
  ]);
  expect(f.sent.map((input) => input.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(f.ended).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

it("never merges normal scrolling with a differently modified wheel gesture", async () => {
  const f = fixture();
  f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 10, modifiers: 0 });
  f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 20, modifiers: 2 });
  f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 30, modifiers: 2 });
  f.beginGate.resolve({ state, gestureId: "owned", nextSequence: 1 });
  await flush();
  expect(f.sent.map((input) => input.event)).toEqual([
    { kind: "scroll", point: point(1), deltaX: 0, deltaY: 10, modifiers: 0 },
    { kind: "scroll", point: point(1), deltaX: 0, deltaY: 50, modifiers: 2 },
  ]);
  f.queue.cancel();
  await flush();
});

it("keeps a held drag/release/end when pixels are revoked, but a new press then needs decoded pixels", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  f.changeAuthority(null);
  expect(f.queue.enqueue(move(50))).toBe(true);
  expect(f.queue.enqueue({ kind: "up", button: "left", point: point(50), clickCount: 1 })).toBe(
    true,
  );
  f.queue.finish();
  await flush();
  expect(f.sent.map((value) => value.event.kind)).toEqual(["down", "move", "up"]);
  expect(f.sent.slice(1).every((value) => value.target === undefined)).toBe(true);
  expect(f.ended).toEqual([expect.objectContaining({ gestureId: "opaque", cancel: false })]);
  expect(f.errors).toEqual([]);
  // No retained admission survives the closed channel.
  expect(f.queue.enqueue({ kind: "down", button: "left", point: point(50), clickCount: 1 })).toBe(
    false,
  );
  expect(f.sent).toHaveLength(3);
});

it("keeps an admitted keyup, but a new press after revoked pixels is refused before publication", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue({
    kind: "key",
    type: "down",
    key: "Control",
    code: "ControlLeft",
    modifiers: 2,
    repeat: false,
  });
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  f.changeAuthority(null);
  expect(
    f.queue.enqueue({
      kind: "key",
      type: "up",
      key: "Control",
      code: "ControlLeft",
      modifiers: 0,
      repeat: false,
    }),
  ).toBe(true);
  await flush();
  f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 });
  await flush();
  expect(f.sent.map((value) => value.event.kind)).toEqual(["key", "key"]);
  expect(f.errors).toHaveLength(1);
  expect(f.ended).toEqual([expect.objectContaining({ cancel: true })]);
});

it("control incarnation replacement still cancels an admitted continuation before publication", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  const gate = deferred<Awaited<ReturnType<BrowserGestureTransport["update"]>>>();
  f.transport.update = async (input) => {
    f.sent.push(input);
    return await gate.promise;
  };
  f.queue.enqueue(move(2));
  f.queue.enqueue(move(3));
  f.changeAuthority(null);
  f.changeControl({ ...authority, expected: { ...authority.expected, runtimeId: "replacement" } });
  gate.resolve({ state, gestureId: "opaque", nextSequence: 3, cursor: null });
  await flush();
  expect(f.sent.map((value) => value.event.kind)).toEqual(["down", "move"]);
  expect(f.ended.at(-1)?.cancel).toBe(true);
});

/** Simulate native idle expiry while the client runs no scheduled cleanup callbacks. */
function idleFixture() {
  let clock = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const f = fixture(undefined, true);
  const beginnings: BrowserGestureAuthority[] = [];
  f.transport.begin = async (input) => {
    beginnings.push(input);
    return { state, gestureId: `opaque-${beginnings.length}`, nextSequence: 1 };
  };
  const publish = f.transport.update;
  f.transport.update = async (input) => {
    if (clock >= 5_000 && input.gestureId === "opaque-1") {
      throw new Error(
        "Workspace runtime input.check failed: Live browser input attachment changed",
      );
    }
    return publish(input);
  };
  const end = f.transport.end;
  f.transport.end = async (input) => {
    if (clock >= 5_000 && input.gestureId === "opaque-1" && !input.cancel) {
      throw new Error("Browser gesture is unavailable");
    }
    return end(input);
  };
  return {
    ...f,
    beginnings,
    advanceClock: (elapsedMs: number) => {
      clock += elapsedMs;
    },
    async cleanup() {
      f.queue.cancel();
      await flush();
      clockSpy.mockRestore();
    },
  };
}

it("reopens an expired channel only from a newer decoded frame, never from the old admission", async () => {
  const f = idleFixture();
  try {
    f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
    f.queue.enqueue({ kind: "up", button: "left", point: point(1), clickCount: 1 });
    await flush();
    f.changeAuthority(freshAuthority);
    // Simulate a paused client: no timer or finish callback ran before native expiry.
    f.advanceClock(6_000);
    f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 });
    await flush();
    expect(f.errors).toEqual([]);
    expect(f.beginnings).toHaveLength(2);
    expect(f.beginnings[1]?.target).toEqual(freshAuthority.target);
    expect(f.sent.map((input) => input.gestureId)).toEqual(["opaque-1", "opaque-1", "opaque-2"]);
    expect(f.sent.at(-1)?.target).toEqual(freshAuthority.target);
  } finally {
    await f.cleanup();
  }
});

it("retires a late idle finish without addressing the expired channel", async () => {
  const f = idleFixture();
  try {
    f.queue.enqueue(move(1));
    await flush();
    f.advanceClock(6_000);
    f.queue.finish();
    await flush();
    expect(f.errors).toEqual([]);
    expect(f.ended).toEqual([]);
    expect(f.finishes()).toBe(1);
    f.changeAuthority(freshAuthority);
    expect(f.queue.enqueue(move(2))).toBe(true);
    await flush();
    expect(f.beginnings).toHaveLength(2);
    expect(f.sent.at(-1)?.gestureId).toBe("opaque-2");
  } finally {
    await f.cleanup();
  }
});

it("never reopens a held channel or replays its rejected release after idle expiry", async () => {
  const f = idleFixture();
  try {
    f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
    await flush();
    f.advanceClock(6_000);
    f.queue.enqueue({ kind: "up", button: "left", point: point(1), clickCount: 1 });
    await flush();
    expect(f.beginnings).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toHaveLength(1);
    expect(f.ended).toMatchObject([{ gestureId: "opaque-1", cancel: true }]);
  } finally {
    await f.cleanup();
  }
});

it("discards suspended idle admission when native control identity changes", async () => {
  const f = idleFixture();
  try {
    f.queue.enqueue(move(1));
    await flush();
    f.advanceClock(6_000);
    f.changeAuthority(null);
    f.changeControl({ ...authority, controlToken: "replacement-control" });
    expect(f.queue.enqueue(move(2))).toBe(false);
    await flush();
    expect(f.beginnings).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(f.ended).toMatchObject([{ gestureId: "opaque-1", cancel: true }]);
  } finally {
    await f.cleanup();
  }
});

it("never reopens on a spent receipt: the next press waits for a newer decoded frame", async () => {
  let waited = 0;
  const f: ReturnType<typeof fixture> = fixture(async (afterFrameId) => {
    waited += 1;
    expect(afterFrameId).toBe(authority.target.frameId);
    f.changeAuthority(freshAuthority);
  }, true);
  const beginnings: BrowserGestureAuthority[] = [];
  f.transport.begin = async (input) => {
    beginnings.push(input);
    return { state, gestureId: `opaque-${beginnings.length}`, nextSequence: 1 };
  };
  f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
  f.queue.enqueue({ kind: "up", button: "left", point: point(1), clickCount: 1 });
  await flush();
  f.queue.finish();
  await flush();
  expect(f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 })).toBe(
    true,
  );
  await flush();
  expect(waited).toBe(1);
  expect(beginnings).toHaveLength(2);
  expect(beginnings[1]?.target).toEqual(freshAuthority.target);
  expect(f.sent.at(-1)?.gestureId).toBe("opaque-2");
  expect(f.sent.at(-1)?.target).toEqual(freshAuthority.target);
  expect(f.errors).toEqual([]);
  f.queue.cancel();
  await flush();
  f.changeControl(null);
  expect(f.queue.enqueue(move(3))).toBe(false);
});

it("does not create geometry admission from an unknown begin or visual-only frame", async () => {
  const f = fixture(undefined, true);
  f.changeAuthority(null);
  expect(f.queue.enqueue(move(1))).toBe(false);
  f.changeAuthority(authority);
  f.transport.begin = async () => {
    throw new Error("Unknown publication");
  };
  f.queue.enqueue(move(1));
  await flush();
  expect(f.errors).toHaveLength(1);
  f.changeAuthority(null);
  expect(f.queue.enqueue(move(2))).toBe(false);
  expect(f.sent).toEqual([]);
});

it("does not retain admitted geometry after an uncertain update", async () => {
  const f = fixture(undefined, true);
  f.transport.begin = async () => ({ state, gestureId: "opaque", nextSequence: 1 });
  f.transport.update = async () => {
    throw new Error("Lost published update reply");
  };
  f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
  await flush();
  f.changeAuthority(null);
  expect(f.queue.enqueue(move(2))).toBe(false);
  expect(f.errors).toHaveLength(1);
  expect(f.ended).toEqual([expect.objectContaining({ cancel: true })]);
});

it.each(["viewer", "controller", "session", "runtime", "bridge", "document", "viewport"])(
  "discards idle geometry across %s replacement without a decoded replacement basis",
  async (field) => {
    const f = fixture(undefined, true);
    let begins = 0;
    f.transport.begin = async () => ({ state, gestureId: `opaque-${++begins}`, nextSequence: 1 });
    f.queue.enqueue({ kind: "scroll", point: point(1), deltaX: 0, deltaY: 10 });
    await flush();
    f.queue.finish();
    await flush();
    f.changeAuthority(null);
    const replacement = structuredClone(authority);
    if (field === "viewer") replacement.viewerToken = "new-viewer";
    if (field === "controller") replacement.controlToken = "new-control";
    if (field === "session") replacement.expected.sessionId = "new-session";
    if (field === "runtime") replacement.expected.runtimeId = "new-runtime";
    if (field === "bridge") replacement.expected.bridgeEpoch = 2;
    if (field === "document") replacement.expected.navigationGeneration = 2;
    if (field === "viewport") replacement.expected.viewportGeneration = 2;
    f.changeControl(replacement);
    expect(f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 })).toBe(
      false,
    );
    expect(begins).toBe(1);
    expect(f.sent).toHaveLength(1);
  },
);

it("reports host acknowledgement of every receipt-revoking input, never plain hover", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue(move(1));
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  f.queue.enqueue(move(2));
  await flush();
  expect(f.acknowledgements).toEqual([]);
  f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 });
  await flush();
  expect(f.acknowledgements).toEqual(["ack"]);
  f.queue.enqueue(move(3)); // a held drag keeps revoking
  f.queue.enqueue({ kind: "up", button: "left", point: point(3), clickCount: 1 });
  await flush();
  expect(f.acknowledgements).toHaveLength(3);
  f.queue.enqueue({ kind: "scroll", point: point(3), deltaX: 0, deltaY: 5 });
  await flush();
  expect(f.acknowledgements).toHaveLength(4);
  f.queue.cancel();
});

it("waits for the next decoded frame when video revoked its receipt, then presses with that frame", async () => {
  // Video input authority disappears (null) right after an acknowledged press and
  // returns only when the next packet paints; the queue must wait, not refuse.
  let waited = 0;
  const f: ReturnType<typeof fixture> = fixture(async (afterFrameId) => {
    waited += 1;
    expect(afterFrameId).toBe(authority.target.frameId);
    f.changeAuthority(freshAuthority);
  }, true);
  f.queue.enqueue({ kind: "down", button: "left", point: point(1), clickCount: 1 });
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  f.queue.enqueue({ kind: "up", button: "left", point: point(1), clickCount: 1 });
  await flush();
  f.changeAuthority(null);
  expect(f.queue.enqueue({ kind: "down", button: "left", point: point(2), clickCount: 1 })).toBe(
    true,
  );
  await flush();
  expect(waited).toBe(1);
  expect(f.errors).toEqual([]);
  expect(f.sent.map((input) => input.event.kind)).toEqual(["down", "up", "down"]);
  expect(f.sent.map((input) => input.target?.frameId)).toEqual([
    authority.target.frameId,
    undefined,
    freshAuthority.target.frameId,
  ]);
  f.queue.cancel();
});
it("gives each independent touch contact its own decoded receipt; fingers within a gesture and text reuse the channel", async () => {
  const f: ReturnType<typeof fixture> = fixture(async () => {
    f.changeAuthority(freshAuthority);
  }, true);
  const touch = (type: "start" | "move" | "end", ids: number[]): BrowserGestureEvent => ({
    kind: "touch",
    type,
    points: ids.map((id) => ({ ...point(id + 1), id })),
  });
  f.queue.enqueue(touch("start", [0]));
  f.beginGate.resolve({ state, gestureId: "opaque", nextSequence: 1 });
  await flush();
  f.queue.enqueue(touch("start", [0, 1]));
  f.queue.enqueue(touch("move", [1]));
  f.queue.enqueue(touch("end", []));
  f.queue.enqueue(touch("start", [2]));
  f.queue.enqueue(touch("end", []));
  f.queue.enqueue({ kind: "text", text: "Unicode π" });
  await flush();
  expect(f.sent.map((input) => input.event.kind)).toEqual([
    "touch",
    "touch",
    "touch",
    "touch",
    "touch",
    "touch",
    "text",
  ]);
  expect(f.sent.map((input) => input.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(f.sent.map((input) => input.target?.frameId)).toEqual([
    authority.target.frameId,
    undefined,
    undefined,
    undefined,
    freshAuthority.target.frameId,
    undefined,
    undefined,
  ]);
  expect(f.errors).toEqual([]);
  f.queue.cancel();
});

it("preserves a complete tap while begin waits and only decoded authority is revoked", async () => {
  const f = fixture(undefined, true);
  const start: BrowserGestureEvent = {
    kind: "touch",
    type: "start",
    points: [{ ...point(1), id: 0 }],
  };
  const end: BrowserGestureEvent = { kind: "touch", type: "end", points: [] };
  expect(f.queue.enqueue(start)).toBe(true);
  f.changeAuthority(null);
  expect(f.queue.enqueue(end)).toBe(true);
  f.queue.finish();
  expect(f.sent).toEqual([]);
  f.beginGate.resolve({ state, gestureId: "pending-tap", nextSequence: 1 });
  await flush();
  expect(f.sent.map((input) => input.event)).toEqual([start, end]);
  expect(f.sent.map((input) => input.sequence)).toEqual([1, 2]);
  expect(f.ended).toEqual([
    expect.objectContaining({ gestureId: "pending-tap", sequence: 3, cancel: false }),
  ]);
  expect(f.errors).toEqual([]);
});

it("discards pending tap edges after actual control replacement", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue({ kind: "touch", type: "start", points: [{ ...point(1), id: 0 }] });
  f.changeAuthority(null);
  f.changeControl({ ...authority, controlToken: "replacement" });
  expect(f.queue.enqueue({ kind: "touch", type: "end", points: [] })).toBe(false);
  f.beginGate.resolve({ state, gestureId: "old-pending-tap", nextSequence: 1 });
  await flush();
  expect(f.sent).toEqual([]);
  expect(f.ended).toEqual([
    expect.objectContaining({ gestureId: "old-pending-tap", sequence: 1, cancel: true }),
  ]);
});

it("publishes no buffered tap after unknown begin failure and never reuses its basis", async () => {
  const f = fixture(undefined, true);
  f.queue.enqueue({ kind: "touch", type: "start", points: [{ ...point(1), id: 0 }] });
  f.changeAuthority(null);
  expect(f.queue.enqueue({ kind: "touch", type: "end", points: [] })).toBe(true);
  f.beginGate.reject(new Error("Unknown admission outcome"));
  await flush();
  expect(f.sent).toEqual([]);
  expect(f.ended).toEqual([]);
  expect(f.errors).toHaveLength(1);
  expect(f.queue.enqueue({ kind: "touch", type: "start", points: [{ ...point(2), id: 0 }] })).toBe(
    false,
  );
});

it("preserves release during stale-frame waiting until fresh same-context admission", async () => {
  const frameGate = deferred<void>();
  let waiting = false;
  const f = fixture(async () => {
    waiting = true;
    await frameGate.promise;
  }, true);
  const beginnings: BrowserGestureAuthority[] = [];
  f.transport.begin = async (input) => {
    beginnings.push(input);
    return beginnings.length === 1
      ? { state, admission: "stale-frame" }
      : { state, gestureId: "fresh-tap", nextSequence: 1 };
  };
  const start: BrowserGestureEvent = {
    kind: "touch",
    type: "start",
    points: [{ ...point(1), id: 0 }],
  };
  const end: BrowserGestureEvent = { kind: "touch", type: "end", points: [] };
  f.queue.enqueue(start);
  await flush();
  expect(waiting).toBe(true);
  f.changeAuthority(null);
  expect(f.queue.enqueue(end)).toBe(true);
  f.queue.finish();
  expect(f.sent).toEqual([]);
  f.changeAuthority({
    ...authority,
    target: { ...authority.target, frameId: "fresh-after-stale" },
  });
  frameGate.resolve();
  await flush();
  expect(beginnings.map((input) => input.target.frameId)).toEqual([
    "decoded-front",
    "fresh-after-stale",
  ]);
  expect(f.sent.map((input) => input.event)).toEqual([start, end]);
  expect(f.ended).toEqual([
    expect.objectContaining({ gestureId: "fresh-tap", sequence: 3, cancel: false }),
  ]);
  expect(f.errors).toEqual([]);
});
