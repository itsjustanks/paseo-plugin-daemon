import { describe, expect, it } from "vitest";
import { containedRect } from "../../shared/managed-browser/browser";
import { getBrowserCanvasLayout } from "./browser-canvas-layout";

describe("local browser canvas geometry", () => {
  it("defaults to Fit and exactly preserves containedRect's letterboxing", () => {
    const container = { width: 1000, height: 700 };
    const frame = { width: 824, height: 1678 };
    expect(getBrowserCanvasLayout(container, frame, { width: 412, height: 839 })).toEqual({
      contentSize: container,
      frameRect: containedRect(container, frame),
    });
  });

  it("displays sharp Pixel capture at canonical CSS size rather than twice its size", () => {
    expect(
      getBrowserCanvasLayout(
        { width: 300, height: 600 },
        { width: 824, height: 1678 },
        { width: 412, height: 839 },
        "actual",
      ),
    ).toEqual({
      contentSize: { width: 412, height: 839 },
      frameRect: { x: 0, y: 0, width: 412, height: 839 },
    });
  });

  it("keeps Actual size unchanged at DPR1,2 or3", () => {
    const viewport = { width: 1280, height: 800 };
    for (const scale of [1, 2, 3]) {
      expect(
        getBrowserCanvasLayout(
          { width: 600, height: 400 },
          { width: viewport.width * scale, height: viewport.height * scale },
          viewport,
          "actual",
        ),
      ).toEqual({
        contentSize: viewport,
        frameRect: { x: 0, y: 0, ...viewport },
      });
    }
  });

  it("lets the scroll host center a smaller Actual frame without an outer-sized spacer", () => {
    expect(
      getBrowserCanvasLayout(
        { width: 1000, height: 1000 },
        { width: 824, height: 1678 },
        { width: 412, height: 839 },
        "actual",
      ),
    ).toEqual({
      contentSize: { width: 412, height: 839 },
      frameRect: { x: 0, y: 0, width: 412, height: 839 },
    });
  });

  it("uses exact frame extents on both axes so scrollbar allocation cannot create unused overflow", () => {
    expect(
      getBrowserCanvasLayout(
        { width: 1000, height: 500 },
        { width: 824, height: 1678 },
        { width: 412, height: 839 },
        "actual",
      ),
    ).toEqual({
      contentSize: { width: 412, height: 839 },
      frameRect: { x: 0, y: 0, width: 412, height: 839 },
    });
    expect(
      getBrowserCanvasLayout(
        { width: 300, height: 1000 },
        { width: 824, height: 1678 },
        { width: 412, height: 839 },
        "actual",
      ),
    ).toEqual({
      contentSize: { width: 412, height: 839 },
      frameRect: { x: 0, y: 0, width: 412, height: 839 },
    });
  });

  it("rejects invalid/unmeasured dimensions without publishing NaN overlay coordinates", () => {
    const valid = { width: 600, height: 400 };
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const axis of ["width", "height"] as const) {
        const size = { ...valid, [axis]: invalid };
        expect(getBrowserCanvasLayout(size, valid, valid)).toBeNull();
        expect(getBrowserCanvasLayout(valid, size, valid)).toBeNull();
        expect(getBrowserCanvasLayout(valid, valid, size, "actual")).toBeNull();
      }
    }
  });

  it("does not require resolved remote CSS size before the existing Fit geometry can render", () => {
    expect(
      getBrowserCanvasLayout(
        { width: 800, height: 600 },
        { width: 1280, height: 800 },
        { width: 0, height: 0 },
      ),
    ).toEqual({
      contentSize: { width: 800, height: 600 },
      frameRect: containedRect({ width: 800, height: 600 }, { width: 1280, height: 800 }),
    });
  });
});
