import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { ChildGroup } from "../server/disk-children";
import { CACHE_COMMANDS, DiskCleaner, DiskTokens, type ItemKind } from "../server/disk-clear";
import { gitAllows, gitVerdicts, groupGit, type GitRun } from "../server/disk-git";
import { hostSnapshot, parseLsof, parsePs, statusUids, usedBeneath, type HostSnapshot, type SnapshotDeps } from "../server/disk-inuse";
import { QuarantineInventory } from "../server/disk-quarantine";
import { probeInside, quarantineAndRemove, rmArgs } from "../server/disk-remove";
import { DiskScanner, busyReason, canonicalChain, disksFor, folderAskText, itemBlocked, readWorkspace, workspaceState, type DiskPlaces, type WorkspaceInfo } from "../server/disk-scan";
import { diskWorker, runWorker } from "../server/disk-worker";
import { GuardLoop } from "../server/guard-loop";
import { DaemonLogTail } from "../server/daemon-log";
import { isPackageDownload } from "../server/jobs";
import {
  DISK_CRITICAL_PERCENT, DiskReportSchema, diskLevel, diskSentence, diskSpace, formatSize, protectedReason, protectedSet, stateWords, toolCacheName,
} from "../shared/disk";
import { evaluateHealth } from "../shared/health";
import type { ActionLogEntry } from "../shared/processes";

