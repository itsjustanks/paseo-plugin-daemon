import { describe, expect, it } from "vitest";
import type { BrowserState } from "../../shared/managed-browser/browser";
import { controlRequestBasis, isControlRequestCurrent } from "./browser-control-request";

const state = {
  tabId: "tab-one",
  sessionId: "session-one",
  navigationGeneration: 4,
  viewportGeneration: 2,
} as BrowserState;

describe("browser control request identity", () => {
  it("accepts only the original viewer, tab, page, and controller observation", () => {
    const basis = controlRequestBasis("host/workspace", "viewer-one", state, 7);
    const current = (next: BrowserState, revision = 7) =>
      isControlRequestCurrent(basis, "host/workspace", "viewer-one", next, revision);

    expect(current(state)).toBe(true);
    expect(isControlRequestCurrent(basis, "other/workspace", "viewer-one", state, 7)).toBe(false);
    expect(isControlRequestCurrent(basis, "host/workspace", "viewer-two", state, 7)).toBe(false);
    expect(current({ ...state, tabId: "tab-two" })).toBe(false);
    expect(current({ ...state, sessionId: "session-two" })).toBe(false);
    expect(current({ ...state, navigationGeneration: 5 })).toBe(false);
    expect(current({ ...state, viewportGeneration: 3 })).toBe(false);
    expect(current(state, 8)).toBe(false);
  });
});
