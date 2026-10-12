/** Exercise the actual page program with bounded DOM fixtures; native geometry is covered by smoke. */
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { browserCursorExpression } from "./browser-cursor";

function fixture({
  cursor = "auto",
  userSelect = "auto",
  writingMode = "horizontal-tb",
  editable = false,
  contains = true,
  legacy = false,
} = {}) {
  const node = { nodeType: 3, length: 5 };
  const element = { isContentEditable: editable, contains: () => contains };
  const range = {
    setStart() {},
    setEnd() {},
    getClientRects: () => [{ left: 10, right: 40, top: 10, bottom: 25 }],
  };
  const position = { offsetNode: node, offset: 2 };
  const document = {
    elementFromPoint: () => element,
    createRange: () => range,
    ...(legacy
      ? { caretRangeFromPoint: () => ({ startContainer: node, startOffset: 2 }) }
      : { caretPositionFromPoint: () => position }),
  };
  return {
    document,
    sample: (x = 20, y = 15) =>
      runInNewContext(browserCursorExpression(x, y), {
        document,
        getComputedStyle: () => ({ cursor, userSelect, writingMode }),
      }),
  };
}

it("resolves auto over selectable text, including the legacy caret API", () => {
  expect(fixture().sample()).toBe("text");
  expect(fixture({ legacy: true }).sample()).toBe("text");
});

it("preserves explicit cursor choices even over selectable text", () => {
  expect(fixture({ cursor: "default" }).sample()).toBe("default");
  expect(fixture({ cursor: "pointer" }).sample()).toBe("pointer");
});

it("does not mistake nearby text, overlays or non-selectable content for text", () => {
  expect(fixture().sample(90, 15)).toBe("default");
  expect(fixture({ contains: false }).sample()).toBe("default");
  expect(fixture({ userSelect: "none" }).sample()).toBe("default");
});

it("resolves empty editing surfaces and vertical text without moving selection", () => {
  expect(fixture({ editable: true }).sample(90, 15)).toBe("text");
  expect(fixture({ writingMode: "vertical-rl" }).sample()).toBe("vertical-text");
});

it("rejects invalid coordinates before constructing page code", () => {
  for (const x of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(() => browserCursorExpression(x, 10)).toThrow("finite non-negative");
  }
});
