import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildGroup } from "../server/disk-children";
import { DiskCleaner, DiskTokens } from "../server/disk-clear";
import { busyInWorkspace, hostSnapshot, lsofPids, parseLsof, parsePs, statusUids, titleArgv, usedBeneath, type HostSnapshot, type SnapshotDeps } from "../server/disk-inuse";
import { JOURNAL_PROBLEM, QuarantineInventory, moveNoReplace } from "../server/disk-quarantine";
import { quarantineAndRemove, rmArgs } from "../server/disk-remove";
import { DiskScanner, type DiskPlaces, type WorkspaceInfo } from "../server/disk-scan";
import { classifyJob } from "../server/jobs";
import { DiskReportSchema, isBigDelete } from "../shared/disk";
import type { ActionLogEntry } from "../shared/processes";

/**
 * 0.16.0 one-press Clear: build folders INSIDE a workspace or worktree only.
 * Ported from the reviewed 0.14 cleanup branch's deletion-safety tests, plus
 * every finding from its third review (titles, lsof, /tmp, the journal,
 * no-replace restore, one deadline, the snapshot after git). Real git, real
 * rm, in a temp home this test creates.
 */

const MB = 1024 * 1024;
const big = (path: string, bytes = MB) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
const UID = process.getuid!();
const bare = (path: string) => { mkdirSync(join(path, "objects"), { recursive: true }); mkdirSync(join(path, "refs", "heads"), { recursive: true }); writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n"); };
/** A recorded manifest; recovery never trusts it to prove a deletion (final gate). */
const MANIFEST = { entries: 3, bytes: 3 * MB };
const hasQuarantine = (dir: string) => readdirSync(dir).some((name) => name.startsWith(".hosts-quarantine-"));

let root = "";
let places: DiskPlaces;
let app = "";
let worktree = "";

function world() {
  const home = join(root, "home");
  const paseoHome = join(home, ".paseo");
  places = { platform: process.platform === "darwin" ? "darwin" : "linux", home, paseoHome, stateDir: join(paseoHome, "daemon-link"), tmpDirs: [join(root, "tmp")], cacheBases: [join(home, ".cache")], browserRoots: [join(home, ".cache", "ms-playwright")] };
  app = join(home, "code", "app");
  mkdirSync(app, { recursive: true });
  git(app, "init", "-q");
  writeFileSync(join(app, ".gitignore"), "node_modules\n.next\ndist/\n.env\n");
  big(join(app, "src", "index.ts"), 1000);
  writeFileSync(join(app, ".env"), "SECRET=1\n");
  // A node_modules goes only with a lockfile beside its package.json (final gate).
  writeFileSync(join(app, "package.json"), "{}\n");
  writeFileSync(join(app, "package-lock.json"), "{}\n");
  git(app, "add", ".gitignore", "src", "package.json", "package-lock.json");
  git(app, "commit", "-qm", "init");
  big(join(app, "node_modules", "react", "index.js"), 3 * MB);
  big(join(app, ".next", "cache", "a.bin"), 2 * MB);
  big(join(app, "dist", "main.js"), MB);
  worktree = join(paseoHome, "worktrees", "proj1", "feature-x");
  mkdirSync(join(paseoHome, "worktrees", "proj1"), { recursive: true });
  git(app, "worktree", "add", "-q", "-b", "feature-x", worktree);
  big(join(paseoHome, "config.json"), 1000);
  big(join(home, ".claude", "projects", "history.jsonl"), MB);
  big(join(home, ".npm", "_cacache", "content", "blob"), 2 * MB);
  big(join(home, ".cache", "ms-playwright", "chromium-1100", "chrome"), MB);
  big(join(root, "tmp", "build-old", "node_modules", "x"), MB);
}

const idleWorkspace = (status = "done", directory = app): WorkspaceInfo => ({ id: "wks_1", name: "App", project: "app", directory, worktree: false, status, activityAt: Date.now() - 3_600_000, branch: "main", devServers: [] });
const calm = (processes: HostSnapshot["processes"] = [], open: string[] = []): HostSnapshot => ({ processes, open, complete: true, why: null });
const proc = (argv: string[], cwd: string | null = app, pid = 9, ppid: number | null = 1, stdin: "tty" | "file" | "pipe" | "none" | "other" = "tty") => ({ pid, ppid, argv, cwd, stdin });

async function scanned(workspaces: WorkspaceInfo[] = [idleWorkspace()]) {
  const scanner = new DiskScanner({ places, uid: UID, listWorkspaces: async () => workspaces, cacheFile: null, scanSeconds: 60, pnpmStore: async () => null });
  scanner.start();
  await scanner.wait();
  const tokens = new DiskTokens();
  const report = DiskReportSchema.parse(await scanner.report(workspaces, [], (input) => tokens.mint(input)));
  return { scanner, tokens, report };
}

function cleaner(tokens: DiskTokens, scanner: DiskScanner, overrides: Partial<ConstructorParameters<typeof DiskCleaner>[0]> = {}) {
  const log: ActionLogEntry[] = [];
  const instance = new DiskCleaner({
    places, uid: UID, tokens, tmpRoots: [],
    listWorkspaces: async () => [idleWorkspace()],
    unlinkedWorktrees: (claimed) => scanner.unlinkedWorktrees(claimed),
    snapshot: async () => calm(),
    inventory: new QuarantineInventory(join(places.stateDir, "quarantine.json")),
    log: async (entry) => { log.push(entry); },
    cleared: (path, bytes) => scanner.forget(path, bytes),
    ...overrides,
  });
  return { instance, log };
}

type Report = Awaited<ReturnType<typeof scanned>>["report"];
const item = (report: Report, where: string) => report.workspaces.flatMap((w) => w.items).find((i) => i.where === where);
const run = async (c: DiskCleaner, tokens: string[]) => { c.start(tokens); await c.wait(); return c.status(); };
const mintFor = (tokens: DiskTokens, path: string, rootPath = app) => {
  const st = lstatSync(path);
  return tokens.mint({ path, root: rootPath, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, workspace: "App", bytes: 1, what: "x", cost: "y" });
};

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "hosts-clear-"))); world(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("one complete snapshot, or nothing", () => {
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

  it("Linux: another user's process is skipped; this user's must be fully readable; rewritten titles are kept", async () => {
    const ok = await hostSnapshot("linux", 1000, linux({ "1": { uid: 0, cwdUnreadable: true }, "50": { uid: 1000, cmdline: "npm install", cwd: "/home/u/app", fds: { "3": "/home/u/app/node_modules/x" } }, "60": { status: "missing" } }));
    expect(ok).toMatchObject({ complete: true, processes: [{ pid: 50, argv: ["npm install"], cwd: "/home/u/app" }] });
    expect(ok.processes[0]!.ppid).toBeNull();
    expect(ok.open).toContain("/home/u/app/node_modules/x");
    for (const broken of [{ uid: 1000, cwdUnreadable: true }, { uid: 1000, cwd: "/x", fds: { "4": "/y" }, badFd: "4" }, { status: "unreadable" as const }]) {
      expect(await hostSnapshot("linux", 1000, linux({ "50": broken }))).toMatchObject({ complete: false, why: expect.any(String) });
    }
    expect(statusUids("Uid:\t0\t1000\t0\t0\n")).toEqual([0, 1000]);
  });

  it("macOS: ps or lsof failing, or a live process with no lsof record, is incomplete; zombies and exited processes are fine", async () => {
    const deps = (ps: { code: number | null; stdout: string }, lsof: { code: number | null; stdout: string }, alive: (pid: number) => boolean = () => true): SnapshotDeps => ({ readdir: async () => [], readFile: async () => "", readlink: async () => "", run: async (file: string) => (file === "ps" ? ps : lsof), alive, startOf: async (pid) => (alive(pid) ? "Thu Oct 8 17:01:23 2026" : null) });
    expect(await hostSnapshot("darwin", 501, deps({ code: 1, stdout: "  9 1 501 S Thu Oct  8 17:01:23 2026 node x.js\n" }, { code: 0, stdout: "" }))).toMatchObject({ complete: false, why: expect.stringMatching(/ps/) });
    expect(await hostSnapshot("darwin", 501, deps({ code: 0, stdout: "  9 1 501 S Thu Oct  8 17:01:23 2026 node x.js\n" }, { code: 1, stdout: "p9\nfcwd\nn/Users/x/app\n" }))).toMatchObject({ complete: false, why: expect.stringMatching(/lsof/) });
    expect(await hostSnapshot("darwin", 501, deps({ code: 0, stdout: "  9 1 501 S Thu Oct  8 17:01:23 2026 node x.js\n 11 1 501 S Thu Oct  8 17:01:23 2026 vim\n" }, { code: 0, stdout: "p9\nfcwd\nn/Users/x/app\n" }))).toMatchObject({ complete: false, why: expect.stringMatching(/PID 11/) });
    const ok = await hostSnapshot("darwin", 501, deps({ code: 0, stdout: "  9 1 501 S Thu Oct  8 17:01:23 2026 npm run build\n 10 0 0 Ss Thu Oct  8 17:01:23 2026 /sbin/launchd\n 12 1 501 Z Thu Oct  8 17:01:23 2026 (node)\n 13 1 501 S Thu Oct  8 17:01:23 2026 gone\n" }, { code: 0, stdout: "p9\nfcwd\nn/Users/x/app\nf12\nn/Users/x/app/dist/a.js\n" }, (pid) => pid !== 13));
    // PID 13 exited (no lsof record, not alive): dropped, so it can't block every workspace as "folder unknown".
    expect(ok).toEqual({ complete: true, why: null, processes: [{ pid: 9, ppid: 1, argv: ["npm", "run", "build"], cwd: "/Users/x/app", stdin: "none" }], open: ["/Users/x/app", "/Users/x/app/dist/a.js"] });
    expect(parsePs("  9 3 501 S Thu Oct  8 17:01:23 2026 a b\n 10 1 0 S Thu Oct  8 17:01:23 2026 c\n", 501)).toEqual([{ pid: 9, ppid: 3, argv: ["a", "b"], zombie: false, start: "Thu Oct 8 17:01:23 2026" }]);
    expect(parseLsof("p9\nfcwd\nn/a\n").cwd.get(9)).toBe("/a");
    expect([...lsofPids("p9\nfcwd\nn/a\np10\n")]).toEqual([9, 10]);
  });

  it("anything in a workspace but an idle shell counts as using it, rewritten titles included", () => {
    const classify = (argv: string[]) => classifyJob(argv)?.label ?? null;
    expect(titleArgv(["npm install"])).toEqual(["npm", "install"]);
    expect(busyInWorkspace(["zsh"], classify)).toBeNull();
    expect(busyInWorkspace(["-zsh"], classify)).toBeNull();
    expect(busyInWorkspace(["bash", "-c", "npm run build"], classify)).not.toBeNull();
    for (const argv of [["npm install"], ["npm exec vite"], ["pnpm install"], ["yarn"], ["bun install"], ["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "ci"], ["npm", "run", "dev"], ["claude"], ["vim", "x"], ["node", "server.js"], ["next-server (v15)"]]) {
      expect(busyInWorkspace(argv, classify), argv.join(" ")).not.toBeNull();
    }
  });

  it("an incomplete snapshot deletes nothing and says why", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance } = cleaner(tokens, scanner, { snapshot: async () => ({ processes: [], open: [], complete: false, why: "The process list (ps) couldn't be read completely." }) });
    const job = await run(instance, [item(report, "node_modules")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/complete picture of what's running \(The process list \(ps\)/) });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });
});

describe("deleting: quarantine, physical probe, system rm, one deadline", () => {
  const remove = (path: string, extra: Partial<Parameters<typeof quarantineAndRemove>[2]> = {}) => {
    const st = lstatSync(path);
    return quarantineAndRemove(path, { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup(), deadline: Date.now() + 120_000, ...extra });
  };

  it("rm is the system rm with stay-on-one-disk, as argv", () => {
    expect(rmArgs("gnu", "/x/.hosts-quarantine-a")).toEqual(["-rf", "--one-file-system", "--", "/x/.hosts-quarantine-a"]);
    expect(rmArgs("bsd", "/x/.hosts-quarantine-a")).toEqual(["-rf", "-x", "--", "/x/.hosts-quarantine-a"]);
  });

  it("a folder swapped for a symlink just before rm is unlinked as a link; its target survives", async () => {
    big(join(root, "outside", "precious"), 1000);
    mkdirSync(join(app, "node_modules", "sub", "deep"), { recursive: true });
    const result = await remove(join(app, "node_modules"), { beforeRemove: (q) => { rmSync(join(q, "sub"), { recursive: true }); symlinkSync(join(root, "outside"), join(q, "sub")); } });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("a bare repository or .env inside is put back untouched; a different inode or no safe rm refuses", async () => {
    bare(join(app, "node_modules", "dep.git"));
    expect(await remove(join(app, "node_modules"))).toMatchObject({ ok: false, error: expect.stringMatching(/git repository/) });
    expect(existsSync(join(app, "node_modules", "dep.git", "HEAD"))).toBe(true);
    big(join(app, "dist", ".env"), 10);
    expect(await remove(join(app, "dist"))).toMatchObject({ ok: false });
    expect(existsSync(join(app, "dist", ".env"))).toBe(true);
    const st = lstatSync(join(app, ".next"));
    expect(await quarantineAndRemove(join(app, ".next"), { dev: st.dev, ino: st.ino + 1, bytes: 1 }, { group: new ChildGroup(), deadline: Date.now() + 60_000 })).toMatchObject({ ok: false });
    expect(await remove(join(app, ".next"), { flavour: async () => null })).toMatchObject({ ok: false, error: expect.stringMatching(/stay on one disk/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("nothing starts past the deadline, and the inside-check and rm only get what's left", async () => {
    expect(await remove(join(app, ".next"), { deadline: Date.now() + 1000 })).toMatchObject({ ok: false, error: expect.stringMatching(/time for this clear ran out/) });
    let given = 0;
    await remove(join(app, ".next"), { deadline: Date.now() + 60_000, probe: async (_path, _group, deadline) => { given = deadline - Date.now(); return { ok: false, why: "stop" }; } });
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThanOrEqual(60_000);
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
  });

  it("records each quarantine and forgets it once it's done", async () => {
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    const seen: number[] = [];
    await remove(join(app, ".next"), { inventory, beforeRemove: async () => { seen.push((await inventory.list()).length); } });
    expect(seen).toEqual([1]);
    expect(await inventory.list()).toEqual([]);
  });
});

describe("the quarantine journal and putting things back", () => {
  async function interrupted(inventory: QuarantineInventory, original: string) {
    const { mkdtempSync } = await import("node:fs");
    const quarantine = mkdtempSync(join(join(original, ".."), ".hosts-quarantine-"));
    const st = lstatSync(original);
    await inventory.add({ quarantine, original, name: "node_modules", dev: st.dev, ino: st.ino, bytes: 3 * MB, at: Date.now() });
    renameSync(original, join(quarantine, "node_modules"));
    // A crash after the look inside: "moved", with what was in it.
    await inventory.moved(quarantine, MANIFEST);
    return quarantine;
  }

  it("puts an interrupted clear back where its place is still free", async () => {
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    await interrupted(inventory, join(app, "node_modules"));
    const outcome = await inventory.recover();
    expect(outcome.restored).toHaveLength(1);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("never replaces: a new folder in its place (even an EMPTY one) leaves the item set aside and listed", async () => {
    for (const fill of [true, false]) {
      const inventory = new QuarantineInventory(join(places.stateDir, `q-${fill}.json`));
      if (!existsSync(join(app, "node_modules"))) big(join(app, "node_modules", "react", "index.js"));
      const quarantine = await interrupted(inventory, join(app, "node_modules"));
      mkdirSync(join(app, "node_modules"));
      if (fill) big(join(app, "node_modules", "fresh-install.js"), 10);
      const outcome = await inventory.recover();
      expect(outcome.aside).toHaveLength(1);
      expect((await inventory.status()).entries[0]).toMatchObject({ state: "aside", setAside: true });
      expect(existsSync(join(quarantine, "node_modules", "react", "index.js"))).toBe(true);
      if (fill) expect(existsSync(join(app, "node_modules", "fresh-install.js"))).toBe(true);
      expect(await inventory.list()).toHaveLength(1);
      rmSync(join(app, "node_modules"), { recursive: true });
      renameSync(join(quarantine, "node_modules"), join(app, "node_modules"));
      rmSync(quarantine, { recursive: true });
    }
  });

  it("moveNoReplace: moves when free (inode checked), conflicts when anything is there", async () => {
    big(join(root, "a", "f"), 10);
    const ino = lstatSync(join(root, "a")).ino;
    expect(await moveNoReplace(join(root, "a"), join(root, "b"), ino)).toBe("moved");
    mkdirSync(join(root, "c"));
    expect(await moveNoReplace(join(root, "b"), join(root, "c"), ino)).toBe("conflict");
    expect(existsSync(join(root, "b", "f"))).toBe(true);
  });

  it("a corrupt or malformed journal is reported, never treated as empty, never overwritten, and stops every clear", async () => {
    const file = join(places.stateDir, "quarantine.json");
    mkdirSync(places.stateDir, { recursive: true });
    for (const content of ["{not json", JSON.stringify([{ quarantine: "relative", original: "/x", name: "n" }]), JSON.stringify({ entries: [] })]) {
      writeFileSync(file, content);
      const inventory = new QuarantineInventory(file);
      expect((await inventory.inspect()).problem).toBe(JOURNAL_PROBLEM);
      expect((await inventory.recover()).problem).toBe(JOURNAL_PROBLEM);
      await expect(inventory.add({ quarantine: "/q", original: "/o", name: "n", dev: 1, ino: 1, bytes: 1, at: 1 })).rejects.toThrow();
      expect((await import("node:fs")).readFileSync(file, "utf8")).toBe(content);
      const { scanner, tokens, report } = await scanned();
      const job = await run(cleaner(tokens, scanner, { inventory }).instance, [item(report, ".next")!.token!]);
      expect(job.results[0]).toMatchObject({ ok: false, message: JOURNAL_PROBLEM });
      expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    }
  });
});

describe("clearing", () => {
  it("deletes an ignored build folder inside a workspace, logs it, drops it from the list", async () => {
    const { scanner, tokens, report } = await scanned();
    const { instance, log } = cleaner(tokens, scanner);
    const job = await run(instance, [item(report, ".next")!.token!]);
    expect(job.results).toEqual([expect.objectContaining({ workspace: "App", where: ".next", ok: true })]);
    expect(job.message).toMatch(/^Deleted .* from 1 folder\./);
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "src", "index.ts"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
    expect(log[0]).toMatchObject({ action: "disk-clear", source: "disk", status: "done" });
  });

  it("only workspace items get a token: caches, /tmp and browser downloads never do", async () => {
    const { report } = await scanned();
    expect(report.caches.flatMap((group) => group.items).every((entry) => !entry.token)).toBe(true);
    expect(report.workspaces.flatMap((w) => w.items).filter((entry) => entry.safe).every((entry) => !!entry.token)).toBe(true);
  });

  it("nothing outside a workspace is deletable, even with a forged token: /tmp, caches, browser downloads", async () => {
    const { scanner, tokens } = await scanned();
    const forged = [mintFor(tokens, join(root, "tmp", "build-old", "node_modules")), mintFor(tokens, join(places.home, ".cache", "ms-playwright", "chromium-1100")), mintFor(tokens, join(places.home, ".npm", "_cacache"))];
    const job = await run(cleaner(tokens, scanner).instance, forged);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(root, "tmp", "build-old", "node_modules", "x"))).toBe(true);
    expect(existsSync(join(places.home, ".cache", "ms-playwright", "chromium-1100", "chrome"))).toBe(true);
    expect(existsSync(join(places.home, ".npm", "_cacache", "content", "blob"))).toBe(true);
  });

  it("a workspace whose root is under a temporary folder is refused", async () => {
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner, { tmpRoots: [root] }).instance, [item(report, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/temporary folder/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
  });

  it("a folder reached through a symlinked ancestor is refused", async () => {
    const { scanner, tokens } = await scanned();
    big(join(places.home, ".codex", "work", "node_modules", "precious.js"), 10);
    symlinkSync(join(places.home, ".codex", "work"), join(app, "linked"));
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, "linked", "node_modules"))]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/link somewhere on the way/) });
    expect(existsSync(join(places.home, ".codex", "work", "node_modules", "precious.js"))).toBe(true);
  });

  it("refuses untracked work, symlinks, swaps and writes since the check", async () => {
    const { scanner, tokens, report } = await scanned();
    const swap = item(report, "node_modules")!.token!;
    const next = item(report, ".next")!.token!;
    renameSync(join(app, "node_modules"), join(app, "node_modules.real"));
    big(join(app, "node_modules", "decoy.js"), 10);
    writeFileSync(join(app, ".next", "new-file"), "x");
    const later = new Date(Date.now() + 5000); utimesSync(join(app, ".next"), later, later);
    big(join(app, "src", "coverage", "route.ts"), 100);
    big(join(root, "outside", "precious"), 1000);
    symlinkSync(join(root, "outside"), join(app, ".turbo"));
    const job = await run(cleaner(tokens, scanner).instance, [swap, next, mintFor(tokens, join(app, "src", "coverage")), mintFor(tokens, join(app, ".turbo"))]);
    expect(job.results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(existsSync(join(app, "src", "coverage", "route.ts"))).toBe(true);
    expect(existsSync(join(root, "outside", "precious"))).toBe(true);
  });

  it("refuses anything open, an agent working or waiting, anything running in the workspace, and anything whose folder can't be told", async () => {
    const { scanner, tokens, report } = await scanned();
    const token = item(report, "node_modules")!.token!;
    const cases: Array<[Partial<ConstructorParameters<typeof DiskCleaner>[0]>, RegExp]> = [
      [{ snapshot: async () => calm([], [join(app, "node_modules", "react", "index.js")]) }, /open right now/],
      [{ listWorkspaces: async () => [idleWorkspace("running")] }, /agent is working/],
      [{ listWorkspaces: async () => [idleWorkspace("attention")] }, /waiting for you/],
      [{ snapshot: async () => calm([proc(["npm install"])]) }, /running in this workspace \(npm install\)/],
      [{ snapshot: async () => calm([proc(["pnpm", "install"], join(app, "packages", "ui"))]) }, /running in this workspace/],
      [{ snapshot: async () => calm([proc(["node", "server.js"])]) }, /running in this workspace/],
      [{ snapshot: async () => calm([proc(["claude"])]) }, /running in this workspace/],
      [{ snapshot: async () => calm([proc(["node", "node_modules/.bin/vitest", "run"], null)]) }, /can't tell in which folder/],
    ];
    for (const [overrides, reason] of cases) expect((await run(cleaner(tokens, scanner, overrides).instance, [token])).results[0]).toMatchObject({ ok: false, message: expect.stringMatching(reason) });
    // An idle terminal shell there, and work elsewhere, are fine.
    expect((await cleaner(tokens, scanner, { snapshot: async () => calm([proc(["zsh"]), proc(["npm install"], "/elsewhere", 10)]) }).instance.check(token)).ok).toBe(true);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("the snapshot is taken after git, and fresh before each item: a build that starts mid-clear is seen", async () => {
    const { scanner, tokens, report } = await scanned();
    const order: string[] = [];
    const gitSpy = (async (cwd: string, args: readonly string[]) => { order.push("git"); return { code: args[0] === "rev-parse" ? 0 : args[0] === "check-ignore" ? 0 : 0, stdout: args[0] === "rev-parse" ? `${app}\n` : args[0] === "check-ignore" ? ".next/\0node_modules/\0" : "", stderr: "" }; }) as never;
    let calls = 0;
    // Item 1: the check's snapshot and the final one before rm are calm; then a build starts.
    const job = await run(cleaner(tokens, scanner, { git: gitSpy, snapshot: async () => { order.push("snapshot"); return calls++ < 2 ? calm() : calm([proc(["npm", "run", "build"])]); } }).instance, [item(report, ".next")!.token!, item(report, "node_modules")!.token!]);
    expect(job.results.map((r) => r.ok)).toEqual([true, false]);
    expect(order.indexOf("snapshot")).toBeGreaterThan(order.indexOf("git"));
    expect(order.filter((step) => step === "snapshot")).toHaveLength(3);
    expect(order.lastIndexOf("git")).toBeLessThan(order.lastIndexOf("snapshot"));
  });

  it("refuses Paseo's data, agents' history, whole workspaces and worktrees and their parents, even with a token", async () => {
    const { scanner, tokens } = await scanned();
    mkdirSync(join(places.paseoHome, "plugin-data", "node_modules"), { recursive: true });
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(places.paseoHome, "plugin-data", "node_modules")), mintFor(tokens, join(places.home, ".claude")), mintFor(tokens, app), mintFor(tokens, join(places.home, "code")), mintFor(tokens, worktree)]);
    expect(job.results.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(places.paseoHome, "config.json"))).toBe(true);
    expect(existsSync(join(places.home, ".claude", "projects", "history.jsonl"))).toBe(true);
    expect(existsSync(join(worktree, ".git"))).toBe(true);
  });

  it("refuses a tampered or expired token; the preview re-checks fresh and deletes nothing", async () => {
    const { scanner, tokens, report } = await scanned();
    const [body, sig] = item(report, "node_modules")!.token!.split(".");
    const forged = Buffer.from(Buffer.from(body!, "base64url").toString().replace("node_modules", "src")).toString("base64url");
    const expired = new DiskTokens(Buffer.alloc(32, 7), () => Date.now() - 3_600_000).mint({ path: join(app, "node_modules"), root: app, dev: 1, ino: 1, mtimeMs: 1, workspace: "App", bytes: 1, what: "x", cost: "y" });
    expect((await run(cleaner(tokens, scanner).instance, [`${forged}.${sig}`, expired])).results.map((r) => r.ok)).toEqual([false, false]);
    const before = Date.now();
    const plan = await cleaner(tokens, scanner, { snapshot: async () => calm([], [join(app, ".next", "cache", "a.bin")]) }).instance.preview([item(report, "node_modules")!.token!, item(report, ".next")!.token!]);
    expect(plan.items.map((entry) => [entry.workspace, entry.where, entry.ok])).toEqual([["App", "node_modules", true], ["App", ".next", false]]);
    expect(plan.items[1]!.reason).toMatch(/open right now/);
    expect(plan.count).toBe(1);
    expect(plan.checkedAt).toBeGreaterThanOrEqual(before);
    expect(existsSync(join(app, "node_modules"))).toBe(true);
  });

  it("big deletes: more than 10 GB or more than 20 folders", () => {
    expect(isBigDelete(10 * 1024 ** 3, 20)).toBe(false);
    expect(isBigDelete(10 * 1024 ** 3 + 1, 1)).toBe(true);
    expect(isBigDelete(1, 21)).toBe(true);
  });
});

describe("unloading", () => {
  it("closing the cleaner stops before the next item; nothing is deleted after", async () => {
    const { scanner, tokens, report } = await scanned();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const c = cleaner(tokens, scanner, { snapshot: async () => { await gate; return calm(); } }).instance;
    c.start([item(report, ".next")!.token!, item(report, "node_modules")!.token!]);
    const closing = c.close();
    release();
    await closing;
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });
});

describe("Astra review of 09b0955", () => {
  it("1: names compare case- and Unicode-insensitively: .ENV.production, a .GIT pointer, an uppercase bare repo", async () => {
    const { foldName, isClearableName, isEnvFile, describeName, protectedReason, protectedSet } = await import("../shared/disk");
    expect(isEnvFile(".ENV.production")).toBe(true);
    expect(isEnvFile(".Env")).toBe(true);
    // Eligibility is exact (second review): protection folds, deleting doesn't.
    expect(isClearableName("Node_Modules")).toBe(false);
    expect(describeName("NODE_MODULES")).toBeNull();
    expect(isClearableName("node_modules")).toBe(true);
    expect(foldName("café")).toBe(foldName("café"));
    const set = protectedSet({ home: "/home/u", paseoHome: "/home/u/.paseo", stateDir: "/home/u/.paseo/daemon-link" }, ["/home/u/code/app"], []);
    expect(protectedReason("/home/u/.Claude/x", set)).toMatch(/Agents' history/);
    expect(protectedReason("/home/u/.PASEO/config", set)).not.toBeNull();
    expect(protectedReason("/home/u/Code/App", set)).not.toBeNull();
    // The physical look inside, on disk.
    const remove = (path: string) => { const st = lstatSync(path); return quarantineAndRemove(path, { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup(), deadline: Date.now() + 120_000 }); };
    big(join(app, "dist", ".ENV.production"), 10);
    expect(await remove(join(app, "dist"))).toMatchObject({ ok: false, error: expect.stringMatching(/\.env file or a git repository/) });
    expect(existsSync(join(app, "dist", ".ENV.production"))).toBe(true);
    writeFileSync(join(app, ".next", ".GIT"), "gitdir: /elsewhere\n");
    expect(await remove(join(app, ".next"))).toMatchObject({ ok: false });
    expect(existsSync(join(app, ".next", ".GIT"))).toBe(true);
    mkdirSync(join(app, "node_modules", "dep", "OBJECTS"), { recursive: true }); mkdirSync(join(app, "node_modules", "dep", "Refs"), { recursive: true }); writeFileSync(join(app, "node_modules", "dep", "head"), "ref\n");
    expect(await remove(join(app, "node_modules"))).toMatchObject({ ok: false });
    expect(existsSync(join(app, "node_modules", "dep", "head"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("2: only a bare interactive shell with no children is idle; scripts, -c, -s, -l and a shell with a child are busy", async () => {
    const { workspaceUsers } = await import("../server/disk-inuse");
    const classify = (argv: string[]) => classifyJob(argv)?.label ?? null;
    for (const argv of [["zsh"], ["-zsh"], ["bash"], ["-bash"], ["/bin/zsh"]]) expect(busyInWorkspace(argv, classify), argv.join(" ")).toBeNull();
    for (const argv of [["bash", "build.sh"], ["bash", "-lc", "make"], ["sh", "-s"], ["zsh", "-l"], ["zsh", "-i"], ["bash", "-c", "x"], ["sh", "./deploy.sh"]]) expect(busyInWorkspace(argv, classify), argv.join(" ")).not.toBeNull();
    expect(workspaceUsers({ processes: [proc(["zsh"], app, 40)] }, app, classify)).toBeNull();
    expect(workspaceUsers({ processes: [proc(["zsh"], app, 40), proc(["sleep", "100"], "/elsewhere", 41, 40)] }, app, classify)).toMatchObject({ why: expect.stringMatching(/shell with something running/) });
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner, { snapshot: async () => calm([proc(["bash", "build.sh"])]) }).instance, [item(report, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/running in this workspace \(a bash script\)/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
  });

  it("3: macOS, both ways: a live PID in lsof but not in ps is incomplete; one that has gone since is fine", async () => {
    const deps = (lsofOut: string, alive: (pid: number) => boolean): SnapshotDeps => ({ readdir: async () => [], readFile: async () => "", readlink: async () => "", run: async (file: string) => (file === "ps" ? { code: 0, stdout: "  9 1 501 S Thu Oct  8 17:01:23 2026 node x.js\n" } : { code: 0, stdout: lsofOut }), alive, startOf: async () => "Thu Oct 8 17:01:23 2026" });
    expect(await hostSnapshot("darwin", 501, deps("p9\nfcwd\nn/Users/x/app\np77\nfcwd\nn/Users/x/app/node_modules\n", () => true))).toMatchObject({ complete: false, why: expect.stringMatching(/PID 77/) });
    expect(await hostSnapshot("darwin", 501, deps("p9\nfcwd\nn/Users/x/app\np77\nfcwd\nn/Users/x/app\n", (pid) => pid !== 77))).toMatchObject({ complete: true });
    // A process whose folder is inside the workspace uses it, open files beneath or not.
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner, { snapshot: async () => calm([proc(["python3", "-m", "http.server"], join(app, "src"))]) }).instance, [item(report, "node_modules")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/running in this workspace/) });
  });

  it("4: a fresh snapshot after the look inside and right before rm: something that started meanwhile puts it back", async () => {
    const { scanner, tokens, report } = await scanned();
    let calls = 0;
    const late = (procs: HostSnapshot) => cleaner(tokens, scanner, { snapshot: async () => (calls++ === 0 ? calm() : procs) }).instance;
    let job = await run(late(calm([proc(["npm", "install"])])), [item(report, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/started in this workspace .*put back/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    calls = 0;
    const { scanner: s2, tokens: t2, report: r2 } = await scanned();
    job = await run(cleaner(t2, s2, { snapshot: async () => (calls++ === 0 ? calm() : calm([], [join(app, readdirSync(app).find((name) => name.startsWith(".hosts-quarantine-")) ?? "x", ".next", "cache", "a.bin")])) }).instance, [item(r2, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/opened a file in it|put back/) });
    calls = 0;
    const { scanner: s3, tokens: t3, report: r3 } = await scanned();
    job = await run(cleaner(t3, s3, { snapshot: async () => (calls++ === 0 ? calm() : { processes: [], open: [], complete: false, why: "lsof timed out" }) }).instance, [item(r3, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/just before deleting \(lsof timed out\)/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    expect(hasQuarantine(app)).toBe(false);
  });

  it("5: a quarantine Hosts can't look at (EACCES) keeps its entry, shows as couldn't-check, and blocks every delete", async () => {
    const { chmodSync, mkdtempSync } = await import("node:fs");
    const { UNCHECKED_PROBLEM } = await import("../server/disk-quarantine");
    const locked = join(root, "locked");
    mkdirSync(locked);
    const quarantine = mkdtempSync(join(locked, ".hosts-quarantine-"));
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    await inventory.add({ quarantine, original: join(app, "build"), name: "build", dev: 1, ino: 1, bytes: 10, at: Date.now() });
    chmodSync(locked, 0o000);
    try {
      const outcome = await inventory.recover();
      expect(outcome.unchecked).toHaveLength(1);
      expect(outcome.problem).toBe(UNCHECKED_PROBLEM);
      expect(await inventory.list()).toHaveLength(1);
      expect((await inventory.status()).entries[0]).toMatchObject({ state: "unchecked" });
      const { scanner, tokens, report } = await scanned();
      const job = await run(cleaner(tokens, scanner, { inventory }).instance, [item(report, ".next")!.token!]);
      expect(job.results[0]).toMatchObject({ ok: false, message: UNCHECKED_PROBLEM });
      expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
    } finally { chmodSync(locked, 0o700); }
  });

  it("6: a delete interrupted after rm started is never shown as restored; its record stays until dismissed", async () => {
    const { mkdtempSync } = await import("node:fs");
    const inventory = new QuarantineInventory(join(places.stateDir, "quarantine.json"));
    // What remove() records: "moved", then "removing" right before rm.
    const seen: string[] = [];
    const st = lstatSync(join(app, "dist"));
    await quarantineAndRemove(join(app, "dist"), { dev: st.dev, ino: st.ino, bytes: 1 }, { group: new ChildGroup(), deadline: Date.now() + 60_000, inventory, beforeRemove: async () => { seen.push(...(await inventory.list()).map((entry) => entry.stage ?? "?")); } });
    expect(seen).toEqual(["removing"]);
    // An rm that stopped halfway: the item is in its quarantine with part of it gone.
    const quarantine = mkdtempSync(join(app, ".hosts-quarantine-"));
    const nm = lstatSync(join(app, "node_modules"));
    await inventory.add({ quarantine, original: join(app, "node_modules"), name: "node_modules", dev: nm.dev, ino: nm.ino, bytes: 3 * MB, at: Date.now() });
    renameSync(join(app, "node_modules"), join(quarantine, "node_modules"));
    await inventory.removing(quarantine);
    rmSync(join(quarantine, "node_modules", "react"), { recursive: true });
    const outcome = await inventory.recover();
    // Put back (no-replace) but never called restored: it may be incomplete.
    expect(outcome.restored).toEqual([]);
    expect(outcome.incomplete).toHaveLength(1);
    expect(existsSync(join(app, "node_modules"))).toBe(true);
    expect((await inventory.status()).entries).toEqual([expect.objectContaining({ state: "incomplete", setAside: false, quarantine })]);
    expect(await inventory.blocker()).toBeNull();
    // A second load changes nothing; only dismissing drops the record.
    await inventory.recover();
    expect(await inventory.list()).toHaveLength(1);
    expect(await inventory.dismiss(quarantine)).toBe(true);
    expect(await inventory.list()).toEqual([]);
  });
});

describe("Astra re-review of de4291e", () => {
  it("1: eligibility is the exact spelling: a hand-made Build is never build, on a case-sensitive or case-insensitive disk", async () => {
    const { diskWorker } = await import("../server/disk-worker");
    const { CLEARABLE_NAMES, IGNORED_ONLY_NAMES } = await import("../shared/disk");
    // A case-sensitive disk (fake fs): both "Build" and "build" exist side by side.
    const dirStat = { isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, nlink: 1, size: 0, blocks: 0, mtimeMs: 1 };
    const files: Record<string, string[]> = { "/w": ["Build", "build", "NODE_MODULES", "node_modules"], "/w/Build": [], "/w/build": [], "/w/NODE_MODULES": [], "/w/node_modules": [] };
    let ino = 10;
    const fs = { lstatSync: () => ({ ...dirStat, ino: ino++ }), readdirSync: (path: string) => files[path] ?? [] };
    const results: Array<{ items: Array<{ name: string }> }> = [];
    diskWorker(fs as never, { op: "scan", roots: [{ id: "w", path: "/w", mode: "workspace" }], deadline: Date.now() + 10_000, clearable: Object.keys(CLEARABLE_NAMES), ignoredOnly: Object.keys(IGNORED_ONLY_NAMES), ignoredMaxDepth: 4, maxItemsPerRoot: 50 }, (result) => results.push(result as never));
    expect(results[0]!.items.map((entry) => entry.name).sort()).toEqual(["build", "node_modules"]);
    // This Mac's disk (usually case-insensitive): a real "Build" folder, git-ignored, is never offered, and a forged token for it is refused.
    mkdirSync(join(app, "Build", "src"), { recursive: true }); writeFileSync(join(app, "Build", "src", "notes.txt"), "hand-made\n");
    writeFileSync(join(app, ".gitignore"), "node_modules\n.next\ndist/\n.env\nBuild/\nbuild/\n");
    const { scanner, tokens, report } = await scanned();
    expect(report.workspaces.flatMap((w) => w.items).map((entry) => entry.where)).not.toContain("Build");
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, "Build"))]);
    expect(job.results[0]).toMatchObject({ ok: false });
    expect(existsSync(join(app, "Build", "src", "notes.txt"))).toBe(true);
    // On a case-insensitive disk ".../build" opens the "Build" folder: a token spelled "build" is still refused (the parent lists "Build").
    if (existsSync(join(app, "build"))) {
      const st = lstatSync(join(app, "build"));
      const forged = tokens.mint({ path: join(app, "build"), root: app, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, workspace: "App", bytes: 1, what: "x", cost: "y" });
      const second = await run(cleaner(tokens, scanner).instance, [forged]);
      expect(second.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/name on disk isn't exactly|isn't where its name says/) });
      expect(existsSync(join(app, "Build", "src", "notes.txt"))).toBe(true);
    }
  });
});

describe("Astra re-review of de4291e (2, 3, 5)", () => {
  const classify = (argv: string[]) => classifyJob(argv)?.label ?? null;
  it("2: a process that names a path in the workspace on its command line uses it, wherever it runs", async () => {
    const { argvPaths, workspaceUsers } = await import("../server/disk-inuse");
    expect(argvPaths({ argv: ["python3", "-m", "http.server", "--directory", `${app}/dist`], cwd: "/elsewhere" })).toContain(`${app}/dist`);
    expect(argvPaths({ argv: [`--root=${app}/dist`], cwd: null })).toContain(`${app}/dist`);
    expect(argvPaths({ argv: ["serve", "../app/dist"], cwd: join(app, "..", "other") })).toContain(join(app, "dist"));
    expect(workspaceUsers({ processes: [proc(["python3", "-m", "http.server", "--directory", `${app}/dist`], "/elsewhere")] }, app, classify)).toMatchObject({ unknownFolder: false });
    expect(workspaceUsers({ processes: [proc(["node", "server.js", "--port=3000"], "/elsewhere")] }, app, classify)).toBeNull();
    const { scanner, tokens, report } = await scanned();
    let calls = 0;
    // Started between the check and the final look: the final look sees it by its argv and puts the folder back.
    const job = await run(cleaner(tokens, scanner, { snapshot: async () => (calls++ === 0 ? calm() : calm([proc(["python3", "-m", "http.server", "--directory", join(app, ".next")], "/elsewhere", 70)])) }).instance, [item(report, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/put back/) });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
  });

  it("5: a bare shell reading a script (bash < build.sh) or not on a terminal is busy; only a terminal shell is idle", async () => {
    const { workspaceUsers, stdinFromLink, parseLsof } = await import("../server/disk-inuse");
    expect(workspaceUsers({ processes: [proc(["bash"], app, 50, 1, "tty")] }, app, classify)).toBeNull();
    for (const stdin of ["file", "pipe", "none", "other"] as const) expect(workspaceUsers({ processes: [proc(["bash"], app, 50, 1, stdin)] }, app, classify), stdin).toMatchObject({ why: expect.stringMatching(/reading a script/) });
    expect(stdinFromLink("/dev/pts/3")).toBe("tty");
    expect(stdinFromLink("/home/u/app/build.sh")).toBe("file");
    expect(stdinFromLink("pipe:[1234]")).toBe("pipe");
    expect(stdinFromLink(null)).toBe("none");
    const lsof = parseLsof("p9\nf0\ntCHR\nn/dev/ttys003\np10\nf0\ntREG\nn/Users/x/app/build.sh\np11\nf0\ntPIPE\nn->0x1234\n");
    expect([lsof.stdin.get(9), lsof.stdin.get(10), lsof.stdin.get(11)]).toEqual(["tty", "file", "pipe"]);
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner, { snapshot: async () => calm([proc(["bash"], app, 50, 1, "file")]) }).instance, [item(report, ".next")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: false });
    expect(existsSync(join(app, ".next", "cache", "a.bin"))).toBe(true);
  });

  it("3: macOS: an exited ps row is dropped; a reused PID (different start) is dropped; a live one with the same start refuses", async () => {
    const D = "Thu Oct  8 17:01:23 2026";
    const deps = (alive: (pid: number) => boolean, start: (pid: number) => string | null): SnapshotDeps => ({ readdir: async () => [], readFile: async () => "", readlink: async () => "", alive, startOf: async (pid) => start(pid),
      run: async (file: string) => (file === "ps" ? { code: 0, stdout: `  9 1 501 S ${D} node x.js\n 13 1 501 S ${D} gone\n` } : { code: 0, stdout: "p9\nfcwd\nn/Users/x/app\n" }) });
    expect(await hostSnapshot("darwin", 501, deps((pid) => pid !== 13, () => "Thu Oct 8 17:01:23 2026"))).toMatchObject({ complete: true, processes: [{ pid: 9 }] });
    expect(await hostSnapshot("darwin", 501, deps(() => true, (pid) => (pid === 13 ? "Thu Oct 8 17:09:59 2026" : "Thu Oct 8 17:01:23 2026")))).toMatchObject({ complete: true, processes: [{ pid: 9 }] });
    expect(await hostSnapshot("darwin", 501, deps(() => true, () => "Thu Oct 8 17:01:23 2026"))).toMatchObject({ complete: false, why: expect.stringMatching(/PID 13/) });
  });
});

describe("Astra re-review of de4291e (4: crash stages)", () => {
  const set = async (inventory: QuarantineInventory, original: string, stage: "moving" | "moved" | "removing", manifest = true) => {
    const { mkdtempSync } = await import("node:fs");
    const quarantine = mkdtempSync(join(join(original, ".."), ".hosts-quarantine-"));
    const st = lstatSync(original);
    await inventory.add({ quarantine, original, name: "node_modules", dev: st.dev, ino: st.ino, bytes: 3 * MB, at: Date.now() });
    if (stage === "moving") return quarantine;
    renameSync(original, join(quarantine, "node_modules"));
    if (manifest) await inventory.moved(quarantine, MANIFEST);
    if (stage === "removing") await inventory.removing(quarantine);
    return quarantine;
  };
  const journal = () => new QuarantineInventory(join(places.stateDir, `q-${Math.random()}.json`));

  it("moving, original still there, quarantine empty: nothing happened, the entry is dropped", async () => {
    const inventory = journal();
    const quarantine = await set(inventory, join(app, "node_modules"), "moving");
    const outcome = await inventory.recover();
    expect(outcome.dropped).toHaveLength(1);
    expect(await inventory.list()).toEqual([]);
    expect(existsSync(quarantine)).toBe(false);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("moving, item already moved: rm never ran, so it goes back whole, whatever the count", async () => {
    const inventory = journal();
    const quarantine = await set(inventory, join(app, "node_modules"), "moving");
    renameSync(join(app, "node_modules"), join(quarantine, "node_modules"));
    writeFileSync(join(quarantine, "node_modules", "extra"), "x");
    const outcome = await inventory.recover();
    expect(outcome.restored).toHaveLength(1);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect(await inventory.list()).toEqual([]);
  });

  it("moved with a changed count still goes back whole: a count proves nothing either way", async () => {
    const inventory = journal();
    const quarantine = await set(inventory, join(app, "node_modules"), "moved");
    rmSync(join(quarantine, "node_modules", "react", "index.js"));
    const outcome = await inventory.recover();
    expect(outcome.restored).toHaveLength(1);
    expect(existsSync(join(app, "node_modules", "react"))).toBe(true);
  });

  it("moving or moved with its place taken: set aside, not deleted, and said so", async () => {
    for (const stage of ["moving", "moved"] as const) {
      const inventory = journal();
      if (!existsSync(join(app, "node_modules"))) big(join(app, "node_modules", "react", "index.js"));
      const quarantine = await set(inventory, join(app, "node_modules"), stage);
      if (stage === "moving") renameSync(join(app, "node_modules"), join(quarantine, "node_modules"));
      mkdirSync(join(app, "node_modules"));
      const outcome = await inventory.recover();
      expect(outcome.aside).toHaveLength(1);
      expect((await inventory.status()).entries[0]).toMatchObject({ state: "aside", setAside: true });
      expect(await inventory.dismiss(quarantine)).toBe(false);
      rmSync(join(app, "node_modules"), { recursive: true });
      renameSync(join(quarantine, "node_modules"), join(app, "node_modules"));
      rmSync(quarantine, { recursive: true });
    }
  });

  it("removing, even with contents exactly the manifest: put back but only ever 'may be incomplete'", async () => {
    const inventory = journal();
    await set(inventory, join(app, "node_modules"), "removing");
    const outcome = await inventory.recover();
    expect(outcome.restored).toEqual([]);
    expect(outcome.incomplete).toHaveLength(1);
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
    expect((await inventory.status()).entries[0]).toMatchObject({ state: "incomplete", setAside: false });
  });

  it("removing with its place taken: stays set aside and 'may be incomplete'", async () => {
    const inventory = journal();
    const quarantine = await set(inventory, join(app, "node_modules"), "removing");
    mkdirSync(join(app, "node_modules"));
    expect((await inventory.recover()).incomplete).toHaveLength(1);
    expect((await inventory.status()).entries[0]).toMatchObject({ state: "incomplete", setAside: true });
    expect(existsSync(join(quarantine, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("an rm that stops part way in this session: put back, 'may be incomplete', never restored", async () => {
    const { chmodSync } = await import("node:fs");
    const inventory = journal();
    const st = lstatSync(join(app, "node_modules"));
    const result = await quarantineAndRemove(join(app, "node_modules"), { dev: st.dev, ino: st.ino, bytes: 1 }, {
      group: new ChildGroup(), deadline: Date.now() + 120_000, inventory,
      // A folder rm can't empty: everything else goes, this stays.
      beforeRemove: (moved) => { mkdirSync(join(moved, "stuck", "inner"), { recursive: true }); writeFileSync(join(moved, "stuck", "inner", "f"), "x"); chmodSync(join(moved, "stuck"), 0o500); },
    });
    const locked = join(app, "node_modules", "stuck");
    try {
      expect(result).toMatchObject({ ok: false, partial: true, error: expect.stringContaining("A delete was interrupted; this folder may be incomplete. Run the project's install or build to be sure.") });
      expect(result.error).not.toMatch(/part of it is gone|removed part/);
      expect((await inventory.status()).entries[0]).toMatchObject({ state: "incomplete", setAside: false });
      expect(existsSync(locked)).toBe(true);
    } finally { if (existsSync(locked)) chmodSync(locked, 0o700); }
  });

});

describe("final Astra gate on 3ac1b6e", () => {
  const ASK = /only deletes folders a tool makes/;

  it("1: a git-ignored dist with hand-made files and credentials is never offered, and a token for it is refused", async () => {
    big(join(app, "dist", "service-account.json"), 100);
    big(join(app, "dist", "notes.md"), 100);
    const { scanner, tokens, report } = await scanned();
    const { ASK_ONLY } = await import("../server/disk-scan");
    expect(item(report, "dist")).toMatchObject({ safe: false, token: null, blocked: ASK_ONLY });
    const job = await run(cleaner(tokens, scanner).instance, [mintFor(tokens, join(app, "dist"))]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(ASK) });
    expect(existsSync(join(app, "dist", "service-account.json"))).toBe(true);
    expect(existsSync(join(app, "dist", "notes.md"))).toBe(true);
  });

  it("1: build, out, coverage, test reports, storybook-static and .cache are Ask-an-agent only, even with a valid token", async () => {
    const names = ["build", "out", "coverage", "test-results", "playwright-report", "storybook-static", ".cache"];
    writeFileSync(join(app, ".gitignore"), `node_modules\n.next\ndist/\n.env\n${names.join("\n")}\n`);
    for (const name of names) big(join(app, name, "a.bin"), 100);
    const { scanner, tokens, report } = await scanned();
    for (const name of names) expect(item(report, name), name).toMatchObject({ safe: false, token: null });
    const job = await run(cleaner(tokens, scanner).instance, names.map((name) => mintFor(tokens, join(app, name))));
    expect(job.results.every((r) => !r.ok && ASK.test(r.message ?? ""))).toBe(true);
    for (const name of names) expect(existsSync(join(app, name, "a.bin")), name).toBe(true);
  });

  it("1: credential-shaped files inside .next are refused at the check, and at the look inside if they appear later", async () => {
    for (const file of ["server.pem", "tls.key", "store.p12", "a.pfx", "release.keystore", "id_rsa", "id_ed25519.pub", "my-service-account-prod.json", "credentials", "credentials.json", ".npmrc", ".netrc", "prod.env", ".env.local"]) {
      big(join(app, ".next", "standalone", file), 10);
      const { report } = await scanned();
      expect(item(report, ".next"), file).toMatchObject({ safe: false, token: null, blocked: expect.stringMatching(/\.env file|key or credentials/) });
      rmSync(join(app, ".next", "standalone"), { recursive: true });
    }
    const { scanner, tokens, report } = await scanned();
    const token = item(report, ".next")!.token!;
    // Inside an existing folder, so .next itself looks unchanged and only the look inside can catch it.
    big(join(app, ".next", "cache", "Credentials.JSON"), 10);
    const job = await run(cleaner(tokens, scanner, { beforeRemove: () => { throw new Error("rm must not run"); } }).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/key or credentials.*put back/) });
    expect(existsSync(join(app, ".next", "cache", "Credentials.JSON"))).toBe(true);
  });

  it("1: a top-level source file in .vite, .turbo, .parcel-cache or .pytest_cache is refused; deeper ones are the tool's own", async () => {
    writeFileSync(join(app, ".gitignore"), "node_modules\n.next\ndist/\n.env\n.vite\n.turbo\n.parcel-cache\n.pytest_cache\n");
    big(join(app, ".vite", "deps", "react.js"), 100);
    big(join(app, ".turbo", "cookies", "1.cookie"), 100);
    const first = await scanned();
    expect(item(first.report, ".vite")).toMatchObject({ safe: true });
    expect(item(first.report, ".turbo")).toMatchObject({ safe: true });
    for (const [folder, file] of [[".vite", "config.ts"], [".turbo", "run.js"], [".parcel-cache", "main.py"], [".pytest_cache", "helper.go"], [".vite", "lib.RS"], [".turbo", "view.tsx"]] as const) {
      big(join(app, folder, file), 10);
      expect(item((await scanned()).report, folder), `${folder}/${file}`).toMatchObject({ safe: false, blocked: expect.stringMatching(/its tool didn't create|source file at its top level/) });
      rmSync(join(app, folder, file));
    }
    // Appears after the check: the look inside refuses it and puts the folder back. A whole-second mtime,
    // set again after the write, so .vite looks unchanged and only the look inside can catch it.
    utimesSync(join(app, ".vite"), 1_700_000_000, 1_700_000_000);
    const { scanner, tokens, report } = await scanned();
    const token = item(report, ".vite")!.token!;
    big(join(app, ".vite", "plugin.ts"), 10);
    utimesSync(join(app, ".vite"), 1_700_000_000, 1_700_000_000);
    const job = await run(cleaner(tokens, scanner, { beforeRemove: () => { throw new Error("rm must not run"); } }).instance, [token]);
    expect(job.results[0], JSON.stringify(job.results[0])).toMatchObject({ ok: false, message: expect.stringMatching(/(its tool didn't create: plugin\.ts|source file at its top level).*put back/) });
    expect(existsSync(join(app, ".vite", "plugin.ts"))).toBe(true);
  });

  it("1: node_modules is exempt from the credential check (packages ship test keys and .npmrc); its lockfile stands in", async () => {
    big(join(app, "node_modules", "some-pkg", "test", "fixture.pem"), 10);
    big(join(app, "node_modules", "other", ".npmrc"), 10);
    const { scanner, tokens, report } = await scanned();
    expect(item(report, "node_modules")).toMatchObject({ safe: true });
    const job = await run(cleaner(tokens, scanner).instance, [item(report, "node_modules")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: true });
    expect(existsSync(join(app, "node_modules"))).toBe(false);
  });

  it("1: node_modules without a lockfile beside its package.json is refused at the check and by the cleaner", async () => {
    const { scanner, tokens } = await scanned();
    const token = mintFor(tokens, join(app, "node_modules"));
    rmSync(join(app, "package-lock.json"));
    const { NO_LOCKFILE } = await import("../server/disk-scan");
    expect(item((await scanned()).report, "node_modules")).toMatchObject({ safe: false, token: null, blocked: NO_LOCKFILE });
    const job = await run(cleaner(tokens, scanner).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: NO_LOCKFILE });
    expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  it("1: hasLockfile: needs package.json beside it; a lockfile there or at a package.json above it, never above the workspace root", async () => {
    const { hasLockfile } = await import("../server/disk-scan");
    const nested = join(app, "packages", "ui");
    mkdirSync(join(nested, "node_modules"), { recursive: true });
    expect(await hasLockfile(join(nested, "node_modules"), app)).toBe(false);
    writeFileSync(join(nested, "package.json"), "{}");
    expect(await hasLockfile(join(nested, "node_modules"), app)).toBe(true);
    for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]) {
      rmSync(join(app, "package-lock.json"), { force: true });
      for (const other of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]) rmSync(join(app, other), { force: true });
      writeFileSync(join(app, lock), "");
      expect(await hasLockfile(join(app, "node_modules"), app), lock).toBe(true);
    }
    for (const other of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]) rmSync(join(app, other), { force: true });
    // A lockfile above the workspace root doesn't count, and neither does a folder named like one.
    writeFileSync(join(app, "..", "package.json"), "{}");
    writeFileSync(join(app, "..", "package-lock.json"), "{}");
    mkdirSync(join(app, "yarn.lock"));
    expect(await hasLockfile(join(app, "node_modules"), app)).toBe(false);
  });

  it("real delete of node_modules WITH a lockfile; refusal WITHOUT one (real rm, temp workspace)", async () => {
    const { scanner, tokens, report } = await scanned();
    const job = await run(cleaner(tokens, scanner).instance, [item(report, "node_modules")!.token!]);
    expect(job.results[0]).toMatchObject({ ok: true });
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    expect(hasQuarantine(app)).toBe(false);
    big(join(worktree, "node_modules", "y.js"), 100);
    rmSync(join(worktree, "package-lock.json"));
    const again = await scanned([idleWorkspace(), { ...idleWorkspace("done", worktree), id: "wks_2", worktree: true }]);
    expect(again.report.workspaces.find((w) => w.path === app)!.items.find((i) => i.where === "node_modules")).toBeUndefined();
    const wt = again.report.workspaces.find((w) => w.path === worktree)!.items.find((i) => i.where === "node_modules");
    expect(wt).toMatchObject({ safe: false, token: null });
    expect(existsSync(join(worktree, "node_modules", "y.js"))).toBe(true);
  });
});

describe("final Astra gate on 3ac1b6e (2, 3: every stage → its words, in the note and the handoff)", () => {
  const stages = async (stage: "moving" | "moved" | "removing", taken: boolean) => {
    const { mkdtempSync } = await import("node:fs");
    const original = join(app, "node_modules");
    if (!existsSync(original)) big(join(original, "react", "index.js"));
    const quarantine = mkdtempSync(join(app, ".hosts-quarantine-"));
    const inventory = new QuarantineInventory(join(places.stateDir, `q-${stage}-${taken}.json`));
    const st = lstatSync(original);
    await inventory.add({ quarantine, original, name: "node_modules", dev: st.dev, ino: st.ino, bytes: 3 * MB, at: Date.now() });
    renameSync(original, join(quarantine, "node_modules"));
    if (stage !== "moving") await inventory.moved(quarantine, MANIFEST);
    if (stage === "removing") await inventory.removing(quarantine);
    if (taken) mkdirSync(original);
    return { inventory, quarantine };
  };
  const NOTE = {
    aside: "Set aside, not deleted: ~/code/app/node_modules. The delete stopped before anything was removed, and it couldn't be put back without replacing something. It's in a hidden folder beside it; ask an agent to move it back.",
    incompleteAside: "A delete was interrupted; ~/code/app/node_modules may be incomplete. Run the project's install or build to be sure. What's there is set aside in a hidden folder beside it; ask an agent to check it.",
    incompleteBack: "A delete was interrupted; ~/code/app/node_modules may be incomplete. Run the project's install or build to be sure.",
  };
  const cases = [
    { stage: "moving", taken: false, state: null, note: null },
    { stage: "moved", taken: false, state: null, note: null },
    { stage: "moving", taken: true, state: "aside", note: NOTE.aside },
    { stage: "moved", taken: true, state: "aside", note: NOTE.aside },
    { stage: "removing", taken: false, state: "incomplete", note: NOTE.incompleteBack },
    { stage: "removing", taken: true, state: "incomplete", note: NOTE.incompleteAside },
  ] as const;

  for (const c of cases) {
    it(`${c.stage}${c.taken ? ", its place taken" : ""} → ${c.state ?? "put back whole, no note"}`, async () => {
      const { leftoverView } = await import("../server/disk-scan");
      const { inventory } = await stages(c.stage, c.taken);
      const outcome = await inventory.recover();
      const entries = (await inventory.status()).entries;
      if (!c.state) {
        expect(outcome.restored).toHaveLength(1);
        expect(entries).toEqual([]);
        expect(existsSync(join(app, "node_modules", "react", "index.js"))).toBe(true);
        return;
      }
      expect(outcome.restored).toEqual([]);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.state).toBe(c.state);
      const view = leftoverView(entries[0]!, { home: places.home, paseoHome: places.paseoHome });
      expect(view.message).toBe(c.note);
      // The handoff says the same, and never more.
      if (c.state === "aside") expect(view.text).toMatch(/stopped before it removed anything[\s\S]*set aside, not deleted/);
      else expect(view.text).toContain("may be incomplete. Run the project's install or build to be sure.");
      for (const words of [view.message, view.text, view.title]) expect(words).not.toMatch(/Part of it is gone|removed part|partly removed|untouched\.$/);
      if (c.stage !== "removing") expect(view.text).not.toMatch(/incomplete/);
    });
  }

  it("couldn't check → its own words, nothing claimed", async () => {
    const { leftoverMessage } = await import("../shared/disk");
    const { leftoverLead } = await import("../server/disk-scan");
    expect(leftoverMessage("unchecked", "~/x")).toBe("Couldn't check a leftover from an interrupted delete (~/x). Nothing is deleted until Hosts can look at it.");
    expect(leftoverLead("unchecked", "~/x", "1 MB", true)).not.toMatch(/gone|removed|incomplete/);
  });
});

describe("final Astra gate on 279d2cf: by structure, not by extension", () => {
  /**
   * Top-level names from real layouts made on 2026-10-09 (Next 15.x and
   * 16.4 build/standalone/dev, Nuxt 4 build plus a real dev .nuxt, SvelteKit
   * 2 and 3, Turbo 2.11 root and package, Vite 8 + Vitest 5, Parcel 2.16,
   * pytest 8, CPython 3.14). A trailing "/" is a folder.
   */
  const REAL: Record<string, string[]> = {
    ".next": ["BUILD_ID", "app-build-manifest.json", "app-path-routes-manifest.json", "build-manifest.json", "cache/", "dev/", "diagnostics/", "dynamic-css-manifest.json", "export-marker.json", "fallback-build-manifest.json", "images-manifest.json", "next-minimal-server.js.nft.json", "next-server.js.nft.json", "package.json", "prerender-manifest.json", "react-loadable-manifest.json", "required-server-files.js", "required-server-files.json", "routes-manifest.json", "server/", "standalone/", "static/", "trace", "trace-build", "turbopack", "types/"],
    ".nuxt": [".DS_Store", "app.config.mjs", "components.d.ts", "dev/", "dist/", "fetch.d.ts", "imports.d.ts", "manifest/", "nitro.json", "nuxt.d.ts", "nuxt.json", "nuxt.node.d.ts", "nuxt.shared.d.ts", "schema/", "tsconfig.app.json", "tsconfig.app.tsbuildinfo", "tsconfig.json", "tsconfig.node.json", "tsconfig.node.tsbuildinfo", "tsconfig.server.json", "tsconfig.server.tsbuildinfo", "tsconfig.shared.json", "tsconfig.shared.tsbuildinfo", "types/"],
    ".svelte-kit": ["ambient.d.ts", "env.d.ts", "generated/", "non-ambient.d.ts", "output/", "tsconfig.json", "types/"],
    ".turbo": ["cache/", "runs/", "turbo-build.log"],
    ".vite": ["deps/", "vitest/"],
    ".parcel-cache": ["22899de899d4c27b-BundleGraph", "7daea178f9b48961-RequestGraph", "880d99dfa4847a06-AssetGraph", "c23923128c744515-AssetGraph", "data.mdb", "lock.mdb", "snapshot-7daea178f9b48961.txt"],
    ".pytest_cache": [".gitignore", "CACHEDIR.TAG", "README.md", "v/"],
    __pycache__: ["cache-trim.cpython-314.pyc", "devserver-guard.cpython-314.pyc"],
  };
  const KINDS = Object.keys(REAL);
  const lay = (kind: string, names = REAL[kind]!) => {
    for (const name of names) {
      if (name.endsWith("/")) big(join(app, kind, name, "inner.bin"), 100);
      else big(join(app, kind, name), 100);
    }
  };
  const ignoreAll = () => writeFileSync(join(app, ".gitignore"), `node_modules\n.env\ndist/\n${KINDS.join("\n")}\n`);

  it("a real-shaped folder of every kind passes the check and the look inside, and is deleted", async () => {
    rmSync(join(app, ".next"), { recursive: true });
    ignoreAll();
    for (const kind of KINDS) lay(kind);
    const { scanner, tokens, report } = await scanned();
    for (const kind of KINDS) expect(item(report, kind), kind).toMatchObject({ safe: true, blocked: null });
    const job = await run(cleaner(tokens, scanner).instance, KINDS.map((kind) => item(report, kind)!.token!));
    for (const result of job.results) expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    for (const kind of KINDS) expect(existsSync(join(app, kind)), kind).toBe(false);
  });

  it("the reviewer's repro: a hand-made .turbo/custom.mjs is never offered, and the look inside refuses it if it appears later", async () => {
    ignoreAll();
    lay(".turbo");
    big(join(app, ".turbo", "custom.mjs"), 4096);
    const first = await scanned();
    expect(item(first.report, ".turbo")).toMatchObject({ safe: false, token: null, blocked: ".turbo holds something its tool didn't create: custom.mjs. Hosts leaves it." });
    rmSync(join(app, ".turbo", "custom.mjs"));
    // Clean at the check; the file appears after it with .turbo's mtime kept, so only the look inside can catch it.
    utimesSync(join(app, ".turbo"), 1_700_000_000, 1_700_000_000);
    const { scanner, tokens, report } = await scanned();
    const token = item(report, ".turbo")!.token!;
    big(join(app, ".turbo", "custom.mjs"), 4096);
    utimesSync(join(app, ".turbo"), 1_700_000_000, 1_700_000_000);
    const job = await run(cleaner(tokens, scanner, { beforeRemove: () => { throw new Error("rm must not run"); } }).instance, [token]);
    expect(job.results[0]).toMatchObject({ ok: false, message: ".turbo holds something its tool didn't create: custom.mjs, so it was put back." });
    expect(existsSync(join(app, ".turbo", "custom.mjs"))).toBe(true);
    expect(existsSync(join(app, ".turbo", "cache", "inner.bin"))).toBe(true);
  });

  it("anything else at the top level refuses: another folder, another file, a symlink, a folder where a file belongs, any kind", async () => {
    ignoreAll();
    const strays: Array<[string, (dir: string) => void, string]> = [
      [".next", (dir) => big(join(dir, "my-notes", "a.md"), 10), "my-notes"],
      [".nuxt", (dir) => big(join(dir, "seed.sql"), 10), "seed.sql"],
      [".svelte-kit", (dir) => big(join(dir, "backup", "x"), 10), "backup"],
      [".vite", (dir) => symlinkSync(join(app, "src"), join(dir, "deps_link")), "deps_link"],
      [".vite", (dir) => big(join(dir, "results.json"), 10), "results.json"],
      [".parcel-cache", (dir) => big(join(dir, "readme.txt"), 10), "readme.txt"],
      [".pytest_cache", (dir) => big(join(dir, "v2", "x"), 10), "v2"],
      [".pytest_cache", (dir) => big(join(dir, "README.md", "x"), 10), "README.md"],
      ["__pycache__", (dir) => big(join(dir, "helper.py"), 10), "helper.py"],
      ["__pycache__", (dir) => big(join(dir, "sub", "a.pyc"), 10), "sub"],
      [".turbo", (dir) => big(join(dir, "Cache", "x"), 10), "Cache"],
    ];
    for (const [kind, add, name] of strays) {
      rmSync(join(app, kind), { recursive: true, force: true });
      // Compared without case: on a case-insensitive disk "Cache" would land in "cache".
      lay(kind, REAL[kind]!.filter((entry) => entry.replace(/\/$/, "").toLowerCase() !== name.toLowerCase()));
      add(join(app, kind));
      expect(item((await scanned()).report, kind), `${kind}/${name}`).toMatchObject({ safe: false, token: null, blocked: `${kind} holds something its tool didn't create: ${name}. Hosts leaves it.` });
    }
  });

  it("the stray's name is redacted before it's shown", async () => {
    const { strayWords } = await import("../shared/disk");
    expect(strayWords(".next", "token=supersecretvalue123")).not.toContain("supersecretvalue123");
  });

  it("defence in depth: the source check covers mjs, cjs, jsx, vue, svelte, sh and the rest, at the top level only", async () => {
    const { diskWorker } = await import("../server/disk-worker");
    const { TOP_SOURCE_PATTERN, CREDENTIAL_PATTERN } = await import("../shared/disk");
    const fs = await import("node:fs");
    for (const ext of ["mjs", "cjs", "mts", "cts", "jsx", "vue", "svelte", "astro", "rb", "php", "java", "kt", "swift", "c", "cpp", "h", "cs", "sh", "ts", "js", "py", "go", "rs"]) {
      const dir = join(root, `probe-${ext}`);
      big(join(dir, `a.${ext}`), 10);
      big(join(dir, "deep", `b.${ext}`), 10);
      const out: Array<{ hasTopSource?: boolean }> = [];
      diskWorker(fs, { op: "scan", roots: [{ id: "x", path: dir, mode: "whole" }], deadline: Date.now() + 10_000, clearable: [], ignoredOnly: [], ignoredMaxDepth: 0, maxItemsPerRoot: 0, credential: CREDENTIAL_PATTERN, topSource: TOP_SOURCE_PATTERN }, (result) => out.push(result as never));
      expect(out[0]!.hasTopSource, ext).toBe(true);
      rmSync(join(dir, `a.${ext}`));
      out.length = 0;
      diskWorker(fs, { op: "scan", roots: [{ id: "x", path: dir, mode: "whole" }], deadline: Date.now() + 10_000, clearable: [], ignoredOnly: [], ignoredMaxDepth: 0, maxItemsPerRoot: 0, credential: CREDENTIAL_PATTERN, topSource: TOP_SOURCE_PATTERN }, (result) => out.push(result as never));
      expect(out[0]!.hasTopSource, `deep ${ext}`).toBe(false);
    }
    const { itemBlocked } = await import("../server/disk-scan");
    const guard = { folded: new Set<string>(), workspaceRoots: [], worktreeRoots: [], byRoot: new Map() } as never;
    expect(itemBlocked({ name: ".vite", hasEnv: false, hasGit: false, ignoredOnly: false, partial: false, hasCredential: false, hasTopSource: true, topUnexpected: null }, { ignored: true, tracked: false, untracked: false } as never, join(app, ".vite"), guard)).toMatch(/source file at its top level/);
  });

  it("an old scan without the layout answer counts as not confirmed", async () => {
    const { itemBlocked } = await import("../server/disk-scan");
    const guard = { folded: new Set<string>(), workspaceRoots: [], worktreeRoots: [], byRoot: new Map() } as never;
    expect(itemBlocked({ name: ".next", hasEnv: false, hasGit: false, ignoredOnly: false, partial: false, hasCredential: false, hasTopSource: false }, { ignored: true, tracked: false, untracked: false } as never, join(app, ".next"), guard)).toMatch(/couldn't confirm what's at its top level/);
  });
});
