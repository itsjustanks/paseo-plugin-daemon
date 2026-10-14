import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrivateVirtualDisplay, assertNoRetainedDisplay, encodeDisplayAuthority, PrivateDisplayCleanupError } from "./virtual-display";
import { displayArgvHash } from "./display-process";
const root = "/owned/browser/displays/workspace";
const fake = vi.hoisted(() => ({ mkdir: vi.fn(), lstat: vi.fn(), realpath: vi.fn(), readFile: vi.fn(), rm: vi.fn(), writeFile: vi.fn(), spawn: vi.fn(), connect: vi.fn(), inspect: vi.fn(), read: vi.fn() }));
vi.mock("node:fs/promises", () => fake);
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("node:net", () => ({ createConnection: fake.connect }));
vi.mock("./display-process", async (original) => ({ ...(await original<typeof import("./display-process")>()), inspectDisplayExecutable: fake.inspect, readDisplayProcess: fake.read }));
let child: EventEmitter & {pid: number | undefined; exitCode: number | null; signalCode: string | null; stdio: unknown[]; kill: ReturnType<typeof vi.fn>};
let ready: Readable;
let files: Map<string, string>;
let authority: Buffer;
let reserved: boolean;
let argv: string[];
const exit = (signal = "SIGTERM") => { child.signalCode = signal; child.emit("exit", null, signal); };
function processProof() { return { pid: 123, parentPid: process.pid, uid: process.getuid!(), startTicks: "111", executable: "/usr/bin/Xvfb", executableDev: 1, executableIno: 3, argvHash: displayArgvHash(argv), children: [] as number[] }; }
const create = (timeoutMs?: number) => createPrivateVirtualDisplay({ platform: "linux", root, ...(timeoutMs ? { timeoutMs } : {}) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.resetAllMocks(); authority = Buffer.alloc(0); files = new Map(); reserved = false; argv = [];
  fake.inspect.mockResolvedValue({ path: "/usr/bin/Xvfb", dev: 1, ino: 3, sha256: "a".repeat(64) });
  fake.mkdir.mockImplementation(async (path: string) => { if (path === root) { if (reserved) throw Object.assign(new Error(), { code: "EEXIST" }); reserved = true; } });
  fake.lstat.mockImplementation(async (path: string) => { if (path === root && !reserved) throw Object.assign(new Error(), { code: "ENOENT" }); return { uid: process.getuid!(), mode: 0o40700, dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false }; });
  fake.realpath.mockImplementation(async (path: string) => path);
  fake.writeFile.mockImplementation(async (path: string, data: string | Buffer) => { files.set(path, data.toString()); if (Buffer.isBuffer(data)) authority = Buffer.from(data); });
  fake.readFile.mockImplementation(async (path: string) => files.get(path));
  fake.rm.mockImplementation(async () => { reserved = false; files.clear(); });
  ready = new Readable({ read() {} });
  child = Object.assign(new EventEmitter(), { pid: 123 as number | undefined, exitCode: null, signalCode: null, stdio: [null, null, null, ready], kill: vi.fn(() => { exit(); return true; }) });
  fake.read.mockImplementation(async () => child.signalCode !== null || child.exitCode !== null ? null : processProof());
  fake.spawn.mockImplementation((path: string, args: string[]) => { argv = [path, ...args]; queueMicrotask(() => ready.push(`${args[0]!.slice(1)}\n`)); return child; });
  fake.connect.mockImplementation(() => { const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn((packet: Buffer) => { const response = Buffer.alloc(8); response[0] = packet.readUInt16LE(8) === 16 && packet.subarray(-16).equals(authority.subarray(-16)) ? 1 : 0; response.writeUInt16LE(11, 2); queueMicrotask(() => socket.emit("data", response)); }) }); queueMicrotask(() => socket.emit("connect")); return socket; });
});
it("does nothing off Linux and returns missing prerequisite before reserving or spawning", async () => {
  expect(await createPrivateVirtualDisplay({ platform: "darwin", root })).toBeNull(); expect(fake.inspect).not.toHaveBeenCalled();
  fake.inspect.mockResolvedValue(null); expect(await create()).toBeNull(); expect(fake.mkdir).not.toHaveBeenCalled(); expect(fake.spawn).not.toHaveBeenCalled();
});
it("existing reservation blocks even when the executable is missing", async () => {
  reserved = true; fake.inspect.mockResolvedValue(null);
  await expect(create()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.inspect).not.toHaveBeenCalled(); expect(fake.spawn).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled();
});
it("uses owned authenticated storage, unchanged abstract flags and no inherited secrets/display", async () => {
  vi.stubEnv("DISPLAY", ":0"); vi.stubEnv("XAUTHORITY", "/secret/auth"); vi.stubEnv("PROVIDER_SECRET", "fixture-secret"); vi.stubEnv("LD_PRELOAD", "/secret/preload");
  const display = await create(); expect(display).not.toBeNull();
  expect(argv.slice(1)).toEqual([argv[1], "-screen", "0", "3840x3840x24", "-nolisten", "unix", "-nolisten", "tcp", "-nolock", "-auth", root + "/authority", "-displayfd", "3"]);
  expect(fake.spawn.mock.calls[0]![2].env).toEqual({ PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, LANG: "C.UTF-8" });
  expect(fake.writeFile.mock.calls.find(([path]) => path === root + "/authority")?.[2]).toEqual({ mode: 0o600, flag: "wx" });
  expect(JSON.parse(files.get(root + "/OWNED.json")!)).toMatchObject({ version: 1, pid: 123, directory: root, process: { startTicks: "111" } });
  expect(files.get(root + "/OWNED.json")).not.toContain("fixture-secret"); expect(fake.connect).toHaveBeenCalledTimes(3);
  display!.assertAvailable(); await display!.stop(); await display!.stop(); expect(child.kill.mock.calls).toEqual([["SIGTERM"]]); expect(fake.rm).toHaveBeenCalledOnce(); expect(() => display!.assertAvailable()).toThrow("ended");
});
it("refuses a changed readiness number without transmitting its cookie and cleans the known child", async () => {
  fake.spawn.mockImplementation((path, args) => { argv = [path, ...args]; queueMicrotask(() => ready.push("0\n")); return child; });
  await expect(create()).rejects.toThrow("identity changed"); expect(fake.connect).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalledWith("SIGTERM"); expect(fake.rm).toHaveBeenCalledOnce();
});
it("rejects an anonymous-success display and normally removes only its own reservation", async () => {
  fake.connect.mockImplementation(() => { const socket = Object.assign(new EventEmitter(), { destroy() {}, write() { const response = Buffer.alloc(8); response[0] = 1; response.writeUInt16LE(11, 2); queueMicrotask(() => socket.emit("data", response)); } }); queueMicrotask(() => socket.emit("connect")); return socket; });
  await expect(create()).rejects.toThrow("unauthenticated"); expect(fake.rm).toHaveBeenCalledOnce();
});
it("bounds never-ready startup then confirms TERM cleanup", async () => {
  fake.spawn.mockImplementation((path, args) => { argv = [path, ...args]; return child; });
  await expect(create(20)).rejects.toThrow("not ready"); expect(child.kill.mock.calls).toEqual([["SIGTERM"]]); expect(fake.rm).toHaveBeenCalledOnce();
});
it("removes a never-started child's files without a signal after its spawn error", async () => {
  fake.spawn.mockImplementation(() => { child.pid = undefined; queueMicrotask(() => child.emit("error", new Error("private launch detail"))); return child; });
  await expect(create()).rejects.toThrow("failed to start"); expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).toHaveBeenCalledOnce();
});
it.each(["startTicks", "argvHash", "uid", "executableIno", "parentPid"])("never signals a child with unconfirmed initial %s", async (field) => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  fake.read.mockImplementation(async () => ({ ...processProof(), [field]: field === "argvHash" ? "wrong" : field === "startTicks" ? "222" : -1 }));
  // A birth value has no predetermined fixture value: bind first observed birth, not an invented one.
  if (field === "startTicks") { const display = await create(); fake.read.mockImplementation(async () => ({ ...processProof(), startTicks: "333" })); await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); }
  else { const rejected = expect(create()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); await vi.advanceTimersByTimeAsync(2_500); await rejected; }
  expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled(); expect(reserved).toBe(true);
});
it("rechecks birth immediately before escalation and never kills a replacement", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now()); const display = await create(); child.kill.mockImplementation(() => true);
  let replace = false; fake.read.mockImplementation(async () => ({ ...processProof(), ...(replace ? { startTicks: "222" } : {}) }));
  const stopped = display!.stop(); const rejected = expect(stopped).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  await vi.advanceTimersByTimeAsync(999); replace = true; await vi.advanceTimersByTimeAsync(50); await rejected;
  expect(child.kill.mock.calls).toEqual([["SIGTERM"]]); expect(fake.rm).not.toHaveBeenCalled();
});
it("TERM then KILL of only the confirmed child reaps before removing authority", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now()); const display = await create();
  child.kill.mockImplementation((signal) => { if (signal === "SIGKILL") exit("SIGKILL"); return true; });
  const stopped = display!.stop(); await vi.advanceTimersByTimeAsync(1_100); await stopped;
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]); expect(fake.rm).toHaveBeenCalledOnce();
});
it("no final exit settles at the 2.5s total budget and retains authority without retry", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now()); const display = await create(); child.kill.mockImplementation(() => true);
  const started = Date.now(); const stopped = display!.stop(); const rejected = expect(stopped).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  await vi.advanceTimersByTimeAsync(2_500); await rejected; expect(Date.now() - started).toBe(2_500);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]); expect(fake.rm).not.toHaveBeenCalled(); expect(files.has(root + "/authority")).toBe(true);
  await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(child.kill).toHaveBeenCalledTimes(2);
});
it.each(["false", "throw", "error"])("failed signal (%s) refuses and retains authority", async (kind) => {
  const display = await create(); child.kill.mockImplementation(() => { if (kind === "throw") throw Error("private signal detail"); if (kind === "error") child.emit("error", Error("private signal detail")); return false; });
  await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.rm).not.toHaveBeenCalled(); expect(files.has(root + "/authority")).toBe(true);
});
it("a wedged identity read cannot postpone the total bound or signal late", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now()); const display = await create();
  let resolveRead: (value: unknown) => void = () => {}; fake.read.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
  const stopped = display!.stop(); const rejected = expect(stopped).rejects.toBeInstanceOf(PrivateDisplayCleanupError); await vi.advanceTimersByTimeAsync(2_500); await rejected;
  expect(child.kill).not.toHaveBeenCalled(); resolveRead(processProof()); await vi.advanceTimersByTimeAsync(10); expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled();
});
it("active XKB descendants refuse direct-child termination without a broad census or descendant signals", async () => {
  const display = await create(); fake.read.mockImplementation(async () => ({ ...processProof(), children: [456] }));
  await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled();
});
it("changed directory or owner marker refuses removal after confirmed child exit", async () => {
  const display = await create(); const marker = JSON.parse(files.get(root + "/OWNED.json")!); files.set(root + "/OWNED.json", JSON.stringify({ ...marker, nonce: "foreign" }));
  await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.rm).not.toHaveBeenCalled();
});
it("unexpected child exit invalidates availability without signalling or replacement", async () => {
  const display = await create(); exit(); expect(() => display!.assertAvailable()).toThrow("ended"); await display!.stop(); expect(child.kill).not.toHaveBeenCalled(); expect(fake.spawn).toHaveBeenCalledOnce();
});
it("existing reservation check is read-only and refuses unreadable ownership", async () => {
  await expect(assertNoRetainedDisplay(root)).resolves.toBeUndefined(); fake.lstat.mockRejectedValue(Object.assign(new Error(), { code: "EACCES" }));
  await expect(assertNoRetainedDisplay(root)).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.mkdir).not.toHaveBeenCalled();
});
it("authority is scoped to display/cookie and rejects malformed input", () => {
  const cookie = Buffer.alloc(16, 7), authority = encodeDisplayAuthority("23067", cookie); expect(authority.readUInt16BE(0)).toBe(65535); expect(authority.subarray(-16)).toEqual(cookie);
  expect(() => encodeDisplayAuthority("0", cookie)).toThrow(); expect(() => encodeDisplayAuthority("23067", Buffer.alloc(2))).toThrow();
});

