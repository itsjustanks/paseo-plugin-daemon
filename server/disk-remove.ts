import { execFile } from "node:child_process";
import { lstat, mkdtemp, rename, rmdir } from "node:fs/promises";
import { ChildGroup } from "./disk-children";
import { basename, dirname, join } from "node:path";
import { runWorker, type WalkResult } from "./disk-worker";

/**
 * How Hosts deletes (0.14.0, reviewed): no hand-written recursive walk.
 *
 *  1. Move the item into a fresh private quarantine folder beside it
 *     (`mkdtemp`, mode 700, owned by this user, same parent so same device).
 *     A rename is atomic: the project never sees a half-deleted folder.
 *  2. Check the moved item is the very inode that was checked, a real folder.
 *  3. Look inside with Hosts' own physical walk (lstat only, never follows a
 *     link, stays on the device): a .env file, a .git file or folder, a bare
 *     repository (HEAD + objects/ + refs/), an unreadable folder, or running
 *     out of time: move it back and refuse.
 *  4. Delete the quarantine folder with the system `rm -rf` and its
 *     stay-on-this-disk flag (`--one-file-system` on GNU, `-x` on macOS),
 *     through execFile with an argv array, `--`, and no shell. rm walks with
 *     fts physically (openat on GNU, verified chdir on BSD), so a folder
 *     swapped for a symlink mid-walk is unlinked as a link, never followed.
 *     A Linux without GNU rm gets no deletes at all.
 * Every child runs at the lowest priority in its own process group, so
 * unloading Hosts can kill it and everything it started. Every quarantine is
 * written to an inventory before the rename and removed from it only once rm
 * has finished, so a crash in between is found and undone on the next load
 * (disk-quarantine.ts); nothing in a quarantine is ever deleted silently.
 */

export { ChildGroup, lowPriority, type ChildResult } from "./disk-children";

export interface DeleteResult { ok: boolean; removedBytes: number; leftovers: number; partial: boolean; error?: string }
export interface QuarantineEntry { quarantine: string; original: string; name: string; dev: number; ino: number; bytes: number; at: number }

/** Is there anything inside that must never go? Hosts' physical walk, whole folder, with a time limit. */
export async function probeInside(path: string, group: ChildGroup): Promise<{ ok: boolean; why: string | null }> {
  const run = await runWorker<WalkResult>({ op: "scan", roots: [{ id: "probe", path, mode: "whole" }], deadline: Date.now() + 4 * 60_000, clearable: [], ignoredOnly: [], ignoredMaxDepth: 0, maxItemsPerRoot: 0 }, 5 * 60_000, undefined, group);
  const result = run.results[0];
  if (!result || !result.ok || run.timedOut || run.error) return { ok: false, why: "Hosts couldn't look inside it to be sure, so it was put back." };
  if (result.partial || result.skipped) return { ok: false, why: "Hosts couldn't read all of it to be sure, so it was put back." };
  if (result.hasEnv || result.hasGit) return { ok: false, why: "It has a .env file or a git repository inside, so it was put back." };
  return { ok: true, why: null };
}
export type RmFlavour = "gnu" | "bsd" | null;
let flavour: Promise<RmFlavour> | null = null;
/** Which `rm` this system has: macOS's BSD rm (-x), GNU coreutils (--one-file-system), or neither (no deletes). */
export function rmFlavour(platform: NodeJS.Platform = process.platform): Promise<RmFlavour> {
  if (platform === "darwin") return Promise.resolve("bsd");
  flavour ??= new Promise((resolve) => execFile("rm", ["--version"], { timeout: 5000 }, (error, stdout) => resolve(!error && /GNU coreutils/.test(String(stdout)) ? "gnu" : null)));
  return flavour;
}
export const rmArgs = (kind: Exclude<RmFlavour, null>, path: string) => (kind === "gnu" ? ["-rf", "--one-file-system", "--", path] : ["-rf", "-x", "--", path]);

