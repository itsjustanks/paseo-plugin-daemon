import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { LockOutcome } from "./housekeeping-plan";

/**
 * The hand-over lock (0.18.0): `~/.local/state/agent-housekeeper.lock`, the
 * same file the standalone script takes. Hosts opens it itself and has
 * `flock -n` lock that open file (passed in as fd 3), so the lock belongs to
 * Hosts' own descriptor and stays held for the whole cycle after flock exits;
 * closing the descriptor releases it. Busy means another housekeeper (the
 * script, or Hosts on another daemon of this user) is mid-pass: stay passive.
 * No flock, or a lock path that isn't a plain file of this user in a folder
 * of this user, is never worked around.
 */

export interface HeldLock { outcome: LockOutcome; release(): Promise<void> }

export type FlockRun = (fd: number, signal: AbortSignal) => Promise<{ code: number | null; missing: boolean }>;

const BUSY = 75;

export const runFlock: FlockRun = (fd, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve({ code: null, missing: false }); return; }
  let settled = false;
  const done = (value: { code: number | null; missing: boolean }) => { if (!settled) { settled = true; resolve(value); } };
  try {
    const child = spawn("flock", ["-n", "-E", String(BUSY), "3"], { stdio: ["ignore", "ignore", "ignore", fd], signal, timeout: 10_000, killSignal: "SIGKILL" });
    child.on("error", (error) => done({ code: null, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }));
    child.on("exit", (code) => done({ code, missing: false }));
  } catch (error) { done({ code: null, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }); }
});

const noop = async () => {};

async function safeFolder(folder: string, uid: number): Promise<string | null> {
  const stat = await lstat(folder).catch(() => null);
  if (!stat) return "its folder couldn't be read";
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "its folder is a link or not a folder";
  if (stat.uid !== uid) return "its folder belongs to another user";
  // Group-writable is common (umask 002 with per-user groups) and harmless here: the file is opened with O_NOFOLLOW and checked.
  if (stat.mode & 0o002) return "its folder can be written by every user";
  return null;
}

export async function takeLock(path: string, uid: number, signal: AbortSignal, flock: FlockRun = runFlock): Promise<HeldLock> {
  const refuse = (outcome: LockOutcome): HeldLock => ({ outcome, release: noop });
  const folder = dirname(path);
  // The standalone script made this folder; on a fresh host Hosts makes it the same way (private to this user).
  if (!(await lstat(folder).catch(() => null))) await mkdir(folder, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const unsafe = await safeFolder(folder, uid);
  if (unsafe) return refuse({ kind: "unsafe", reason: unsafe });
  const before = await lstat(path).catch((error) => ((error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined));
  if (before === undefined) return refuse({ kind: "failed", reason: "the lock file couldn't be read" });
  if (before && (before.isSymbolicLink() || !before.isFile() || before.uid !== uid || before.nlink !== 1)) return refuse({ kind: "unsafe", reason: "the lock file is a link, not a plain file, or not this user's" });
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); }
  catch { return refuse({ kind: "failed", reason: "the lock file couldn't be opened" }); }
  const release = async () => { await handle.close().catch(() => undefined); };
  const opened = await handle.stat().catch(() => null);
  if (!opened || !opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || (before && (opened.ino !== before.ino || opened.dev !== before.dev))) {
    await release();
    return refuse({ kind: "unsafe", reason: "the lock file changed while it was opened" });
  }
  if (signal.aborted) { await release(); return refuse({ kind: "failed", reason: "cancelled" }); }
  const result = await flock(handle.fd, signal);
  const final = await lstat(path).catch(() => null);
  if (result.code === 0 && !signal.aborted && final?.dev === opened.dev && final.ino === opened.ino && !final.isSymbolicLink() && final.nlink === 1) return { outcome: { kind: "held" }, release };
  await release();
  if (result.missing) return refuse({ kind: "missing-flock" });
  if (result.code === BUSY || result.code === 1) return refuse({ kind: "busy" });
  return refuse({ kind: "failed", reason: signal.aborted ? "cancelled" : "flock didn't answer" });
}
