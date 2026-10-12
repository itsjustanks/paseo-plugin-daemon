import { describe, expect, it } from "vitest";
import { getFillViewportResolution } from "./browser-fill-viewport";

describe("fill viewport resolution", () => {
  it("uses the visible canvas's logical size, including fractional layout rounding", () => {
    expect(getFillViewportResolution({ width: 1042.4, height: 781.6 })).toEqual({
      width: 1042,
      height: 782,
    });
  });

  it("accepts both supported boundaries", () => {
    expect(getFillViewportResolution({ width: 320, height: 480 })).toEqual({
      width: 320,
      height: 480,
    });
    expect(getFillViewportResolution({ width: 3840, height: 3840 })).toEqual({
      width: 3840,
      height: 3840,
    });
  });

  it("preserves logical size at sharp density and rejects oversized physical captures", () => {
    expect(getFillViewportResolution({ width: 1000, height: 700 }, 2)).toEqual({
      width: 1000,
      height: 700,
    });
    expect(getFillViewportResolution({ width: 1921, height: 700 }, 2)).toBeNull();
    expect(getFillViewportResolution({ width: 1000, height: 1921 }, 2)).toBeNull();
  });

  it("rejects unavailable and unsupported sizes without substituting a resolution", () => {
    for (const size of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: 600 },
      { width: 800, height: Number.POSITIVE_INFINITY },
      { width: 319, height: 600 },
      { width: 800, height: 479 },
      { width: 3841, height: 800 },
      { width: 800, height: 3841 },
    ]) {
      expect(getFillViewportResolution(size)).toBeNull();
    }
  });
});
