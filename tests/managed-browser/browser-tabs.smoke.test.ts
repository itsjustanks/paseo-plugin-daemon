import { expect, it } from "vitest";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

it("starts with one tab and appends new tabs in creation order", async () => {
  await withIsolatedBrowser(async (owner, runtime) => {
    const initial = await owner.request(runtime, "tabs.list", null);
    expect(initial).toMatchObject([{ targetId: runtime.rootTargetId }]);
    expect(initial).toHaveLength(1);
    const second = await owner.request(runtime, "tabs.create", null);
    const third = await owner.request(runtime, "tabs.create", null);
    const expected = [
      runtime.rootTargetId,
      (second as { targetId: string }).targetId,
      (third as { targetId: string }).targetId,
    ];
    for (let read = 0; read < 3; read++) {
      const tabs = (await owner.request(runtime, "tabs.list", null)) as { targetId: string }[];
      expect(tabs.map((tab) => tab.targetId)).toEqual(expected);
    }
    await expect(
      owner.request(runtime, "identity", { targetId: expected[1]! }),
    ).resolves.toMatchObject({ targetId: expected[1] });
    await owner.request(runtime, "tabs.close", { targetId: expected[0]! });
    const remaining = (await owner.request(runtime, "tabs.list", null)) as { targetId: string }[];
    expect(remaining.map((tab) => tab.targetId)).toEqual(expected.slice(1));
  });
}, 30_000);
