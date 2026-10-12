import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireRuntimeOwner } from "../../server/cross-daemon/runtime-owner.server";
import { makeTempDir } from "./temp-dir.test-support";
it("holds exclusive ownership until release, then permits another runtime", () => {
  const dir = makeTempDir("hcd-lock-");
  const release = acquireRuntimeOwner(dir)!;
  expect(lstatSync(join(dir, "runtime.lock")).mode & 0o777).toBe(0o700);
  expect(acquireRuntimeOwner(dir)).toBeNull(); release(); release();
  const second = acquireRuntimeOwner(dir); expect(second).toBeTypeOf("function"); second!();
});
it("never reclaims stale locks or removes a replacement lock inode", () => {
  const dir = makeTempDir("hcd-stale-lock-");
  const release = acquireRuntimeOwner(dir)!;
  renameSync(join(dir, "runtime.lock"), join(dir, "old.lock"));
  mkdirSync(join(dir, "runtime.lock")); const replacement = lstatSync(join(dir, "runtime.lock"));
  release(); expect(lstatSync(join(dir, "runtime.lock")).ino).toBe(replacement.ino);
  expect(acquireRuntimeOwner(dir)).toBeNull();
});