const MB = 1024 * 1024;
const big = (path: string, bytes = MB) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
const age = (path: string, hours = 24) => { const at = new Date(Date.now() - hours * 3_600_000); utimesSync(path, at, at); };
const UID = process.getuid!();
const bare = (path: string) => { mkdirSync(join(path, "objects"), { recursive: true }); mkdirSync(join(path, "refs", "heads"), { recursive: true }); writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n"); };

let root = "";
let places: DiskPlaces;
let app = "";
let worktree = "";

/**
 * A home in a temp folder: one workspace (a git repo with ignored
 * node_modules, .next and dist, a tracked "coverage" source folder and a .env),
 * a real git worktree no workspace claims, npm's cache, a pnpm store,
 * Playwright and agent-browser downloads, a tool cache, ~/.claude, ~/.codex,
 * Paseo's own data and /tmp folders.
 */
function world() {
  const home = join(root, "home");
  const paseoHome = join(home, ".paseo");
  places = {
    platform: process.platform === "darwin" ? "darwin" : "linux", home, paseoHome, stateDir: join(paseoHome, "daemon-link"),
    tmpDirs: [join(root, "tmp")], cacheBases: [join(home, ".cache")], browserRoots: [join(home, ".cache", "ms-playwright"), join(home, ".agent-browser", "browsers")],
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
  big(join(app, "build", "keep.js"), MB);
  big(join(app, "packages", "ui", "node_modules", "x.js"), MB);
  worktree = join(paseoHome, "worktrees", "proj1", "feature-x");
  mkdirSync(join(paseoHome, "worktrees", "proj1"), { recursive: true });
  git(app, "worktree", "add", "-q", "-b", "feature-x", worktree);
  big(join(worktree, "node_modules", "y.js"), MB);
  big(join(paseoHome, "config.json"), 1000);
  big(join(places.stateDir, "actions.jsonl"), 100);
  big(join(home, ".claude", "projects", "history.jsonl"), MB);
  big(join(home, ".codex", "sessions", "s.jsonl"), MB);
  big(join(home, ".npm", "_cacache", "content", "blob"), 2 * MB);
  big(join(home, ".npm", "_npx", "abc", "pkg"), MB);
  big(join(home, "pnpm-store", "v10", "files", "pkg"), MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1100", "chrome"), MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1200", "chrome"), MB);
  big(join(home, ".agent-browser", "browsers", "chrome-154.0.8037.57", "chrome"), MB);
  big(join(home, ".cache", "pip", "wheel"), MB);
  big(join(home, ".cache", "unknown-app", "state"), MB);
  big(join(root, "tmp", "build-old", "x"), MB);
  age(join(root, "tmp", "build-old", "x")); age(join(root, "tmp", "build-old"));
}

const idleWorkspace = (status = "done"): WorkspaceInfo => ({ id: "wks_1", name: "App", project: "app", directory: app, worktree: false, status, activityAt: Date.now() - 3_600_000, branch: "main", devServers: [] });
const calm = (processes: HostSnapshot["processes"] = [], open: string[] = []): HostSnapshot => ({ processes, open, complete: true, why: null });
const pid = (argv: string[], cwd: string | null = app, id = 9) => ({ pid: id, argv, cwd });

async function scanned(workspaces: WorkspaceInfo[] = [idleWorkspace()], extra: Partial<ConstructorParameters<typeof DiskScanner>[0]> = {}) {
  const scanner = new DiskScanner({
    places, uid: UID, listWorkspaces: async () => workspaces, cacheFile: null, scanSeconds: 60,
    pnpmStore: async () => join(places.home, "pnpm-store", "v10"), toolReady: async () => true, ...extra,
  });
  scanner.start();
  await scanner.wait();
  const tokens = new DiskTokens();
  const report = DiskReportSchema.parse(await scanner.report(workspaces, (item) => tokens.mint(item), []));
  return { scanner, tokens, report };
}

function cleaner(tokens: DiskTokens, scanner: DiskScanner, overrides: Partial<ConstructorParameters<typeof DiskCleaner>[0]> = {}) {
  const log: ActionLogEntry[] = [];
  const commands: string[] = [];
  const instance = new DiskCleaner({
    places, uid: UID, tokens,
    listWorkspaces: async () => [idleWorkspace()],
    unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
    snapshot: async () => calm(),
    inventory: new QuarantineInventory(join(places.stateDir, "quarantine.json")),
    toolReady: async () => true,
    command: async (kind) => { commands.push(kind); return { ok: true, message: `${kind} cleaned` }; },
    log: async (entry) => { log.push(entry); },
    cleared: (path, bytes) => scanner.forget(path, bytes),
    ...overrides,
  });
  return { instance, log, commands };
}

type Report = Awaited<ReturnType<typeof scanned>>["report"];
const item = (report: Report, where: string) => report.workspaces.flatMap((w) => w.items).find((i) => i.where === where);
const cache = (report: Report, name: string) => report.caches.flatMap((g) => g.items).find((i) => i.name === name);
const run = async (c: DiskCleaner, tokens: string[]) => { c.start(tokens); await c.wait(); return c.status(); };
const mintFor = (tokens: DiskTokens, path: string, kind: string = "workspace", action: "delete" | "command" = "delete") => {
  const st = lstatSync(path);
  return tokens.mint({ path, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, action, kind: kind as ItemKind, owner: "x", bytes: 1 });
};
const hasQuarantine = (dir: string) => fs.readdirSync(dir).some((name) => name.startsWith(".hosts-quarantine-"));

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "hosts-disk-"))); world(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the rules, pure", () => {
  it("disk levels and words: 85% warns, 95% is critical", () => {
    expect(diskLevel(84.9)).toBe("ok");
    expect(diskLevel(85)).toBe("warning");
    expect(diskLevel(DISK_CRITICAL_PERCENT)).toBe("critical");
    expect(diskSentence(96, 8 * 1024 ** 3)).toBe("The disk is 96% full (8 GB left). Agents will start failing to write files soon.");
    expect(diskSentence(40, 1)).toBeNull();
    // A fleet daemon on 2026-10-08: 581 GB with 17 GB writable.
    expect(diskSpace("x", { bsize: 4096, blocks: 152305664, bfree: 4456448, bavail: 4456448 }).level).toBe("critical");
    expect(formatSize(1536 * MB)).toBe("1.5 GB");
  });

  it("protects home, workspaces and / as targets and parents; agents' history, Paseo's data and Hosts' folder also from the inside", () => {
    const set = protectedSet({ home: "/home/u", paseoHome: "/home/u/.paseo", stateDir: "/home/u/.paseo/daemon-link" }, ["/home/u/code/app"], ["/home/u/.paseo/worktrees/p1/feat"]);
    expect(protectedReason("/home/u/.paseo/config.json", set)).toMatch(/Paseo's own data/);
    expect(protectedReason("/home/u/.paseo/worktrees/p1/feat/node_modules", set)).toBeNull();
    expect(protectedReason("/home/u/.paseo/worktrees/p1", set)).toMatch(/contains/);
    expect(protectedReason("/home/u/.claude/projects", set)).toMatch(/your data/);
    expect(protectedReason("/home/u/.codex/cache/chromium-1", set)).toMatch(/your data/);
    expect(protectedReason("/home/u", set)).toMatch(/whole folder/);
    expect(protectedReason("/home", set)).toMatch(/contains/);
    expect(protectedReason("/home/u/code", set)).toMatch(/contains/);
    expect(protectedReason("/home/u/code/app/node_modules", set)).toBeNull();
    const session = protectedSet({ home: "/home/u", paseoHome: "/tmp/session/state", stateDir: "/tmp/session/state/daemon-link" }, [], []);
    expect(protectedReason("/tmp/session", session)).toMatch(/contains/);
  });

  it("knows tool caches by name, and an install or download when one runs", () => {
    expect(toolCacheName("Yarn")).toBe("Yarn downloads");
    expect(toolCacheName("claude")).toBeNull();
    expect(isPackageDownload(["npm", "install"])).toBe(true);
    expect(isPackageDownload(["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "ci"])).toBe(true);
    expect(isPackageDownload(["pnpm", "add", "react"])).toBe(true);
    expect(isPackageDownload(["npx", "tsc"])).toBe(true);
    expect(isPackageDownload(["agent-browser", "install"])).toBe(true);
    expect(isPackageDownload(["npm", "run", "dev"])).toBe(false);
  });

  it("the cache commands are exactly the tools' own, as argv", () => {
    expect(CACHE_COMMANDS.npm).toMatchObject({ file: "npm", args: ["cache", "clean", "--force"] });
    expect(CACHE_COMMANDS.pnpm).toMatchObject({ file: "pnpm", args: ["store", "prune"] });
    expect(CACHE_COMMANDS.playwright).toMatchObject({ file: "npx", args: ["--no-install", "playwright", "uninstall"] });
    expect(rmArgs("gnu", "/a/q")).toEqual(["-rf", "--one-file-system", "--", "/a/q"]);
    expect(rmArgs("bsd", "/a/q")).toEqual(["-rf", "-x", "--", "/a/q"]);
  });

  it("reads Paseo's workspace descriptors, and says what's busy", () => {
    const parsed = readWorkspace({ id: "w", name: "Site", workspaceDirectory: "/x/site", workspaceKind: "worktree", status: "running", gitRuntime: { currentBranch: "feat" }, scripts: [{ scriptName: "web", lifecycle: "running", port: 3000 }] });
    expect(parsed).toMatchObject({ worktree: true, status: "running", branch: "feat", devServers: ["web :3000"] });
    expect(workspaceState("needs_input")).toBe("waiting");
    expect(busyReason("working", [])).toMatch(/agent is working/);
    expect(busyReason("idle", ["web :3000"])).toMatch(/dev server/);
    expect(stateWords("idle", Date.now() - 3 * 86_400_000)).toBe("Idle since 3 days ago");
  });

  it("clearable only on git's three answers; a cut-off check, .env, .git or bare repository say no", () => {
    const set = protectedSet({ home: "/h", paseoHome: "/h/.paseo", stateDir: "/h/.paseo/daemon-link" }, ["/h/a"], []);
    const base = { name: "node_modules", hasEnv: false, hasGit: false, ignoredOnly: false, partial: false };
    const yes = { ignored: true, tracked: false, untracked: false };
    expect(itemBlocked(base, yes, "/h/a/node_modules", set)).toBeNull();
    expect(itemBlocked(base, { ...yes, untracked: true }, "/h/a/node_modules", set)).toBe("hide");
    expect(itemBlocked(base, null, "/h/a/node_modules", set)).toMatch(/Git couldn't confirm/);
    expect(itemBlocked({ ...base, name: "dist", ignoredOnly: true }, null, "/h/a/dist", set)).toBe("hide");
    expect(itemBlocked({ ...base, partial: true }, yes, "/h/a/node_modules", set)).toMatch(/time ran out/);
    expect(itemBlocked({ ...base, hasGit: true }, yes, "/h/a/node_modules", set)).toMatch(/git repository/);
  });

  it("the ask-an-agent texts never say to rm and always ask first", () => {
    for (const kind of ["worktree", "tmp", "leftover"] as const) {
      const text = folderAskText({ path: "/h/x", bytes: MB, branch: null, changedAt: Date.now(), kind, original: "/h/code/app/node_modules" }, "/h");
      expect(text).toContain("Ask me before you delete anything.");
      expect(text).not.toMatch(/\brm -rf\b/);
    }
  });
});

describe("one complete snapshot, or nothing (P1-3)", () => {
  const linux = (entries: Record<string, { uid?: number; status?: "unreadable" | "missing"; cmdline?: string; cwd?: string; cwdUnreadable?: boolean; fds?: Record<string, string>; badFd?: string }>): SnapshotDeps => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    return {
      readdir: async (path) => (path === "/proc" ? Object.keys(entries) : Object.keys(entries[path.split("/")[2]!]!.fds ?? {})),
      readFile: async (path) => {
        const [, , id, file] = path.split("/");
        const entry = entries[id!]!;
        if (file === "status") { if (entry.status === "unreadable") throw err("EACCES"); if (entry.status === "missing") throw err("ENOENT"); return `Uid:\t${entry.uid}\t${entry.uid}\t${entry.uid}\t${entry.uid}\n`; }
        return entry.cmdline ?? "node\0x.js\0";
      },
      readlink: async (path) => {
        const [, , id, kind, fd] = path.split("/");
        const entry = entries[id!]!;
        if (kind === "cwd") { if (entry.cwdUnreadable) throw err("EACCES"); return entry.cwd ?? "/"; }
        if (fd === entry.badFd) throw err("EACCES");
        return entry.fds![fd!]!;
      },
      run: async () => ({ code: 0, stdout: "" }),
    };
  };

  it("Linux: another user's unreadable process is skipped; this user's must be fully readable", async () => {
    const ok = await hostSnapshot("linux", 1000, linux({ "1": { uid: 0, cwdUnreadable: true }, "50": { uid: 1000, cmdline: "npm\0install\0", cwd: "/home/u/app", fds: { "3": "/home/u/app/node_modules/x" } }, "60": { status: "missing" } }));
    expect(ok).toMatchObject({ complete: true, processes: [{ pid: 50, argv: ["npm", "install"], cwd: "/home/u/app" }] });
    expect(ok.open).toContain("/home/u/app/node_modules/x");
    for (const broken of [{ uid: 1000, cwdUnreadable: true }, { uid: 1000, cwd: "/x", fds: { "4": "/y" }, badFd: "4" }, { status: "unreadable" as const }]) {
      expect(await hostSnapshot("linux", 1000, linux({ "50": broken }))).toMatchObject({ complete: false, why: expect.any(String) });
    }
  });

  it("Linux: no cap: 5000 open files are all read", async () => {
    const fds: Record<string, string> = {};
    for (let fd = 0; fd < 5000; fd += 1) fds[String(fd)] = `/tmp/f${fd}`;
    fds["4999"] = "/home/u/app/node_modules/late.js";
    const snap = await hostSnapshot("linux", 1000, linux({ "50": { uid: 1000, cwd: "/x", fds } }));
    expect(usedBeneath("/home/u/app/node_modules", snap.open)).toBe("/home/u/app/node_modules/late.js");
    expect(statusUids("Uid:\t0\t1000\t0\t0\n")).toEqual([0, 1000]);
  });

  it("macOS: a failed ps or lsof (even with partial output) is incomplete; otherwise every process gets its cwd", async () => {
    const run = (ps: { code: number | null; stdout: string }, lsof: { code: number | null; stdout: string }) => ({ readdir: async () => [], readFile: async () => "", readlink: async () => "", run: async (file: string) => (file === "ps" ? ps : lsof) });
    expect(await hostSnapshot("darwin", 501, run({ code: 1, stdout: "  9 501 node x.js\n" }, { code: 0, stdout: "" }))).toMatchObject({ complete: false, why: expect.stringMatching(/ps/) });
    expect(await hostSnapshot("darwin", 501, run({ code: 0, stdout: "  9 501 node x.js\n" }, { code: 1, stdout: "p9\nfcwd\nn/Users/x/app\n" }))).toMatchObject({ complete: false, why: expect.stringMatching(/lsof/) });
    const ok = await hostSnapshot("darwin", 501, run({ code: 0, stdout: "  9 501 npm run build\n 10 0 /sbin/launchd\n" }, { code: 0, stdout: "p9\nfcwd\nn/Users/x/app\nf12\nn/Users/x/app/dist/a.js\n" }));
    expect(ok).toEqual({ complete: true, why: null, processes: [{ pid: 9, argv: ["npm", "run", "build"], cwd: "/Users/x/app" }], open: ["/Users/x/app", "/Users/x/app/dist/a.js"] });
    expect(parsePs("  9 501 a b\n 10 0 c\n", 501)).toEqual([{ pid: 9, argv: ["a", "b"] }]);
    expect(parseLsof("p9\nfcwd\nn/a\n").cwd.get(9)).toBe("/a");
  });

  it("regression: an incomplete snapshot clears nothing and runs no cache command, and says why", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, commands } = cleaner(tokens, scanner, { snapshot: async () => ({ processes: [], open: [], complete: false, why: "The process list (ps) couldn't be read completely." }) });
    const job = await run(instance, [item(report, "node_modules")!.token!, cache(report, "npm cache")!.token!]);
    expect(job.results.every((r) => !r.ok && /complete picture of what's running \(The process list \(ps\)/.test(r.message))).toBe(true);
    expect(commands).toEqual([]);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });
});

describe("the physical walk", () => {
  it("never follows a symlink out, counts hard links once, and finds .env inside", async () => {
    big(join(root, "outside", "secret"), 4 * MB);
    symlinkSync(join(root, "outside"), join(app, "node_modules", "escape"));
    fs.linkSync(join(app, "node_modules", "react", "index.js"), join(app, "hardlink.js"));
    big(join(app, ".next", ".env.local"), 10);
    const result = (await runWorker<{ totalBytes: number; items: Array<{ rel: string; bytes: number; hasEnv: boolean }> }>({ op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() + 20_000, clearable: ["node_modules", ".next"], ignoredOnly: ["dist"], ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, 30_000)).results[0]!;
    expect(result.totalBytes).toBeLessThan(14 * MB);
    expect(result.items.find((i) => i.rel === "node_modules")!.bytes).toBeLessThan(4 * MB);
    expect(result.items.find((i) => i.rel === ".next")!.hasEnv).toBe(true);
  });

  it("regression (P1-1): finds a bare repository (HEAD + objects/ + refs/, no .git) inside an item or as the root", async () => {
    bare(join(app, "node_modules", "dep.git"));
    const scan = (await runWorker<{ items: Array<{ rel: string; hasGit: boolean }> }>({ op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() + 20_000, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, 30_000)).results[0]!;
    expect(scan.items.find((i) => i.rel === "node_modules")!.hasGit).toBe(true);
    bare(join(root, "backup.git"));
    expect(await probeInside(join(root, "backup.git"), new ChildGroup())).toMatchObject({ ok: false, why: expect.stringMatching(/git repository/) });
  });

  it("stops at its deadline and says the result is partial", () => {
    const results: Array<{ partial: boolean; skipped?: boolean }> = [];
    diskWorker(fs as never, { op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() - 1, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 10 }, (r) => results.push(r as never));
    expect(results.every((r) => r.skipped && r.partial)).toBe(true);
  });
});

describe("deleting: quarantine, physical probe, system rm", () => {
  const remove = (path: string, extra: Partial<Parameters<typeof quarantineAndRemove>[2]> = {}) => {
    const st = lstatSync(path);
    return quarantineAndRemove(path, { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup(), ...extra });
  };

  it("a folder swapped for a symlink just before rm is unlinked as a link; its target survives", async () => {
    big(join(root, "outside", "precious"), 1000);
    mkdirSync(join(app, "node_modules", "sub", "deep"), { recursive: true });
    const result = await remove(join(app, "node_modules"), { beforeRemove: (q) => { rmSync(join(q, "sub"), { recursive: true }); symlinkSync(join(root, "outside"), join(q, "sub")); } });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("regression (P1-1): a bare repository inside is put back untouched", async () => {
    bare(join(app, "node_modules", "dep.git"));
    const result = await remove(join(app, "node_modules"));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/git repository/) });
    expect(existsSync(join(app, "node_modules", "dep.git", "HEAD"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("puts back a .env inside, a different inode, and refuses without GNU rm", async () => {
    big(join(app, "node_modules", "react", ".env"), 10);
    expect(await remove(join(app, "node_modules"))).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules", "react", ".env"))).toBe(true);
    const st = lstatSync(join(app, ".next"));
    expect(await quarantineAndRemove(join(app, ".next"), { dev: st.dev, ino: st.ino + 1, bytes: 1 }, { group: new ChildGroup() })).toMatchObject({ ok: false });
    expect(await remove(join(app, ".next"), { flavour: async () => null })).toMatchObject({ ok: false, error: expect.stringMatching(/stay on one disk/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("records each quarantine and forgets it once it's done", async () => {
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    const seen: number[] = [];
    await remove(join(app, ".next"), { inventory, beforeRemove: async () => { seen.push((await inventory.list()).length); } });
    expect(seen).toEqual([1]);
    expect(await inventory.list()).toEqual([]);
  });
});

describe("crash recovery (P2)", () => {
  /** A clear that stopped right after the move: the inventory has it, the item sits in its quarantine. */
  async function interrupted(inventory: QuarantineInventory, original: string) {
    const quarantine = fs.mkdtempSync(join(join(original, ".."), ".hosts-quarantine-"));
    const st = lstatSync(original);
    await inventory.add({ quarantine, original, name: "node_modules", dev: st.dev, ino: st.ino, bytes: 3 * MB, at: Date.now() });
    renameSync(original, join(quarantine, "node_modules"));
    return quarantine;
  }

  it("puts an interrupted clear back where its place is still free", async () => {
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    await interrupted(inventory, join(app, "node_modules"));
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    const outcome = await inventory.recover();
    expect(outcome.restored).toHaveLength(1);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
    expect(await inventory.list()).toEqual([]);
  });

  it("leaves it listed, untouched, when something now sits in its place, and the report shows it with Ask an agent", async () => {
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    const quarantine = await interrupted(inventory, join(app, "node_modules"));
    big(join(app, "node_modules", "fresh-install.js"), 10);
    const outcome = await inventory.recover();
    expect(outcome.left).toHaveLength(1);
    expect(existsSync(join(quarantine, "node_modules", "react", "index.js"))).toBe(true);
    const { report } = await scanned([idleWorkspace()], { inventory });
    expect(report.leftovers).toEqual([expect.objectContaining({ id: `leftover:${quarantine}`, name: "node_modules", where: "~/code/app/node_modules" })]);
  });
});

describe("git (P2: one deadline, killable)", () => {
  it("ignored, nothing tracked, nothing untracked: only then", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100);
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, "src", "api", "coverage"), join(app, "src", "coverage"), join(app, "dist"), join(app, "build")]);
    expect(gitAllows(verdicts.get(join(app, "node_modules")))).toBe(true);
    expect(gitAllows(verdicts.get(join(app, "dist")))).toBe(true);
    expect(verdicts.get(join(app, "src", "api", "coverage"))).toMatchObject({ tracked: true });
    expect(verdicts.get(join(app, "src", "coverage"))).toMatchObject({ ignored: false, untracked: true });
    expect(gitAllows((await gitVerdicts([join(root, "tmp", "build-old")])).get(join(root, "tmp", "build-old")))).toBe(false);
  });

  it("nothing runs past the deadline", async () => {
    let calls = 0;
    const slow: GitRun = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { code: 0, stdout: `${app}\n`, stderr: "" }; };
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, ".next")], slow, Date.now() + 10);
    expect([...verdicts.values()].every((verdict) => !gitAllows(verdict))).toBe(true);
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("regression: git runs in the process group, so unloading kills it and nothing is confirmed", async () => {
    const group = new ChildGroup();
    group.killAll();
    const verdicts = await gitVerdicts([join(app, "node_modules")], groupGit(group));
    expect(gitAllows(verdicts.get(join(app, "node_modules")))).toBe(false);
  });

  it("regression: a registry that never answers can't stretch the scan past its deadline", async () => {
    const started = Date.now();
    const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: () => new Promise(() => undefined), cacheFile: null, scanSeconds: 2, pnpmStore: async () => null, toolReady: async () => false });
    scanner.start();
    await scanner.wait();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(scanner.last()!.warnings.join(" ")).toMatch(/workspaces couldn't be read in time/);
  }, 15_000);
});

describe("the scan", () => {
  it("offers only what git ignores in workspaces; caches only through their tools; everything else by size", async () => {
    const { report } = await scanned();
    const workspace = report.workspaces.find((w) => w.names.includes("App"))!;
    expect(workspace.items.map((i) => i.where).sort()).toEqual([".next", "dist", "node_modules", "packages/ui/node_modules"]);
    expect(workspace.items.every((i) => i.token && i.action === "delete")).toBe(true);
    expect(report.workspaces.find((w) => w.state === "unlinked")!.items.map((i) => [i.where, !!i.token])).toEqual([["node_modules", true]]);
    expect(cache(report, "npm cache")).toMatchObject({ action: "command", button: "Clean with npm…" });
    expect(cache(report, "npm cache")!.token).toBeTruthy();
    expect(cache(report, "pnpm store")).toMatchObject({ action: "command", button: "Prune with pnpm…" });
    expect(cache(report, "Playwright browsers")).toMatchObject({ action: "command", button: "Remove unused browsers…" });
    for (const name of ["npx downloads", "agent-browser browsers", "pip", "build-old"]) {
      const row = cache(report, name)!;
      expect(row.token, name).toBeNull();
      expect(row.blocked, name).toMatch(/Shown for its size/);
    }
    expect(cache(report, "build-old")!.askId).toBe(`tmp:${join(root, "tmp", "build-old")}`);
    expect(cache(report, "unknown-app")).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(".claude");
  });

  it("no command is offered for a tool that isn't there", async () => {
    const { report } = await scanned([idleWorkspace()], { toolReady: async () => false });
    expect(cache(report, "npm cache")!.token).toBeNull();
    expect(cache(report, "Playwright browsers")!.token).toBeNull();
  });

  it("regression (P1-2): a cache folder reached through a symlinked ancestor isn't listed", async () => {
    rmSync(join(places.home, ".cache"), { recursive: true });
    big(join(places.home, ".codex", "cache", "ms-playwright", "chromium-1", "precious"), 1000);
    symlinkSync(join(places.home, ".codex", "cache"), join(places.home, ".cache"));
    const { report } = await scanned();
    expect(JSON.stringify(report)).not.toContain("chromium-1");
    expect(cache(report, "Playwright browsers")).toBeUndefined();
    expect(await canonicalChain(join(places.home, ".cache", "ms-playwright"))).toBe(false);
  });

  it("untracked work, no repository, or git without an answer: nothing is offered", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100);
    expect(item((await scanned()).report, "src/coverage")).toBeUndefined();
    const silent = await scanned([idleWorkspace()], { git: async () => ({ code: null, stdout: "", stderr: "timeout" }) });
    expect(silent.report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
    rmSync(join(app, ".git"), { recursive: true });
    expect((await scanned()).report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
  });

  it("a working agent or a running dev server makes a workspace busy", async () => {
    expect((await scanned([idleWorkspace("running")])).report.workspaces.find((w) => w.names.includes("App"))!.items.every((i) => i.token === null)).toBe(true);
    expect((await scanned([{ ...idleWorkspace(), devServers: ["web :3000"] }])).report.workspaces.find((w) => w.names.includes("App"))!.busy).toMatch(/dev server/);
  });
});

describe("clearing", () => {
  it("clears an ignored workspace folder, logs it, drops it from the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, log } = cleaner(tokens, scanner);
    const job = await run(instance, [item(report, ".next")!.token!]);
    expect(job.results).toEqual([expect.objectContaining({ name: ".next", ok: true })]);
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
    expect(log[0]).toMatchObject({ action: "disk-clear", source: "disk", status: "done" });
  });

  it("runs only the tool's own command for a cache, and logs which", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, commands, log } = cleaner(tokens, scanner);
    const job = await run(instance, [cache(report, "npm cache")!.token!, cache(report, "pnpm store")!.token!, cache(report, "Playwright browsers")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(commands).toEqual(["npm", "pnpm", "playwright"]);
    expect(log.map((entry) => entry.message).join(" ")).toContain("npm cache clean --force");
    // The folders themselves are untouched: the tool decides.
    expect(existsSync(join(places.home, ".npm", "_cacache", "content", "blob"))).toBe(true);
  });

  it("cache commands wait while an install or download runs", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, commands } = cleaner(tokens, scanner, { snapshot: async () => calm([pid(["pnpm", "add", "left-pad"], "/elsewhere")]) });
    const job = await run(instance, [cache(report, "npm cache")!.token!, cache(report, "pnpm store")!.token!]);
    expect(job.results.every((r) => !r.ok && /install or browser download/.test(r.message))).toBe(true);
    expect(commands).toEqual([]);
  });

  it("regression (P1-4): nothing in /tmp, browser downloads or tool caches is deletable, even with a forged token", async () => {
    const { scanner, tokens } = await scanned();
    const forged = [
      mintFor(tokens, join(root, "tmp", "build-old"), "tmp"),
      mintFor(tokens, join(places.home, ".cache", "ms-playwright", "chromium-1100"), "versions"),
      mintFor(tokens, join(places.home, ".cache", "pip"), "tool"),
      mintFor(tokens, join(places.home, ".cache", "pip"), "npm", "delete"),
    ];
    const job = await run(cleaner(tokens, scanner).instance, forged);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(root, "tmp", "build-old", "x"))).toBe(true);
    expect(existsSync(join(places.home, ".cache", "ms-playwright", "chromium-1100", "chrome"))).toBe(true);
    expect(existsSync(join(places.home, ".cache", "pip", "wheel"))).toBe(true);
  });

  it("regression (P1-2): a workspace folder reached through a symlinked ancestor is refused", async () => {
    const { scanner, tokens } = await scanned();
    // ~/code/linked → ~/.codex/sessions-dir; a token for a node_modules "inside" it.
    big(join(places.home, ".codex", "work", "node_modules", "precious.js"), 10);
    symlinkSync(join(places.home, ".codex", "work"), join(app, "linked"));
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, "linked", "node_modules"))]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/link somewhere on the way/) });
    expect(existsSync(join(places.home, ".codex", "work", "node_modules", "precious.js"))).toBe(true);
  });

  it("refuses tracked or untracked work, symlinks, swaps and writes since the check", async () => {
    const { scanner, tokens, report } = await scanned();
    big(join(app, "src", "coverage", "route.ts"), 100);
    const swapToken = item(report, "node_modules")!.token!;
    const nextToken = item(report, ".next")!.token!;
    renameSync(join(app, "node_modules"), join(app, "node_modules.real"));
    big(join(app, "node_modules", "decoy.js"), 10);
    writeFileSync(join(app, ".next", "new-file"), "x");
    const later = new Date(Date.now() + 5000); utimesSync(join(app, ".next"), later, later);
    big(join(root, "outside", "precious"), 1000);
    symlinkSync(join(root, "outside"), join(app, ".turbo"));
    const job = await run(cleaner(tokens, scanner).instance, [swapToken, nextToken, mintFor(tokens, join(app, "src", "coverage")), mintFor(tokens, join(app, ".turbo"))]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(existsSync(join(app, "src", "coverage", "route.ts"))).toBe(true);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
  });

  it("refuses anything open, a busy workspace, a build in it, and any build whose folder can't be told", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const cases: Array<[Partial<ConstructorParameters<typeof DiskCleaner>[0]>, RegExp]> = [
      [{ snapshot: async () => calm([], [join(app, "node_modules", "react", "index.js")]) }, /open right now/],
      [{ listWorkspaces: async () => [idleWorkspace("running")] }, /agent is working/],
      [{ listWorkspaces: async () => [idleWorkspace("attention")] }, /waiting for you/],
      [{ snapshot: async () => calm([pid(["npm", "run", "build"])]) }, /Something is running in this workspace/],
      [{ snapshot: async () => calm([pid(["node", "node_modules/.bin/vitest", "run"], null)]) }, /can't tell in which folder, so it won't clear any workspace/],
    ];
    for (const [overrides, reason] of cases) expect((await run(cleaner(tokens, scanner, overrides).instance, [token])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(reason) });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("a build that starts mid-clear is seen before the next item", async () => {
    const { scanner, tokens, report } = await scanned();
    let calls = 0;
    const job = await run(cleaner(tokens, scanner, { snapshot: async () => (calls++ === 0 ? calm() : calm([pid(["npm", "run", "build"])])) }).instance, [item(report, ".next")!.token!, item(report, "dist")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, false]);
  });

  it("refuses Paseo's data, Hosts' folder, agents' history, whole folders and their parents, even with a token", async () => {
    const { scanner, tokens } = await scanned();
    mkdirSync(join(places.paseoHome, "plugin-data", "node_modules"), { recursive: true });
    const job = await run(cleaner(tokens, scanner).instance, [
      mintFor(tokens, join(places.paseoHome, "plugin-data", "node_modules")), mintFor(tokens, places.stateDir), mintFor(tokens, join(places.home, ".claude")),
      mintFor(tokens, app), mintFor(tokens, join(places.home, "code")), mintFor(tokens, worktree),
    ]);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(places.paseoHome, "config.json"))).toBe(true);
    expect(existsSync(join(places.home, ".claude", "projects", "history.jsonl"))).toBe(true);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
  });

  it("refuses a tampered or expired token; the preview changes nothing", async () => {
    const { scanner, tokens, report } = await scanned();
    const [body, sig] = item(report, "node_modules")!.token!.split(".");
    const forged = Buffer.from(Buffer.from(body!, "base64url").toString().replace("node_modules", "src")).toString("base64url");
    const expired = new DiskTokens(Buffer.alloc(32, 7), () => Date.now() - 3_600_000).mint({ path: join(app, "node_modules"), dev: 1, ino: 1, mtimeMs: 1, action: "delete", kind: "workspace", owner: "x", bytes: 1 });
    expect((await run(cleaner(tokens, scanner).instance, [`${forged}.${sig}`, expired])).results.map((r) => r.ok)).toEqual([false, false]);
    const plan = await cleaner(tokens, scanner).instance.preview([item(report, "node_modules")!.token!, cache(report, "npm cache")!.token!]);
    expect(plan.items.map((i) => [i.name, i.ok, i.action])).toEqual([["node_modules", true, "delete"], ["npm cache", true, "command"]]);
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });
});