export interface RemoveDeps {
  group: ChildGroup;
  flavour?: () => Promise<RmFlavour>;
  /** Records the quarantine before the rename; `done` forgets it once it's resolved (gone, or put back). */
  inventory?: { add(entry: QuarantineEntry): Promise<void>; done(quarantine: string): Promise<void> };
  /** The physical inside-check; tests can swap it. Defaults to the scan worker. */
  probe?: (path: string, group: ChildGroup) => Promise<{ ok: boolean; why: string | null }>;
  /** Tests only: runs after the item is quarantined and checked, just before rm. */
  beforeRemove?: (quarantined: string) => Promise<void> | void;
  timeoutMs?: number;
}

/** Quarantine, verify, look for .env/.git, then rm. `expected` is the inode the checks approved. */
export async function quarantineAndRemove(target: string, expected: { dev: number; ino: number; bytes: number }, deps: RemoveDeps): Promise<DeleteResult> {
  const refuse = (error: string): DeleteResult => ({ ok: false, removedBytes: 0, leftovers: 0, partial: false, error });
  const kind = await (deps.flavour ?? rmFlavour)();
  if (!kind) return refuse("This system's rm can't promise to stay on one disk, so Hosts doesn't delete anything here.");
  let quarantine: string;
  try { quarantine = await mkdtemp(join(dirname(target), ".hosts-quarantine-")); } catch { return refuse("It couldn't be moved aside to clear, so it was left."); }
  const q = await lstat(quarantine).catch(() => null);
  if (!q || !q.isDirectory() || q.isSymbolicLink() || q.dev !== expected.dev || (typeof process.getuid === "function" && q.uid !== process.getuid())) {
    await rmdir(quarantine).catch(() => undefined);
    return refuse("It's on a different disk from its folder, so Hosts leaves it.");
  }
  const moved = join(quarantine, basename(target));
  const entry: QuarantineEntry = { quarantine, original: target, name: basename(target), dev: expected.dev, ino: expected.ino, bytes: expected.bytes, at: Date.now() };
  // Written before the rename: a crash from here on is found and undone on the next load.
  try { await deps.inventory?.add(entry); } catch { await rmdir(quarantine).catch(() => undefined); return refuse("Hosts couldn't record the move, so it left it alone."); }
  try { await rename(target, moved); } catch { await rmdir(quarantine).catch(() => undefined); await deps.inventory?.done(quarantine).catch(() => undefined); return refuse("It couldn't be moved aside to clear, so it was left."); }
  const putBack = async (error: string): Promise<DeleteResult> => {
    try { await rename(moved, target); await rmdir(quarantine); await deps.inventory?.done(quarantine).catch(() => undefined); return refuse(error); }
    // Couldn't put it back: it stays in the inventory and shows as left over from an interrupted clear.
    catch { return refuse(`${error} It couldn't be put back, so it's set aside, untouched; Hosts lists it under "Left over from an interrupted clear".`); }
  };
  const st = await lstat(moved).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory() || st.ino !== expected.ino || st.dev !== expected.dev) return putBack("It changed just before it was cleared, so it was put back.");
  const inside = await (deps.probe ?? probeInside)(moved, deps.group);
  if (!inside.ok) return putBack(inside.why ?? "Hosts couldn't be sure what's inside, so it was put back.");
  await deps.beforeRemove?.(moved);
  const removed = await deps.group.run("rm", rmArgs(kind, quarantine), { timeoutMs: deps.timeoutMs ?? 20 * 60_000 });
  const gone = !(await lstat(quarantine).catch(() => null));
  if (removed.code === 0 && gone) { await deps.inventory?.done(quarantine).catch(() => undefined); return { ok: true, removedBytes: expected.bytes, leftovers: 0, partial: false }; }
  return { ok: false, removedBytes: 0, leftovers: 1, partial: true, error: removed.killed || removed.timedOut ? "Clearing was stopped before it finished; what's left is listed under \"Left over from an interrupted clear\"." : "Some of it couldn't be removed (on another disk, or in use); what's left is listed under \"Left over from an interrupted clear\"." };
}
