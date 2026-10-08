import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { mapLimit } from "./platform";

/**
 * What's in use (0.14.0): every working directory and open file of this
 * user's processes, read once per clear and checked against each folder
 * just before it goes. Linux reads /proc/<pid>/cwd and /proc/<pid>/fd;
 * macOS asks `lsof` once for the whole user. When the answer can't be read
 * completely, `complete` is false and nothing is cleared: "in use" is the
 * safe default.
 */

export interface OpenPaths { paths: string[]; complete: boolean }

export interface InUseDeps {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  lsof(uid: number): Promise<string>;
}

const realDeps: InUseDeps = {
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
  lsof: (uid) => new Promise((resolve, reject) => {
    execFile("lsof", ["-nP", "-w", "-Fn", "-u", String(uid)], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin", LC_ALL: "C" } }, (error, stdout) => {
      // lsof exits 1 when some files couldn't be listed but still prints the rest.
      if (error && !stdout) reject(error); else resolve(stdout);
    });
  }),
};

/** `lsof -Fn` output: the `n` lines are names; only absolute paths matter. */
export function parseLsofNames(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1).replace(/ \((deleted|stat: .*)\)$/, ""));
}

export async function openPaths(platform: "linux" | "darwin", uid: number, deps: InUseDeps = realDeps): Promise<OpenPaths> {
  if (platform === "darwin") {
    try { return { paths: parseLsofNames(await deps.lsof(uid)), complete: true }; } catch { return { paths: [], complete: false }; }
  }
  let pids: string[];
  try { pids = (await deps.readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); } catch { return { paths: [], complete: false }; }
  const paths: string[] = [];
  let complete = true;
  await mapLimit(pids, 16, async (pid) => {
    try { paths.push(clean(await deps.readlink(`/proc/${pid}/cwd`))); } catch (error) {
      // Another user's process, or one that just exited, is fine; anything else means the picture is incomplete.
      if (!isGoneOrForeign(error)) complete = false;
      return;
    }
    let fds: string[] = [];
    try { fds = await deps.readdir(`/proc/${pid}/fd`); } catch (error) { if (!isGoneOrForeign(error)) complete = false; return; }
    for (const fd of fds.slice(0, 4096)) {
      try { const target = await deps.readlink(`/proc/${pid}/fd/${fd}`); if (target.startsWith("/")) paths.push(clean(target)); } catch { /* Closed meanwhile. */ }
    }
  });
  return { paths, complete };
}

const clean = (path: string) => path.replace(/ \(deleted\)$/, "");
const isGoneOrForeign = (error: unknown) => ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "");

/** The first open path at or beneath `target`, or null. */
export function usedBeneath(target: string, open: readonly string[]): string | null {
  const prefix = target.endsWith("/") ? target : `${target}/`;
  return open.find((path) => path === target || path.startsWith(prefix)) ?? null;
}
