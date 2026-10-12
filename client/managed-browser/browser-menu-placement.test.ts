import { describe, expect, it } from "vitest";
import { browserMenuPlacement, browserSubmenuPlacement } from "./browser-menu-placement";

describe("bounded toolbar menus", () => {
  it("aligns under a desktop trigger without exceeding the pane", () => {
    expect(
      browserMenuPlacement(
        { width: 800, height: 600 },
        { x: 740, y: 8, width: 28, height: 28 },
        240,
      ),
    ).toEqual({ x: 468, y: 40, width: 300, height: 240 });
  });
  it("fits a narrow phone pane and bounds a long favorites list for scrolling", () => {
    const rect = browserMenuPlacement(
      { width: 280, height: 240 },
      { x: 20, y: 8, width: 28, height: 28 },
      900,
    )!;
    expect(rect).toEqual({ x: 8, y: 40, width: 264, height: 192 });
  });
  it("opens above a lower anchor when there is more space there", () => {
    expect(
      browserMenuPlacement(
        { width: 400, height: 300 },
        { x: 340, y: 260, width: 28, height: 28 },
        160,
      ),
    ).toEqual({ x: 68, y: 96, width: 300, height: 160 });
  });
  it("refuses unknown or invalid measured geometry", () => {
    for (const bad of [0, -1, Infinity, NaN]) {
      expect(
        browserMenuPlacement(
          { width: bad, height: 600 },
          { x: 20, y: 8, width: 28, height: 28 },
          240,
        ),
      ).toBeNull();
      expect(
        browserMenuPlacement(
          { width: 800, height: 600 },
          { x: 20, y: 8, width: bad, height: 28 },
          240,
        ),
      ).toBeNull();
    }
  });
});

describe("bounded child menu placement", () => {
  it("opens beside a parent with enough room", () => {
    expect(
      browserSubmenuPlacement(
        { width: 900, height: 600 },
        { x: 8, y: 40, width: 300, height: 100 },
        { x: 8, y: 80, width: 300, height: 36 },
        200,
      ),
    ).toEqual({ x: 312, y: 80, width: 240, height: 200 });
  });
  it("flips left and clamps a long submenu for internal scrolling", () => {
    expect(
      browserSubmenuPlacement(
        { width: 800, height: 300 },
        { x: 468, y: 40, width: 300, height: 100 },
        { x: 468, y: 260, width: 300, height: 36 },
        900,
      ),
    ).toEqual({ x: 224, y: 8, width: 240, height: 284 });
  });
  it("refuses unknown pane or row geometry", () => {
    expect(
      browserSubmenuPlacement(
        { width: 0, height: 300 },
        { x: 0, y: 0, width: 100, height: 80 },
        { x: 0, y: 20, width: 100, height: 30 },
        160,
      ),
    ).toBeNull();
    expect(
      browserSubmenuPlacement(
        { width: 800, height: 300 },
        { x: 0, y: 0, width: 100, height: 80 },
        { x: 0, y: NaN, width: 100, height: 30 },
        160,
      ),
    ).toBeNull();
  });
});
