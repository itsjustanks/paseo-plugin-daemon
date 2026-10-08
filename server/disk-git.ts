import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";

/**
 * Git's word on folders inside a workspace (0.14.0, reviewed). A folder is
 * clearable only when git gives three definite answers, from the repository
 * the folder actually sits in (`rev-parse --show-toplevel` from its parent):
 *  - `check-ignore` says it is ignored (for every name, node_modules too);
 *  - `ls-files` lists nothing tracked beneath it;
 *  - `ls-files --others --exclude-standard` lists nothing untracked and
 *    unignored beneath it (a new `src/coverage/route.ts` is work, not output).
 * No repository, no git, an error, or running past the deadline: no answer,
 * and no answer means not clearable.
 */

export interface GitResult { code: number | null; stdout: string; stderr: string }
export type GitRun = (cwd: string, args: readonly string[], input: string | undefined, timeoutMs: number) => Promise<GitResult>;

export const runGit: GitRun = (cwd, args, input, timeoutMs) => new Promise((resolve) => {
  const child = execFile("git", ["-C", cwd, ...args], { timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
    resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
  if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
});

/** Each answer is true/false, or null when git couldn't give one. */
export interface GitVerdict { ignored: boolean | null; tracked: boolean | null; untracked: boolean | null }

/** Clearable by git's word: ignored, nothing tracked, nothing untracked-and-unignored beneath. */
export const gitAllows = (verdict: GitVerdict | undefined | null) => !!verdict && verdict.ignored === true && verdict.tracked === false && verdict.untracked === false;

const STEP_MS = 15_000;
const UNKNOWN: GitVerdict = { ignored: null, tracked: null, untracked: null };

/** For each absolute folder: git's three answers. Nothing runs past `deadline` (epoch ms); what's left is unknown. */
export async function gitVerdicts(paths: readonly string[], run: GitRun = runGit, deadline = Date.now() + 120_000, now: () => number = Date.now): Promise<Map<string, GitVerdict>> {
  const out = new Map<string, GitVerdict>(paths.map((path) => [path, UNKNOWN]));
  const left = () => Math.min(STEP_MS, deadline - now());
  const tops = new Map<string, string | null>();
  const byTop = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    if (!tops.has(dir)) {
      if (left() <= 0) break;
      const result = await run(dir, ["rev-parse", "--show-toplevel"], undefined, left());
      tops.set(dir, result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null);
    }
    const top = tops.get(dir);
    if (!top) continue; // not a repository, or git failed: unknown, so not clearable
    byTop.set(top, [...(byTop.get(top) ?? []), path]);
  }
  for (const [top, list] of byTop) {
    for (let start = 0; start < list.length; start += 100) {
      if (left() <= 0) return out;
      const chunk = list.slice(start, start + 100);
      const rels = chunk.map((path) => relative(top, path));
      if (rels.some((rel) => !rel || rel.startsWith(".."))) continue;
      const [ignored, tracked, untracked] = await Promise.all([
        // A trailing slash tells git it's a folder, so "dist/" patterns match.
        run(top, ["check-ignore", "-z", "--stdin"], rels.map((rel) => `${rel}/`).join("\0") + "\0", left()),
        run(top, ["ls-files", "-z", "--", ...rels], undefined, left()),
        run(top, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...rels], undefined, left()),
      ]);
      // check-ignore exits 1 when nothing is ignored: an answer. Anything else that isn't 0 is not.
      const ignoredSet = ignored.code === 0 || (ignored.code === 1 && !ignored.stderr.trim()) ? new Set(ignored.stdout.split("\0").filter(Boolean).map((rel) => rel.replace(/\/$/, ""))) : null;
      const trackedFiles = tracked.code === 0 ? tracked.stdout.split("\0").filter(Boolean) : null;
      const untrackedFiles = untracked.code === 0 ? untracked.stdout.split("\0").filter(Boolean) : null;
      const under = (files: string[], rel: string) => files.some((file) => file === rel || file.startsWith(`${rel}/`));
      chunk.forEach((path, index) => {
        const rel = rels[index]!;
        out.set(path, {
          ignored: ignoredSet === null ? null : ignoredSet.has(rel),
          tracked: trackedFiles === null ? null : under(trackedFiles, rel),
          untracked: untrackedFiles === null ? null : under(untrackedFiles, rel),
        });
      });
    }
  }
  return out;
}
