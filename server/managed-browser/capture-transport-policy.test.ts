import { describe, expect, it } from "vitest";
import type { RuntimeFrame } from "./agent-browser-runtime";
import { createCaptureTransportPolicy } from "./capture-transport-policy";

const frame: RuntimeFrame = {
  dataBase64: "Zml4dHVyZQ==",
  byteLength: 7,
  width: 1280,
  height: 800,
  transport: "screenshot",
  capturedAt: "2026-10-02T12:00:00.000Z",
};

describe("capture transport policy", () => {
  it("keeps the true screenshot and original capture time only through1000ms at exact quality/budget", () => {
    const policy = createCaptureTransportPolicy();
    const token = policy.beginScreenshot();
    expect(policy.rememberScreenshot(token, frame, 100, 100, 1000)).toBe(true);
    policy.endScreenshot(token, 100);
    expect(policy.readScreenshot(1100, 100, 1000)).toBe(frame);
    expect(policy.readScreenshot(1101, 100, 1000)).toBeNull();
    expect(policy.readScreenshot(500, 90, 1000)).toBeNull();
    expect(policy.readScreenshot(500, 100, 1001)).toBeNull();
  });

  it("revokes old asynchronous completions on input/session invalidation", () => {
    const policy = createCaptureTransportPolicy();
    const old = policy.beginScreenshot();
    policy.invalidate();
    const fresh = policy.beginScreenshot();
    expect(policy.rememberScreenshot(old, frame, 100, 100, 1000)).toBe(false);
    policy.endScreenshot(old, 100);
    expect(policy.readScreenshot(100, 100, 1000)).toBeNull();
    expect(policy.rememberScreenshot(fresh, frame, 200, 100, 1000)).toBe(true);
    policy.invalidate();
    expect(policy.readScreenshot(200, 100, 1000)).toBeNull();
  });

  it("cannot recover from screenshot-induced frames or repeated sparse capture cycles", () => {
    const policy = createCaptureTransportPolicy();
    policy.enterFallback(0);
    for (let time = 0; time < 6000; time += 1000) {
      const token = policy.beginScreenshot();
      policy.observeStream(`inside-${time}`, time + 10);
      policy.endScreenshot(token, time + 20);
      policy.observeStream(`queued-${time}`, time + 100);
      expect(policy.canUseStream(time + 500)).toBe(false);
    }
  });

  it("requires3 distinct events over500ms with bounded gaps and retains the original dwell", () => {
    const policy = createCaptureTransportPolicy();
    policy.enterFallback(0);
    policy.observeStream("one", 1100);
    policy.enterFallback(1200);
    policy.observeStream("two", 1350);
    expect(policy.canUseStream(1500)).toBe(false);
    policy.observeStream("three", 1600);
    expect(policy.canUseStream(1600)).toBe(true);
  });

  it("rejects duplicate events, burst-only evidence and stale recovery", () => {
    const duplicate = createCaptureTransportPolicy();
    duplicate.enterFallback(0);
    duplicate.observeStream("same", 1000);
    duplicate.observeStream("same", 1250);
    duplicate.observeStream("same", 1500);
    expect(duplicate.canUseStream(1500)).toBe(false);

    const burst = createCaptureTransportPolicy();
    burst.enterFallback(0);
    burst.observeStream("one", 1400);
    burst.observeStream("two", 1450);
    burst.observeStream("three", 1500);
    expect(burst.canUseStream(1500)).toBe(false);
    expect(burst.canUseStream(2100)).toBe(false);
  });

  it("a long inter-event gap resets evidence and invalidation clears all recovery", () => {
    const policy = createCaptureTransportPolicy();
    policy.enterFallback(0);
    policy.observeStream("one", 1000);
    policy.observeStream("two", 1250);
    policy.observeStream("three", 1800);
    expect(policy.canUseStream(1800)).toBe(false);
    policy.observeStream("four", 2050);
    policy.invalidate();
    policy.observeStream("five", 2300);
    expect(policy.canUseStream(2300)).toBe(false);
  });
});

it("quality-only captures preserve independent recovery and still exclude capture-induced events", () => {
  const policy = createCaptureTransportPolicy();
  policy.enterFallback(0);
  policy.observeStream("one", 1100);
  const token = policy.beginScreenshot({ preserveRecovery: true });
  policy.observeStream("induced", 1120);
  policy.endScreenshot(token, 1130);
  policy.observeStream("queued", 1250);
  expect(policy.canUseStream(1500)).toBe(false);
  policy.observeStream("two", 1500);
  policy.observeStream("three", 1750);
  expect(policy.canUseStream(1750)).toBe(true);
});
