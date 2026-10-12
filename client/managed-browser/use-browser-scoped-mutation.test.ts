/** Exercise actual publication/settlement callbacks across render and mount boundaries. */
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  index: 0,
  cleanup: null as (() => void) | null,
  options: null as unknown,
  submissions: [] as unknown[],
}));
vi.mock("react", () => ({
  useRef(value: unknown) {
    const index = fixture.index++;
    if (!fixture.slots[index]) fixture.slots[index] = { current: value };
    return fixture.slots[index];
  },
  useLayoutEffect(operation: () => () => void) {
    if (!fixture.cleanup) fixture.cleanup = operation();
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation(options: unknown) {
    fixture.options = options;
    return { isPending: false, mutate: (request: unknown) => fixture.submissions.push(request) };
  },
}));

import { useBrowserScopedMutation } from "./use-browser-scoped-mutation";

const send = vi.fn(async (input: string) => ({ value: input }));
const success = vi.fn();
const failure = vi.fn();
function render(identity = "host/workspace/viewer/control", currentIdentity?: () => string) {
  fixture.index = 0;
  const hook = useBrowserScopedMutation({
    identity,
    ...(currentIdentity ? { currentIdentity } : {}),
    mutationFn: send,
    onSuccess: success,
    onError: failure,
  });
  const options = fixture.options as {
    mutationFn(request: { input: string; identity: string }): Promise<{ value: string }>;
    onSuccess(result: { value: string }, request: { input: string; identity: string }): void;
    onError(error: unknown, request: { input: string; identity: string }): void;
    retry: boolean;
  };
  return { hook, options };
}
beforeEach(() => {
  fixture.slots = [];
  fixture.index = 0;
  fixture.cleanup = null;
  fixture.submissions = [];
  vi.clearAllMocks();
});
it("captures submitted identity, keeps current settlement and never retries", async () => {
  const { hook, options } = render();
  hook.mutate("chosen");
  const request = fixture.submissions[0] as { input: string; identity: string };
  const result = await options.mutationFn(request);
  options.onSuccess(result, request);
  expect(send).toHaveBeenCalledExactlyOnceWith("chosen");
  expect(success).toHaveBeenCalledExactlyOnceWith(result);
  expect(options.retry).toBe(false);
});
for (const replacement of [
  "new-host/workspace/viewer/control",
  "host/new-workspace/viewer/control",
  "host/workspace/new-viewer/control",
  "host/workspace/viewer/new-control",
]) {
  it(`discards published success and failure after ${replacement}`, async () => {
    const previous = render();
    previous.hook.mutate("published");
    const request = fixture.submissions[0] as { input: string; identity: string };
    await previous.options.mutationFn(request);
    const latest = render(replacement);
    expect(() => latest.options.mutationFn(request)).toThrow("context changed");
    latest.options.onSuccess({ value: "old" }, request);
    latest.options.onError(new Error("old"), request);
    previous.hook.mutate("retained callback");
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(fixture.submissions).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
}
it("refuses stale queued publication and ignores callbacks after unmount", async () => {
  const { hook, options } = render();
  hook.mutate("unsent");
  const request = fixture.submissions[0] as { input: string; identity: string };
  fixture.cleanup?.();
  expect(() => options.mutationFn(request)).toThrow("context changed");
  options.onSuccess({ value: "late" }, request);
  options.onError(new Error("late"), request);
  hook.mutate("after unmount");
  expect(send).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  expect(fixture.submissions).toHaveLength(1);
});

it("synchronous authority observations revoke settlement before another render", async () => {
  let observed = "host/workspace/viewer/control";
  const { hook, options } = render(observed, () => observed);
  hook.mutate("published");
  const request = fixture.submissions[0] as { input: string; identity: string };
  await options.mutationFn(request);
  observed = "host/workspace/viewer/new-ownership";
  options.onSuccess({ value: "late" }, request);
  options.onError(new Error("late"), request);
  hook.mutate("not yet rendered");
  expect(success).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  expect(fixture.submissions).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
});
