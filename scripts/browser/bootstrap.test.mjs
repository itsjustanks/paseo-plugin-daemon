import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { artifactsFor } from "./artifacts.mjs";
import { privateEnvironment, verifyFile } from "./bootstrap.mjs";
import { replaceRuntime } from "./replace-runtime.mjs";

test("unsupported target fails closed before dependencies or downloads", () => {
  assert.throws(() => artifactsFor("win32", "x64"), /supports macOS arm64 and Linux x64/);
  assert.throws(() => artifactsFor("linux", "arm64"), /supports macOS arm64 and Linux x64/);
});
test("private interpreter drops loader injection without changing the parent environment", () => {
  const original = { PATH: "/node22/bin", NODE_OPTIONS: "--import=untrusted", NODE_PATH: "/external",
    npm_config_node_options: "--require=untrusted", ELECTRON_RUN_AS_NODE: "1", PASEO_HOME: "/owned home" };
  const clean = privateEnvironment(original, "/private node/bin");
  assert.equal(clean.PATH, "/private node/bin:/node22/bin");
  assert.equal(clean.PASEO_HOME, "/owned home");
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.npm_config_node_options, undefined);
  assert.equal(original.NODE_OPTIONS, "--import=untrusted");
});
test("corrupt or oversized artifact cannot replace the previous immutable runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosts build test "));
  try {
    const a = join(root, ".runtime-123e4567-e89b-42d3-a456-426614174000");
    const b = join(root, ".runtime-123e4567-e89b-42d3-a456-426614174001");
    await mkdir(a); await mkdir(b);
    await writeFile(join(a, "asset"), "A"); await writeFile(join(b, "asset"), "B");
    await replaceRuntime(a, join(root, "runtime"));
    await assert.rejects(verifyFile(join(b, "asset"), "0".repeat(64), 100), /SHA-256 mismatch/);
    await assert.rejects(verifyFile(join(b, "asset"), "0".repeat(64), 0), /size bound/);
    assert.equal((await readFile(join(root, "runtime-current"), "utf8")).trim(), a.split("/").at(-1));
    await verifyFile(join(b, "asset"), createHash("sha256").update("B").digest("hex"), 100);
    await replaceRuntime(b, join(root, "runtime"));
    assert.equal(await readFile(join(a, "asset"), "utf8"), "A");
    assert.equal((await readFile(join(root, "runtime-current"), "utf8")).trim(), b.split("/").at(-1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Node22 plugin bridge bundles without private runtime implementation dependencies", async () => {
  const result = await build({ entryPoints: [resolve("index.server.ts")], bundle: true, write: false,
    platform: "node", format: "cjs", target: "node22", metafile: true,
    external: ["@getpaseo/plugin", "@getpaseo/plugin/server", "zod"] });
  const inputs = Object.keys(result.metafile.inputs);
  const prohibited = /(?:server\/managed-browser\/(?:agent-browser-runtime|runtime-owner|supervisor\.ts|cdp\.ts|native-video)|node_modules\/(?:agent-browser|@modelcontextprotocol))/;
  assert.deepEqual(inputs.filter((name) => prohibited.test(name)), []);
  assert(inputs.some((name) => name.endsWith("supervisor-paths.ts")));
});
