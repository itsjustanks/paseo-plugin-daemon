import { expect, it } from "vitest";
import { createVideoSourceRecovery } from "./video-source-recovery";

it("uses monotonic cooldown and clears permanent refusal only on exact configuration replacement", () => {
  let now = 0;
  const recovery = createVideoSourceRecovery(() => now);
  const context = { connection: {}, page: {}, viewport: {}, attachmentGeneration: 0 };
  recovery.failed(context, "startup");
  expect(recovery.blocked(context)).toBe("startup");
  now = 2999;
  expect(recovery.blocked(context)).toBe("startup");
  now = 3000;
  expect(recovery.blocked(context)).toBeNull();
  recovery.failed(context, "source-dimensions");
  now = 1_000_000;
  expect(recovery.blocked({ ...context })).toBe("source-dimensions");
  expect(recovery.blocked({ ...context, viewport: {} })).toBeNull();
  recovery.failed(context, "source-dimensions");
  expect(recovery.blocked({ ...context, attachmentGeneration: 1 })).toBeNull();
});
