import { describe, expect, it, vi } from "vitest";
import {
  containedRect,
  createImageSizeLoader,
  mapDisplayedPoint,
  toViewportPoint,
} from "../../shared/managed-browser/browser";

const viewport = { width: 1280, height: 800 };

// Mirrors the panel: image-sized rect, display point to viewport point, then server mapping.
function css(
  container: { width: number; height: number },
  image: typeof viewport,
  x: number,
  y: number,
) {
  const rect = containedRect(container, image);
  if (!rect) throw new Error("no rect");
  const scale = rect.width / image.width;
  return mapDisplayedPoint(
    toViewportPoint({ x: x * scale, y: y * scale }, rect, viewport),
    viewport,
  );
}

describe("pointer mapping uses the actual bitmap", () => {
  it("maps a JPEG shorter than the metadata within one CSS pixel", () => {
    const p = css({ width: 900, height: 700 }, { width: 1280, height: 633 }, 280, 200);
    expect(p.x).toBeCloseTo(280, 0);
    expect(p.y).toBeCloseTo(200, 0);
  });

  it.each([
    ["normal", { width: 1000, height: 800 }, viewport],
    ["cropped", { width: 1000, height: 300 }, { width: 1280, height: 633 }],
    ["compact", { width: 360, height: 640 }, { width: 1280, height: 633 }],
    ["dpr3", { width: 800, height: 800 }, { width: 3840, height: 1899 }],
  ])("%s", (_name, container, image) => {
    const factor = image.width / viewport.width;
    const p = css(container, image, 280 * factor, 200 * factor);
    expect(p.x).toBeCloseTo(280, 0);
    expect(p.y).toBeCloseTo(200, 0);
  });

  it("keeps the point inside the viewport", () => {
    const rect = { width: 500, height: 500 };
    expect(toViewportPoint({ x: 500, y: 500 }, rect, viewport).y).toBe(800);
  });

  it("scales scroll deltas and anchors with one factor", () => {
    const rect = { width: 640, height: 317 };
    const anchor = toViewportPoint({ x: 320, y: 158 }, rect, viewport);
    expect(anchor).toMatchObject({ x: 640, y: 316, width: 1280, height: 800 });
    expect(viewport.width / rect.width).toBe(2);
  });
});

describe("createImageSizeLoader", () => {
  it("looks a bitmap up once", () => {
    const getSize = vi.fn();
    const load = createImageSizeLoader(getSize, vi.fn());
    load("a");
    load("a");
    expect(getSize).toHaveBeenCalledTimes(1);
  });

  it("drops superseded callbacks", () => {
    const callbacks: Record<string, (w: number, h: number) => void> = {};
    const onSize = vi.fn();
    const load = createImageSizeLoader((uri, ok) => {
      callbacks[uri] = ok;
    }, onSize);
    load("a");
    load("b");
    callbacks.a?.(10, 10);
    expect(onSize).not.toHaveBeenCalled();
    callbacks.b?.(20, 10);
    expect(onSize).toHaveBeenCalledWith("b", { width: 20, height: 10 });
  });
});
