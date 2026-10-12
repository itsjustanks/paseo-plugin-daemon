import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { build } from "esbuild";
import { RecoveryDetailsSchema } from "../../shared/recovery";
import { RecoveryStore } from "../../server/recovery/store";
import { details, fixture } from "./fixtures";
const fixtures: ReturnType<typeof fixture>[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

describe("offline owner-only recovery inventory", () => {
  it("creates, reads, edits and removes without target IO and enforces revisions", () => {
    const f = make(); expect(f.store.list()).toEqual([]);
    const p = f.save({ auth: { kind: "identity", path: "/nonexistent/runner/key" } });
    expect(statSync(f.store.directory).mode & 0o777).toBe(0o700); expect(statSync(f.store.file).mode & 0o777).toBe(0o600);
    expect(f.store.list()).toEqual([p]);
    const edited = f.store.save({ schemaVersion: 1, id: p.id, expectedRevision: 1, details: details({ name: "Edited target" }) });
    expect(edited.revision).toBe(2); expect(edited.id).toBe(p.id);
    expect(() => f.store.save({ schemaVersion: 1, id: p.id, expectedRevision: 1, details: details() })).toThrow("changed");
    expect(() => f.store.remove(p.id, 1)).toThrow("changed"); f.store.remove(p.id, 2); expect(f.store.list()).toEqual([]);
    expect(() => f.store.get(p.id, 2)).toThrow("changed");
  });
  it("rejects unexpected schema/password/command fields without echoing values", () => {
    const f = make();
    for (const input of [{ schemaVersion: 2, expectedRevision: 0, details: details() }, { schemaVersion: 1, expectedRevision: 0, details: { ...details(), password: "fixture-sensitive-value" } }, { schemaVersion: 1, expectedRevision: 0, details: { ...details(), command: "arbitrary-command" } }]) {
      expect(() => f.store.save(input as never)).toThrow("not accepted");
      try { f.store.save(input as never); } catch (e) { expect(String(e)).not.toContain("fixture-sensitive-value"); }
    }
    expect(() => f.store.save({ schemaVersion: 1, expectedRevision: 1, details: details() })).toThrow("changed");
    expect(RecoveryDetailsSchema.safeParse({ ...details(), auth: { kind: "identity", path: "relative/key" } }).success).toBe(false);
    expect(RecoveryDetailsSchema.safeParse({ ...details(), auth: { kind: "identity", path: "/runner/key\ncontent" } }).success).toBe(false);
  });
  it("bounds the inventory and document size", () => {
    const f = make(); for (let i = 0; i < 20; i++) f.save({ name: `Fixture ${i}` });
    expect(() => f.save()).toThrow("20"); expect(f.store.list()).toHaveLength(20);
    writeFileSync(f.store.file, "x".repeat(65537)); expect(() => f.store.list()).toThrow("storage");
  });
  it.each(["file", "directory", "ancestor"])("refuses %s symlinks and leaves their target unchanged", kind => {
    const f = make(), target = join(f.root, "untouched"); writeFileSync(target, "unchanged", { mode: 0o600 });
    let store = f.store;
    if (kind === "file") { mkdirSync(store.directory, { mode: 0o700 }); symlinkSync(target, store.file); }
    if (kind === "directory") symlinkSync(f.root, store.directory);
    if (kind === "ancestor") { symlinkSync(f.root, join(f.root, "alias")); store = new RecoveryStore(join(f.root, "alias", "nested")); }
    expect(() => store.save({ schemaVersion: 1, expectedRevision: 0, details: details() })).toThrow("storage");
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });
  it("refuses hard links, unsafe modes and directories as profile files", () => {
    const f = make(); f.save(); chmodSync(f.store.file, 0o644); expect(() => f.store.list()).toThrow("storage");
    chmodSync(f.store.file, 0o600); chmodSync(f.store.directory, 0o755); expect(() => f.store.list()).toThrow("storage");
    chmodSync(f.store.directory, 0o700); linkSync(f.store.file, join(f.root, "hardlink")); expect(() => f.store.list()).toThrow("storage");
    const other = new RecoveryStore(join(f.root, "other")); mkdirSync(other.directory, { mode: 0o700 }); mkdirSync(other.file); expect(() => other.list()).toThrow("storage");
  });
  it.each(["invalid JSON", JSON.stringify({ schemaVersion: 2, profiles: [] })])("fails closed on corrupt or unsupported documents", raw => {
    const f = make(); f.save(); writeFileSync(f.store.file, raw); expect(() => f.store.list()).toThrow("storage");
  });
  it.each([false, true])("rejects an owned FIFO without freezing its child event loop (stale precheck=%s)", async stalePrecheck => {
    const f = make(); mkdirSync(f.store.directory, { mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", f.store.file], { timeout: 1000 });
    expect(statSync(f.store.file).isFIFO()).toBe(true);
    const regular = join(f.root, "regular"); writeFileSync(regular, "fixture", { mode: 0o600 });
    // The second case simulates a regular-file precheck becoming stale before open.
    // fstat still sees the real FIFO, so O_NONBLOCK must protect the open itself.
    const probe = await build({ stdin: { contents: `
      import fs from "node:fs";
      import { RecoveryStore } from "./server/recovery/store";
      if (process.argv[3] === "stale") {
        const realLstat = fs.lstatSync, regular = realLstat(process.argv[4]);
        fs.lstatSync = ((path, ...args) => String(path) === process.argv[2] + "/profiles.json" ? regular : realLstat(path, ...args));
      }
      process.send({ kind: "ready" });
      setTimeout(() => { process.send({ kind: "heartbeat" }, () => process.exit(0)); }, 20);
      try { new RecoveryStore(process.argv[2]).list(); process.send({ kind: "accepted" }); }
      catch { process.send({ kind: "rejected" }); }
    `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "cjs", write: false });
    const file = join(f.root, "fifo-probe.cjs"); writeFileSync(file, probe.outputFiles[0].text);
    const child = fork(file, [f.store.directory, stalePrecheck ? "stale" : "normal", regular], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const messages: string[] = [];
    child.on("message", message => messages.push((message as { kind: string }).kind));
    const completed = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 3000);
      child.once("close", code => { clearTimeout(timeout); resolve(code === 0); });
      child.once("error", () => { clearTimeout(timeout); child.kill("SIGKILL"); resolve(false); });
    });
    expect(completed, "owned probe must reject the FIFO and exit before its watchdog").toBe(true);
    expect(messages).toEqual(["ready", "rejected", "heartbeat"]);
  });
  it("refuses duplicate IDs in stored data", () => {
    const f = make(), p = f.save(); writeFileSync(f.store.file, JSON.stringify({ schemaVersion: 1, profiles: [p, p] })); expect(() => f.store.list()).toThrow("storage");
  });
});
