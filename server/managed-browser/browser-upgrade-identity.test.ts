import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const socketFixture = vi.hoisted(() => ({ sockets: new Map<string, { uid: number; mode: number }>() }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: (file: string) => {
    const socket = socketFixture.sockets.get(String(file));
    return socket ? { ...socket, isSocket: () => true, isSymbolicLink: () => false } : fs.lstatSync(file);
  } };
});
import { BrowserUpgradeIdentity, ownedUnixListenerInode, parseUpgradeProcesses, readUpgradeProcess, type UpgradeProcess } from "./browser-upgrade-identity";
import { browserDataRoot } from "./browser-upgrade-receipt";
import { resolveSupervisorPaths } from "./supervisor-paths";
const homes: string[] = [], hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hosts-owned-upgrade-identity-")); homes.push(home);
  const root = browserDataRoot(home), runtime = join(root, ".runtime-11111111-1111-4111-8111-111111111111"), paths = resolveSupervisorPaths(home, 2), uid = process.getuid!();
  for (const dir of [join(runtime, "node/bin"), paths.lock, join(root, "profiles/site")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime, "node/bin/node"), "fixture private Node", { mode: 0o700 });
  writeFileSync(join(runtime, "supervisor.cjs"), "fixture v2 bundle", { mode: 0o600 });
  writeFileSync(join(runtime, "provenance.json"), JSON.stringify({ reference: "daed6eb12f4156ca392f71c48e7a9ccca231ae8c", node: "24.20.0", agentBrowser: "0.38.2", chrome: "155.0.8059.39", chromeRevision: "1697595", target: "darwin-arm64",
    nodeSha256: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8", chromeSha256: "529a71bd61aaa2ef266a4d4bd300ae9572ba6a3468a8d55c3023ffeffb5b6b4e",
    nodeUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz", chromeUrl: "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/mac-arm64/chrome-mac-arm64.zip" }), { mode: 0o600 });
  writeFileSync(paths.endpoint, JSON.stringify({ version: 2, socket: paths.socket }) + "\n", { mode: 0o600 });
  writeFileSync(paths.token, "NEVER_READ_THIS_SECRET", { mode: 0o600 });
  writeFileSync(join(paths.lock, "pid"), "100\n", { mode: 0o600 });
  writeFileSync(join(root, "profiles/site/Cookies"), "fixture saved profile", { mode: 0o600 });
  socketFixture.sockets.set(paths.socket, { uid, mode: 0o600 });
  const row = (pid: number, ppid: number, command: string, executable = "/engine/node"): UpgradeProcess => ({ pid, ppid, uid, command, executable, birth: `birth-${pid}`, argvHash: hash(command) });
  const rows = new Map<number, UpgradeProcess>([
    [20, row(20, 7, "Paseo Daemon")], [30, row(30, 20, "/engine/node /engine/plugin-process.js")],
    [100, row(100, 1, `${runtime}/node/bin/node ${runtime}/supervisor.cjs`, `${runtime}/node/bin/node`)],
  ]);
  let socketPid = 100, unreadable = false, beforeRead: (pid: number) => void = () => {};
  const exec = (file: string, args: readonly string[]) => {
    if (unreadable) throw Error("private OS stderr");
    if (file.endsWith("lsof")) return `p${socketPid}\nn${paths.socket}\n`;
    expect(args).toContain("-axo");
    return [...rows.values()].map(row => `${row.pid} ${row.ppid} ${row.uid} S Mon Oct 12 12:00:00 2026 ${row.command}`).join("\n");
  };
  const identity = new BrowserUpgradeIdentity({ home, platform: "darwin", arch: "arm64", exec, readProcess: pid => {
    beforeRead(pid); const row = rows.get(pid); return row ? { ...row } : null;
  }, pluginPid: 30, uid });
  return { home, root, runtime, paths, identity, rows, row, set socketPid(pid: number) { socketPid = pid; }, set unreadable(value: boolean) { unreadable = value; },
    set beforeRead(read: (pid: number) => void) { beforeRead = read; },
    stop() { rows.delete(100); socketFixture.sockets.delete(paths.socket); } };
}
afterEach(() => { socketFixture.sockets.clear(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it("binds private owner/assets/lock/socket/daemon without reading token or emitting argv", () => {
  const f = fixture(), observed = f.identity.observe();
  expect(observed.binding.owner.pid).toBe(100); expect(observed.activeBrowserProcesses).toBe(0);
  expect(observed.binding.assetHashes.supervisor).toMatch(/^[a-f0-9]{64}$/); expect(observed.binding.profiles).toHaveLength(2);
  expect(JSON.stringify(observed)).not.toContain("NEVER_READ"); expect(JSON.stringify(observed)).not.toContain("command");
});
it.each(["pid", "uid", "birth", "argvHash", "executable"] as const)("final check refuses changed owner %s", key => {
  const f = fixture(), before = f.identity.observe().binding, owner = f.rows.get(100)!;
  f.rows.set(100, { ...owner, [key]: typeof owner[key] === "number" ? Number(owner[key]) + 1 : String(owner[key]) + "changed" });
  expect(() => f.identity.assertFinal(before)).toThrow();
});
it("final check refuses endpoint/lock changes", () => {
  const f = fixture(), before = f.identity.observe().binding;
  writeFileSync(join(f.paths.lock, "pid"), "101\n"); expect(() => f.identity.assertFinal(before)).toThrow("private identity");
  writeFileSync(join(f.paths.lock, "pid"), "100\n"); writeFileSync(f.paths.endpoint, JSON.stringify({ version: 2, socket: "/other.sock" }));
  expect(() => f.identity.assertFinal(before)).toThrow("private identity");
});
it.each(["mode", "uid", "owner"])("refuses wrong socket %s", key => {
  const f = fixture();
  if (key === "mode") socketFixture.sockets.get(f.paths.socket)!.mode = 0o666;
  else if (key === "uid") socketFixture.sockets.get(f.paths.socket)!.uid += 1;
  else f.socketPid = 101;
  expect(() => f.identity.observe()).toThrow("socket");
});
it("refuses executable substitution and unknown supervisor ancestry", () => {
  const f = fixture(), owner = f.rows.get(100)!;
  f.rows.set(100, { ...owner, executable: "/usr/bin/node" }); expect(() => f.identity.observe()).toThrow("executable");
  f.rows.set(100, { ...owner, ppid: 999 }); expect(() => f.identity.observe()).toThrow("reparented");
});
it("allows known daemon subreaper parent and configured sibling plugins", () => {
  const f = fixture(); f.rows.get(100)!.ppid = 7; expect(() => f.identity.observe()).not.toThrow();
  f.rows.set(31, f.row(31, 20, "/engine/node /engine/plugin-process.js"));
  f.rows.set(32, f.row(32, 20, "/engine/node /engine/plugin-process.js"));
  const before = f.identity.observe(); expect(before.activeBrowserProcesses).toBe(0);
  f.stop(); expect(f.identity.verifyStopped(before.binding)).toBe(true);
});
it("allows a sibling plus another live daemon's plugin and private coordinator", () => {
  const f = fixture(); f.rows.set(31, f.row(31, 20, "/engine/node /engine/plugin-process.js"));
  f.rows.set(40, f.row(40, 7, "Paseo Daemon"));
  f.rows.set(41, f.row(41, 40, "/engine/node /engine/plugin-process.js"));
  f.rows.set(42, f.row(42, 7, "/isolated/home/plugin-data/daemon-link/browser/.runtime-22222222-2222-4222-8222-222222222222/node/bin/node /isolated/home/plugin-data/daemon-link/browser/.runtime-22222222-2222-4222-8222-222222222222/supervisor.cjs"));
  const before = f.identity.observe(); expect(before.activeBrowserProcesses).toBe(0);
  f.identity.assertFinal(before.binding); f.stop(); expect(f.identity.verifyStopped(before.binding)).toBe(true);
});
it.each([0, 1, 99])("refuses orphaned plugin child with unavailable parent %s", parent => {
  const f = fixture(); f.rows.set(31, f.row(31, parent, "/engine/node /engine/plugin-process.js"));
  expect(() => f.identity.observe()).toThrow("overlap");
});
it("refuses plugin reparenting during fresh parent observation", () => {
  const f = fixture(); f.rows.set(40, f.row(40, 7, "Paseo Daemon"));
  f.rows.set(41, f.row(41, 40, "/engine/node /engine/plugin-process.js"));
  f.beforeRead = pid => { if (pid === 40) f.rows.get(41)!.ppid = 1; };
  expect(() => f.identity.observe()).toThrow("overlap");
});
it("refuses unknown parent visibility and changed child identity", () => {
  const f = fixture(); f.rows.set(40, f.row(40, 7, "Paseo Daemon"));
  f.rows.set(41, f.row(41, 40, "/engine/node /engine/plugin-process.js"));
  f.beforeRead = pid => { if (pid === 40) throw Error("private parent stderr"); };
  expect(() => f.identity.observe()).toThrow("private parent stderr");
  f.beforeRead = pid => { if (pid === 40) f.rows.get(41)!.birth = "replacement-child"; };
  expect(() => f.identity.observe()).toThrow("overlap");
});
it("refuses unsupported provenance or public asset permissions", () => {
  const f = fixture(); chmodSync(join(f.runtime, "node/bin/node"), 0o755); expect(() => f.identity.observe()).toThrow("metadata");
  chmodSync(join(f.runtime, "node/bin/node"), 0o700); writeFileSync(join(f.runtime, "provenance.json"), "{}"); expect(() => f.identity.observe()).toThrow("provenance");
});
it("old MCPs from every immutable runtime are excluded; Chrome/native/Xvfb still count", () => {
  const f = fixture(), other = f.runtime.replace("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  f.rows.set(101, f.row(101, 50, `${f.runtime}/node/bin/node ${f.runtime}/hosts-browser-mcp.cjs`));
  f.rows.set(102, f.row(102, 50, `${other}/node/bin/node ${other}/hosts-browser-mcp.cjs`));
  f.rows.set(103, f.row(103, 100, `${f.runtime}/chromium/chrome --user-data-dir=${f.root}/profiles/site`));
  f.rows.set(104, f.row(104, 1, "/usr/bin/Xvfb -auth /tmp/paseo-browser-display-owned/authority"));
  const before = f.identity.observe(); expect(before.activeBrowserProcesses).toBe(2); expect(before.binding.descendants).toHaveLength(1);
  f.stop(); expect(f.identity.verifyStopped(before.binding)).toBe(false);
  f.rows.delete(103); f.rows.delete(104); expect(f.identity.verifyStopped(before.binding)).toBe(true);
});
it("profile byte writes during graceful shutdown are allowed, directories must survive", () => {
  const f = fixture(), before = f.identity.observe().binding; f.stop();
  mkdirSync(join(f.root, "profiles/site/Cache")); rmSync(join(f.root, "profiles/site/Cache"), { recursive: true });
  writeFileSync(join(f.root, "profiles/site/Cookies"), "Chrome flushed new saved data"); expect(f.identity.verifyStopped(before)).toBe(true);
  rmSync(join(f.root, "profiles/site"), { recursive: true }); expect(() => f.identity.verifyStopped(before)).toThrow("profile directories");
});
it("a newly orphaned plugin child refuses the final check and later reconciliation", () => {
  const f = fixture(), before = f.identity.observe().binding;
  f.rows.set(31, f.row(31, 1, "/engine/node /engine/plugin-process.js"));
  expect(() => f.identity.assertFinal(before)).toThrow("overlap");
  f.stop(); expect(() => f.identity.verifyStopped(before)).toThrow("overlap");
});
it("orphaned same-user plugin child requires review rather than guessing installation identity", () => {
  const f = fixture(); f.rows.set(31, f.row(31, 1, "/engine/node /engine/plugin-process.js"));
  expect(() => f.identity.observe()).toThrow("overlap");
});
it("second coordinator and unknown same-home process ownership refuse", () => {
  const f = fixture(); f.rows.set(31, f.row(31, 1, `${f.runtime}/node/bin/node ${f.runtime}/supervisor.cjs`));
  expect(() => f.identity.observe()).toThrow("coordinator");
  f.rows.delete(31); f.rows.set(32, { ...f.row(32, 1, `${f.runtime}/chromium/chrome`), uid: process.getuid!() + 1 });
  expect(() => f.identity.observe()).toThrow("ownership");
});
it("a competing coordinator appearing after preview refuses the final check", () => {
  const f = fixture(), before = f.identity.observe().binding;
  f.rows.set(31, f.row(31, 1, `${f.runtime}/node/bin/node ${f.runtime}/supervisor.cjs`));
  expect(() => f.identity.assertFinal(before)).toThrow("coordinator");
});
it("rewritten native argv is still found by its private executable; unreadable candidate refuses", () => {
  const f = fixture(); f.rows.set(101, f.row(101, 1, "agent-browser-daemon", `${f.runtime}/node_modules/agent-browser/bin/agent-browser`));
  const before = f.identity.observe(); expect(before.activeBrowserProcesses).toBe(1); f.stop();
  expect(f.identity.verifyStopped(before.binding)).toBe(false);
});
it("unsupported platforms refuse without any command", () => {
  const f = fixture(), exec = vi.fn();
  const identity = new BrowserUpgradeIdentity({ home: f.home, platform: "win32", exec });
  expect(() => identity.observe()).toThrow("supports macOS"); expect(exec).not.toHaveBeenCalled();
});
it("changed immutable assets cannot be reconciled as success", () => {
  const f = fixture(), before = f.identity.observe().binding; f.stop();
  writeFileSync(join(f.runtime, "supervisor.cjs"), "substituted"); expect(() => f.identity.verifyStopped(before)).toThrow("assets changed");
});
it("PID reuse means original owner gone; same-birth exec remains unknown", () => {
  const f = fixture(), before = f.identity.observe().binding; f.stop();
  f.rows.set(100, { ...f.row(100, 1, "/other/process"), birth: "new-birth" }); expect(f.identity.verifyStopped(before)).toBe(true);
  f.rows.get(100)!.birth = before.owner.birth; expect(f.identity.verifyStopped(before)).toBe(false);
});
it("normal postflight keeps actor identity; explicit read-only recheck can reconcile after reboot", () => {
  const f = fixture(), before = f.identity.observe().binding; f.stop(); f.rows.get(20)!.birth = "rebooted-worker";
  expect(() => f.identity.verifyStopped(before)).toThrow("identity changed");
  expect(f.identity.verifyStopped(before, undefined, false)).toBe(true);
});
it("unreadable process visibility and retained socket refuse acceptance", () => {
  const f = fixture(), before = f.identity.observe().binding; f.rows.delete(100);
  expect(f.identity.verifyStopped(before)).toBe(false);
  f.unreadable = true; expect(() => f.identity.verifyStopped(before)).toThrow();
});
it("strict census parser refuses hidden, empty, duplicate and oversized tables", () => {
  for (const text of ["", "100 unreadable", "100 1 501 S Mon Oct 12 12:00:00 2026", Array(4097).fill("row").join("\n"),
    Array(2).fill("100 1 501 S Mon Oct 12 12:00:00 2026 /node").join("\n")]) expect(() => parseUpgradeProcesses(text)).toThrow();
});
it("Linux socket parser requires unique stream LISTEN inode at exact derived path", () => {
  const row = "0: 2 0 00010000 0001 01 123 /tmp/owned.sock";
  expect(ownedUnixListenerInode("header\n" + row, "/tmp/owned.sock")).toBe("123");
  for (const text of [row.replace("00010000", "00000000"), row.replace("0001 01", "0002 03"), row + "\n" + row, row.replace("/tmp/owned", "/tmp/other")]) expect(() => ownedUnixListenerInode("header\n" + text, "/tmp/owned.sock")).toThrow();
});
it("Mac final read brackets changed executable and birth; gone PID is distinct", () => {
  let calls = 0;
  const row = "100 1 501 S Mon Oct 12 12:00:00 2026 /private/node /private/supervisor.cjs";
  expect(readUpgradeProcess(100, "darwin", () => "")).toBeNull();
  expect(() => readUpgradeProcess(100, "darwin", (_file, args) => args.includes("comm=") ? (++calls === 1 ? "/private/node" : "/other/node") : row)).toThrow("changed");
  expect(() => readUpgradeProcess(100, "darwin", (_file, args) => args.includes("comm=") ? "/private/node" : (++calls % 2 ? row : row.replace("12:00:00", "12:00:01")))).toThrow("changed");
});