it("an observed descendant is retained even if the display exits during that census", async () => {
  const display = await create(); fake.read.mockImplementation(async () => { exit(); return { ...processProof(), children: [456] }; });
  await expect(display!.stop()).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled();
});

it("refuses a display accepting a different nonempty cookie", async () => {
  fake.connect.mockImplementation(() => { const socket = Object.assign(new EventEmitter(), { destroy() {}, write(packet: Buffer) { const response = Buffer.alloc(8); response[0] = packet.readUInt16LE(8) === 16 ? 1 : 0; response.writeUInt16LE(11, 2); queueMicrotask(() => socket.emit("data", response)); } }); queueMicrotask(() => socket.emit("connect")); return socket; });
  await expect(create()).rejects.toThrow("foreign cookie"); expect(fake.rm).toHaveBeenCalledOnce();
});

it("a retained-reservation check has a bounded read and cannot launch after timing out", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now()); fake.lstat.mockImplementation(() => new Promise(() => {}));
  const checked = assertNoRetainedDisplay(root); const rejected = expect(checked).rejects.toBeInstanceOf(PrivateDisplayCleanupError); await vi.advanceTimersByTimeAsync(5_000); await rejected; expect(fake.spawn).not.toHaveBeenCalled();
});


it.each(["before TERM", "after TERM"])("waits for libuv exit when proc disappears %s without another signal", async (ordering) => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const display = await create();
  const exitPending = () => { fake.read.mockResolvedValue(null); setTimeout(() => exit(), 5); };
  if (ordering === "before TERM") exitPending();
  else child.kill.mockImplementation(() => { exitPending(); return true; });
  const stopped = display!.stop().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(50); expect(await stopped).toBeUndefined();
  expect(child.kill.mock.calls).toEqual(ordering === "before TERM" ? [] : [["SIGTERM"]]);
  expect(fake.rm).toHaveBeenCalledOnce(); expect(reserved).toBe(false);
});

