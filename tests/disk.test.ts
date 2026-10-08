import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCleaner, DiskTokens } from "../server/disk-clear";
import { gitVerdicts } from "../server/disk-git";
import { parseLsofNames, usedBeneath } from "../server/disk-inuse";
import { DiskScanner, busyReason, disksFor, folderAskText, itemBlocked, readWorkspace, workspaceState, type DiskPlaces, type WorkspaceInfo } from "../server/disk-scan";
import { diskWorker, runWorker } from "../server/disk-worker";
import { GuardLoop } from "../server/guard-loop";
import { DaemonLogTail } from "../server/daemon-log";
import {
  DISK_CRITICAL_PERCENT, DiskReportSchema, diskLevel, diskSentence, diskSpace, formatSize, neverDelete, olderVersions, stateWords, toolCacheName,
} from "../shared/disk";
import { evaluateHealth } from "../shared/health";
import type { ActionLogEntry } from "../shared/processes";
import type { RawProcess } from "../server/platform";
import * as fs from "node:fs";

const MB = 1024 * 1024;
const big = (path: string, bytes = MB) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
const old = (path: string, hours = 24) => { const at = new Date(Date.now() - hours * 3_600_000); utimesSync(path, at, at); };

let root = "";
let places: DiskPlaces;
let app = "";

/**
 * A home in a temp folder: one workspace (a git repo with node_modules,
 * .next, an ignored dist, a tracked "coverage" source folder and a .env),
 * an unlinked Paseo worktree, npm's cache, two Playwright versions, a tool
 * cache, ~/.claude, Paseo's own data and /tmp leftovers.
 */
function world() {
  const home = join(root, "home");
  places = { platform: process.platform === "darwin" ? "darwin" : "linux", home, paseoHome: join(home, ".paseo"), tmpDirs: [join(root, "tmp")], cacheBases: [join(home, ".cache")] };
  app = join(home, "code", "app");
  mkdirSync(app, { recursive: true });
  git(app, "init", "-q");
  writeFileSync(join(app, ".gitignore"), "node_modules\n.next\ndist/\n.env\n");
  big(join(app, "src", "index.ts"), 1000);
  big(join(app, "src", "api", "coverage", "route.ts"), 1000); // source that happens to be called "coverage"
  writeFileSync(join(app, ".env"), "SECRET=1\n");
  git(app, "add", ".gitignore", "src");
  git(app, "commit", "-qm", "init");
  big(join(app, "node_modules", "react", "index.js"), 3 * MB);
  big(join(app, ".next", "cache", "a.bin"), 2 * MB);
  big(join(app, "dist", "main.js"), MB);
  big(join(app, "build", "keep.js"), MB); // not ignored: part of the project
  mkdirSync(join(app, "packages", "ui", "node_modules"), { recursive: true });
  big(join(app, "packages", "ui", "node_modules", "x.js"), MB);
  // An unlinked worktree under $PASEO_HOME/worktrees.
  const wt = join(places.paseoHome, "worktrees", "proj1", "feature-x");
  big(join(wt, "node_modules", "y.js"), MB);
  writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
  // Paseo's own data, agents' history.
  big(join(places.paseoHome, "config.json"), 1000);
  big(join(home, ".claude", "projects", "history.jsonl"), MB);
  // Caches.
  big(join(home, ".npm", "_cacache", "content", "blob"), 2 * MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1100", "chrome"), MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1200", "chrome"), MB);
  big(join(home, ".cache", "pip", "wheel"), MB);
  big(join(home, ".cache", "unknown-app", "state"), MB);
  // /tmp: an old leftover, a fresh one, a protected one.
  big(join(root, "tmp", "build-old", "x"), MB);
  old(join(root, "tmp", "build-old", "x")); old(join(root, "tmp", "build-old"));
  big(join(root, "tmp", "build-new", "x"), MB);
  big(join(root, "tmp", "claude-501", "x"), MB);
  old(join(root, "tmp", "claude-501", "x")); old(join(root, "tmp", "claude-501"));
}

