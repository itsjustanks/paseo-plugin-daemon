import { describe, expect, it } from "vitest";
import { formatRuntimeInputGeneration, sameRuntimeInputAttachment } from "./input-generation";

describe("private native input generation codec", () => {
  it("admits document changes only within the same exact native attachment", () => {
    expect(
      sameRuntimeInputAttachment(
        formatRuntimeInputGeneration(3, 4),
        formatRuntimeInputGeneration(3, 5),
      ),
    ).toBe(true);
    expect(sameRuntimeInputAttachment("3:4", "4:4")).toBe(false);
  });

  it("refuses missing, opaque, truncated and unbounded generation formats", () => {
    for (const invalid of [
      null,
      "opaque",
      "3",
      "3:",
      "03:4",
      "3:-1",
      "3:9007199254740992",
      "3:4:5",
    ]) {
      expect(sameRuntimeInputAttachment("3:4", invalid)).toBe(false);
      expect(sameRuntimeInputAttachment(invalid, "3:4")).toBe(false);
    }
    expect(() => formatRuntimeInputGeneration(-1, 0)).toThrow("Invalid");
  });
});
