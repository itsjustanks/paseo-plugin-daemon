/** Exercise debounce and cancellation with the repository's lightweight hook harness. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  ref: null as { current: unknown } | null,
  dependencies: null as unknown[] | null,
  cleanup: null as (() => void) | null,
}));

vi.mock("react", () => ({
  useRef(value: unknown) {
    fixture.ref ??= { current: value };
    return fixture.ref;
  },
  useEffect(operation: () => (() => void) | undefined, dependencies: unknown[]) {
    if (
      fixture.dependencies &&
      dependencies.every((value, index) => Object.is(value, fixture.dependencies?.[index]))
    ) {
      return;
    }
    fixture.cleanup?.();
    fixture.dependencies = dependencies;
    fixture.cleanup = operation() ?? null;
  },
}));

import type { CaptureDensity } from "../../shared/managed-browser/capture-density";
import { useBrowserAutoCaptureDensity } from "./use-browser-auto-capture-density";

const apply = vi.fn();
const defaults = {
  identity: "host/workspace/viewer/control",
  enabled: true,
  canChange: true,
  target: 2 as CaptureDensity | null,
  currentDensity: 1,
  apply,
};

beforeEach(() => {
  fixture.ref = null;
  fixture.dependencies = null;
  fixture.cleanup = null;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  fixture.cleanup?.();
  vi.useRealTimers();
});

it("debounces adjustments and does not repeat acknowledged density changes", () => {
  useBrowserAutoCaptureDensity(defaults);
  vi.advanceTimersByTime(249);
  expect(apply).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(apply).toHaveBeenCalledExactlyOnceWith(2);
  useBrowserAutoCaptureDensity({ ...defaults, currentDensity: 2 });
  vi.advanceTimersByTime(1000);
  expect(apply).toHaveBeenCalledOnce();
});

it("cancels queued work for observers, hidden panels, pending mutations and manual choices", () => {
  for (const override of [{ canChange: false }, { enabled: false }, { target: null }]) {
    useBrowserAutoCaptureDensity(defaults);
    vi.advanceTimersByTime(100);
    useBrowserAutoCaptureDensity({ ...defaults, ...override });
    vi.advanceTimersByTime(500);
    expect(apply).not.toHaveBeenCalled();
  }
});

it("waits while Fill viewport owns a combined size and density transition", () => {
  useBrowserAutoCaptureDensity({ ...defaults, canChange: false });
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
  useBrowserAutoCaptureDensity({ ...defaults, currentDensity: 2 });
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
});

it("drops superseded screen measurements and uses the latest scoped action", () => {
  useBrowserAutoCaptureDensity(defaults);
  vi.advanceTimersByTime(100);
  useBrowserAutoCaptureDensity({ ...defaults, target: 1 });
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
  const latest = vi.fn();
  useBrowserAutoCaptureDensity({ ...defaults, apply: latest });
  vi.advanceTimersByTime(250);
  expect(latest).toHaveBeenCalledExactlyOnceWith(2);
});

it("cancels on workspace replacement and unmount", () => {
  useBrowserAutoCaptureDensity(defaults);
  useBrowserAutoCaptureDensity({ ...defaults, identity: "other/workspace", enabled: false });
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
  useBrowserAutoCaptureDensity(defaults);
  fixture.cleanup?.();
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
});