const idleWorkspace = (status = "done"): WorkspaceInfo => ({ id: "wks_1", name: "App", project: "app", directory: app, worktree: false, status, activityAt: Date.now() - 3_600_000, branch: "main", devServers: [] });

async function scanned(workspaces: WorkspaceInfo[] = [idleWorkspace()]) {
  const scanner = new DiskScanner({ places, uid: process.getuid!(), listWorkspaces: async () => workspaces, cacheFile: null, scanSeconds: 60, pnpmStore: async () => null });
  scanner.start();
  await scanner.wait();
  const tokens = new DiskTokens();
  const report = DiskReportSchema.parse(await scanner.report(workspaces, (item) => tokens.mint(item), []));
  return { scanner, tokens, report };
}

function cleaner(tokens: DiskTokens, scanner: DiskScanner, overrides: Partial<ConstructorParameters<typeof DiskCleaner>[0]> = {}) {
  const log: ActionLogEntry[] = [];
  const instance = new DiskCleaner({
    places, uid: process.getuid!(), tokens,
    listWorkspaces: async () => [idleWorkspace()],
    unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
    processes: async () => [],
    openPaths: async () => ({ paths: [], complete: true }),
    pnpmStore: async () => null,
    log: async (entry) => { log.push(entry); },
    cleared: (path, bytes) => scanner.forget(path, bytes),
    ...overrides,
  });
  return { instance, log };
}

