import { setTimeout, clearTimeout } from "./node-timers";
/**
 * Owns one authenticated, invisible Linux X display per browser runtime. Abstract
 * Unix transport avoids WSLg's protected pathname directory; TCP is never enabled.
 * The display stays alive across CDP reconnects. Startup failure is definitive:
 * callers must not silently relaunch a partly initialized browser headlessly.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { lstat, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { inspectDisplayExecutable, readDisplayProcess, sameDisplayProcess, displayArgvHash, type DisplayExecutable, type DisplayProcess } from "./display-process";
import type { Readable } from "node:stream";
import { MAX_VIEWPORT } from "../../shared/managed-browser/viewport-limits";
import { RuntimeLostError } from "./runtime-protocol";

const AUTH_NAME = "MIT-MAGIC-COOKIE-1";
const STARTUP_MS = 5_000;

/** Fixed-text startup failure; safe to show operators because it never embeds paths or secrets. */
export class PrivateDisplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateDisplayError";
  }
}

export interface PrivateVirtualDisplay {
  readonly launchEnvironment: Readonly<{ DISPLAY: string; XAUTHORITY: string }>;
  /** Throws RuntimeLostError after the display exits; it never creates a replacement display. */
  assertAvailable(): void;
  /** Idempotently terminates only the owned child and removes its private auth file. */
  stop(): Promise<void>;
}

/** Serializes a FamilyWild Xauthority record, scoped to this display and cookie. */
export function encodeDisplayAuthority(display: string, cookie: Buffer): Buffer {
  if (!/^\d{4,5}$/.test(display) || Number(display) > 65_535 || cookie.length !== 16) {
    throw new PrivateDisplayError("Invalid private display authority");
  }
  const fields = [Buffer.alloc(0), Buffer.from(display), Buffer.from(AUTH_NAME), cookie];
  const family = Buffer.alloc(2);
  family.writeUInt16BE(65_535);
  return Buffer.concat([
    family,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(field.length);
      return [length, field];
    }),
  ]);
}

/** Performs a bounded X11 setup exchange to prove the owned secret is accepted. */
export async function authenticateDisplay(display: string, cookie: Buffer): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ path: `\0/tmp/.X11-unix/X${display}` });
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      const name = Buffer.from(AUTH_NAME);
      const header = Buffer.alloc(12);
      header[0] = 0x6c; // X11 little-endian client, protocol 11.
      header.writeUInt16LE(11, 2);
      header.writeUInt16LE(name.length, 6);
      header.writeUInt16LE(cookie.length, 8);
      socket.write(Buffer.concat([header, name, Buffer.alloc(2), cookie]));
    });
    socket.on("data", (chunk) => {
      if (received.length + chunk.length > 32_768) return finish(false);
      received = Buffer.concat([received, chunk]);
      if (received.length >= 8) {
        finish(received[0] === 1 && received.readUInt16LE(2) === 11);
      }
    });
  });
}

