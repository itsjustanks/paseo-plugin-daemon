import { expect, it } from "vitest";
import { browserCaptureInterval } from "./browser-capture-cadence";

it("keeps idle/hover polling bounded and only accelerates actual ready input", () => {
  expect(browserCaptureInterval("ready", false)).toBe(250);
  expect(browserCaptureInterval("ready", true)).toBe(100);
  expect(browserCaptureInterval("starting", true)).toBe(1_500);
  expect(browserCaptureInterval(undefined, false)).toBe(1_500);
});
