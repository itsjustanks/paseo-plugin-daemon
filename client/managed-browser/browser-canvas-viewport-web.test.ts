import { describe, expect, it } from "vitest";
import { configureBrowserCanvasWebScrolling } from "./browser-canvas-viewport-web";

describe("local web browser viewport overflow", () => {
  it("enables both overflow axes on the same public scroll node, preserving Actual offsets", () => {
    const node = {
      style: { overflowX: "hidden", overflowY: "auto" },
      scrollLeft: 300,
      scrollTop: 150,
    };
    configureBrowserCanvasWebScrolling({ getScrollableNode: () => node }, "actual", true);
    expect(node).toEqual({
      style: { overflowX: "auto", overflowY: "auto" },
      scrollLeft: 300,
      scrollTop: 150,
    });
  });

  it("hides overflow and resets both local offsets when returning to Fit", () => {
    const node = {
      style: { overflowX: "auto", overflowY: "auto" },
      scrollLeft: 300,
      scrollTop: 150,
    };
    configureBrowserCanvasWebScrolling({ getScrollableNode: () => node }, "fit", true);
    expect(node).toEqual({
      style: { overflowX: "hidden", overflowY: "hidden" },
      scrollLeft: 0,
      scrollTop: 0,
    });
  });

  it("retains an Actual observation position when local panning is disabled", () => {
    const node = {
      style: { overflowX: "auto", overflowY: "auto" },
      scrollLeft: 300,
      scrollTop: 150,
    };
    configureBrowserCanvasWebScrolling({ getScrollableNode: () => node }, "actual", false);
    expect(node).toEqual({
      style: { overflowX: "hidden", overflowY: "hidden" },
      scrollLeft: 300,
      scrollTop: 150,
    });
  });

  it("uses the documented native host fallback while preserving the handle receiver", () => {
    const node = { style: { overflowX: "", overflowY: "" }, scrollLeft: 0, scrollTop: 0 };
    const handle = {
      node,
      getScrollableNode: () => null,
      getNativeScrollRef() {
        return this.node;
      },
    };
    configureBrowserCanvasWebScrolling(handle, "actual", true);
    expect(node.style).toEqual({ overflowX: "auto", overflowY: "auto" });
  });

  it("ignores missing, disappearing and non-DOM platform refs without changing unrelated nodes", () => {
    expect(() => configureBrowserCanvasWebScrolling(null, "actual", true)).not.toThrow();
    expect(() =>
      configureBrowserCanvasWebScrolling({ getScrollableNode: () => 42 }, "actual", true),
    ).not.toThrow();
    expect(() =>
      configureBrowserCanvasWebScrolling(
        {
          getScrollableNode: () => {
            throw new Error("Detached");
          },
        },
        "actual",
        true,
      ),
    ).not.toThrow();
  });
});
