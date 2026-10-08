import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { ChildGroup } from "../server/disk-children";
import { gitAllows, gitVerdicts, groupGit, type GitRun } from "../server/disk-git";
import { CLEANUP_RULES, DiskScanner, busyReason, canonicalChain, cleanupAskText, disksFor, folderAskText, itemBlocked, readWorkspace, workspaceState, type DiskPlaces, type WorkspaceInfo } from "../server/disk-scan";
import { diskWorker, runWorker } from "../server/disk-worker";
import { GuardLoop } from "../server/guard-loop";
import { DaemonLogTail } from "../server/daemon-log";
import { DISK_CRITICAL_PERCENT, DiskReportSchema, diskLevel, diskSentence, diskSpace, formatSize, protectedReason, protectedSet, stateWords, toolCacheName } from "../shared/disk";
import { AskSubjectSchema } from "../shared/ask";
import { evaluateHealth } from "../shared/health";

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
 * browser downloads, a tool cache, ~/.claude, ~/.codex, Paseo's own data and
 * a /tmp folder.
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
  big(join(app, "src", "api", "coverage", "route.ts"), 1000);
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
  big(join(home, ".claude", "projects", "history.jsonl"), MB);
  big(join(home, ".codex", "sessions", "s.jsonl"), MB);
  big(join(home, ".npm", "_cacache", "content", "blob"), 2 * MB);
  big(join(home, ".npm", "_npx", "abc", "pkg"), MB);
  big(join(home, "pnpm-store", "v10", "files", "pkg"), MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1100", "chrome"), MB);
  big(join(home, ".agent-browser", "browsers", "chrome-154.0.8037.57", "chrome"), MB);
  big(join(home, ".cache", "pip", "wheel"), MB);
  big(join(home, ".cache", "unknown-app", "state"), MB);
  big(join(root, "tmp", "build-old", "x"), MB);
  age(join(root, "tmp", "build-old", "x")); age(join(root, "tmp", "build-old"));
}

const idleWorkspace = (status = "done"): WorkspaceInfo => ({ id: "wks_1", name: "App", project: "app", directory: app, worktree: false, status, activityAt: Date.now() - 3_600_000, branch: "main", devServers: [] });

