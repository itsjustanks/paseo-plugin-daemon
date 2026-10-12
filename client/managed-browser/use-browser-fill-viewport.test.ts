/** Exercise debounce and cancellation with the repository's lightweight hook harness. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  ref: null as { current: unknown } | null,
  dependencies: null as unknown[] | null,
  cleanup: null as (() => void) | null,
  deferEffects: false,
}));

vi.mock("react", () => ({
  useRef(value: unknown) {
    fixture.ref ??= { current: value };
    return fixture.ref;
  },
  useEffect(operation: () => (() => void) | undefined, dependencies: unknown[]) {
    if (fixture.deferEffects) return;
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

import { useBrowserFillViewport } from "./use-browser-fill-viewport";

const apply = vi.fn();
const defaults = {
  identity: "host/workspace/viewer/control",
  enabled: true,
  canResize: true,
  target: { width: 1000, height: 700 },
  viewport: { width: 1280, height: 720 },
  apply,
};

beforeEach(() => {
  fixture.ref = null;
  fixture.dependencies = null;
  fixture.cleanup = null;
  fixture.deferEffects = false;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  fixture.cleanup?.();
  vi.useRealTimers();
});

it("coalesces rapid panel changes into one resize using the latest action", () => {
  useBrowserFillViewport(defaults);
  vi.advanceTimersByTime(100);
  const latest = vi.fn();
  useBrowserFillViewport({ ...defaults, target: { width: 900, height: 600 }, apply: latest });
  vi.advanceTimersByTime(199);
  expect(latest).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(latest).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("cancels queued work when control is released, a mutation starts, or following stops", () => {
  for (const override of [{ canResize: false }, { enabled: false }, { target: null }]) {
    useBrowserFillViewport(defaults);
    vi.advanceTimersByTime(100);
    useBrowserFillViewport({ ...defaults, ...override });
    vi.advanceTimersByTime(300);
    expect(apply).not.toHaveBeenCalled();
  }
});

it("resumes after control returns without repeatedly resizing an acknowledged resolution", () => {
  useBrowserFillViewport({ ...defaults, canResize: false });
  vi.advanceTimersByTime(500);
  expect(apply).not.toHaveBeenCalled();
  useBrowserFillViewport(defaults);
  vi.advanceTimersByTime(200);
  expect(apply).toHaveBeenCalledOnce();
  useBrowserFillViewport({ ...defaults, viewport: defaults.target });
  vi.advanceTimersByTime(500);
  expect(apply).toHaveBeenCalledOnce();
});

it("cancels work when moving to another workspace or unmounting", () => {
  useBrowserFillViewport(defaults);
  vi.advanceTimersByTime(100);
  useBrowserFillViewport({ ...defaults, identity: "other/workspace", enabled: false });
  vi.advanceTimersByTime(300);
  expect(apply).not.toHaveBeenCalled();
  useBrowserFillViewport(defaults);
  fixture.cleanup?.();
  vi.advanceTimersByTime(300);
  expect(apply).not.toHaveBeenCalled();
});

it("rechecks render-time authority before effect cleanup can cancel a queued resize", () => {
  useBrowserFillViewport(defaults);
  fixture.deferEffects = true;
  useBrowserFillViewport({ ...defaults, identity: "other/workspace", canResize: false });
  vi.advanceTimersByTime(200);
  expect(apply).not.toHaveBeenCalled();
});
