import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { DiskCleaner, DiskTokens } from "../server/disk-clear";
import { gitAllows, gitVerdicts, type GitRun } from "../server/disk-git";
import { openPaths, parseLsofNames, statusUids, usedBeneath, type InUseDeps } from "../server/disk-inuse";
import { ChildGroup, quarantineAndRemove, rmArgs } from "../server/disk-remove";
import { DiskScanner, busyReason, disksFor, folderAskText, itemBlocked, readWorkspace, workspaceState, type DiskPlaces, type WorkspaceInfo } from "../server/disk-scan";
import { diskWorker, runWorker } from "../server/disk-worker";
import { GuardLoop } from "../server/guard-loop";
import { DaemonLogTail } from "../server/daemon-log";
import { isPackageDownload } from "../server/jobs";
import type { RawProcess } from "../server/platform";
import {
  DISK_CRITICAL_PERCENT, DiskReportSchema, diskLevel, diskSentence, diskSpace, formatSize, olderVersions, protectedReason, protectedSet, stateWords, toolCacheName,
} from "../shared/disk";
import { evaluateHealth } from "../shared/health";
import type { ActionLogEntry } from "../shared/processes";

const MB = 1024 * 1024;
const big = (path: string, bytes = MB) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
const age = (path: string, hours = 24) => { const at = new Date(Date.now() - hours * 3_600_000); utimesSync(path, at, at); };
const UID = process.getuid!();

let root = "";
let places: DiskPlaces;
let app = "";
let worktree = "";

/**
 * A home in a temp folder: one workspace (a git repo with ignored
 * node_modules, .next and dist, a tracked "coverage" source folder and a .env),
 * a real git worktree under $PASEO_HOME/worktrees that no workspace claims,
 * npm's cache, two Playwright versions, a tool cache, ~/.claude, Paseo's own
 * data and /tmp leftovers.
 */
function world() {
  const home = join(root, "home");
  const paseoHome = join(home, ".paseo");
  places = {
    platform: process.platform === "darwin" ? "darwin" : "linux", home, paseoHome, stateDir: join(paseoHome, "daemon-link"),
    tmpDirs: [join(root, "tmp")], cacheBases: [join(home, ".cache")], browserRoots: [join(home, ".cache", "ms-playwright")],
  };
  app = join(home, "code", "app");
  mkdirSync(app, { recursive: true });
  git(app, "init", "-q");
  writeFileSync(join(app, ".gitignore"), "node_modules\n.next\ndist/\n.env\n");
  big(join(app, "src", "index.ts"), 1000);
  big(join(app, "src", "api", "coverage", "route.ts"), 1000); // tracked source that happens to be called "coverage"
  writeFileSync(join(app, ".env"), "SECRET=1\n");
  git(app, "add", ".gitignore", "src");
  git(app, "commit", "-qm", "init");
  big(join(app, "node_modules", "react", "index.js"), 3 * MB);
  big(join(app, ".next", "cache", "a.bin"), 2 * MB);
  big(join(app, "dist", "main.js"), MB);
  big(join(app, "build", "keep.js"), MB); // not ignored: part of the project
  big(join(app, "packages", "ui", "node_modules", "x.js"), MB);
  worktree = join(paseoHome, "worktrees", "proj1", "feature-x");
  mkdirSync(join(paseoHome, "worktrees", "proj1"), { recursive: true });
  git(app, "worktree", "add", "-q", "-b", "feature-x", worktree);
  big(join(worktree, "node_modules", "y.js"), MB);
  big(join(paseoHome, "config.json"), 1000);
  big(join(places.stateDir, "actions.jsonl"), 100);
  big(join(home, ".claude", "projects", "history.jsonl"), MB);
  big(join(home, ".npm", "_cacache", "content", "blob"), 2 * MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1100", "chrome"), MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1200", "chrome"), MB);
  big(join(home, ".cache", "pip", "wheel"), MB);
  big(join(home, ".cache", "unknown-app", "state"), MB);
  big(join(root, "tmp", "build-old", "x"), MB);
  age(join(root, "tmp", "build-old", "x")); age(join(root, "tmp", "build-old"));
  big(join(root, "tmp", "build-new", "x"), MB);
  big(join(root, "tmp", "claude-501", "x"), MB);
  age(join(root, "tmp", "claude-501", "x")); age(join(root, "tmp", "claude-501"));
}

const idleWorkspace = (status = "done"): WorkspaceInfo => ({ id: "wks_1", name: "App", project: "app", directory: app, worktree: false, status, activityAt: Date.now() - 3_600_000, branch: "main", devServers: [] });

async function scanned(workspaces: WorkspaceInfo[] = [idleWorkspace()], extra: Partial<ConstructorParameters<typeof DiskScanner>[0]> = {}) {
  const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => workspaces, cacheFile: null, scanSeconds: 60, pnpmStore: async () => null, ...extra });
  scanner.start();
  await scanner.wait();
  const tokens = new DiskTokens();
  const report = DiskReportSchema.parse(await scanner.report(workspaces, (item) => tokens.mint(item), []));
  return { scanner, tokens, report };
}