const item = (report: Awaited<ReturnType<typeof scanned>>["report"], where: string) => report.workspaces.flatMap((w) => w.items).find((i) => i.where === where);
const run = async (c: DiskCleaner, tokens: string[]) => { c.start(tokens); await c.wait(); return c.status(); };

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
    // statfs as `df` counts it: a 494 GB disk with 24.7 GB still writable is 95% full.
    const space = diskSpace("This computer's disk", { bsize: 4096, blocks: 120699413, bfree: 6032826, bavail: 6032826 });
    expect(space).toMatchObject({ level: "critical", percent: 95 });
    expect(space.sentence).toBe("The disk is 95% full (23 GB left). Agents will start failing to write files soon.");
    expect(formatSize(1536 * MB)).toBe("1.5 GB");
  });

  it("never deletes $PASEO_HOME's data, ~/.claude, ~/.codex, home or /", () => {
    const where = { home: "/home/u", paseoHome: "/home/u/.paseo" };
    expect(neverDelete("/home/u/.paseo/config.json", where)).toMatch(/Paseo's own data/);
    expect(neverDelete("/home/u/.paseo/plugins/x/node_modules", where)).toMatch(/Paseo's own data/);
    expect(neverDelete("/home/u/.paseo/worktrees/p1", where)).toMatch(/Paseo's own data/);
    expect(neverDelete("/home/u/.paseo/worktrees/p1/feat", where)).toMatch(/Paseo's own data/);
    expect(neverDelete("/home/u/.paseo/worktrees/p1/feat/node_modules", where)).toBeNull();
    expect(neverDelete("/home/u/.claude/projects", where)).toMatch(/your data/);
    expect(neverDelete("/home/u/.codex", where)).toMatch(/your data/);
    expect(neverDelete("/home/u", where)).not.toBeNull();
    expect(neverDelete("/", where)).not.toBeNull();
    expect(neverDelete("/home/u/code/app/node_modules", where)).toBeNull();
  });

  it("keeps the newest download of each kind, and knows tool caches by name", () => {
    expect(olderVersions(["chromium-1100", "chromium-1200", "chromium_headless_shell-1200", "ffmpeg-1011", ".links", "b", "firefox-1465", "firefox-1490"])).toEqual(["chromium-1100", "firefox-1465"]);
    expect(olderVersions(["mac_arm-131.0.6778.85", "mac_arm-128.0.6613.119"])).toEqual(["mac_arm-128.0.6613.119"]);
    expect(toolCacheName("Yarn")).toBe("Yarn downloads");
    expect(toolCacheName("claude")).toBeNull();
    expect(toolCacheName("unknown-app")).toBeNull();
  });

  it("reads Paseo's workspace descriptors, and says what's busy", () => {
    const parsed = readWorkspace({ id: "w", name: "Site", title: null, workspaceDirectory: "/x/site", workspaceKind: "worktree", status: "running", activityAt: "2026-10-08T00:00:00Z", gitRuntime: { currentBranch: "feat" }, scripts: [{ scriptName: "web", lifecycle: "running", port: 3000 }, { scriptName: "api", lifecycle: "stopped", port: 4000 }], projectDisplayName: "Site" });
    expect(parsed).toMatchObject({ name: "Site", worktree: true, status: "running", branch: "feat", devServers: ["web :3000"] });
    expect(readWorkspace({ id: "w", workspaceDirectory: "/x", archivingAt: "2026-10-08T00:00:00Z" })).toBeNull();
    expect(readWorkspace({ id: "w" })).toBeNull();
    expect(workspaceState("running")).toBe("working");
    expect(workspaceState("needs_input")).toBe("waiting");
    expect(busyReason("working", [])).toMatch(/agent is working/);
    expect(busyReason("idle", ["web :3000"])).toMatch(/dev server is running/);
    expect(busyReason("idle", [])).toBeNull();
    expect(stateWords("idle", Date.now() - 3 * 86_400_000)).toBe("Idle since 3 days ago");
  });

  it("hides tracked and un-ignored folders, blocks .env and .git inside", () => {
    const where = { home: "/h", paseoHome: "/h/.paseo" };
    const base = { name: "node_modules", hasEnv: false, hasGit: false, ignoredOnly: false };
    expect(itemBlocked(base, { tracked: true, ignored: false }, "/h/a/node_modules", where)).toBe("hide");
    expect(itemBlocked({ ...base, name: "dist", ignoredOnly: true }, { tracked: false, ignored: false }, "/h/a/dist", where)).toBe("hide");
    expect(itemBlocked(base, { tracked: null, ignored: null }, "/h/a/node_modules", where)).toMatch(/Git couldn't check/);
    expect(itemBlocked({ ...base, hasEnv: true }, { tracked: false, ignored: true }, "/h/a/node_modules", where)).toMatch(/\.env/);
    expect(itemBlocked({ ...base, hasGit: true }, { tracked: false, ignored: true }, "/h/a/node_modules", where)).toMatch(/\.git/);
    expect(itemBlocked(base, { tracked: false, ignored: true }, "/h/a/node_modules", where)).toBeNull();
  });

  it("reads what's open (lsof) and checks beneath a folder, not beside it", () => {
    expect(parseLsofNames("p1\nfcwd\nn/Users/x/app\nf12\nn/Users/x/app/node_modules/a.js\nnpipe\nn/tmp/f (deleted)\n")).toEqual(["/Users/x/app", "/Users/x/app/node_modules/a.js", "/tmp/f"]);
    expect(usedBeneath("/a/node_modules", ["/a/node_modules/x"])).toBe("/a/node_modules/x");
    expect(usedBeneath("/a/node_modules", ["/a/node_modules2/x", "/a"])).toBeNull();
  });

  it("the worktree message asks before deleting and never says to rm", () => {
    const text = folderAskText({ path: "/h/.paseo/worktrees/p/feat", bytes: 2 * 1024 ** 3, branch: "feat", changedAt: Date.now() - 86_400_000 * 20 }, "/h");
    expect(text).toContain("~/.paseo/worktrees/p/feat");
    expect(text).toContain("git worktree remove");
    expect(text).toContain("Ask me before you delete anything.");
    expect(text).not.toMatch(/\brm -rf\b/);
  });
});

describe("the worker (a low-priority child process)", () => {
  it("never follows a symlink out, counts hard links once, and finds .env inside", async () => {
    big(join(root, "outside", "secret"), 4 * MB);
    symlinkSync(join(root, "outside"), join(app, "node_modules", "escape"));
    fs.linkSync(join(app, "node_modules", "react", "index.js"), join(app, "hardlink.js"));
    big(join(app, ".next", ".env.local"), 10);
    const run = await runWorker<{ totalBytes: number; items: Array<{ rel: string; bytes: number; hasEnv: boolean }> }>({ op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() + 20_000, clearable: ["node_modules", ".next"], ignoredOnly: ["dist"], ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, 30_000);
    const result = run.results[0]!;
    expect(result.totalBytes).toBeLessThan(13 * MB); // the 4 MB outside isn't counted, the 3 MB hard link only once
    expect(result.items.find((i) => i.rel === "node_modules")!.bytes).toBeLessThan(4 * MB);
    expect(result.items.find((i) => i.rel === ".next")!.hasEnv).toBe(true);
  });

  it("stops at its deadline and says the result is partial", () => {
    const results: Array<{ partial: boolean; skipped?: boolean }> = [];
    diskWorker(fs as never, { op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }, { id: "b", path: app, mode: "workspace" }], deadline: Date.now() - 1, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 10 }, (r) => results.push(r as never));
    expect(results.every((r) => r.skipped && r.partial)).toBe(true);
  });

  it("a delete removes symlinks as themselves and never removes .env files or .git folders", async () => {
    big(join(root, "outside", "secret"), 1000);
    symlinkSync(join(root, "outside"), join(app, "node_modules", "escape"));
    big(join(app, "node_modules", "pkg", ".env"), 10);
    big(join(app, "node_modules", "dep", ".git", "HEAD"), 10);
    const dev = lstatSync(join(app, "node_modules")).dev;
    const run = await runWorker<{ ok: boolean; leftovers: number }>({ op: "delete", path: join(app, "node_modules"), dev, deadline: Date.now() + 20_000 }, 30_000);
    expect(run.results[0]!.ok).toBe(false);
    expect(existsSync(join(root, "outside", "secret"))).toBe(true);
    expect(existsSync(join(app, "node_modules", "pkg", ".env"))).toBe(true);
    expect(existsSync(join(app, "node_modules", "dep", ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(app, "node_modules", "react"))).toBe(false);
  });
});

describe("git's word", () => {
  it("tracked folders are source; dist is build output only when ignored", async () => {
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, "src", "api", "coverage"), join(app, "dist"), join(app, "build")]);
    expect(verdicts.get(join(app, "node_modules"))).toMatchObject({ tracked: false });
    expect(verdicts.get(join(app, "src", "api", "coverage"))).toMatchObject({ tracked: true });
    expect(verdicts.get(join(app, "dist"))).toMatchObject({ tracked: false, ignored: true });
    expect(verdicts.get(join(app, "build"))).toMatchObject({ tracked: false, ignored: false });
    const outside = await gitVerdicts([join(root, "tmp", "build-old")]);
    expect(outside.get(join(root, "tmp", "build-old"))).toMatchObject({ repo: false, tracked: false });
  });
});

