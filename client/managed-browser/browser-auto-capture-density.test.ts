import { describe, expect, it } from "vitest";
import { getAutomaticCaptureDensity } from "./browser-auto-capture-density";

describe("automatic capture density", () => {
  it("sharpens the reported phone layout without enlarging CSS dimensions", () => {
    const viewport = { width: 411, height: 653 };
    expect(getAutomaticCaptureDensity(viewport, viewport, 3, "fit")).toBe(2);
    expect(getAutomaticCaptureDensity(viewport, viewport, 1, "fit")).toBe(1);
  });

  it("accounts for both high DPI screens and enlarged low DPI presentations", () => {
    const viewport = { width: 800, height: 600 };
    expect(getAutomaticCaptureDensity(viewport, viewport, 1.5, "fit")).toBe(2);
    expect(getAutomaticCaptureDensity(viewport, { width: 1200, height: 900 }, 1, "fit")).toBe(2);
  });

  it("does not double density for fractional layout rounding alone", () => {
    expect(
      getAutomaticCaptureDensity(
        { width: 411, height: 653 },
        { width: 411.1, height: 653.1 },
        1,
        "fit",
      ),
    ).toBe(1);
  });

  it("avoids unnecessary density when a large page is shrunk on a phone", () => {
    expect(
      getAutomaticCaptureDensity(
        { width: 1920, height: 1080 },
        { width: 411, height: 653 },
        3,
        "fit",
      ),
    ).toBe(1);
  });

  it("uses the contained frame rather than letterboxed container height", () => {
    expect(
      getAutomaticCaptureDensity(
        { width: 1000, height: 500 },
        { width: 400, height: 2000 },
        2,
        "fit",
      ),
    ).toBe(1);
  });

  it("uses CSS dimensions for Actual size even when the panel clips the page", () => {
    expect(
      getAutomaticCaptureDensity(
        { width: 1280, height: 800 },
        { width: 400, height: 600 },
        2,
        "actual",
      ),
    ).toBe(2);
  });

  it("reduces density at the physical capture limit without substituting a layout size", () => {
    expect(
      getAutomaticCaptureDensity(
        { width: 1920, height: 1920 },
        { width: 1920, height: 1920 },
        3,
        "fit",
      ),
    ).toBe(2);
    expect(
      getAutomaticCaptureDensity(
        { width: 1921, height: 700 },
        { width: 1921, height: 700 },
        3,
        "fit",
      ),
    ).toBe(1);
    expect(
      getAutomaticCaptureDensity(
        { width: 3840, height: 3840 },
        { width: 3840, height: 3840 },
        3,
        "fit",
      ),
    ).toBe(1);
    expect(
      getAutomaticCaptureDensity(
        { width: 3841, height: 700 },
        { width: 3841, height: 700 },
        3,
        "fit",
      ),
    ).toBeNull();
  });

  it("waits for usable geometry and screen metrics", () => {
    const size = { width: 411, height: 653 };
    expect(getAutomaticCaptureDensity(size, { width: 0, height: 0 }, 3, "fit")).toBeNull();
    expect(getAutomaticCaptureDensity(size, size, Number.NaN, "fit")).toBeNull();
    expect(getAutomaticCaptureDensity(size, size, 0, "fit")).toBeNull();
  });
});
