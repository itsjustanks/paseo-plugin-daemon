import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChildGroup } from "../server/disk-children";
import { gitVerdicts, groupGit, runGit, safeGitEnv } from "../server/disk-git";

/**
 * Review fix (0.14.0): Hosts' git questions can't run a repository's code.
 * A repository whose fsmonitor hook writes a marker file: plain `git
 * ls-files` runs it (the control), Hosts' queries never do.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "hosts-git-safety-")));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function repoWithHook(name: string): { repo: string; marker: string } {
  const repo = join(root, name);
  const marker = join(root, `${name}.marker`);
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "index.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "x\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
  git("init", "-q");
  git("add", ".gitignore", "index.js");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  const hook = join(root, `${name}-fsmonitor.sh`);
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  // Also a hooks folder with a hook that would write the marker, in case a query ran one.
  writeFileSync(join(repo, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(join(repo, ".git", "hooks", "post-index-change"), 0o755);
  git("config", "core.fsmonitor", hook);
  return { repo, marker };
}

describe("git without the repository's code", () => {
  it("control: plain git ls-files runs the fsmonitor hook", () => {
    const { repo, marker } = repoWithHook("control");
    execFileSync("git", ["-C", repo, "ls-files"], { stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });

  it("Hosts' three questions (direct and through a ChildGroup) never run it, and still answer", async () => {
    const { repo, marker } = repoWithHook("hosts");
    const target = join(repo, "node_modules");
    const direct = await gitVerdicts([target], runGit);
    const grouped = await gitVerdicts([target], groupGit(new ChildGroup()));
    expect(existsSync(marker)).toBe(false);
    expect(direct.get(target)).toEqual({ ignored: true, tracked: false, untracked: false });
    expect(grouped.get(target)).toEqual({ ignored: true, tracked: false, untracked: false });
  });

  it("drops inherited GIT_* variables (no config injected through the environment)", () => {
    const env = safeGitEnv({ PATH: "/usr/bin", GIT_DIR: "/elsewhere", GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/tmp/x'", GIT_CONFIG_COUNT: "1" });
    expect(env).toEqual({ PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" });
  });
});