function cleaner(tokens: DiskTokens, scanner: DiskScanner, overrides: Partial<ConstructorParameters<typeof DiskCleaner>[0]> = {}) {
  const log: ActionLogEntry[] = [];
  const instance = new DiskCleaner({
    places, uid: UID, tokens,
    listWorkspaces: async () => [idleWorkspace()],
    unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
    processes: async () => [],
    openPaths: async () => ({ paths: [], complete: true }),
    cwds: async () => new Map(),
    pnpmStore: async () => null,
    log: async (entry) => { log.push(entry); },
    cleared: (path, bytes) => scanner.forget(path, bytes),
    ...overrides,
  });
  return { instance, log };
}

const proc = (argv: string[], cwd: string | null = app, pid = 9): RawProcess => ({ pid, ppid: 1, uid: UID, comm: argv[0]!, argv, state: "running", cpuSeconds: 0, startId: `s${pid}`, rssBytes: 0, ageSeconds: 0, cwd });
type Report = Awaited<ReturnType<typeof scanned>>["report"];
const item = (report: Report, where: string) => report.workspaces.flatMap((w) => w.items).find((i) => i.where === where);
const cache = (report: Report, name: string) => report.caches.flatMap((g) => g.items).find((i) => i.name === name);
const run = async (c: DiskCleaner, tokens: string[]) => { c.start(tokens); await c.wait(); return c.status(); };
const mintFor = (tokens: DiskTokens, path: string, kind: "workspace" | "npm" | "versions" | "tool" | "tmp") => {
  const st = lstatSync(path);
  return tokens.mint({ path, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind, owner: "x", bytes: 1 });
};
const hasQuarantine = (dir: string) => fs.readdirSync(dir).some((name) => name.startsWith(".hosts-quarantine-"));

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "hosts-disk-"))); world(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the rules, pure", () => {
  it("disk levels and words: 85% warns, 95% is critical", () => {
    expect(diskLevel(84.9)).toBe("ok");
    expect(diskLevel(85)).toBe("warning");
    expect(diskLevel(DISK_CRITICAL_PERCENT)).toBe("critical");
    expect(diskSentence(93, 30 * 1024 ** 3)).toBe("The disk is 93% full (30 GB left). Clearing build files and caches under Workspaces can help.");
    expect(diskSentence(96, 8 * 1024 ** 3)).toBe("The disk is 96% full (8 GB left). Agents will start failing to write files soon.");
    expect(diskSentence(40, 1)).toBeNull();
    // A fleet daemon on 2026-10-08: 581 GB with 17 GB writable is critical.
    const space = diskSpace("This computer's disk", { bsize: 4096, blocks: 152305664, bfree: 4456448, bavail: 4456448 });
    expect(space.level).toBe("critical");
    expect(Math.round(space.percent)).toBe(97);
    expect(formatSize(1536 * MB)).toBe("1.5 GB");
  });

  it("protects home, Paseo's data, agents' history, Hosts' folder, workspace roots and /, as targets, ancestors and (for data) contents", () => {
    const set = protectedSet({ home: "/home/u", paseoHome: "/home/u/.paseo", stateDir: "/home/u/.paseo/daemon-link" }, ["/home/u/code/app"], ["/home/u/.paseo/worktrees/p1/feat"]);
    expect(protectedReason("/home/u/.paseo/config.json", set)).toMatch(/Paseo's own data/);
    expect(protectedReason("/home/u/.paseo/plugins/x/node_modules", set)).toMatch(/Paseo's own data/);
    expect(protectedReason("/home/u/.paseo/worktrees/p1", set)).toMatch(/contains a folder Hosts protects/);
    expect(protectedReason("/home/u/.paseo/worktrees/p1/feat", set)).toMatch(/whole folder/);
    expect(protectedReason("/home/u/.paseo/worktrees/p1/feat/node_modules", set)).toBeNull();
    expect(protectedReason("/home/u/.claude/projects", set)).toMatch(/your data/);
    expect(protectedReason("/home/u/.codex", set)).toMatch(/whole folder/);
    expect(protectedReason("/home/u", set)).toMatch(/whole folder/);
    expect(protectedReason("/home", set)).toMatch(/contains a folder Hosts protects/);
    expect(protectedReason("/", set)).not.toBeNull();
    expect(protectedReason("/home/u/code/app", set)).toMatch(/whole folder/);
    expect(protectedReason("/home/u/code", set)).toMatch(/contains/);
    expect(protectedReason("/home/u/code/app/node_modules", set)).toBeNull();
    expect(protectedReason("/home/u/.cache/pip", set)).toBeNull();
  });

  it("regression (finding 2): a /tmp folder that encloses $PASEO_HOME is protected", () => {
    const set = protectedSet({ home: "/home/u", paseoHome: "/tmp/session/state", stateDir: "/tmp/session/state/daemon-link" }, [], []);
    expect(protectedReason("/tmp/session", set)).toMatch(/contains a folder Hosts protects/);
    expect(protectedReason("/tmp/other-build", set)).toBeNull();
  });

  it("keeps the newest download of each kind, and knows tool caches by name", () => {
    expect(olderVersions(["chromium-1193", "chromium-1228", "chromium-1243", "chromium_headless_shell-1243", "chromium_headless_shell-1228", "ffmpeg-1011", ".links", "b"])).toEqual(["chromium-1193", "chromium-1228", "chromium_headless_shell-1228"]);
    expect(olderVersions(["chrome-154.0.8037.57"])).toEqual([]);
    expect(toolCacheName("Yarn")).toBe("Yarn downloads");
    expect(toolCacheName("claude")).toBeNull();
    expect(toolCacheName("unknown-app")).toBeNull();
  });

  it("reads Paseo's workspace descriptors, and says what's busy", () => {
    const parsed = readWorkspace({ id: "w", name: "Site", title: null, workspaceDirectory: "/x/site", workspaceKind: "worktree", status: "running", activityAt: "2026-10-08T00:00:00Z", gitRuntime: { currentBranch: "feat" }, scripts: [{ scriptName: "web", lifecycle: "running", port: 3000 }, { scriptName: "api", lifecycle: "stopped", port: 4000 }], projectDisplayName: "Site" });
    expect(parsed).toMatchObject({ name: "Site", worktree: true, status: "running", branch: "feat", devServers: ["web :3000"] });
    expect(readWorkspace({ id: "w", workspaceDirectory: "/x", archivingAt: "2026-10-08T00:00:00Z" })).toBeNull();
    expect(workspaceState("needs_input")).toBe("waiting");
    expect(busyReason("working", [])).toMatch(/agent is working/);
    expect(busyReason("idle", ["web :3000"])).toMatch(/dev server is running/);
    expect(busyReason("idle", [])).toBeNull();
    expect(stateWords("idle", Date.now() - 3 * 86_400_000)).toBe("Idle since 3 days ago");
  });

  it("clearable only on git's three definite answers; cut-off checks, .env and .git inside say no", () => {
    const set = protectedSet({ home: "/h", paseoHome: "/h/.paseo", stateDir: "/h/.paseo/daemon-link" }, ["/h/a"], []);
    const base = { name: "node_modules", hasEnv: false, hasGit: false, ignoredOnly: false, partial: false };
    const yes = { ignored: true, tracked: false, untracked: false };
    expect(itemBlocked(base, yes, "/h/a/node_modules", set)).toBeNull();
    expect(itemBlocked(base, { ...yes, tracked: true }, "/h/a/node_modules", set)).toBe("hide");
    expect(itemBlocked(base, { ...yes, untracked: true }, "/h/a/node_modules", set)).toBe("hide");
    expect(itemBlocked(base, { ...yes, ignored: false }, "/h/a/node_modules", set)).toBe("hide");
    expect(itemBlocked(base, { ignored: null, tracked: false, untracked: false }, "/h/a/node_modules", set)).toMatch(/Git couldn't confirm/);
    expect(itemBlocked(base, null, "/h/a/node_modules", set)).toMatch(/Git couldn't confirm/);
    expect(itemBlocked({ ...base, partial: true }, yes, "/h/a/node_modules", set)).toMatch(/time ran out/);
    expect(itemBlocked({ ...base, hasEnv: true }, yes, "/h/a/node_modules", set)).toMatch(/\.env/);
    expect(itemBlocked({ ...base, hasGit: true }, yes, "/h/a/node_modules", set)).toMatch(/\.git/);
    expect(gitAllows({ ignored: true, tracked: null, untracked: false })).toBe(false);
    expect(itemBlocked({ ...base, name: "dist", ignoredOnly: true }, null, "/h/a/dist", set)).toBe("hide");
  });

  it("knows a package install or browser download when one runs", () => {
    expect(isPackageDownload(["npm", "install"])).toBe(true);
    expect(isPackageDownload(["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "ci"])).toBe(true);
    expect(isPackageDownload(["pnpm", "add", "react"])).toBe(true);
    expect(isPackageDownload(["npx", "tsc"])).toBe(true);
    expect(isPackageDownload(["npx", "playwright", "install"])).toBe(true);
    expect(isPackageDownload(["agent-browser", "install"])).toBe(true);
    expect(isPackageDownload(["yarn"])).toBe(true);
    expect(isPackageDownload(["npm", "run", "dev"])).toBe(false);
    expect(isPackageDownload(["node", "server.js"])).toBe(false);
  });

  it("the worktree message asks before deleting and never says to rm", () => {
    const text = folderAskText({ path: "/h/.paseo/worktrees/p/feat", bytes: 2 * 1024 ** 3, branch: "feat", changedAt: Date.now() - 86_400_000 * 20 }, "/h");
    expect(text).toContain("git worktree remove");
    expect(text).toContain("Ask me before you delete anything.");
    expect(text).not.toMatch(/\brm -rf\b/);
  });
});

describe("in use fails closed (finding 4)", () => {
  type Entry = { uid?: number; status?: "unreadable" | "missing"; cwd?: string; cwdUnreadable?: boolean; fds?: Record<string, string>; fdsUnreadable?: boolean; badFd?: string };
  const fakeProc = (entries: Record<string, Entry>): InUseDeps => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    return {
      readdir: async (path) => {
        if (path === "/proc") return Object.keys(entries);
        const entry = entries[path.split("/")[2]!]!;
        if (entry.fdsUnreadable) throw err("EACCES");
        return Object.keys(entry.fds ?? {});
      },
      readFile: async (path) => {
        const entry = entries[path.split("/")[2]!]!;
        if (entry.status === "unreadable") throw err("EACCES");
        if (entry.status === "missing") throw err("ENOENT");
        return `Name:\tx\nUid:\t${entry.uid}\t${entry.uid}\t${entry.uid}\t${entry.uid}\n`;
      },
      readlink: async (path) => {
        const [, , pid, kind, fd] = path.split("/");
        const entry = entries[pid!]!;
        if (kind === "cwd") { if (entry.cwdUnreadable) throw err("EACCES"); return entry.cwd ?? "/"; }
        if (fd === entry.badFd) throw err("EACCES");
        return entry.fds![fd!]!;
      },
      lsof: async () => ({ code: 0, stdout: "" }),
    };
  };

  it("macOS: any lsof error, timeout or nonzero exit (even with partial output) means in use", async () => {
    const deps = { readdir: async () => [], readFile: async () => "", readlink: async () => "", lsof: async () => ({ code: 1 as number | null, stdout: "p1\nn/Users/x/app/node_modules/a.js\n" }) };
    expect(await openPaths("darwin", 501, deps)).toEqual({ paths: [], complete: false });
    expect(await openPaths("darwin", 501, { ...deps, lsof: async () => ({ code: null, stdout: "" }) })).toMatchObject({ complete: false });
    expect(await openPaths("darwin", 501, { ...deps, lsof: async () => ({ code: 0, stdout: "p1\nn/a/b\n" }) })).toEqual({ paths: ["/a/b"], complete: true });
    expect(parseLsofNames("p1\nfcwd\nn/Users/x/app\nn/tmp/f (deleted)\n")).toEqual(["/Users/x/app", "/tmp/f"]);
  });

  it("Linux: skips only processes whose status shows another user; unreadable same-user cwd or fd means in use", async () => {
    // pid 1 is root's init: its fds can't be read, but its status says uid 0, so it's skipped (the fleet's case).
    const fine = fakeProc({ "1": { uid: 0, cwdUnreadable: true, fdsUnreadable: true }, "50": { uid: 1000, cwd: "/home/u/app", fds: { "0": "/dev/null", "3": "/home/u/app/node_modules/x" } }, "60": { status: "missing" } });
    expect(await openPaths("linux", 1000, fine)).toEqual({ paths: ["/home/u/app", "/dev/null", "/home/u/app/node_modules/x"], complete: true });
    expect(await openPaths("linux", 1000, fakeProc({ "50": { uid: 1000, cwdUnreadable: true } }))).toMatchObject({ complete: false });
    expect(await openPaths("linux", 1000, fakeProc({ "50": { uid: 1000, cwd: "/x", fds: { "4": "/y" }, badFd: "4" } }))).toMatchObject({ complete: false });
    expect(await openPaths("linux", 1000, fakeProc({ "50": { uid: 1000, cwd: "/x", fdsUnreadable: true } }))).toMatchObject({ complete: false });
    expect(await openPaths("linux", 1000, fakeProc({ "50": { status: "unreadable" } }))).toMatchObject({ complete: false });
  });

  it("Linux: no fd cap: a process with 5000 open files is read to the last one", async () => {
    const fds: Record<string, string> = {};
    for (let fd = 0; fd < 5000; fd += 1) fds[String(fd)] = `/tmp/f${fd}`;
    fds["4999"] = "/home/u/app/node_modules/late.js";
    const result = await openPaths("linux", 1000, fakeProc({ "50": { uid: 1000, cwd: "/x", fds } }));
    expect(result.complete).toBe(true);
    expect(usedBeneath("/home/u/app/node_modules", result.paths)).toBe("/home/u/app/node_modules/late.js");
    expect(statusUids("Uid:\t0\t1000\t0\t0\n")).toEqual([0, 1000]);
  });
});

describe("the scan worker (a low-priority child process)", () => {
  it("never follows a symlink out, counts hard links once, and finds .env inside", async () => {
    big(join(root, "outside", "secret"), 4 * MB);
    symlinkSync(join(root, "outside"), join(app, "node_modules", "escape"));
    fs.linkSync(join(app, "node_modules", "react", "index.js"), join(app, "hardlink.js"));
    big(join(app, ".next", ".env.local"), 10);
    const result = (await runWorker<{ totalBytes: number; items: Array<{ rel: string; bytes: number; hasEnv: boolean }> }>({ op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() + 20_000, clearable: ["node_modules", ".next"], ignoredOnly: ["dist"], ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, 30_000)).results[0]!;
    expect(result.totalBytes).toBeLessThan(13 * MB);
    expect(result.items.find((i) => i.rel === "node_modules")!.bytes).toBeLessThan(4 * MB);
    expect(result.items.find((i) => i.rel === ".next")!.hasEnv).toBe(true);
  });

  it("stops at its deadline and says the result is partial", () => {
    const results: Array<{ partial: boolean; skipped?: boolean }> = [];
    diskWorker(fs as never, { op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() - 1, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 10 }, (r) => results.push(r as never));
    expect(results.every((r) => r.skipped && r.partial)).toBe(true);
  });
});

describe("deleting: quarantine, then the system rm (finding 3)", () => {
  it("passes rm a stay-on-one-disk flag and --", () => {
    expect(rmArgs("gnu", "/a/q")).toEqual(["-rf", "--one-file-system", "--", "/a/q"]);
    expect(rmArgs("bsd", "/a/q")).toEqual(["-rf", "-x", "--", "/a/q"]);
  });

  it("regression: a folder inside swapped for a symlink just before rm is unlinked as a link; its target survives", async () => {
    big(join(root, "outside", "precious"), 1000);
    mkdirSync(join(app, "node_modules", "sub", "deep"), { recursive: true });
    const st = lstatSync(join(app, "node_modules"));
    const result = await quarantineAndRemove(join(app, "node_modules"), { dev: st.dev, ino: st.ino, bytes: 1 }, {
      group: new ChildGroup(),
      beforeRemove: (quarantined) => { rmSync(join(quarantined, "sub"), { recursive: true }); symlinkSync(join(root, "outside"), join(quarantined, "sub")); },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("puts it back, untouched, when a .env or .git turns up inside", async () => {
    big(join(app, "node_modules", "react", ".env"), 10);
    const st = lstatSync(join(app, "node_modules"));
    const result = await quarantineAndRemove(join(app, "node_modules"), { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup() });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/\.env file or a \.git folder/) });
    expect(existsSync(join(app, "node_modules", "react", ".env"))).toBe(true);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("refuses a different inode, and a Linux without GNU rm", async () => {
    const st = lstatSync(join(app, ".next"));
    expect(await quarantineAndRemove(join(app, ".next"), { dev: st.dev, ino: st.ino + 1, bytes: 1 }, { group: new ChildGroup() })).toMatchObject({ ok: false });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    expect(await quarantineAndRemove(join(app, ".next"), { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup(), flavour: async () => null })).toMatchObject({ ok: false, error: expect.stringMatching(/stay on one disk/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });
});

describe("git's word (findings 6 and 8)", () => {
  it("ignored, nothing tracked, nothing untracked: only then", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100); // new, untracked work
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, "src", "api", "coverage"), join(app, "src", "coverage"), join(app, "dist"), join(app, "build")]);
    expect(gitAllows(verdicts.get(join(app, "node_modules")))).toBe(true);
    expect(gitAllows(verdicts.get(join(app, "dist")))).toBe(true);
    expect(verdicts.get(join(app, "src", "api", "coverage"))).toMatchObject({ tracked: true });
    expect(verdicts.get(join(app, "src", "coverage"))).toMatchObject({ ignored: false, untracked: true });
    expect(verdicts.get(join(app, "build"))).toMatchObject({ ignored: false, untracked: true });
    expect(gitAllows((await gitVerdicts([join(root, "tmp", "build-old")])).get(join(root, "tmp", "build-old")))).toBe(false);
  });

  it("regression: nothing runs past the deadline; what's left is unknown and not clearable", async () => {
    let calls = 0;
    const slow: GitRun = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { code: 0, stdout: `${app}\n`, stderr: "" }; };
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, ".next")], slow, Date.now() + 10);
    expect([...verdicts.values()].every((verdict) => !gitAllows(verdict))).toBe(true);
    expect(calls).toBeLessThanOrEqual(1);
  });
});

describe("the scan", () => {
  it("offers only what git ignores; hides source; lists the unlinked worktree and caches", async () => {
    const { report } = await scanned();
    const workspace = report.workspaces.find((w) => w.names.includes("App"))!;
    expect(workspace.items.map((i) => i.where).sort()).toEqual([".next", "dist", "node_modules", "packages/ui/node_modules"]);
    expect(workspace.items.every((i) => i.token && !i.blocked)).toBe(true);
    expect(workspace.clearableBytes).toBeGreaterThanOrEqual(7 * MB);
    const unlinked = report.workspaces.find((w) => w.state === "unlinked")!;
    expect(unlinked.folder).toBe("~/.paseo/worktrees/proj1/feature-x");
    expect(unlinked.items.map((i) => [i.where, !!i.token])).toEqual([["node_modules", true]]);
    const names = report.caches.flatMap((g) => g.items).map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["npm cache", "chromium-1100", "pip", "build-old", "build-new"]));
    expect(names).not.toContain("chromium-1200");
    expect(names).not.toContain("unknown-app");
    expect(names).not.toContain("claude-501");
    expect(cache(report, "build-new")!.token).toBeNull();
    expect(JSON.stringify(report)).not.toContain(".claude");
  });

  it("regression (finding 6): new, untracked src/coverage isn't offered", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100);
    expect(item((await scanned()).report, "src/coverage")).toBeUndefined();
  });

  it("no git repository: nothing inside is clearable", async () => {
    rmSync(join(app, ".git"), { recursive: true });
    const { report } = await scanned();
    expect(report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
  });

  it("regression (finding 1): a browser-cache entry that is a symlink is never listed", async () => {
    big(join(places.home, "documents", "backup-1", "photos"), 1000);
    big(join(places.home, "documents", "backup-2", "photos"), 1000);
    symlinkSync(join(places.home, "documents", "backup-1"), join(places.home, ".cache", "ms-playwright", "chromium-1"));
    const { report } = await scanned();
    expect(cache(report, "chromium-1")).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("backup-1");
  });

  it("regression (finding 2): a /tmp folder that contains $PASEO_HOME is never listed", async () => {
    big(join(root, "tmp", "session", "state", "history.db"), 1000);
    age(join(root, "tmp", "session", "state", "history.db")); age(join(root, "tmp", "session", "state")); age(join(root, "tmp", "session"));
    places = { ...places, paseoHome: join(root, "tmp", "session", "state"), stateDir: join(root, "tmp", "session", "state", "daemon-link") };
    expect(cache((await scanned()).report, "session")).toBeUndefined();
  });

  it("regression (finding 8): when git can't answer in time, nothing is clearable", async () => {
    const { report } = await scanned([idleWorkspace()], { git: async () => ({ code: null, stdout: "", stderr: "timeout" }) });
    expect(report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
  });

  it("a working agent or a running dev server makes a workspace busy", async () => {
    const working = await scanned([idleWorkspace("running")]);
    expect(working.report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
    const serving = await scanned([{ ...idleWorkspace(), devServers: ["web :3000"] }]);
    expect(serving.report.workspaces.find((w) => w.names.includes("App"))!.busy).toMatch(/dev server/);
  });
});

describe("clearing: the hard rules", () => {
  it("clears an ignored folder, logs it, and drops it from the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, log } = cleaner(tokens, scanner);
    const job = await run(instance, [item(report, ".next")!.token!]);
    expect(job.results).toEqual([expect.objectContaining({ name: ".next", ok: true })]);
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
    expect(log[0]).toMatchObject({ action: "disk-clear", source: "disk", status: "done", name: ".next" });
    expect(log[0]!.message).toContain("Confirmed in the Paseo app");
  });

  it("clears inside an unlinked worktree, never the worktree itself", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = report.workspaces.find((w) => w.state === "unlinked")!.items[0]!.token!;
    const job = await run(cleaner(tokens, scanner).instance, [token, mintFor(tokens, worktree, "workspace")]);
    expect(job.results.map((r) => r.ok)).toEqual([true, false]);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
  });

  it("refuses a folder git tracks, or with untracked work inside, even with a valid token", async () => {
    const { scanner, tokens } = await scanned();
    big(join(app, "src", "coverage", "route.ts"), 100);
    git(app, "add", "-f", "node_modules/react/index.js"); git(app, "commit", "-qm", "oops");
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, "node_modules"), "workspace"), mintFor(tokens, join(app, "src", "coverage"), "workspace")]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false]);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect(existsSync(join(app, "src", "coverage", "route.ts"))).toBe(true);
  });

  it("refuses a symlink, and a path with a symlink on the way", async () => {
    const { scanner, tokens } = await scanned();
    big(join(root, "outside", "precious"), 1000);
    rmSync(join(app, ".next"), { recursive: true });
    symlinkSync(join(root, "outside"), join(app, ".next"));
    big(join(root, "elsewhere", "node_modules", "z.js"), 1000);
    symlinkSync(join(root, "elsewhere"), join(app, "linked"));
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, ".next"), "workspace"), mintFor(tokens, join(app, "linked", "node_modules"), "workspace")]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false]);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
    expect(existsSync(join(root, "elsewhere", "node_modules", "z.js"))).toBe(true);
  });

  it("regression (finding 1): a symlinked browser download can't delete what it points at, even with a token", async () => {
    const { scanner, tokens } = await scanned();
    big(join(places.home, "documents", "backup-1", "photos"), 1000);
    big(join(places.home, "documents", "backup-2", "photos"), 1000);
    symlinkSync(join(places.home, "documents", "backup-1"), join(places.home, ".cache", "ms-playwright", "chromium-1"));
    // A token for the link's target, as the old scan minted after canonicalising, and one for the link itself.
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(places.home, "documents", "backup-1"), "versions"), mintFor(tokens, join(places.home, ".cache", "ms-playwright", "chromium-1"), "versions")]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false]);
    expect(existsSync(join(places.home, "documents", "backup-1", "photos"))).toBe(true);
  });

  it("regression (finding 2): an old /tmp folder that contains $PASEO_HOME is refused", async () => {
    big(join(root, "tmp", "session", "state", "history.db"), 1000);
    age(join(root, "tmp", "session", "state", "history.db")); age(join(root, "tmp", "session", "state")); age(join(root, "tmp", "session"));
    places = { ...places, paseoHome: join(root, "tmp", "session", "state"), stateDir: join(root, "tmp", "session", "state", "daemon-link") };
    const { scanner, tokens } = await scanned();
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(root, "tmp", "session"), "tmp")]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/contains a folder Hosts protects/) });
    expect(existsSync(join(root, "tmp", "session", "state", "history.db"))).toBe(true);
  });

  it("refuses anything in use, or when the in-use picture is incomplete", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const open = await run(cleaner(tokens, scanner, { openPaths: async () => ({ paths: [join(app, "node_modules", "react", "index.js")], complete: true }) }).instance, [token]);
    expect(open.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/open right now/) });
    const unknown = await run(cleaner(tokens, scanner, { openPaths: async () => ({ paths: [], complete: false }) }).instance, [token]);
    expect(unknown.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/couldn't check what's in use/) });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("refuses when the folder was swapped or written to since the check", async () => {
    const { scanner, tokens, report } = await scanned();
    const swapToken = item(report, "node_modules")!.token!;
    renameSync(join(app, "node_modules"), join(app, "node_modules.real"));
    big(join(app, "node_modules", "decoy.js"), 10);
    expect((await run(cleaner(tokens, scanner).instance, [swapToken])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/isn't the same folder/) });
    const nextToken = item(report, ".next")!.token!;
    writeFileSync(join(app, ".next", "new-file"), "x");
    const later = new Date(Date.now() + 5000); utimesSync(join(app, ".next"), later, later);
    expect((await run(cleaner(tokens, scanner).instance, [nextToken])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/changed since it was checked/) });
  });

  it("regression (finding 5): a build that starts mid-clear is seen before the next item", async () => {
    const { scanner, tokens, report } = await scanned();
    let calls = 0;
    const processes = async () => (calls++ === 0 ? [] : [proc(["npm", "run", "build"])]);
    const job = await run(cleaner(tokens, scanner, { processes }).instance, [item(report, ".next")!.token!, item(report, "dist")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, false]);
    expect(job.results[1]!.message).toMatch(/Something is running in this workspace/);
    expect(existsSync(join(app, "dist", "main.js"))).toBe(true);
  });

  it("regression (finding 5): a build with an unknown folder blocks every workspace clear, and says so", async () => {
    const { scanner, tokens, report } = await scanned();
    const blocked = await run(cleaner(tokens, scanner, { processes: async () => [proc(["node", "node_modules/.bin/vitest", "run"], null)] }).instance, [item(report, ".next")!.token!]);
    expect(blocked.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/can't tell in which folder, so it won't clear any workspace/) });
    // On macOS Hosts first asks lsof for the job's folder; one it can place elsewhere doesn't block.
    places = { ...places, platform: "darwin" };
    const placed = await run(cleaner(tokens, scanner, { processes: async () => [proc(["node", "node_modules/.bin/vitest", "run"], null, 77)], cwds: async () => new Map([[77, "/somewhere/else"]]) }).instance, [item(report, ".next")!.token!]);
    expect(placed.results[0]!.ok).toBe(true);
  });

  it("regression (finding 5): caches and prune wait while a package install or browser download runs", async () => {
    const store = join(places.home, "pnpm-store", "v10");
    big(join(store, "files", "00", "pkg"), MB);
    const { scanner, tokens, report } = await scanned([idleWorkspace()], { pnpmStore: async () => store });
    let pruned = 0;
    const prune = async () => { pruned += 1; return { ok: true, message: "pruned" }; };
    const installing = cleaner(tokens, scanner, { processes: async () => [proc(["pnpm", "add", "left-pad"], "/elsewhere")], pnpmStore: async () => store, prune });
    const job = await run(installing.instance, [cache(report, "npm cache")!.token!, cache(report, "chromium-1100")!.token!, cache(report, "pnpm store")!.token!]);
    expect(job.results.every((r) => !r.ok && /package install or browser download/.test(r.message))).toBe(true);
    expect(pruned).toBe(0);
    expect(existsSync(join(places.home, ".npm", "_cacache", "content", "blob"))).toBe(true);
    const calm = cleaner(tokens, scanner, { pnpmStore: async () => store, prune });
    expect((await run(calm.instance, [cache(report, "pnpm store")!.token!])).results[0]!.ok).toBe(true);
    expect(pruned).toBe(1);
  });

  it("refuses while an agent works or waits there", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    expect((await run(cleaner(tokens, scanner, { listWorkspaces: async () => [idleWorkspace("running")] }).instance, [token])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/agent is working/) });
    expect((await run(cleaner(tokens, scanner, { listWorkspaces: async () => [idleWorkspace("attention")] }).instance, [token])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/waiting for you/) });
    expect((await run(cleaner(tokens, scanner, { processes: async () => [proc(["claude"])] }).instance, [token])).results[0]).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("refuses $PASEO_HOME's data, Hosts' folder, ~/.claude and whole folders, even with a token", async () => {
    const { scanner, tokens } = await scanned();
    mkdirSync(join(places.paseoHome, "plugin-data"), { recursive: true });
    const job = await run(cleaner(tokens, scanner).instance, [
      mintFor(tokens, join(places.paseoHome, "plugin-data"), "workspace"),
      mintFor(tokens, places.stateDir, "workspace"),
      mintFor(tokens, join(places.home, ".claude"), "tool"),
      mintFor(tokens, app, "workspace"),
      mintFor(tokens, join(places.home, "code"), "workspace"),
    ]);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(places.home, ".claude", "projects", "history.jsonl"))).toBe(true);
    expect(existsSync(join(places.paseoHome, "config.json"))).toBe(true);
    expect(existsSync(join(places.stateDir, "actions.jsonl"))).toBe(true);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
  });

  it("refuses a tampered or expired token, and a name that isn't on the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const [body, sig] = item(report, "node_modules")!.token!.split(".");
    const forged = Buffer.from(Buffer.from(body!, "base64url").toString().replace("node_modules", "src")).toString("base64url");
    const expired = new DiskTokens(Buffer.alloc(32, 7), () => Date.now() - 3_600_000).mint({ path: join(app, "node_modules"), dev: 1, ino: 1, mtimeMs: 1, action: "delete", kind: "workspace", owner: "x", bytes: 1 });
    const job = await run(cleaner(tokens, scanner).instance, [`${forged}.${sig}`, expired, mintFor(tokens, join(app, "src"), "workspace")]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(job.results[2]!.message).toMatch(/isn't on the list/);
  });

  it("caches: clears an older browser, npm's cache and an old /tmp leftover; refuses the newest browser, fresh or protected /tmp, and a wrong root", async () => {
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner).instance, [cache(report, "chromium-1100")!.token!, cache(report, "build-old")!.token!, cache(report, "npm cache")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(existsSync(join(places.home, ".cache", "ms-playwright", "chromium-1200"))).toBe(true);
    const refused = await run(cleaner(tokens, scanner).instance, [
      mintFor(tokens, join(places.home, ".cache", "ms-playwright", "chromium-1200"), "versions"),
      mintFor(tokens, join(root, "tmp", "build-new"), "tmp"),
      mintFor(tokens, join(root, "tmp", "claude-501"), "tmp"),
      mintFor(tokens, join(places.home, ".cache", "pip"), "tmp"), // a tool cache passed off as /tmp: not directly inside /tmp
    ]);
    expect(refused.results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(existsSync(join(root, "tmp", "build-new", "x"))).toBe(true);
    expect(existsSync(join(root, "tmp", "claude-501", "x"))).toBe(true);
    expect(existsSync(join(places.home, ".cache", "pip", "wheel"))).toBe(true);
  });

  it("the ask-first preview changes nothing", async () => {
    const { scanner, tokens, report } = await scanned();
    const plan = await cleaner(tokens, scanner).instance.preview([item(report, "node_modules")!.token!, "garbage"]);
    expect(plan.items[0]).toMatchObject({ name: "node_modules", ok: true, owner: "App", cost: expect.stringMatching(/next install/) });
    expect(plan.items[1]).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });
});