it("proc disappearance after TERM waits only to the existing deadline and never escalates without proof", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const display = await create();
  child.kill.mockImplementation(() => { fake.read.mockResolvedValue(null); return true; });
  const start = Date.now(); let settled = false;
  const rejected = expect(display!.stop().finally(() => { settled = true; })).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  await vi.advanceTimersByTimeAsync(2_499); expect(settled).toBe(false); expect(fake.rm).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(Date.now() - start).toBe(2_500); expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(fake.rm).not.toHaveBeenCalled(); expect(files.has(root + "/authority")).toBe(true);
  exit(); await vi.advanceTimersByTimeAsync(25);
  expect(child.kill).toHaveBeenCalledOnce(); expect(fake.rm).not.toHaveBeenCalled();
});

it("a startup crash before identity binding waits for confirmed exit then permits clean fallback", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  fake.read.mockResolvedValue(null);
  fake.spawn.mockImplementation(() => { setTimeout(() => { child.exitCode = 1; child.emit("exit", 1, null); }, 5); return child; });
  const failed = create().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(25); const error = await failed;
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PrivateDisplayCleanupError);
  expect((error as Error).message).toBe("Private browser display identity could not be confirmed");
  expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).toHaveBeenCalledOnce(); expect(reserved).toBe(false);
});

it("an unbound startup PID without confirmed exit retains authority at the existing deadline", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  fake.read.mockResolvedValue(null); const start = Date.now(); let settled = false;
  const rejected = expect(create().finally(() => { settled = true; })).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  await vi.advanceTimersByTimeAsync(2_499); expect(settled).toBe(false); expect(fake.rm).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(Date.now() - start).toBe(2_500); expect(child.kill).not.toHaveBeenCalled();
  expect(fake.rm).not.toHaveBeenCalled(); expect(files.has(root + "/authority")).toBe(true);
  exit(); await vi.advanceTimersByTimeAsync(25); expect(fake.rm).not.toHaveBeenCalled();
});


it("pending startup exit still retains authority when the bound identity had observed descendants", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  fake.read.mockImplementationOnce(async () => ({ ...processProof(), children: [456] }));
  fake.read.mockImplementation(async () => { setTimeout(() => exit(), 5); return null; });
  const rejected = expect(create()).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  await vi.advanceTimersByTimeAsync(50); await rejected;
  expect(child.kill).not.toHaveBeenCalled(); expect(fake.rm).not.toHaveBeenCalled();
  expect(files.has(root + "/authority")).toBe(true);
});