describe("the scan", () => {
  it("finds what's safe to clear per workspace, hides source, and lists caches and leftovers", async () => {
    const { report } = await scanned();
    const workspace = report.workspaces.find((w) => w.names.includes("App"))!;
    const wheres = workspace.items.map((i) => i.where).sort();
    expect(wheres).toEqual([".next", "dist", "node_modules", "packages/ui/node_modules"]);
    // src/api/coverage is tracked source and build/ isn't ignored: neither is offered at all.
    expect(wheres).not.toContain("src/api/coverage");
    expect(wheres).not.toContain("build");
    expect(workspace.items.every((i) => i.token && !i.blocked)).toBe(true);
    expect(workspace.clearableBytes).toBeGreaterThanOrEqual(7 * MB);
    expect(workspace).toMatchObject({ state: "idle", branch: "main", busy: null });
    // The worktree no workspace claims is listed, never as clearable as a whole.
    const unlinked = report.workspaces.find((w) => w.state === "unlinked")!;
    expect(unlinked.folder).toBe("~/.paseo/worktrees/proj1/feature-x");
    expect(unlinked.items.map((i) => i.where)).toEqual(["node_modules"]);
    const caches = report.caches.flatMap((g) => g.items);
    const names = caches.map((i) => i.name).sort();
    expect(names).toContain("npm cache");
    expect(names).toContain("chromium-1100");
    expect(names).not.toContain("chromium-1200");
    expect(names).toContain("pip");
    expect(names).not.toContain("unknown-app");
    expect(names).toContain("build-old");
    expect(names).not.toContain("claude-501");
    expect(caches.find((i) => i.name === "build-new")?.token ?? null).toBeNull();
    expect(caches.find((i) => i.name === "build-old")!.token).toBeTruthy();
    // Nothing under ~/.claude or Paseo's own data shows up anywhere.
    expect(JSON.stringify(report)).not.toContain(".claude");
    expect(JSON.stringify(report)).not.toContain("config.json");
  });

  it("a working agent or a running dev server makes a workspace busy: nothing in it can be cleared", async () => {
    const working = await scanned([idleWorkspace("running")]);
    const busy = working.report.workspaces.find((w) => w.names.includes("App"))!;
    expect(busy.busy).toMatch(/agent is working/);
    expect(busy.items.every((i) => i.token === null)).toBe(true);
    const serving = await scanned([{ ...idleWorkspace(), devServers: ["web :3000"] }]);
    expect(serving.report.workspaces.find((w) => w.names.includes("App"))!.busy).toMatch(/dev server/);
  });

  it("one scan at a time: asking again joins it", async () => {
    const scanner = new DiskScanner({ places, uid: process.getuid!(), listWorkspaces: async () => [idleWorkspace()], cacheFile: null, pnpmStore: async () => null });
    scanner.start();
    const first = scanner.wait();
    scanner.start();
    expect(scanner.wait()).toBe(first);
    await first;
    expect(scanner.isRunning).toBe(false);
  });
});

