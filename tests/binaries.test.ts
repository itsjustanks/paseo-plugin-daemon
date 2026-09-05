import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRelease } from "../server/binaries";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of dirs) await rm(dir, { recursive: true, force: true }); dirs.length = 0; });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "binary-test-")); dirs.push(dir); return dir; }
describe("optional helper installation", () => {
  it("rejects a mismatched download before it can execute or replace a binary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("untrusted download")));
    const dir = await directory();
    await expect(installRelease({ file: "fixture", sha: "0".repeat(64) }, dir)).rejects.toThrow("checksum");
    expect(await readdir(dir)).toEqual([]);
  });
  it("installs a matching fixture atomically with owner-only permissions", async () => {
    // This executable only prints a fixture version. No external download or real helper installation.
    const data = Buffer.from("#!/bin/sh\necho fixture-version\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(data)));
    const dir = await directory();
    await installRelease({ file: "fixture", sha: createHash("sha256").update(data).digest("hex") }, dir);
    expect(await readFile(join(dir, "cloudflared"))).toEqual(data);
    expect((await stat(join(dir, "cloudflared"))).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual(["cloudflared"]);
  });
  it("reports a provider failure without leaving a partial download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const dir = await directory();
    await expect(installRelease({ file: "fixture", sha: "0".repeat(64) }, dir)).rejects.toThrow("download failed");
    expect(await readdir(dir)).toEqual([]);
  });
});
