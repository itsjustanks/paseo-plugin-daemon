// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

export const OWNER_ONLY_FILE = 0o600;
export const OWNER_ONLY_DIR = 0o700;

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe cross-daemon storage directory");
    fchmodSync(fd, OWNER_ONLY_DIR);
  } finally { closeSync(fd); }
}

function checkExistingFile(file: string): boolean {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe cross-daemon storage file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Unsafe cross-daemon storage file");
  }
}

export function readPrivateJson<Schema extends z.ZodType>(file: string, schema: Schema, empty: z.output<Schema>): z.output<Schema> {
  ensurePrivateDirectory(dirname(file));
  if (!checkExistingFile(file)) return empty;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe cross-daemon storage file");
    fchmodSync(fd, OWNER_ONLY_FILE);
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  } finally { closeSync(fd); }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  renameSync(file, `${file}.unreadable-${Date.now()}`);
  console.error("cross-daemon: unreadable private state was set aside");
  return empty;
}

export function writePrivateJson(file: string, value: unknown): void {
  ensurePrivateDirectory(dirname(file));
  checkExistingFile(file);
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(value, null, 2), { mode: OWNER_ONLY_FILE, flag: "wx" });
    renameSync(staging, file);
  } finally {
    try { unlinkSync(staging); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
