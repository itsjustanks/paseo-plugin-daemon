import { describe, expect, it } from "vitest";
import { createBrowserImageLoadHandler } from "./browser-image-load";

describe("cross-platform browser image decode", () => {
  it("accepts the desktop DOM load envelope without inventing a reported URI", () => {
    const delivered: unknown[] = [];
    const handler = createBrowserImageLoadHandler(1, "data:image/jpeg;base64,frame", (...args) =>
      delivered.push(args),
    );
    expect(() => handler({ nativeEvent: new Event("load") })).not.toThrow();
    expect(delivered).toEqual([[1, true]]);
  });

  it("accepts the native exact source and refuses a contradictory source", () => {
    const delivered: unknown[] = [];
    const handler = createBrowserImageLoadHandler(7, "expected", (...args) => delivered.push(args));
    handler({ nativeEvent: { source: { uri: "other" } } });
    handler({ nativeEvent: { source: { uri: 42 } } });
    expect(delivered).toEqual([]);
    handler({ nativeEvent: { source: { uri: "expected" } } });
    expect(delivered).toEqual([[7, true]]);
  });
});
