import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHelper, missingHelpers, privateOwnedProfile, trimCache, turboCacheDir, unlinkIfOurs, type CacheDir } from "../server/housekeeping-files";
import { takeLock } from "../server/housekeeping-lock";
import { HousekeepingLog, NO_RUNS } from "../server/housekeeping-log";
import { GATE_SH, HEAVY_RUN_SH } from "../shared/housekeeping";
import { ChildGroup, quarantineAndRemove } from "../server/disk-remove";
import { SYNTHETIC_ANTHROPIC_KEY } from "./synthetic-secrets";

const dirs: string[] = [], uid = process.getuid!(), signal = () => new AbortController().signal;
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function folder() { const dir = await mkdtemp(join(tmpdir(), "hosts-hk-files-")); dirs.push(dir); return dir; }
async function cache() {
  const dir = await folder(), root = join(dir, "site"), path = join(root, ".turbo", "cache"); await mkdir(path, { recursive: true });
  const places = { home: join(dir, "home"), paseoHome: join(dir, "paseo"), stateDir: join(dir, "state"), tmpRoots: [] };
  const checked = await turboCacheDir(root, places, uid, [root]); expect(checked).toHaveProperty("chain");
  return { dir, root, path, places, checked: checked as CacheDir };
}
async function entry(path: string, hash: string) { const file = join(path, hash.repeat(16) + ".tar.zst"); await writeFile(file, "cache"); await utimes(file, 0, 0); return file; }