describe("clearing: the hard rules", () => {
  it("clears an allow-listed folder, logs it, and drops it from the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, log } = cleaner(tokens, scanner);
    const job = await run(instance, [item(report, ".next")!.token!]);
    expect(job.results).toEqual([expect.objectContaining({ name: ".next", ok: true })]);
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
    expect(log[0]).toMatchObject({ action: "disk-clear", source: "disk", status: "done", name: ".next" });
    expect(log[0]!.message).toContain("Confirmed in the Paseo app");
    expect(scanner.last()!.folders[0]!.result!.items.some((i) => i.rel === ".next")).toBe(false);
  });

  it("refuses a folder git tracks (even with a valid token)", async () => {
    const { scanner, tokens } = await scanned();
    const st = lstatSync(join(app, "node_modules"));
    git(app, "add", "-f", "node_modules/react/index.js"); git(app, "commit", "-qm", "oops");
    const token = tokens.mint({ path: join(app, "node_modules"), dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind: "workspace", owner: "App", bytes: 1 });
    const job = await run(cleaner(tokens, scanner).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/Git tracks/) });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("refuses a symlink that escapes, and never touches its target", async () => {
    const { scanner, tokens } = await scanned();
    big(join(root, "outside", "precious"), 1000);
    rmSync(join(app, ".next"), { recursive: true });
    symlinkSync(join(root, "outside"), join(app, ".next"));
    const st = lstatSync(join(app, ".next"));
    const token = tokens.mint({ path: join(app, ".next"), dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind: "workspace", owner: "App", bytes: 1 });
    const job = await run(cleaner(tokens, scanner).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/link/) });
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
  });

  it("refuses a path with a symlink on the way (realpath leaves the allowed place)", async () => {
    const { scanner, tokens } = await scanned();
    big(join(root, "elsewhere", "node_modules", "z.js"), 1000);
    symlinkSync(join(root, "elsewhere"), join(app, "linked"));
    const target = join(app, "linked", "node_modules");
    const st = lstatSync(target);
    const token = tokens.mint({ path: target, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind: "workspace", owner: "App", bytes: 1 });
    const job = await run(cleaner(tokens, scanner).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/real location/) });
    expect(existsSync(join(root, "elsewhere", "node_modules", "z.js"))).toBe(true);
  });

  it("refuses anything in use (a file open inside it, or the picture incomplete)", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const open = await run(cleaner(tokens, scanner, { openPaths: async () => ({ paths: [join(app, "node_modules", "react", "index.js")], complete: true }) }).instance, [token]);
    expect(open.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/open right now/) });
    const unknown = await run(cleaner(tokens, scanner, { openPaths: async () => ({ paths: [], complete: false }) }).instance, [token]);
    expect(unknown.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/couldn't check what's in use/) });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("refuses when the folder was swapped (another inode) or written to since the check", async () => {
    const { scanner, tokens, report } = await scanned();
    const swapToken = item(report, "node_modules")!.token!;
    renameSync(join(app, "node_modules"), join(app, "node_modules.real"));
    big(join(app, "node_modules", "decoy.js"), 10);
    const swapped = await run(cleaner(tokens, scanner).instance, [swapToken]);
    expect(swapped.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/isn't the same folder/) });
    expect(existsSync(join(app, "node_modules", "decoy.js"))).toBe(true);
    const nextToken = item(report, ".next")!.token!;
    writeFileSync(join(app, ".next", "new-file"), "x");
    const later = new Date(Date.now() + 5000); utimesSync(join(app, ".next"), later, later);
    const written = await run(cleaner(tokens, scanner).instance, [nextToken]);
    expect(written.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/changed since it was checked/) });
  });

  it("refuses while an agent works, waits, or a build runs in the workspace", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const working = await run(cleaner(tokens, scanner, { listWorkspaces: async () => [idleWorkspace("running")] }).instance, [token]);
    expect(working.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/agent is working/) });
    const waiting = await run(cleaner(tokens, scanner, { listWorkspaces: async () => [idleWorkspace("attention")] }).instance, [token]);
    expect(waiting.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/waiting for you/) });
    const proc = (argv: string[]): RawProcess => ({ pid: 9, ppid: 1, uid: 1, comm: argv[0]!, argv, state: "running", cpuSeconds: 0, startId: "s", rssBytes: 0, ageSeconds: 0, cwd: app });
    const installing = await run(cleaner(tokens, scanner, { processes: async () => [proc(["npm", "install"])] }).instance, [token]);
    expect(installing.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/Something is running/) });
    const agent = await run(cleaner(tokens, scanner, { processes: async () => [proc(["claude"])] }).instance, [token]);
    expect(agent.results[0]).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("refuses $PASEO_HOME's data, ~/.claude and a whole workspace folder, even with a forged-looking token", async () => {
    const { scanner, tokens } = await scanned();
    const mint = (path: string, kind: "workspace" | "tool" | "tmp" = "workspace") => { const st = lstatSync(path); return tokens.mint({ path, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind, owner: "x", bytes: 1 }); };
    mkdirSync(join(places.paseoHome, "plugin-data"), { recursive: true });
    const job = await run(cleaner(tokens, scanner).instance, [
      mint(join(places.paseoHome, "plugin-data")),
      mint(join(places.home, ".claude")),
      mint(join(places.home, ".claude"), "tool"),
      mint(app),
      mint(join(places.paseoHome, "worktrees", "proj1", "feature-x")),
    ]);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(job.results.map((r) => r.message).join(" ")).toMatch(/Paseo's own data/);
    expect(job.results.map((r) => r.message).join(" ")).toMatch(/your data/);
    expect(existsSync(join(places.home, ".claude", "projects", "history.jsonl"))).toBe(true);
    expect(existsSync(join(places.paseoHome, "config.json"))).toBe(true);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(places.paseoHome, "worktrees", "proj1", "feature-x", ".git"))).toBe(true);
  });

  it("refuses a tampered or expired token, and a name that isn't on the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const [body, sig] = token.split(".");
    const forged = Buffer.from(Buffer.from(body!, "base64url").toString().replace("node_modules", "src")).toString("base64url");
    const expired = new DiskTokens(Buffer.alloc(32, 7), () => Date.now() - 3_600_000).mint({ path: join(app, "node_modules"), dev: 1, ino: 1, mtimeMs: 1, action: "delete", kind: "workspace", owner: "x", bytes: 1 });
    const st = lstatSync(join(app, "src"));
    const src = tokens.mint({ path: join(app, "src"), dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind: "workspace", owner: "App", bytes: 1 });
    const job = await run(cleaner(tokens, scanner).instance, [`${forged}.${sig}`, expired, src]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(job.results[2]!.message).toMatch(/isn't on the list/);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
  });

  it("keeps a .env that appeared deep inside after the check (the delete's last line of defence)", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    // One level down, so the folder's own modification time doesn't change and every check still passes.
    writeFileSync(join(app, "node_modules", "react", ".env"), "K=1");
    const job = await run(cleaner(tokens, scanner).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/left \(kept on purpose or in use\)/) });
    const aside = fs.readdirSync(app).find((name) => name.startsWith(".hosts-clearing-node_modules-"));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(app, aside!, "react", ".env"), "utf8")).toBe("K=1");
    expect(existsSync(join(app, aside!, "react", "index.js"))).toBe(false);
  });

  it("caches: clears an older browser and an old /tmp leftover; refuses the newest browser and fresh /tmp", async () => {
    const { scanner, tokens, report } = await scanned();
    const caches = report.caches.flatMap((g) => g.items);
    const job = await run(cleaner(tokens, scanner).instance, [caches.find((i) => i.name === "chromium-1100")!.token!, caches.find((i) => i.name === "build-old")!.token!, caches.find((i) => i.name === "npm cache")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(existsSync(join(places.home, ".cache", "ms-playwright", "chromium-1200"))).toBe(true);
    const mint = (path: string, kind: "versions" | "tmp") => { const st = lstatSync(path); return tokens.mint({ path, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action: "delete", kind, owner: "x", bytes: 1 }); };
    const refused = await run(cleaner(tokens, scanner).instance, [mint(join(places.home, ".cache", "ms-playwright", "chromium-1200"), "versions"), mint(join(root, "tmp", "build-new"), "tmp"), mint(join(root, "tmp", "claude-501"), "tmp")]);
    expect(refused.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(existsSync(join(root, "tmp", "build-new", "x"))).toBe(true);
    expect(existsSync(join(root, "tmp", "claude-501", "x"))).toBe(true);
  });

  it("the ask-first preview says what goes, its size and its cost, without changing anything", async () => {
    const { scanner, tokens, report } = await scanned();
    const plan = await cleaner(tokens, scanner).instance.preview([item(report, "node_modules")!.token!, "garbage"]);
    expect(plan.items[0]).toMatchObject({ name: "node_modules", ok: true, owner: "App", cost: expect.stringMatching(/next install/) });
    expect(plan.items[0]!.bytes).toBeGreaterThan(2 * MB);
    expect(plan.items[1]).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules"))).toBe(true);
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
    expect(verdict.disk).toMatchObject({ level: "critical" });
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
