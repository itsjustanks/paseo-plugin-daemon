import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HELPER_SCRIPTS } from "../shared/housekeeping";
import { isWithin, protectedReason, protectedSet } from "../shared/disk";
import { planTurbo, type CacheEntry } from "./housekeeping-plan";

/**
 * Housekeeping's file work (0.18.0), narrow on purpose:
 *  - Turborepo cache trim: only regular, single-link files this user owns,
 *    named as Turborepo names them, directly inside `<workspace>/.turbo/cache`
 *    of a registered workspace, older than the limit. Never a folder, never a
 *    link, never recursive. The folder chain is checked (real folders of this
 *    user, the real path where it should be) before the scan and again, with
 *    the entry's own device, inode, size and time, right before each unlink.
 *  - The gate scripts: created only where nothing exists (O_CREAT|O_EXCL,
 *    which also refuses a dangling symlink), never overwritten.
 */

export const MAX_CACHE_ENTRIES = 1024;
export const MAX_DELETES_PER_RUN = 256;
export const CACHE_BATCH_SIZE = 16;

export interface Places { home: string; paseoHome: string; stateDir: string; tmpRoots: readonly string[] }

type Link = { path: string; dev: number; ino: number };
export interface CacheDir { root: string; dir: string; chain: Link[] }

const realDir = (stat: Stats | null, uid: number) => !!stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid;

/** The same-user non-use proof applies only to private plain folders owned by that user. */
export async function privateOwnedProfile(path: string, uid: number): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return !!stat && realDir(stat, uid) && (stat.mode & 0o077) === 0;
}

/** The workspace's `.turbo/cache`, if it is exactly what it should be; otherwise why it was left. */
export async function turboCacheDir(directory: string, places: Places, uid: number, allRoots: readonly string[]): Promise<CacheDir | { why: string }> {
  if (!directory.startsWith("/")) return { why: "Its folder isn't a full path" };
  const root = await realpath(directory).catch(() => null);
  if (!root) return { why: "Its folder couldn't be read" };
  const tmpRoots = await Promise.all(places.tmpRoots.map(async (tmp) => await realpath(tmp).catch(() => tmp)));
  if (tmpRoots.some((tmp) => root === tmp || isWithin(root, tmp))) return { why: "It lives in a temporary folder, which Hosts leaves alone" };
  const canonicalPlaces = { ...places, home: await realpath(places.home).catch(() => places.home), paseoHome: await realpath(places.paseoHome).catch(() => places.paseoHome), stateDir: await realpath(places.stateDir).catch(() => places.stateDir) };
  if (protectedReason(root, protectedSet(places, [], [], [places.home])) || protectedReason(root, protectedSet(canonicalPlaces, [], [], [canonicalPlaces.home]))) return { why: "Its folder is your home or holds protected folders" };
  const rootStat = await lstat(root).catch(() => null);
  if (!realDir(rootStat, uid)) return { why: "Its folder isn't a plain folder of this user" };
  const turbo = join(root, ".turbo"), dir = join(turbo, "cache");
  const turboStat = await lstat(turbo).catch(() => null);
  if (!turboStat) return { why: "none" };
  if (!realDir(turboStat, uid)) return { why: "Its .turbo isn't a plain folder of this user" };
  const cacheStat = await lstat(dir).catch(() => null);
  if (!cacheStat) return { why: "none" };
  if (!realDir(cacheStat, uid)) return { why: "Its .turbo/cache isn't a plain folder of this user" };
  if ((await realpath(dir).catch(() => null)) !== dir) return { why: "Its .turbo/cache resolves somewhere else" };
  // Never Paseo's own data or agents' history, even when a workspace is registered inside them.
  const canonical = await Promise.all(allRoots.map((path) => realpath(path).catch(() => null)));
  const roots = canonical.filter((path): path is string => !!path);
  if (protectedReason(join(dir, "x"), protectedSet(places, roots, roots)) || protectedReason(join(dir, "x"), protectedSet(canonicalPlaces, roots, roots))) return { why: "It sits inside folders Hosts protects" };
  return { root, dir, chain: [{ path: root, dev: rootStat!.dev, ino: rootStat!.ino }, { path: turbo, dev: turboStat.dev, ino: turboStat.ino }, { path: dir, dev: cacheStat.dev, ino: cacheStat.ino }] };
}

async function chainIntact(chain: readonly Link[], uid: number): Promise<boolean> {
  for (const link of chain) {
    const stat = await lstat(link.path).catch(() => null);
    if (!realDir(stat, uid) || stat!.ino !== link.ino || stat!.dev !== link.dev) return false;
  }
  return true;
}