describe("housekeeping physical file checks", () => {
  it("limits the same-user profile proof to private owned plain folders", async () => {
    const dir = await folder(), profile = join(dir, "profile");
    await mkdir(profile, { mode: 0o700 });
    expect(await privateOwnedProfile(profile, uid)).toBe(true);
    expect(await privateOwnedProfile(profile, uid + 1)).toBe(false);
    await chmod(profile, 0o755); expect(await privateOwnedProfile(profile, uid)).toBe(false);
    await chmod(profile, 0o700); await symlink(profile, join(dir, "link"));
    expect(await privateOwnedProfile(join(dir, "link"), uid)).toBe(false);
  });
  it("creates the exact appendix scripts exclusively; existing files and dangling links stay untouched", async () => {
    const dir = await folder(); expect(await missingHelpers(dir)).toEqual(["gate.sh", "heavy-run.sh"]);
    expect(await createHelper(dir, "gate.sh")).toBe("created");
    expect(await readFile(join(dir, "gate.sh"), "utf8")).toBe(GATE_SH);
    expect((await lstat(join(dir, "gate.sh"))).mode & 0o777).toBe(0o755);
    expect(await createHelper(dir, "heavy-run.sh")).toBe("created");
    expect(await readFile(join(dir, "heavy-run.sh"), "utf8")).toBe(HEAVY_RUN_SH);
    await writeFile(join(dir, "gate.sh"), "user copy"); expect(await createHelper(dir, "gate.sh")).toBe("present");
    expect(await readFile(join(dir, "gate.sh"), "utf8")).toBe("user copy");
    await rm(join(dir, "heavy-run.sh")); await symlink(join(dir, "missing"), join(dir, "heavy-run.sh"));
    expect(await missingHelpers(dir)).toEqual([]); expect(await createHelper(dir, "heavy-run.sh")).toBe("present");
    expect(await createHelper(dir, "unknown")).toBe("failed");
  });
  it("checks authority before each helper write, and failed cleanup never unlinks a replacement inode", async () => {
    const dir = await folder(); let checks = 0;
    expect(await createHelper(dir, "gate.sh", async () => { checks++; return false; })).toBe("failed");
    expect(await readdir(dir)).toEqual([]);
    checks = 0;
    expect(await createHelper(dir, "gate.sh", async () => {
      checks++;
      if (checks === 3) { await rename(join(dir, "gate.sh"), join(dir, "original")); await writeFile(join(dir, "gate.sh"), "replacement"); return false; }
      return true;
    })).toBe("failed");
    expect(await readFile(join(dir, "gate.sh"), "utf8")).toBe("replacement");
    const captured = await lstat(join(dir, "original")); await unlinkIfOurs(join(dir, "gate.sh"), captured);
    expect(await readFile(join(dir, "gate.sh"), "utf8")).toBe("replacement");
    await unlinkIfOurs(join(dir, "original"), captured); await expect(lstat(join(dir, "original"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preview only counts; cancellation or active use between unlinks stops the batch", async () => {
    const f = await cache(); const a = await entry(f.path, "a"), b = await entry(f.path, "b");
    const preview = await trimCache(f.checked, uid, Date.now(), 7, { preview: true, signal: signal(), mayAct: async () => { throw new Error("mustn't act"); }, budget: 100 });
    expect(preview).toMatchObject({ removed: 0, candidates: 2, bytes: 10 });
    expect(await readFile(a, "utf8")).toBe("cache");
    let checks = 0;
    const result = await trimCache(f.checked, uid, Date.now(), 7, { preview: false, signal: signal(), mayAct: async () => ++checks <= 1, budget: 100 });
    expect(result.removed).toBe(1); expect(result.stopped).toContain("cache use changed");
    expect(await readdir(f.path)).toHaveLength(1);
  });
  it("refuses a swapped cache chain, symlink, new mtime or replacement inode immediately before unlink", async () => {
    for (const change of ["chain", "symlink", "mtime", "inode"]) {
      const f = await cache(); const file = await entry(f.path, "a"); let checks = 0;
      const result = await trimCache(f.checked, uid, Date.now(), 7, { preview: false, signal: signal(), budget: 100, mayAct: async () => {
        if (++checks === 1) {
          if (change === "chain") { await rename(f.path, f.path + "-old"); await mkdir(f.path); await writeFile(file, "replacement"); }
          if (change === "symlink") { await rename(file, file + "-old"); await symlink(file + "-old", file); }
          if (change === "mtime") await utimes(file, new Date(), new Date());
          if (change === "inode") { await rename(file, file + "-old"); await writeFile(file, "replacement"); await utimes(file, 0, 0); }
        }
        return true;
      } });
      expect(result.removed, change).toBe(0); expect(await lstat(file)).toBeDefined();
    }
  });
  it("bounds metadata scans and candidates without per-file full activity scans", async () => {
    const f = await cache();
    for (let i = 0; i < 1030; i++) {
      const path = join(f.path, i.toString(16).padStart(16, "0") + ".tar");
      await writeFile(path, "cache"); await utimes(path, 0, 0);
    }
    const preview = await trimCache(f.checked, uid, Date.now(), 7, { preview: true, signal: signal(), mayAct: async () => false, budget: 20_000 });
    expect(preview).toMatchObject({ scanned: 1024, candidates: 256, truncated: true, removed: 0 });
    let activity = 0, policy = 0;
    const result = await trimCache(f.checked, uid, Date.now(), 7, { preview: false, signal: signal(), mayAct: async () => { policy++; return true; }, batchAvailable: async () => ++activity < 2, budget: 256 });
    expect(result.removed).toBe(16); expect(activity).toBe(2); expect(policy).toBe(16);
    expect(await readdir(f.path)).toHaveLength(1014);
  });
  it("rejects linked cache directories and temporary or protected roots", async () => {
    const f = await cache();
    expect(await turboCacheDir(f.root, { ...f.places, tmpRoots: [f.dir] }, uid, [f.root])).toHaveProperty("why");
    expect(await turboCacheDir(f.dir, { ...f.places, home: f.dir }, uid, [f.dir])).toHaveProperty("why");
    await rename(f.path, f.path + "-old"); await symlink(f.path + "-old", f.path);
    expect(await turboCacheDir(f.root, f.places, uid, [f.root])).toHaveProperty("why");
  });
});

describe("Housekeeping profile deletion authority", () => {
  it.each([1, 2, 3])("refuses cancellation at mutation stage %i and preserves the exact profile", async (stage) => {
    const dir = await folder(), profile = join(dir, "profile");
    await mkdir(profile); await writeFile(join(profile, "cookie"), "keep");
    const expected = await lstat(profile), group = new ChildGroup();
    let checks = 0, deletes = 0, recorded = 0;
    group.run = async () => { deletes++; throw new Error("must not delete"); };
    const result = await quarantineAndRemove(profile, { dev: expected.dev, ino: expected.ino, bytes: 4 }, {
      group, deadline: Date.now() + 60_000, flavour: async () => "gnu",
      mutationCheck: async () => ++checks === stage ? "Housekeeping cancelled" : null,
      probe: async () => ({ ok: true, why: null, manifest: { entries: 1, bytes: 4 } }),
      inventory: { add: async () => { recorded++; }, done: async () => { recorded--; } },
    });
    expect(result).toMatchObject({ ok: false, error: "Housekeeping cancelled", partial: false });
    expect(checks).toBe(stage); expect(deletes).toBe(0); expect(recorded).toBe(0);
    expect((await lstat(profile)).ino).toBe(expected.ino);
    expect(await readFile(join(profile, "cookie"), "utf8")).toBe("keep");
    expect(await readdir(dir)).toEqual(["profile"]);
  });
});

describe("housekeeping handover and private audit", () => {
  it("holds the descriptor until explicit release and refuses unsafe/replaced paths", async () => {
    const dir = await folder(), path = join(dir, "state", "lock"); let fd = -1;
    const held = await takeLock(path, uid, signal(), async (descriptor) => { fd = descriptor; return { code: 0, missing: false }; });
    expect(held.outcome.kind).toBe("held"); expect(fd).toBeGreaterThan(0); await held.release(); await held.release();
    const replaced = await takeLock(path, uid, signal(), async () => { await rename(path, path + "-old"); await writeFile(path, "replacement"); return { code: 0, missing: false }; });
    expect(replaced.outcome.kind).toBe("failed");
    await rm(path); await symlink(path + "-old", path);
    expect((await takeLock(path, uid, signal())).outcome.kind).toBe("unsafe");
    await rm(path); await writeFile(path, ""); await chmod(join(dir, "state"), 0o777);
    expect((await takeLock(path, uid, signal())).outcome.kind).toBe("unsafe");
  });
  it("refuses busy, missing-flock, failed and aborted acquisition", async () => {
    const dir = await folder(), path = join(dir, "lock");
    for (const [code, missing, expected] of [[75, false, "busy"], [null, true, "missing-flock"], [null, false, "failed"]] as const) expect((await takeLock(path, uid, signal(), async () => ({ code, missing }))).outcome.kind).toBe(expected);
    const control = new AbortController(); control.abort(); expect((await takeLock(path, uid, control.signal)).outcome.kind).toBe("failed");
  });
  it("redacts both results and run summaries, rotates to a bound, and writes private files", async () => {
    const dir = await folder(), file = join(dir, "audit.jsonl"), state = join(dir, "runs.json");
    const log = new HousekeepingLog(file, state, () => {});
    for (let i = 0; i < 605; i++) await log.append({ at: i, job: "renice", outcome: "done", what: "build", why: `--token ${SYNTHETIC_ANTHROPIC_KEY}` });
    expect((await log.recent()).length).toBe(20); expect((await log.recent())[0]!.at).toBe(604);
    const raw = await readFile(file, "utf8"); expect(raw).not.toContain(SYNTHETIC_ANTHROPIC_KEY); expect(raw.trim().split("\n").length).toBeLessThanOrEqual(600);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    await log.saveRuns({ ...NO_RUNS, renice: { at: 1, outcome: "done", summary: `--token ${SYNTHETIC_ANTHROPIC_KEY}` } });
    expect(await readFile(state, "utf8")).not.toContain(SYNTHETIC_ANTHROPIC_KEY); expect((await log.runs()).renice?.outcome).toBe("done");
    expect((await lstat(state)).mode & 0o777).toBe(0o600);
    await writeFile(file, "bad\n" + raw); expect((await log.recent()).length).toBe(20);
  });
  it("never follows an audit-file symlink", async () => {
    const dir = await folder(), file = join(dir, "audit"), other = join(dir, "other"); await writeFile(other, "preserve"); await symlink(other, file);
    const log = new HousekeepingLog(file, join(dir, "state"), () => {});
    await log.append({ at: 1, job: "renice", outcome: "done", what: "build", why: "lowered" });
    expect(await readFile(other, "utf8")).toBe("preserve"); expect(await log.recent()).toEqual([]);
  });
});
