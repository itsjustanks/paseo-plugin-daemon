import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const stateDirectory = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "daemon-link");
const exec = promisify(execFile);
// Pinned official release digests from github.com/cloudflare/cloudflared/releases/tag/2026.8.3.
const RELEASE = "2026.8.3";
const ASSETS: Record<string, { file: string; sha: string }> = {
  "linux-x64": { file: "cloudflared-linux-amd64", sha: "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e" },
  "linux-arm64": { file: "cloudflared-linux-arm64", sha: "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391" },
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", sha: "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99" },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f" },
};

export async function cloudflaredPath(): Promise<string> {
  const managed = join(stateDirectory(), "bin", "cloudflared");
  try { if ((await stat(managed)).isFile()) return managed; } catch { /* Fall back to PATH. */ }
  return "cloudflared";
}

export async function executableAvailable(name: "ssh" | "cloudflared"): Promise<boolean> {
  try {
    await exec(name === "ssh" ? name : await cloudflaredPath(), [name === "ssh" ? "-V" : "--version"], { timeout: 3000, maxBuffer: 4096 });
    return true;
  } catch { return false; }
}

let installing: Promise<{ ok: true }> | undefined;
export function installCloudflared(): Promise<{ ok: true }> {
  return installing ??= install().finally(() => { installing = undefined; });
}

async function install(): Promise<{ ok: true }> {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("Automatic tunnel setup supports Linux and macOS on x64 and arm64.");
  const directory = join(stateDirectory(), "bin");
  return installRelease(asset, directory);
}

/** Kept separate so checksum failure and atomic installation can be verified with offline fixtures. */
export async function installRelease(asset: { file: string; sha: string }, directory: string): Promise<{ ok: true }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, "download-"));
  try {
    // React Native's ambient fetch types also enter this project. Use Node's fetch signature here.
    const nodeFetch = fetch as unknown as typeof import("undici-types").fetch;
    const response = await nodeFetch(`https://github.com/cloudflare/cloudflared/releases/download/${RELEASE}/${asset.file}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error("Tunnel download failed. Check this daemon's access to GitHub.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > 100_000_000) throw new Error("Tunnel download exceeded its size limit.");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (createHash("sha256").update(data).digest("hex") !== asset.sha) throw new Error("Tunnel download checksum did not match the pinned release.");
    const file = join(temporary, asset.file);
    await writeFile(file, data, { mode: 0o600 });
    const binary = join(temporary, "cloudflared");
    if (asset.file.endsWith(".tgz")) await exec("tar", ["-xzf", file, "-C", temporary, "cloudflared"], { timeout: 10_000 });
    else await rename(file, binary);
    await chmod(binary, 0o700);
    await exec(binary, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    await rename(binary, join(directory, "cloudflared"));
    return { ok: true };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