async function scanned(workspaces: WorkspaceInfo[] = [idleWorkspace()], extra: Partial<ConstructorParameters<typeof DiskScanner>[0]> = {}) {
  const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => workspaces, cacheFile: null, scanSeconds: 60, pnpmStore: async () => join(places.home, "pnpm-store", "v10"), ...extra });
  scanner.start();
  await scanner.wait();
  const report = DiskReportSchema.parse(await scanner.report(workspaces, []));
  return { scanner, report };
}
type Report = Awaited<ReturnType<typeof scanned>>["report"];
const item = (report: Report, where: string) => report.workspaces.flatMap((w) => w.items).find((i) => i.where === where);
const cache = (report: Report, name: string) => report.caches.flatMap((g) => g.items).find((i) => i.name === name);
const appRow = (report: Report) => report.workspaces.find((w) => w.names.includes("App"))!;

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "hosts-disk-"))); world(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("0.14.0 ships no delete path", () => {
  const source = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");
  const diskFiles = readdirSync(join(__dirname, "..", "server")).filter((name) => name.startsWith("disk-")).map((name) => `server/${name}`);

  it("the disk code has no filesystem delete, rename or truncate call, and spawns no cleanup command", () => {
    expect(diskFiles.sort()).toEqual(["server/disk-children.ts", "server/disk-git.ts", "server/disk-scan.ts", "server/disk-worker.ts"]);
    for (const file of diskFiles) {
      const text = source(file);
      expect(text, file).not.toMatch(/\b(unlink|rmdir|rm|rename|truncate|mkdtemp)(Sync)?\s*\(/);
      expect(text, file).not.toMatch(/"rm"|"rmdir"|"unlink"|"(clean|prune|uninstall|delete|remove)"/);
    }
    // git is only asked read-only questions.
    const verbs = [...source("server/disk-git.ts").matchAll(/run\(\w+, \["([\w-]+)"/g)].map((match) => match[1]);
    expect([...new Set(verbs)].sort()).toEqual(["check-ignore", "ls-files", "rev-parse"]);
  });

  it("no clear, preview or cache-command call exists on the wire or in the handlers", () => {
    expect(source("shared/disk.ts").match(/name: "daemon-link\.disk\.[\w-]+"/g)).toEqual(['name: "daemon-link.disk.report"']);
    expect(source("index.server.ts")).not.toMatch(/disk\.(clear|preview|status)|diskClear|diskPreview/);
    const runtime = source("server/runtime.ts");
    expect(runtime).not.toMatch(/DiskCleaner|DiskTokens|quarantine|cache clean|store prune|playwright uninstall/i);
    expect([...runtime.matchAll(/group\.run\("(\w+)", \[([^\]]*)\]/g)].map((match) => `${match[1]} ${match[2]}`)).toEqual(['pnpm "store", "path"']);
    for (const removed of ["server/disk-clear.ts", "server/disk-remove.ts", "server/disk-quarantine.ts", "server/disk-inuse.ts"]) expect(fs.existsSync(join(__dirname, "..", removed)), removed).toBe(false);
  });

  it("the screens have no clear button or sheet", () => {
    const client = source("client/workspaces.tsx");
    expect(client).not.toMatch(/diskClear|diskPreview|ClearSheet|useClear|label=\{?`?"?Clear\b/);
    expect(client).toContain("Ask an agent to clean this up");
  });
});

describe("the rules, pure", () => {
  it("disk levels and words: 85% warns, 95% is critical", () => {
    expect(diskLevel(84.9)).toBe("ok");
    expect(diskLevel(85)).toBe("warning");
    expect(diskLevel(DISK_CRITICAL_PERCENT)).toBe("critical");
    expect(diskSentence(96, 8 * 1024 ** 3)).toBe("The disk is 96% full (8 GB left). Agents will start failing to write files soon.");
    expect(diskSpace("x", { bsize: 4096, blocks: 152305664, bfree: 4456448, bavail: 4456448 }).level).toBe("critical");
    expect(formatSize(1536 * MB)).toBe("1.5 GB");
  });

  it("protects home, workspaces and / as targets and parents; agents' history, Paseo's data and Hosts' folder also from inside", () => {
    const set = protectedSet({ home: "/home/u", paseoHome: "/home/u/.paseo", stateDir: "/home/u/.paseo/daemon-link" }, ["/home/u/code/app"], ["/home/u/.paseo/worktrees/p1/feat"]);
    expect(protectedReason("/home/u/.paseo/config.json", set)).not.toBeNull();
    expect(protectedReason("/home/u/.paseo/worktrees/p1/feat/node_modules", set)).toBeNull();
    expect(protectedReason("/home/u/.codex/cache/chromium-1", set)).not.toBeNull();
    expect(protectedReason("/home/u", set)).not.toBeNull();
    expect(protectedReason("/home/u/code", set)).not.toBeNull();
    expect(protectedReason("/home/u/code/app/node_modules", set)).toBeNull();
  });

  it("reads Paseo's workspace descriptors, and says what's busy", () => {
    expect(readWorkspace({ id: "w", name: "Site", workspaceDirectory: "/x/site", workspaceKind: "worktree", status: "running", gitRuntime: { currentBranch: "feat" }, scripts: [{ scriptName: "web", lifecycle: "running", port: 3000 }] })).toMatchObject({ worktree: true, branch: "feat", devServers: ["web :3000"] });
    expect(workspaceState("needs_input")).toBe("waiting");
    expect(busyReason("working", [])).toMatch(/agent is working/);
    expect(busyReason("idle", ["web :3000"])).toMatch(/dev server/);
    expect(stateWords("idle", Date.now() - 3 * 86_400_000)).toBe("Idle since 3 days ago");
    expect(toolCacheName("Yarn")).toBe("Yarn downloads");
  });

  it("looks safe only on git's three answers; a cut-off check, .env, .git or bare repository say no", () => {
    const set = protectedSet({ home: "/h", paseoHome: "/h/.paseo", stateDir: "/h/.paseo/daemon-link" }, ["/h/a"], []);
    const base = { name: "node_modules", hasEnv: false, hasGit: false, ignoredOnly: false, partial: false };
    const yes = { ignored: true, tracked: false, untracked: false };
    expect(itemBlocked(base, yes, "/h/a/node_modules", set)).toBeNull();
    expect(itemBlocked(base, { ...yes, untracked: true }, "/h/a/node_modules", set)).toBe("hide");
    expect(itemBlocked(base, null, "/h/a/node_modules", set)).toMatch(/Git couldn't confirm/);
    expect(itemBlocked({ ...base, partial: true }, yes, "/h/a/node_modules", set)).toMatch(/time ran out/);
    expect(itemBlocked({ ...base, hasGit: true }, yes, "/h/a/node_modules", set)).toMatch(/git repository/);
  });
});

describe("Ask an agent to clean this up", () => {
  it("the subject is part of the ask contract", () => {
    expect(AskSubjectSchema.parse({ kind: "cleanup", id: "idle" })).toEqual({ kind: "cleanup", id: "idle" });
    expect(AskSubjectSchema.parse({ kind: "cleanup", id: "caches" })).toEqual({ kind: "cleanup", id: "caches" });
  });

  it("a workspace message lists the exact items with paths and sizes, and every check before deleting", () => {
    const text = cleanupAskText({ kind: "workspaces", title: "App", checkedAt: Date.now() - 4 * 60_000, items: [
      { where: "~/code/app/node_modules", bytes: 3 * MB, what: "Installed packages", cost: "Comes back on the next install (a few minutes).", partial: false },
      { where: "~/code/app/.next", bytes: 2 * MB, what: "Next.js build files", cost: "Rebuilt the next time the app builds or starts.", partial: true },
    ] });
    expect(text).toContain("clearing build output in App");
    expect(text).toContain("(checked 4 min ago)");
    expect(text).toContain("- ~/code/app/node_modules · 3 MB · Installed packages.");
    expect(text).toContain("- ~/code/app/.next · at least 2 MB");
    for (const rule of CLEANUP_RULES) expect(text).toContain(rule);
    expect(text).toMatch(/uncommitted or unpushed work/);
    expect(text).toMatch(/has a file open in it/);
    expect(text).toMatch(/never delete a \.git folder or any git repository, \.env files, ~\/\.claude, ~\/\.codex, Paseo's data/);
    expect(text).toMatch(/npm cache clean --force, pnpm store prune/);
    expect(text).toMatch(/tell me what you deleted and how much space it freed/);
    expect(text).not.toMatch(/\brm -rf\b/);
  });

  it("a caches message names each tool's own way", () => {
    const text = cleanupAskText({ kind: "caches", checkedAt: null, items: [{ where: "~/.npm/_cacache", bytes: 2 * MB, what: "npm cache", how: "use npm's own command: npm cache clean --force", partial: false }] });
    expect(text).toContain("- ~/.npm/_cacache · 2 MB · npm cache: use npm's own command: npm cache clean --force");
    expect(text).toContain("Only clear what's really unused.");
  });

  it("the worktree and /tmp messages ask first and never say rm", () => {
    for (const kind of ["worktree", "tmp"] as const) {
      const text = folderAskText({ path: "/h/x", bytes: MB, branch: null, changedAt: Date.now(), kind }, "/h");
      expect(text).toContain("Ask me before you delete anything.");
      expect(text).not.toMatch(/\brm -rf\b/);
    }
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

  it("finds a bare repository (HEAD + objects/ + refs/, no .git) inside an item", async () => {
    bare(join(app, "node_modules", "dep.git"));
    const scan = (await runWorker<{ items: Array<{ rel: string; hasGit: boolean }> }>({ op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() + 20_000, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, 30_000)).results[0]!;
    expect(scan.items.find((i) => i.rel === "node_modules")!.hasGit).toBe(true);
  });

  it("stops at its deadline and says the result is partial", () => {
    const results: Array<{ partial: boolean; skipped?: boolean }> = [];
    diskWorker(fs as never, { op: "scan", roots: [{ id: "a", path: app, mode: "workspace" }], deadline: Date.now() - 1, clearable: ["node_modules"], ignoredOnly: [], ignoredMaxDepth: 4, maxItemsPerRoot: 10 }, (r) => results.push(r as never));
    expect(results.every((r) => r.skipped && r.partial)).toBe(true);
  });
});

describe("git: one deadline, killable", () => {
  it("ignored, nothing tracked, nothing untracked: only then", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100);
    const verdicts = await gitVerdicts([join(app, "node_modules"), join(app, "src", "api", "coverage"), join(app, "src", "coverage"), join(app, "dist")]);
    expect(gitAllows(verdicts.get(join(app, "node_modules")))).toBe(true);
    expect(gitAllows(verdicts.get(join(app, "dist")))).toBe(true);
    expect(verdicts.get(join(app, "src", "api", "coverage"))).toMatchObject({ tracked: true });
    expect(verdicts.get(join(app, "src", "coverage"))).toMatchObject({ ignored: false, untracked: true });
  });

  it("nothing runs past the deadline, and unloading kills git", async () => {
    let calls = 0;
    const slow: GitRun = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { code: 0, stdout: `${app}\n`, stderr: "" }; };
    expect([...(await gitVerdicts([join(app, "node_modules"), join(app, ".next")], slow, Date.now() + 10)).values()].every((v) => !gitAllows(v))).toBe(true);
    expect(calls).toBeLessThanOrEqual(1);
    const group = new ChildGroup();
    group.killAll();
    expect(gitAllows((await gitVerdicts([join(app, "node_modules")], groupGit(group))).get(join(app, "node_modules")))).toBe(false);
  });

  it("a registry that never answers can't stretch the scan past its deadline", async () => {
    const started = Date.now();
    const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: () => new Promise(() => undefined), cacheFile: null, scanSeconds: 2, pnpmStore: async () => null });
    scanner.start();
    await scanner.wait();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(scanner.last()!.warnings.join(" ")).toMatch(/couldn't be read in time/);
  }, 15_000);
});

describe("the scan (read-only)", () => {
  it("marks what looks safe to clear in workspaces, and lists caches and /tmp by size", async () => {
    const { report } = await scanned();
    const workspace = appRow(report);
    expect(workspace.items.map((i) => i.where).sort()).toEqual([".next", "dist", "node_modules", "packages/ui/node_modules"]);
    expect(workspace.items.every((i) => i.safe && !i.blocked)).toBe(true);
    expect(workspace.clearableBytes).toBeGreaterThanOrEqual(7 * MB);
    expect(report.workspaces.find((w) => w.state === "unlinked")!.items.map((i) => [i.where, i.safe])).toEqual([["node_modules", true]]);
    for (const name of ["npm cache", "npx downloads", "pnpm store", "Playwright browsers", "agent-browser browsers", "pip", "build-old"]) expect(cache(report, name), name).toMatchObject({ safe: false });
    expect(cache(report, "build-old")!.askId).toBe(`tmp:${join(root, "tmp", "build-old")}`);
    expect(cache(report, "unknown-app")).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(".claude");
  });

  it("a cache folder reached through a symlinked parent isn't listed", async () => {
    rmSync(join(places.home, ".cache"), { recursive: true });
    big(join(places.home, ".codex", "cache", "ms-playwright", "chromium-1", "precious"), 1000);
    symlinkSync(join(places.home, ".codex", "cache"), join(places.home, ".cache"));
    const { report } = await scanned();
    expect(JSON.stringify(report)).not.toContain("chromium-1");
    expect(await canonicalChain(join(places.home, ".cache", "ms-playwright"))).toBe(false);
  });

  it("untracked work, no repository, git without an answer, or a bare repository: nothing looks safe", async () => {
    big(join(app, "src", "coverage", "route.ts"), 100);
    expect(item((await scanned()).report, "src/coverage")).toBeUndefined();
    expect(appRow((await scanned([idleWorkspace()], { git: async () => ({ code: null, stdout: "", stderr: "timeout" }) })).report).items.every((i) => !i.safe)).toBe(true);
    bare(join(app, "node_modules", "dep.git"));
    expect(item((await scanned()).report, "node_modules")).toMatchObject({ safe: false, blocked: expect.stringMatching(/git repository/) });
    rmSync(join(app, ".git"), { recursive: true });
    expect(appRow((await scanned()).report).items.every((i) => !i.safe)).toBe(true);
  });

  it("a working agent or a running dev server: nothing looks safe there", async () => {
    expect(appRow((await scanned([idleWorkspace("running")])).report).items.every((i) => !i.safe)).toBe(true);
    expect(appRow((await scanned([{ ...idleWorkspace(), devServers: ["web :3000"] }])).report).busy).toMatch(/dev server/);
  });

  it("closing the scanner kills the walk and waits; no new scan starts", async () => {
    const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => [idleWorkspace()], cacheFile: null, pnpmStore: async () => null });
    scanner.start();
    await scanner.close();
    expect(scanner.isRunning).toBe(false);
    scanner.start();
    expect(scanner.isRunning).toBe(false);
    // Nothing was touched by any of it.
    expect(fs.existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
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
