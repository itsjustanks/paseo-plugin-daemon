import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "./runtime-owner";

type Owner = Awaited<ReturnType<typeof createRuntimeOwner>>;
type Owned = Parameters<Owner["request"]>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(lingerSnapshots: number | null) {
  const owner = await createRuntimeOwner({ virtualDisplay: false, nativeVideo: false });
  const state = { ids: ["root", "closing"], closing: false, polls: 0, next: 0 };
  const native = {
    targets: vi.fn(async () => {
      if (state.closing && lingerSnapshots !== null && state.polls++ >= lingerSnapshots) {
        state.ids = state.ids.filter((id) => id !== "closing");
      } else if (state.closing && lingerSnapshots === null) {
        state.polls++;
      }
      return state.ids.map((targetId) => ({ targetId, title: targetId, url: "about:blank" }));
    }),
    closeTarget: vi.fn(async () => {
      state.closing = true;
    }),
    createTarget: vi.fn(async () => {
      const id = `new-${++state.next}`;
      state.ids.unshift(id);
      return id;
    }),
    selectTarget: vi.fn(async () => {}),
  };
  const owned = {
    runtimeId: "review-runtime",
    runtime: native,
    rootTargetId: "root",
    runtimeOptions: {},
    tabs: new Map(),
    tabOrder: ["root", "closing"],
    display: null,
    displayNotice: null,
  } as unknown as Owned;
  return { owner, owned, native, state };
}

it("confirms an acknowledged close only after the target disappears without replay", async () => {
  const f = await fixture(2);
  const pending = f.owner.request(f.owned, "tabs.close", { targetId: "closing" });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeNull();
  expect(f.native.closeTarget).toHaveBeenCalledTimes(1);
  expect(f.state.polls).toBe(3);
  expect(
    ((await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[]).map(
      (x) => x.targetId,
    ),
  ).toEqual(["root"]);
});

it("fails explicitly, without replaying close or reordering, when the target never disappears", async () => {
  const f = await fixture(null);
  const outcome = f.owner.request(f.owned, "tabs.close", { targetId: "closing" }).then(
    () => "ok",
    (error) => String(error),
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toContain(
    "CdpUnknownOutcomeError: Browser tab close could not be confirmed",
  );
  expect(f.native.closeTarget).toHaveBeenCalledTimes(1);
  expect(f.state.polls).toBe(20);
  const ids = (await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[];
  expect(ids.map((tab) => tab.targetId)).toEqual(["root", "closing"]);
});

it("retains known ordering across unordered snapshots and appends explicit creations", async () => {
  const f = await fixture(null);
  f.state.ids = ["third", "closing", "root"];
  const ids = async () =>
    ((await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[]).map(
      (x) => x.targetId,
    );
  expect(await ids()).toEqual(["root", "closing", "third"]);
  f.state.ids = ["closing", "root", "third"];
  expect(await ids()).toEqual(["root", "closing", "third"]);
  await f.owner.request(f.owned, "tabs.create", null);
  await f.owner.request(f.owned, "tabs.create", null);
  expect(await ids()).toEqual(["root", "closing", "third", "new-1", "new-2"]);
});

it("preserves the existing last-tab refusal", async () => {
  const f = await fixture(null);
  f.state.ids = ["root"];
  await expect(f.owner.request(f.owned, "tabs.close", { targetId: "root" })).rejects.toThrow(
    "last browser tab",
  );
  expect(f.native.closeTarget).not.toHaveBeenCalled();
});