/** Reads only the exact child readiness FD before sending its cookie to a socket. */
async function waitDisplayReady(
  child: ChildProcess,
  display: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ready = child.stdio[3] as Readable;
    let response = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ready.removeListener("data", onData);
      ready.removeListener("error", onError);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      ready.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onError = () =>
      finish(new PrivateDisplayError("Private browser display failed to start"));
    const onExit = () =>
      finish(new PrivateDisplayError("Private browser display ended before readiness"));
    const onData = (chunk: Buffer) => {
      response += chunk.toString("ascii");
      if (response.length > 16)
        return finish(new PrivateDisplayError("Invalid private display readiness"));
      if (response.includes("\n")) {
        finish(
          response === `${display}\n`
            ? undefined
            : new PrivateDisplayError("Private display identity changed"),
        );
      }
    };
    const timer = setTimeout(
      () => finish(new PrivateDisplayError("Private browser display was not ready")),
      timeoutMs,
    );
    ready.on("data", onData);
    ready.once("error", onError);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/** An unconfirmed cleanup keeps its exclusive reservation; callers must not replace the browser. */
export class PrivateDisplayCleanupError extends PrivateDisplayError {
  constructor() { super("Private browser display cleanup is unconfirmed; owned files were retained"); this.name = "PrivateDisplayCleanupError"; }
}
const SHUTDOWN_MS = 2_500;
const TERM_GRACE_MS = 1_000;

/** One deadline for proofs/waits. Late read-only results never trigger signals or subsequent work. */
async function proveBefore<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new PrivateDisplayCleanupError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PrivateDisplayCleanupError()), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function pauseBefore(deadline: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
}
function confirmedExit(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Direct-child signals only, never descendants or a process group. Refuse if the
 * exact child's task census sees descendants: killing it could orphan xkbcomp.
 * All identity reads and waits share the 2.5s deadline; no post-timeout signals.
 */
async function stopDisplayChild(
  child: ChildProcess,
  identity: DisplayProcess | null,
  childFault: () => boolean,
  deadline: number,
): Promise<void> {
  if (confirmedExit(child)) {
    if (identity?.children.length) throw new PrivateDisplayCleanupError();
    return;
  }
  if (!child.pid) {
    if (childFault()) return; // A confirmed spawn error with no PID never started a child.
    throw new PrivateDisplayCleanupError();
  }
  // /proc can disappear (or expose a zombie without exe) before libuv reports exit.
  // An unbound startup PID has the same uncertainty. Neither case permits a signal.
  const waitForConfirmedExit = async () => {
    while (!confirmedExit(child) && performance.now() < deadline) await pauseBefore(deadline);
    if (!confirmedExit(child) || identity?.children.length) throw new PrivateDisplayCleanupError();
  };
  if (!identity) { await waitForConfirmedExit(); return; }
  const current = async (): Promise<boolean> => {
    if (confirmedExit(child)) return false;
    const proof = await proveBefore(deadline, () => readDisplayProcess(identity.pid));
    if (proof?.children.length) throw new PrivateDisplayCleanupError();
    if (confirmedExit(child)) return false;
    if (!proof) { await waitForConfirmedExit(); return false; }
    if (childFault() || child.pid !== identity.pid || !sameDisplayProcess(identity, proof) || proof.children.length)
      throw new PrivateDisplayCleanupError();
    return true;
  };
  const signal = async (name: "SIGTERM" | "SIGKILL") => {
    if (!(await current())) return;
    if (performance.now() >= deadline) throw new PrivateDisplayCleanupError();
    try {
      if (!child.kill(name) && !confirmedExit(child)) throw new PrivateDisplayCleanupError();
    } catch { throw new PrivateDisplayCleanupError(); }
  };
  const wait = async (until: number) => {
    while (!confirmedExit(child) && performance.now() < until) {
      await current();
      await pauseBefore(Math.min(until, deadline));
    }
  };
  await signal("SIGTERM");
  await wait(Math.min(deadline, performance.now() + TERM_GRACE_MS));
  if (!confirmedExit(child)) await signal("SIGKILL");
  await wait(deadline);
  if (!confirmedExit(child)) throw new PrivateDisplayCleanupError();
}

/** Existing reservations survive opt-out/restart and may never be silently replaced. */
export async function assertNoRetainedDisplay(root: string): Promise<void> {
  try { await proveBefore(performance.now() + STARTUP_MS, () => lstat(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new PrivateDisplayCleanupError(); }
  throw new PrivateDisplayCleanupError();
}

export interface PrivateDisplayOptions {
  /** Exclusive per-workspace reservation under Hosts' mutable browser area. */
  root: string;
  platform?: NodeJS.Platform;
  /** Trusted internal choice only; no PATH or caller-supplied RPC executable. */
  executablePath?: string;
  timeoutMs?: number;
}

/** Authenticated Linux display with an exclusive reservation surviving unknown cleanup. */
export async function createPrivateVirtualDisplay(options: PrivateDisplayOptions): Promise<PrivateVirtualDisplay | null> {
  if ((options.platform ?? process.platform) !== "linux") return null;
  const deadline = performance.now() + Math.min(STARTUP_MS, Math.max(1, options.timeoutMs ?? STARTUP_MS));
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root)
    throw new PrivateDisplayError("Invalid private display directory");
  await proveBefore(deadline, () => assertNoRetainedDisplay(options.root));
  let executable: DisplayExecutable | null;
  try { executable = await proveBefore(deadline, () => inspectDisplayExecutable(options.executablePath ?? "/usr/bin/Xvfb")); }
  catch { throw new PrivateDisplayError("Private browser display executable is not trusted or usable"); }
  if (!executable) return null;
  const directory = options.root;
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.() ||
      (parentInfo.mode & 0o777) !== 0o700 || await realpath(parent) !== parent)
    throw new PrivateDisplayError("Private browser display directory is not trusted");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PrivateDisplayCleanupError();
    throw new PrivateDisplayError("Private browser display directory is unavailable");
  }
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid?.() ||
      (rootInfo.mode & 0o777) !== 0o700 || await realpath(directory) !== directory)
    throw new PrivateDisplayCleanupError();
  const nonce = randomBytes(16).toString("hex");
  const markerPath = join(directory, "OWNED.json");
  const authPath = join(directory, "authority");
  const display = String(randomInt(20_000, 60_000));
  const cookie = randomBytes(16);
  let child: ChildProcess | null = null;
  let identity: DisplayProcess | null = null;
  let stopPromise: Promise<void> | null = null;
  let revoked = false;
  let fault = false;
  const owner = { version: 1, nonce, directory, executable, pid: null as number | null, process: null as DisplayProcess | null };
  let markerWritten = false;
  const stop = () => (stopPromise ??= (async () => {
    revoked = true;
    const shutdownDeadline = performance.now() + SHUTDOWN_MS;
    try {
      if (child) await stopDisplayChild(child, identity, () => fault, shutdownDeadline);
      const info = await proveBefore(shutdownDeadline, () => lstat(directory));
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== rootInfo.dev || info.ino !== rootInfo.ino ||
          info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || await proveBefore(shutdownDeadline, () => realpath(directory)) !== directory)
        throw new PrivateDisplayCleanupError();
      if (markerWritten) {
        const text = await proveBefore(shutdownDeadline, () => readFile(markerPath, "utf8"));
        if (text.length > 4096) throw new PrivateDisplayCleanupError();
        const marker = JSON.parse(text);
        if (marker.nonce !== nonce || marker.directory !== directory) throw new PrivateDisplayCleanupError();
      }
      // Deletion follows confirmed child exit/never-started proof, never a finally block.
      // Node cannot abort rm; it may finish late only after confirmed exit and a verified root.
      await proveBefore(shutdownDeadline, () => rm(directory, { recursive: true, force: false }));
    } catch { throw new PrivateDisplayCleanupError(); }
  })());
  try {
    await writeFile(markerPath, JSON.stringify(owner) + "\n", { mode: 0o600, flag: "wx" });
    markerWritten = true;
    await writeFile(authPath, encodeDisplayAuthority(display, cookie), { mode: 0o600, flag: "wx" });
    if (performance.now() >= deadline) throw new PrivateDisplayError("Private browser display was not ready");
    const argv = [executable.path, `:${display}`, "-screen", "0", `${MAX_VIEWPORT.width}x${MAX_VIEWPORT.height}x24`,
      "-nolisten", "unix", "-nolisten", "tcp", "-nolock", "-auth", authPath, "-displayfd", "3"];
    child = spawn(executable.path, argv.slice(1), {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, LANG: "C.UTF-8" },
    });
    child.on("error", () => { fault = true; });
    child.once("exit", () => { revoked = true; });
    owner.pid = child.pid ?? null;
    // Persist the exact owned PID before asynchronous verification; an unverified child is never signalled.
    await writeFile(markerPath, JSON.stringify(owner) + "\n", { mode: 0o600 });
    if (child.pid) {
      const candidate = await proveBefore(deadline, () => readDisplayProcess(child!.pid!));
      if (!candidate || candidate.parentPid !== process.pid || candidate.uid !== process.getuid?.() ||
          candidate.executable !== executable.path || candidate.executableDev !== executable.dev ||
          candidate.executableIno !== executable.ino || candidate.argvHash !== displayArgvHash(argv))
        throw new PrivateDisplayError("Private browser display identity could not be confirmed");
      identity = candidate;
      owner.process = identity;
      await writeFile(markerPath, JSON.stringify(owner) + "\n", { mode: 0o600 });
    }
    if (fault || !child.pid || confirmedExit(child)) throw new PrivateDisplayError("Private browser display failed to start");
    if (performance.now() >= deadline) throw new PrivateDisplayError("Private browser display was not ready");
    await waitDisplayReady(child, display, Math.max(1, deadline - performance.now()));
    const readyIdentity = await proveBefore(deadline, () => readDisplayProcess(child!.pid!));
    if (!identity || !readyIdentity || !sameDisplayProcess(identity, readyIdentity) || readyIdentity.children.length)
      throw new PrivateDisplayError("Private browser display identity could not be confirmed");
    identity = readyIdentity;
    if (revoked || fault || !(await proveBefore(deadline, () => authenticateDisplay(display, cookie))))
      throw new PrivateDisplayError("Private browser display authentication failed");
    if (await proveBefore(deadline, () => authenticateDisplay(display, Buffer.alloc(0))))
      throw new PrivateDisplayError("Private browser display accepted an unauthenticated client");
    const foreignCookie = Buffer.from(cookie);
    foreignCookie[0] = foreignCookie[0]! ^ 0xff;
    if (await proveBefore(deadline, () => authenticateDisplay(display, foreignCookie)))
      throw new PrivateDisplayError("Private browser display accepted a foreign cookie");
    if (revoked || fault) throw new PrivateDisplayError("Private browser display ended");
    return {
      launchEnvironment: Object.freeze({ DISPLAY: `:${display}`, XAUTHORITY: authPath }),
      assertAvailable() { if (revoked || fault) throw new RuntimeLostError("Private browser display ended"); },
      stop,
    };
  } catch (error) {
    await stop();
    throw error instanceof PrivateDisplayError ? error : new PrivateDisplayError("Private browser display failed to start");
  }
}
