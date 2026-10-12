/** Materializes the trusted tab-capture helper inside this runtime's private IPC tree. */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

const PUBLIC_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs/JqirNVWTX8dJUeT8eyDXNNZS9jbMpw+IeqE6MHaM6+DPzMH/+QoM1VswHRZ/dRDWpqnKLtf5mhB7dWqWYXxAttlgbxolhVvj2M1DE9qfW+vEY9ag2vmn0d33nkhX5tHZcl4l1z9Gq9nrOaRjOsSm8FOfQIkCvFKwUgbE7rdgXUjwKjPf598zM5Pu36vT6IH4rP1dpnJpi+wVJzRKL1bRziP0hrrZulVNO97JOHumQ05VmS8jrmnKhwk/koFMSOHVvonuxXqnnPwdzNHfgQeCuYUcRNqgWxSnSwFfGqRwRjJ14H0l4nmFS3gvcMuabma9c3fTAX5EEU1CmzdW3MYQIDAQAB";
export const NATIVE_VIDEO_EXTENSION_ID = [
  ...createHash("sha256")
    .update(Buffer.from(PUBLIC_EXTENSION_KEY, "base64"))
    .digest()
    .subarray(0, 16),
]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join("");
const HELPER_HTML = '<!doctype html><meta charset="utf-8"><script src="recorder.js"></script>';
const HELPER_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Shared Browser native capture",
  version: "1.0.0",
  key: PUBLIC_EXTENSION_KEY,
  permissions: ["tabCapture", "debugger"],
});
const CONTENT_HASH = createHash("sha256")
  .update(HELPER_MANIFEST)
  .update(HELPER_HTML)
  .update(NATIVE_VIDEO_EXTENSION_SOURCE)
  .digest("hex");
const preparations = new Map<string, Promise<string>>();

/**
 * Publish an immutable content-versioned directory atomically, safe for concurrent
 * workspace startups sharing one IPC root. Failure is retryable, never cached.
 * No web-accessible resources, messages, content scripts, or network permissions.
 */
export function prepareNativeVideoExtension(ipcDirectory: string): Promise<string> {
  let preparation = preparations.get(ipcDirectory);
  if (!preparation) {
    preparation = materializeExtension(ipcDirectory);
    preparations.set(ipcDirectory, preparation);
    void preparation.catch(() => {
      if (preparations.get(ipcDirectory) === preparation) preparations.delete(ipcDirectory);
    });
  }
  return preparation;
}

async function materializeExtension(ipcDirectory: string): Promise<string> {
  await mkdir(ipcDirectory, { recursive: true, mode: 0o700 });
  const directory = join(ipcDirectory, `native-video-extension-${CONTENT_HASH.slice(0, 24)}`);
  if (await isComplete(directory)) return directory;
  const temporary = await mkdtemp(join(ipcDirectory, ".native-video-extension-"));
  try {
    await chmod(temporary, 0o700);
    await Promise.all([
      writeFile(join(temporary, "manifest.json"), HELPER_MANIFEST, { mode: 0o600 }),
      writeFile(join(temporary, "recorder.html"), HELPER_HTML, { mode: 0o600 }),
      writeFile(join(temporary, "recorder.js"), NATIVE_VIDEO_EXTENSION_SOURCE, { mode: 0o600 }),
    ]);
    await writeFile(join(temporary, "complete"), CONTENT_HASH, { mode: 0o600 });
    try {
      await rename(temporary, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !(await isComplete(directory)))
        throw error;
    }
    return directory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** The completion marker is published with the whole directory, never separately. */
async function isComplete(directory: string): Promise<boolean> {
  try {
    return (await readFile(join(directory, "complete"), "utf8")) === CONTENT_HASH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