/** What's in the cache folder, top level only, bounded. Entries that vanish mid-read are skipped. */
export async function listCache(dir: string, budget = MAX_CACHE_ENTRIES, signal?: AbortSignal): Promise<{ entries: Array<CacheEntry & { dev: number; ino: number }>; truncated: boolean; scanned: number }> {
  const limit = Math.min(MAX_CACHE_ENTRIES, Math.max(0, budget));
  const names: string[] = [];
  for await (const entry of await opendir(dir)) {
    if (signal?.aborted) break;
    names.push(entry.name);
    if (names.length > limit) break;
  }
  const truncated = names.length > limit;
  let scanned = 0;
  const entries: Array<CacheEntry & { dev: number; ino: number }> = [];
  for (const name of names.slice(0, limit)) {
    if (signal?.aborted) break;
    scanned++;
    const stat = await lstat(join(dir, name)).catch(() => null);
    if (!stat) continue;
    entries.push({ name, isFile: stat.isFile(), isSymlink: stat.isSymbolicLink(), uid: stat.uid, nlink: stat.nlink, mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino });
  }
  return { entries, truncated, scanned };
}

export interface TrimResult { removed: number; bytes: number; candidates: number; truncated: boolean; scanned: number; stopped: string | null }

/**
 * Deletes at most 256 planned entries. Activity is revalidated before each batch of at most 16;
 * `mayAct` checks fresh policy and cancellation before every unlink; the folder chain and the entry
 * itself are re-checked right before each one. Preview counts only.
 */
export async function trimCache(cache: CacheDir, uid: number, now: number, maxDays: number, options: { preview: boolean; signal: AbortSignal; mayAct(): Promise<boolean>; batchAvailable?(): Promise<boolean>; budget: number; scanBudget?: number; now?: () => number; remove?: (path: string) => Promise<void> }): Promise<TrimResult> {
  const { entries, truncated, scanned } = await listCache(cache.dir, options.scanBudget, options.signal);
  const plan = planTurbo(entries, now, maxDays, uid).remove as Array<CacheEntry & { dev: number; ino: number }>;
  const candidates = plan.slice(0, Math.min(options.budget, MAX_DELETES_PER_RUN));
  const result: TrimResult = { removed: 0, bytes: 0, candidates: candidates.length, truncated: truncated || plan.length > candidates.length, scanned, stopped: null };
  if (options.preview || !candidates.length) { result.bytes = candidates.reduce((sum, entry) => sum + entry.size, 0); return result; }
  const remove = options.remove ?? unlink;
  for (const [index, entry] of candidates.entries()) {
    if (index % CACHE_BATCH_SIZE === 0 && options.batchAvailable && !(await options.batchAvailable())) { result.stopped = "Workspace or cache use changed before the next batch"; break; }
    if (options.signal.aborted || !(await options.mayAct())) { result.stopped = "Housekeeping paused or cache use changed"; break; }
    if (!(await chainIntact(cache.chain, uid))) { result.stopped = "The cache folder changed while it was being trimmed"; break; }
    const path = join(cache.dir, entry.name);
    const fresh = await lstat(path).catch(() => null);
    if (!fresh || !fresh.isFile() || fresh.isSymbolicLink() || fresh.uid !== uid || fresh.nlink !== 1 || fresh.dev !== entry.dev || fresh.ino !== entry.ino || fresh.mtimeMs !== entry.mtimeMs || fresh.size !== entry.size) continue;
    if (!planTurbo([entry], options.now?.() ?? Date.now(), maxDays, uid).remove.length) continue;
    if (options.signal.aborted) { result.stopped = "Housekeeping stopped"; break; }
    try { await remove(path); result.removed++; result.bytes += entry.size; } catch { /* Gone or refused: left as it is. */ }
  }
  return result;
}

// ------------------------------------------------------------------ gate scripts

export type HelperState = "present" | "missing" | "created" | "failed";

/** Which helper scripts are absent (lstat: a link, even a dangling one, counts as present). */
export async function missingHelpers(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const script of HELPER_SCRIPTS) {
    const stat = await lstat(join(dir, script.name)).catch((error) => ((error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined));
    if (stat === null) out.push(script.name);
  }
  return out;
}

/** Creates one helper only if nothing is there. Never truncates, follows or replaces anything. */
export async function createHelper(dir: string, name: string, mayAct: () => Promise<boolean> = async () => true): Promise<HelperState> {
  const script = HELPER_SCRIPTS.find((item) => item.name === name);
  if (!script) return "failed";
  const path = join(dir, name);
  if (!(await mayAct())) return "failed";
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o755); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST" ? "present" : "failed"; }
  const captured = await handle.stat().catch(() => null);
  try {
    if (!(await mayAct())) throw new Error("cancelled");
    await handle.writeFile(script.content, "utf8");
    if (!(await mayAct())) throw new Error("cancelled");
    await handle.chmod(0o755);
    await handle.close();
    return "created";
  } catch {
    await handle.close().catch(() => undefined);
    // Only the file this call created, and only while it is still that file.
    if (await mayAct()) await unlinkIfOurs(path, captured).catch(() => undefined);
    return "failed";
  }
}

export async function unlinkIfOurs(path: string, captured: Pick<Stats, "dev" | "ino"> | null) {
  const stat = await lstat(path);
  if (captured && stat.dev === captured.dev && stat.ino === captured.ino && stat.isFile() && typeof process.getuid === "function" && stat.uid === process.getuid()) await unlink(path);
}