describe("unloading (finding 7)", () => {
  it("kills a running child's whole process group and waits for it", async () => {
    const group = new ChildGroup();
    const started = Date.now();
    const pending = group.run("sh", ["-c", "sleep 30 & sleep 30; wait"], { timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    group.killAll();
    const result = await pending;
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(group.running).toBe(0);
    expect((await group.run("true", [], { timeoutMs: 1000 })).killed).toBe(true);
  });

  it("closing the cleaner kills a running prune and stops before the next item", async () => {
    const store = join(places.home, "pnpm-store", "v10");
    big(join(store, "files", "00", "pkg"), MB);
    const { scanner, tokens, report } = await scanned([idleWorkspace()], { pnpmStore: async () => store });
    let pruneKilled = false;
    const prune = async (group: ChildGroup) => { const result = await group.run("sleep", ["30"], { timeoutMs: 60_000 }); pruneKilled = result.killed; return { ok: false, message: "stopped" }; };
    const c = cleaner(tokens, scanner, { pnpmStore: async () => store, prune }).instance;
    c.start([cache(report, "pnpm store")!.token!, item(report, "node_modules")!.token!]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await c.close();
    expect(pruneKilled).toBe(true);
    expect(c.isRunning).toBe(false);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  }, 20_000);

  it("closing the scanner kills the walk and waits; no new scan starts", async () => {
    const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => [idleWorkspace()], cacheFile: null, pnpmStore: async () => null });
    scanner.start();
    await scanner.close();
    expect(scanner.isRunning).toBe(false);
    scanner.start();
    expect(scanner.isRunning).toBe(false);
  });
});

describe("the disk in the 10-second loop", () => {
  it("reads statfs only, and the verdict warns at 85% and is critical at 95%", async () => {
    const asked: string[][] = [];
    const disks = async (paths: readonly string[]) => { asked.push([...paths]); return [diskSpace("This computer's disk", { bsize: 4096, blocks: 1000, bfree: 40, bavail: 40 })]; };
    const loop = new GuardLoop({ sampler: { sample: async () => { throw new Error("n/a"); } }, tail: new DaemonLogTail("/x", { stat: async () => ({ size: 0, ino: 1 }), read: async () => Buffer.alloc(0) }), readSettings: async () => ({ autoStopRunaways: false }), diskPaths: () => ["/a", "/b"], disks });
    await loop.tick();
    expect(asked).toEqual([["/a", "/b"]]);
    const state = loop.state();
    expect(state.disks![0]).toMatchObject({ level: "critical", percent: 96 });
    const { verdict } = evaluateHealth({ now: 1, snapshot: { services: [], processes: [], scope: { status: "ready", message: "", projects: [] }, supported: true, cpu: { pressure: "normal" }, memory: { pressure: "normal" } } as never, tunnels: [], connections: [], profiles: [], background: true, guard: state });
    expect(verdict.issues.find((i) => i.code === "disk-full")).toMatchObject({ severity: "critical", message: expect.stringContaining("Agents will start failing to write files soon") });
  });

  it("statfs and stat only: one reading per disk", async () => {
    const calls: string[] = [];
    const disks = await disksFor(["/one", "/two", "/three"], {
      stat: (async (path: string) => { calls.push(`stat ${path}`); return { dev: path === "/three" ? 2 : 1 }; }) as never,
      statfs: (async (path: string) => { calls.push(`statfs ${path}`); return { bsize: 4096, blocks: 100, bfree: 50, bavail: 50 }; }) as never,
    });
    expect(disks).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("statfs"))).toEqual(["statfs /one", "statfs /three"]);
  });
});