describe("unloading", () => {
  it("kills a running child's whole process group and waits; no new work after", async () => {
    const group = new ChildGroup();
    const pending = group.run("sh", ["-c", "sleep 30 & sleep 30; wait"], { timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    group.killAll();
    expect((await pending).killed).toBe(true);
    expect(group.running).toBe(0);
    expect((await group.run("true", [], { timeoutMs: 1000 })).killed).toBe(true);
  });

  it("closing the cleaner kills a running command and stops before the next item", async () => {
    const { scanner, tokens, report } = await scanned();
    let killed = false;
    const c = cleaner(tokens, scanner, { command: async (_kind, group) => { killed = (await group.run("sleep", ["30"], { timeoutMs: 60_000 })).killed; return { ok: false, message: "stopped" }; } }).instance;
    c.start([cache(report, "pnpm store")!.token!, item(report, "node_modules")!.token!]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await c.close();
    expect(killed).toBe(true);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  }, 20_000);

  it("closing the scanner kills the walk and waits; no new scan starts", async () => {
    const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => [idleWorkspace()], cacheFile: null, pnpmStore: async () => null, toolReady: async () => false });
    scanner.start();
    await scanner.close();
    expect(scanner.isRunning).toBe(false);
    scanner.start();
    expect(scanner.isRunning).toBe(false);
  });
});

describe("the disk in the 10-second loop", () => {
  it("reads statfs only, and the verdict is critical at 95%", async () => {
    const asked: string[][] = [];
    const disks = async (paths: readonly string[]) => { asked.push([...paths]); return [diskSpace("This computer's disk", { bsize: 4096, blocks: 1000, bfree: 40, bavail: 40 })]; };
    const loop = new GuardLoop({ sampler: { sample: async () => { throw new Error("n/a"); } }, tail: new DaemonLogTail("/x", { stat: async () => ({ size: 0, ino: 1 }), read: async () => Buffer.alloc(0) }), readSettings: async () => ({ autoStopRunaways: false }), diskPaths: () => ["/a", "/b"], disks });
    await loop.tick();
    expect(asked).toEqual([["/a", "/b"]]);
    const { verdict } = evaluateHealth({ now: 1, snapshot: { services: [], processes: [], scope: { status: "ready", message: "", projects: [] }, supported: true, cpu: { pressure: "normal" }, memory: { pressure: "normal" } } as never, tunnels: [], connections: [], profiles: [], background: true, guard: loop.state() });
    expect(verdict.issues.find((i) => i.code === "disk-full")).toMatchObject({ severity: "critical" });
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
