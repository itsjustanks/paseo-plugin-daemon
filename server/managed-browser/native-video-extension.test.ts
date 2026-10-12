import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareNativeVideoExtension } from "./native-video-extension";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

describe("immutable trusted native video helper", () => {
  it("concurrent workspace starts publish complete files once without in-place truncation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owned-extension-"));
    try {
      const paths = await Promise.all(
        Array.from({ length: 12 }, () => prepareNativeVideoExtension(directory)),
      );
      expect(new Set(paths).size).toBe(1);
      const path = paths[0]!;
      expect(await readFile(join(path, "recorder.js"), "utf8")).toBe(NATIVE_VIDEO_EXTENSION_SOURCE);
      expect((await readdir(directory)).length).toBe(1);
      const modified = (await stat(join(path, "recorder.js"))).mtimeMs;
      await prepareNativeVideoExtension(directory);
      expect((await stat(join(path, "recorder.js"))).mtimeMs).toBe(modified);
      const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
      expect(manifest.permissions).toEqual(["tabCapture", "debugger"]);
      expect(manifest.content_scripts).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("a failed publication does not poison future startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owned-extension-retry-"));
    const blocked = join(directory, "initially-file");
    try {
      await writeFile(blocked, "occupied");
      await expect(prepareNativeVideoExtension(blocked)).rejects.toThrow();
      await rm(blocked);
      expect(await prepareNativeVideoExtension(blocked)).toContain("native-video-extension-");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
