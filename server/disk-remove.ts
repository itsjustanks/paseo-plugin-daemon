import { execFile } from "node:child_process";
import { lstat, mkdtemp, rename, rmdir } from "node:fs/promises";
import { moveNoReplace, type QuarantineEntry } from "./disk-quarantine";
import { ChildGroup } from "./disk-children";
import { basename, dirname, join } from "node:path";
import { runWorker, type WalkResult } from "./disk-worker";
import { CREDENTIAL_PATTERN, TOP_SOURCE_PATTERN, probeChecksFor, strayWords, type ProbeChecks } from "../shared/disk";
import { nodeModulesVerdict, strayLog } from "./disk-nodemodules";

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
 *
 * 0.16.0: every step lives inside the clear's one deadline (the inside-check
 * and rm get only what's left of it); putting an item back never replaces
 * anything (moveNoReplace).
 */

export { ChildGroup, lowPriority, type ChildResult } from "./disk-children";

export interface DeleteResult { ok: boolean; removedBytes: number; leftovers: number; partial: boolean; error?: string }
export type { QuarantineEntry } from "./disk-quarantine";

export interface Manifest { entries: number; bytes: number }

/**
 * Is there anything inside that must never go? Hosts' physical walk, whole
 * folder, until `deadline`. Also what's in it (its manifest: entries and
 * bytes), kept as a record only; a count never proves a deletion.
 */
export async function probeInside(path: string, group: ChildGroup, deadline: number, checks: ProbeChecks = { credentials: true, topSource: true, layout: null }): Promise<{ ok: boolean; why: string | null; manifest?: Manifest }> {
  const left = deadline - Date.now();
  if (left < 2000) return { ok: false, why: "There wasn't enough time left to look inside it, so it was put back." };
  const run = await runWorker<WalkResult>({ op: "scan", roots: [{ id: "probe", path, mode: "whole" }], deadline: deadline - 1000, clearable: [], ignoredOnly: [], ignoredMaxDepth: 0, maxItemsPerRoot: 0, credential: CREDENTIAL_PATTERN, topSource: TOP_SOURCE_PATTERN, ...(checks.layout ? { rootLayout: checks.layout } : {}), rootNodeModules: basename(path) === "node_modules" }, left, undefined, group);
  const result = run.results[0];
  if (!result || !result.ok || run.timedOut || run.error) return { ok: false, why: "Hosts couldn't look inside it to be sure, so it was put back." };
  if (result.partial || result.skipped) return { ok: false, why: "Hosts couldn't read all of it to be sure, so it was put back." };
  if (result.hasEnv || result.hasGit) return { ok: false, why: "It has a .env file or a git repository inside, so it was put back." };
  // Fail-closed: a walk that didn't say "none" counts as "found". Structure first: only what its tool puts at the top level.
  if (checks.layout && result.topUnexpected !== null) return { ok: false, why: result.topUnexpected ? `${strayWords(basename(path), result.topUnexpected)}, so it was put back.` : "Hosts couldn't confirm what's at its top level, so it was put back." };
  const stray = strayLog(result.conditional, checks.turboLogs);
  if (stray) return { ok: false, why: `${strayWords(basename(path), stray)}, so it was put back.` };
  if (basename(path) === "node_modules") {
    if (!checks.nodeModules) return { ok: false, why: "Hosts couldn't check it against its lockfile, so it was put back." };
    const why = await nodeModulesVerdict(result.top, result.topOverflow, checks.nodeModules, path).catch(() => "Hosts couldn't check its top level");
    if (why) return { ok: false, why: `${why}, so it was put back.` };
  }
  if (checks.credentials && result.hasCredential !== false) return { ok: false, why: "It has a file inside that looks like a key or credentials, so it was put back." };
  if (checks.topSource && result.hasTopSource !== false) return { ok: false, why: "It has a source file at its top level that someone may have put there, so it was put back." };
  return { ok: true, why: null, manifest: { entries: result.entries, bytes: result.totalBytes } };
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
  /** What the look inside checks (default: the kind's own checks; a .turbo's logs and a node_modules then refuse). */
  checks?: ProbeChecks;
  flavour?: () => Promise<RmFlavour>;
  /** Records the quarantine before the rename; `done` forgets it once it's resolved (gone, or put back). */
  inventory?: {
    add(entry: QuarantineEntry): Promise<void>; done(quarantine: string): Promise<void>;
    moved?(quarantine: string, manifest: Manifest): Promise<void>; removing?(quarantine: string): Promise<void>;
    outcome?(quarantine: string, outcome: "aside" | "incomplete", aside?: boolean): Promise<void>;
  };
  /** The physical inside-check; tests can swap it. Defaults to the scan worker. */
  probe?: (path: string, group: ChildGroup, deadline: number, checks?: ProbeChecks) => Promise<{ ok: boolean; why: string | null; manifest?: Manifest }>;
  /** Tests only: runs after the item is quarantined and checked, just before rm. */
  beforeRemove?: (quarantined: string) => Promise<void> | void;
  /** The clear's one deadline (epoch ms): the inside-check and rm get only what's left. */
  deadline: number;
  /**
   * 0.16.0 review fix: the last check, after the inside-check and right before
   * rm, from a fresh snapshot: a reason to put it back, or null to go ahead.
   */
  finalCheck?: (quarantined: string) => Promise<string | null>;
}

