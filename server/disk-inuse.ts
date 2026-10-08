import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { mapLimit } from "./platform";

/**
 * What's in use (0.14.0, reviewed: fail closed). Every working directory and
 * open file of this user's processes, read fresh before each item.
 *  - macOS: one `lsof -u <uid>`. Any error, timeout or nonzero exit (even
 *    with partial output) means the picture is incomplete.
 *  - Linux: /proc. A process is skipped only when its /proc/<pid>/status
 *    shows a different user (real and effective uid); a process of this user
 *    whose cwd or any fd can't be read makes the picture incomplete. A process
 *    that exited meanwhile is fine. Every fd is read; there is no cap.
 * Incomplete means "in use": nothing is cleared.
 */

export interface OpenPaths { paths: string[]; complete: boolean }

export interface InUseDeps {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  lsof(uid: number): Promise<{ code: number | null; stdout: string }>;
}

const realDeps: InUseDeps = {
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
  readFile: (path) => readFile(path, "utf8"),
  lsof: (uid) => new Promise((resolve) => {
    execFile("lsof", ["-nP", "-w", "-Fn", "-u", String(uid)], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin", LC_ALL: "C" } }, (error, stdout) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? "") });
    });
  }),
};

/** `lsof -Fn` output: the `n` lines are names; only absolute paths matter. */
export function parseLsofNames(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1).replace(/ \((deleted|stat: .*)\)$/, ""));
}

/** `/proc/<pid>/status` → its real and effective uid, or null when the line isn't there. */
export function statusUids(text: string): number[] | null {
  const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "");
const clean = (path: string) => path.replace(/ \(deleted\)$/, "");

export async function openPaths(platform: "linux" | "darwin", uid: number, deps: InUseDeps = realDeps): Promise<OpenPaths> {
  if (platform === "darwin") {
    const result = await deps.lsof(uid).catch(() => ({ code: null, stdout: "" }));
    return result.code === 0 ? { paths: parseLsofNames(result.stdout), complete: true } : { paths: [], complete: false };
  }
  let pids: string[];
  try { pids = (await deps.readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); } catch { return { paths: [], complete: false }; }
  const paths: string[] = [];
  let complete = true;
  await mapLimit(pids, 16, async (pid) => {
    let status: string;
    try { status = await deps.readFile(`/proc/${pid}/status`); } catch (error) { if (!gone(error)) complete = false; return; }
    const uids = statusUids(status);
    if (!uids) { complete = false; return; }
    if (uids.every((id) => id !== uid)) return; // another user's process: Hosts can't clear anything it holds anyway
    try { paths.push(clean(await deps.readlink(`/proc/${pid}/cwd`))); } catch (error) { if (!gone(error)) complete = false; return; }
    let fds: string[];
    try { fds = await deps.readdir(`/proc/${pid}/fd`); } catch (error) { if (!gone(error)) complete = false; return; }
    for (const fd of fds) {
      try { const target = await deps.readlink(`/proc/${pid}/fd/${fd}`); if (target.startsWith("/")) paths.push(clean(target)); }
      catch (error) { if (!gone(error)) complete = false; }
    }
  });
  return { paths, complete };
}

/** The first open path at or beneath `target`, or null. */
export function usedBeneath(target: string, open: readonly string[]): string | null {
  const prefix = target.endsWith("/") ? target : `${target}/`;
  return open.find((path) => path === target || path.startsWith(prefix)) ?? null;
}

/**
 * macOS: the working directories of the given processes, from one `lsof -a
 * -d cwd`. Processes it can't answer for stay unknown (null), and unknown
 * blocks workspace clears.
 */
export function darwinCwds(pids: readonly number[], run: (args: string[]) => Promise<{ code: number | null; stdout: string }> = (args) => new Promise((resolve) => {
  execFile("lsof", args, { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin", LC_ALL: "C" } }, (error, stdout) => {
    const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
    resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? "") });
  });
})): Promise<Map<number, string>> {
  if (!pids.length) return Promise.resolve(new Map());
  return run(["-a", "-nP", "-w", "-d", "cwd", "-Fpn", "-p", pids.join(",")]).then((result) => {
    const out = new Map<number, string>();
    if (result.code !== 0) return out;
    let pid: number | null = null;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n/") && pid !== null) out.set(pid, line.slice(1));
    }
    return out;
  });
}
