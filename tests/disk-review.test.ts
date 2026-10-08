import type { PaseoApi } from "@getpaseo/client";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAsk } from "../server/ask";
import { DiskScanner, findPnpmStore } from "../server/disk-scan";
import type { AskContext } from "../shared/ask";
import type { HealthVerdict } from "../shared/health";
import { SYNTHETIC_GITHUB_TOKEN } from "./synthetic-secrets";

/** Review fixes (0.14.0): pnpm's store without running pnpm, and every ask redacted. */

const root = realpathSync(mkdtempSync(join(tmpdir(), "hosts-review-")));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const home = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };

describe("pnpm store, found without running pnpm", () => {
  it("prefers store-dir from ~/.npmrc (with ~), then pnpm's rc, then the default place", async () => {
    const a = home("a");
    mkdirSync(join(a, "custom-store"));
    mkdirSync(join(a, "Library", "pnpm", "store"), { recursive: true });
    writeFileSync(join(a, ".npmrc"), "registry=https://registry.npmjs.org/\nstore-dir = ~/custom-store\n");
    expect(await findPnpmStore({ platform: "darwin", home: a }, {})).toBe(join(a, "custom-store"));
    const b = home("b");
    mkdirSync(join(b, "Library", "pnpm", "store"), { recursive: true });
    expect(await findPnpmStore({ platform: "darwin", home: b }, {})).toBe(join(b, "Library", "pnpm", "store"));
    const c = home("c");
    mkdirSync(join(c, ".local", "share", "pnpm", "store"), { recursive: true });
    expect(await findPnpmStore({ platform: "linux", home: c }, {})).toBe(join(c, ".local", "share", "pnpm", "store"));
    const d = home("d");
    mkdirSync(join(d, "rc-store"));
    mkdirSync(join(d, ".config", "pnpm"), { recursive: true });
    writeFileSync(join(d, ".config", "pnpm", "rc"), `store-dir=${join(d, "rc-store")}\n`);
    expect(await findPnpmStore({ platform: "linux", home: d }, {})).toBe(join(d, "rc-store"));
  });

  it("is null when nothing exists, and the scan says \"pnpm store: not found\" only when a workspace uses pnpm", async () => {
    const e = home("e");
    expect(await findPnpmStore({ platform: "darwin", home: e }, {})).toBeNull();
    const project = home("e-project");
    writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const places = { platform: "darwin" as const, home: e, paseoHome: join(e, ".paseo"), stateDir: join(e, ".paseo", "daemon-link"), tmpDirs: [], cacheBases: [], browserRoots: [] };
    const workspace = { id: "w1", name: "main", project: "P", directory: project, worktree: false, status: "idle", activityAt: null, branch: null, devServers: [] };
    const walk = async () => ({ results: [], timedOut: false, error: null });
    const scanner = new DiskScanner({ places, uid: process.getuid?.() ?? 0, listWorkspaces: async () => [workspace], cacheFile: null, scanSeconds: 10, walk: walk as never, pnpmStore: async () => null });
    scanner.start(); await scanner.wait();
    expect(scanner.last()?.warnings).toContain("pnpm store: not found.");
    const plain = new DiskScanner({ places, uid: process.getuid?.() ?? 0, listWorkspaces: async () => [{ ...workspace, directory: home("e-npm") }], cacheFile: null, scanSeconds: 10, walk: walk as never, pnpmStore: async () => null });
    plain.start(); await plain.wait();
    expect(plain.last()?.warnings).not.toContain("pnpm store: not found.");
  });
});