/** Quarantine, verify, look for .env/.git, then rm. `expected` is the inode the checks approved. */
export async function quarantineAndRemove(target: string, expected: { dev: number; ino: number; bytes: number }, deps: RemoveDeps): Promise<DeleteResult> {
  const refuse = (error: string): DeleteResult => ({ ok: false, removedBytes: 0, leftovers: 0, partial: false, error });
  const kind = await (deps.flavour ?? rmFlavour)();
  if (!kind) return refuse("This system's rm can't promise to stay on one disk, so Hosts doesn't delete anything here.");
  if (deps.deadline - Date.now() < 10_000) return refuse("The time for this clear ran out before it got here, so it was left.");
  let quarantine: string;
  try { quarantine = await mkdtemp(join(dirname(target), ".hosts-quarantine-")); } catch { return refuse("It couldn't be moved aside to clear, so it was left."); }
  const q = await lstat(quarantine).catch(() => null);
  if (!q || !q.isDirectory() || q.isSymbolicLink() || q.dev !== expected.dev || (typeof process.getuid === "function" && q.uid !== process.getuid())) {
    await rmdir(quarantine).catch(() => undefined);
    return refuse("It's on a different disk from its folder, so Hosts leaves it.");
  }
  const moved = join(quarantine, basename(target));
  const entry: QuarantineEntry = { quarantine, original: target, name: basename(target), dev: expected.dev, ino: expected.ino, bytes: expected.bytes, at: Date.now(), stage: "moving" };
  // "moving", written before the rename: a crash from here on is found on the next load (stages: disk-quarantine.ts).
  try { await deps.inventory?.add(entry); } catch { await rmdir(quarantine).catch(() => undefined); return refuse("Hosts couldn't record the move, so it left it alone."); }
  try { await rename(target, moved); } catch { await rmdir(quarantine).catch(() => undefined); await deps.inventory?.done(quarantine).catch(() => undefined); return refuse("It couldn't be moved aside to clear, so it was left."); }
  const putBack = async (error: string): Promise<DeleteResult> => {
    // Never replaces anything: if something now sits at the original place, the item stays set aside and listed.
    // Whatever sits in the quarantine now goes back as itself: its own inode is the one checked after the move.
    const current = await lstat(moved).catch(() => null);
    const back = current && !current.isSymbolicLink() ? await moveNoReplace(moved, target, current.ino) : "failed";
    if (back === "moved") { await rmdir(quarantine).catch(() => undefined); await deps.inventory?.done(quarantine).catch(() => undefined); return refuse(error); }
    // rm hadn't started: it's whole, set aside, not deleted, and listed as such.
    await deps.inventory?.outcome?.(quarantine, "aside", true).catch(() => undefined);
    return { ...refuse(`${error} It couldn't be put back${back === "conflict" ? " (something new is in its place)" : ""}, so it's set aside, not deleted; Hosts lists it under "Left over from an interrupted delete".`), leftovers: 1 };
  };
  const st = await lstat(moved).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory() || st.ino !== expected.ino || st.dev !== expected.dev) return putBack("It changed just before it was cleared, so it was put back.");
  const inside = await (deps.probe ?? probeInside)(moved, deps.group, deps.deadline, deps.checks ?? probeChecksFor(basename(target)));
  if (!inside.ok) return putBack(inside.why ?? "Hosts couldn't be sure what's inside, so it was put back.");
  // "moved": rm hasn't run, so a crash from here on puts it back whole.
  const manifest = inside.manifest ?? null;
  if (!manifest) return putBack("Hosts couldn't count what's inside, so it was put back.");
  try { await deps.inventory?.moved?.(quarantine, manifest); } catch { return putBack("Hosts couldn't record the move, so it was put back."); }
  // The inside-check can take a while: look again at what's running, now, before anything is removed.
  const blocked = deps.finalCheck ? await deps.finalCheck(quarantine).catch(() => "Hosts couldn't check again what's running, so it was put back.") : null;
  if (blocked) return putBack(blocked);
  // Recorded before rm starts: if Hosts stops mid-delete, the next load says "may be incomplete", never "restored".
  try { await deps.inventory?.removing?.(quarantine); } catch { return putBack("Hosts couldn't record the delete, so it was put back."); }
  await deps.beforeRemove?.(moved);
  const left = deps.deadline - Date.now();
  if (left < 5000) return putBack("The time for this clear ran out before it could be removed.");
  const removed = await deps.group.run("rm", rmArgs(kind, quarantine), { timeoutMs: left });
  const gone = !(await lstat(quarantine).catch(() => null));
  if (removed.code === 0 && gone) { await deps.inventory?.done(quarantine).catch(() => undefined); return { ok: true, removedBytes: expected.bytes, leftovers: 0, partial: false }; }
  // rm stopped early: it may have removed some of it, and a count can't prove how much. Put back what's there
  // (never replacing anything) and say only that it may be incomplete; the note stays until dismissed.
  const current = await lstat(moved).catch(() => null);
  const back = current && current.isDirectory() && !current.isSymbolicLink() ? await moveNoReplace(moved, target, current.ino) : "failed";
  if (back === "moved") await rmdir(quarantine).catch(() => undefined);
  await deps.inventory?.outcome?.(quarantine, "incomplete", back !== "moved").catch(() => undefined);
  return { ok: false, removedBytes: 0, leftovers: 1, partial: true, error: `A delete was interrupted; this folder may be incomplete. Run the project's install or build to be sure.${back === "moved" ? "" : " What's there is set aside in a hidden folder beside it."}` };
}
