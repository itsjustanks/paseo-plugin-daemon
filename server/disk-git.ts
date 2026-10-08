import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";

/**
 * Git's word on candidate folders (0.14.0): is anything inside tracked
 * (then it's source, never cleared), and is a dist/build/out folder ignored
 * (only then is it build output). Each folder is asked of the repository it
 * actually sits in (`rev-parse --show-toplevel` from its parent), so nested
 * repositories answer for themselves. A git that fails or times out is
 * "unknown", and unknown blocks the clear.
 */

export interface GitResult { code: number | null; stdout: string; stderr: string }
export type GitRun = (cwd: string, args: readonly string[], input?: string) => Promise<GitResult>;

export const runGit: GitRun = (cwd, args, input) => new Promise((resolve) => {
  const child = execFile("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
    resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
  if (input !== undefined) child.stdin?.end(input);
});

export interface GitVerdict { tracked: boolean | null; ignored: boolean | null; repo: boolean }

/** For each absolute folder path: tracked? ignored? (null = git couldn't say). */
export async function gitVerdicts(paths: readonly string[], run: GitRun = runGit): Promise<Map<string, GitVerdict>> {
  const out = new Map<string, GitVerdict>();
  const tops = new Map<string, Promise<string | null | "unknown">>();
  const topOf = (dir: string) => {
    let known = tops.get(dir);
    if (!known) {
      known = run(dir, ["rev-parse", "--show-toplevel"]).then((result) => {
        if (result.code === 0) return result.stdout.trim() || "unknown";
        return /not a git repository/i.test(result.stderr) ? null : "unknown";
      });
      tops.set(dir, known);
    }
    return known;
  };
  const byTop = new Map<string, string[]>();
  for (const path of paths) {
    const top = await topOf(dirname(path));
    if (top === null) { out.set(path, { tracked: false, ignored: false, repo: false }); continue; }
    if (top === "unknown") { out.set(path, { tracked: null, ignored: null, repo: true }); continue; }
    const list = byTop.get(top) ?? [];
    list.push(path);
    byTop.set(top, list);
  }
  for (const [top, list] of byTop) {
    for (let start = 0; start < list.length; start += 100) {
      const chunk = list.slice(start, start + 100);
      const rels = chunk.map((path) => relative(top, path));
      const [tracked, ignored] = await Promise.all([
        run(top, ["ls-files", "-z", "--", ...rels]),
        // A trailing slash tells git it's a folder, so "dist/" patterns match.
        run(top, ["check-ignore", "-z", "--stdin"], rels.map((rel) => `${rel}/`).join("\0") + "\0"),
      ]);
      const trackedFiles = tracked.code === 0 ? tracked.stdout.split("\0").filter(Boolean) : null;
      // check-ignore exits 1 when nothing is ignored; that's an answer, not a failure.
      const ignoredSet = ignored.code === 0 || ignored.code === 1 ? new Set(ignored.stdout.split("\0").filter(Boolean).map((rel) => rel.replace(/\/$/, ""))) : null;
      chunk.forEach((path, index) => {
        const rel = rels[index]!;
        out.set(path, {
          tracked: trackedFiles === null ? null : trackedFiles.some((file) => file === rel || file.startsWith(`${rel}/`)),
          ignored: ignoredSet === null ? null : ignoredSet.has(rel),
          repo: true,
        });
      });
    }
  }
  return out;
}