describe("every ask is redacted", () => {
  const verdict = { status: "ok", checkedAt: 1, background: true, issues: [], services: [], watched: [] } as unknown as HealthVerdict;
  const leaky = (kind: string): AskContext => ({
    title: `Clean up API_KEY=${SYNTHETIC_GITHUB_TOKEN} (1 GB)`,
    text: `Workspace API_KEY=${SYNTHETIC_GITHUB_TOKEN} on branch feat/token=${SYNTHETIC_GITHUB_TOKEN}\n- ~/code/x/node_modules · 1 GB · ${kind}`,
    workspaceId: "w1", workspaceName: `API_KEY=${SYNTHETIC_GITHUB_TOKEN}`, outputFrom: null,
  });
  const ask = createAsk({
    report: async () => ({ supported: false }) as never, verdict: async () => verdict, lost: () => null, home: "/home/alice",
    cleanup: async () => leaky("cleanup"), folder: async () => leaky("folder"),
  });
  for (const kind of ["cleanup", "folder"] as const) {
    it(`a ${kind} ask reaches the preview with names redacted`, async () => {
      const context = await ask.context(kind === "cleanup" ? { kind, id: "idle" } : { kind, id: "wt:/x" }, {} as PaseoApi);
      const all = `${context.title}\n${context.text}\n${context.workspaceName}`;
      expect(all).not.toContain(SYNTHETIC_GITHUB_TOKEN);
      expect(context.text).toContain("~/code/x/node_modules · 1 GB");
    });
  }
});

describe("one deadline (review fix)", () => {
  it("a stalled registry read fails after REGISTRY_READ_MS, and its late answer writes nothing", async () => {
    const { vi } = await import("vitest");
    const { ProjectScope, REGISTRY_READ_MS } = await import("../server/scope");
    vi.useFakeTimers();
    try {
      let release: (value: unknown) => void = () => undefined;
      const stalled = new Promise((resolve) => { release = resolve; });
      const project = { projectId: "p1", projectDisplayName: "Site", projectRootPath: "/home/alice/site" };
      let calls = 0;
      const api = {
        projects: { list: vi.fn(async () => { calls += 1; if (calls === 1) await stalled; return { projects: [project] }; }) },
        workspaces: { list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } })) },
      };
      const scope = new ProjectScope(async (path) => path, "/home/alice");
      scope.bind(api as unknown as PaseoApi);
      const first = scope.refresh(true).then(() => "ok", () => "failed");
      await vi.advanceTimersByTimeAsync(REGISTRY_READ_MS + 1);
      expect(await first).toBe("failed");
      await scope.refresh(true);
      expect(scope.workspaceDescriptors).toBeDefined();
      // The first read answers now, long after its deadline: dropped.
      release(undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("bounded() answers null after its time and the value otherwise", async () => {
    const { bounded } = await import("../server/runtime");
    expect(await bounded(new Promise(() => undefined), 20)).toBeNull();
    expect(await bounded(Promise.resolve(7), 20)).toBe(7);
    expect(await bounded(Promise.reject(new Error("x")), 20)).toBeNull();
  });

  it("a scan whose registry never answers finishes within its deadline, and unloading stops it", async () => {
    const e = home("deadline");
    const places = { platform: "darwin" as const, home: e, paseoHome: join(e, ".paseo"), stateDir: join(e, ".paseo", "daemon-link"), tmpDirs: [], cacheBases: [], browserRoots: [] };
    const scanner = new DiskScanner({ places, uid: process.getuid?.() ?? 0, listWorkspaces: () => new Promise(() => undefined), cacheFile: null, scanSeconds: 1, walk: (async () => ({ results: [], timedOut: false, error: null })) as never, pnpmStore: async () => null });
    const started = Date.now();
    scanner.start(); await scanner.wait();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(scanner.last()?.warnings.join(" ")).toMatch(/couldn't be read in time/);
    const again = new DiskScanner({ places, uid: process.getuid?.() ?? 0, listWorkspaces: () => new Promise(() => undefined), cacheFile: null, scanSeconds: 60, walk: (async () => ({ results: [], timedOut: false, error: null })) as never, pnpmStore: async () => null });
    again.start();
    const closing = Date.now();
    await again.close();
    expect(Date.now() - closing).toBeLessThan(60_000);
  });
});

describe("second review (1ba11b3)", () => {
  const scannerFor = (name: string, listWorkspaces: () => Promise<never[]>) => {
    const e = home(name);
    const places = { platform: "darwin" as const, home: e, paseoHome: join(e, ".paseo"), stateDir: join(e, ".paseo", "daemon-link"), tmpDirs: [], cacheBases: [], browserRoots: [] };
    return new DiskScanner({ places, uid: process.getuid?.() ?? 0, listWorkspaces, cacheFile: null, scanSeconds: 60, walk: (async () => ({ results: [], timedOut: false, error: null })) as never, pnpmStore: async () => null });
  };
  const watchRejections = () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => { seen.push(reason); };
    process.on("unhandledRejection", listener);
    return { seen, stop: () => process.off("unhandledRejection", listener) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("start, close, then a registry rejection: no unhandledRejection, and no read started after close", async () => {
    const watch = watchRejections();
    try {
      let reject: ((error: Error) => void) | null = null;
      let calls = 0;
      const scanner = scannerFor("unload-1", () => { calls += 1; return new Promise<never[]>((_, no) => { reject = no; }); });
      scanner.start();
      await scanner.close();
      (reject as ((error: Error) => void) | null)?.(new Error("registry went away"));
      await settle();
      expect(watch.seen).toEqual([]);
      expect(calls).toBe(0);
    } finally { watch.stop(); }
  });

  it("a registry read already started, then close, then it rejects: handled", async () => {
    const watch = watchRejections();
    try {
      let reject: ((error: Error) => void) | null = null;
      let called: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { called = resolve; });
      const scanner = scannerFor("unload-2", () => { called(); return new Promise<never[]>((_, no) => { reject = no; }); });
      scanner.start();
      await started;
      await scanner.close();
      (reject as ((error: Error) => void) | null)?.(new Error("registry went away"));
      await settle(); await settle();
      expect(watch.seen).toEqual([]);
    } finally { watch.stop(); }
  });
});

describe("config files are read safely (second review)", () => {
  it("a FIFO is skipped at once, not opened and waited on", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readConfigFile } = await import("../server/disk-scan");
    const f = home("fifo");
    execFileSync("mkfifo", [join(f, ".npmrc")]);
    mkdirSync(join(f, "Library", "pnpm", "store"), { recursive: true });
    const started = Date.now();
    expect(await readConfigFile(join(f, ".npmrc"))).toBe("");
    expect(await findPnpmStore({ platform: "darwin", home: f }, {})).toBe(join(f, "Library", "pnpm", "store"));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads at most 64 KB, follows a symlink only to a regular file, and stops when cancelled", async () => {
    const { symlinkSync } = await import("node:fs");
    const { CONFIG_READ_LIMIT, readConfigFile } = await import("../server/disk-scan");
    const g = home("big");
    writeFileSync(join(g, "huge"), `store-dir=/early\n${"x".repeat(4 * 1024 * 1024)}\nstore-dir=/late\n`);
    const text = await readConfigFile(join(g, "huge"));
    expect(text.length).toBe(CONFIG_READ_LIMIT);
    expect(text).toContain("store-dir=/early");
    expect(text).not.toContain("store-dir=/late");
    symlinkSync("/dev/zero", join(g, "endless"));
    expect(await readConfigFile(join(g, "endless"))).toBe("");
    writeFileSync(join(g, "real"), "store-dir=~/s\n");
    symlinkSync(join(g, "real"), join(g, "linked"));
    expect(await readConfigFile(join(g, "linked"))).toBe("store-dir=~/s\n");
    const cancelled = new AbortController(); cancelled.abort();
    expect(await readConfigFile(join(g, "real"), cancelled.signal)).toBe("");
    expect(await findPnpmStore({ platform: "darwin", home: g }, {}, cancelled.signal)).toBeNull();
  });
});
