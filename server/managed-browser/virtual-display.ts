import { setTimeout, clearTimeout } from "./node-timers";
/**
 * Owns one authenticated, invisible Linux X display per browser runtime. Abstract
 * Unix transport avoids WSLg's protected pathname directory; TCP is never enabled.
 * The display stays alive across CDP reconnects. Startup failure is definitive:
 * callers must not silently relaunch a partly initialized browser headlessly.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const finish = (error?: Error) => {
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

/** Stops a spawned child before deleting the secret it may still be reading. */
async function stopDisplayChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts Xvfb only for Linux hidden browsers when the existing executable exists.
 * Absence returns null. Present-but-broken Xvfb fails closed with bounded cleanup.
 * No process.env mutation, network listener, host display, or dependency install.
 * One 3840x3840x24 framebuffer is bounded at about 57 MiB before server overhead;
 * Chromium CPU/memory costs remain those of the existing browser runtime.
 */
export async function createPrivateVirtualDisplay(
  options: { platform?: NodeJS.Platform; executablePath?: string; timeoutMs?: number } = {},
): Promise<PrivateVirtualDisplay | null> {
  if ((options.platform ?? process.platform) !== "linux") return null;
  const executable = options.executablePath ?? "/usr/bin/Xvfb";
  try {
    await access(executable, constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PrivateDisplayError("Private browser display executable is not usable");
  }
  const display = String(randomInt(20_000, 60_000));
  const directory = await mkdtemp(join(tmpdir(), "paseo-browser-display-"));
  const authPath = join(directory, "authority");
  const cookie = randomBytes(16);
  let child: ChildProcess | null = null;
  let stopPromise: Promise<void> | null = null;
  let exited = false;
  const stop = () =>
    (stopPromise ??= (async () => {
      exited = true;
      try {
        if (child) await stopDisplayChild(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    await chmod(directory, 0o700);
    await writeFile(authPath, encodeDisplayAuthority(display, cookie), { mode: 0o600, flag: "wx" });
    child = spawn(
      executable,
      [
        `:${display}`,
        "-screen",
        "0",
        `${MAX_VIEWPORT.width}x${MAX_VIEWPORT.height}x24`,
        "-nolisten",
        "unix",
        "-nolisten",
        "tcp",
        "-nolock",
        "-auth",
        authPath,
        "-displayfd",
        "3",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    child.once("error", () => {
      exited = true;
    });
    child.once("exit", () => {
      exited = true;
    });
    // An explicit high display plus readiness FD does not invoke Xvfb's scan
    // starting at :0. The child's pipe proves it bound that exact listener first.
    await waitDisplayReady(
      child,
      display,
      Math.min(STARTUP_MS, Math.max(1, options.timeoutMs ?? STARTUP_MS)),
    );
    if (exited || !(await authenticateDisplay(display, cookie))) {
      throw new PrivateDisplayError("Private browser display authentication failed");
    }
    if (await authenticateDisplay(display, Buffer.alloc(0))) {
      throw new PrivateDisplayError("Private browser display accepted an unauthenticated client");
    }
    if (exited) throw new PrivateDisplayError("Private browser display ended");
    return {
      launchEnvironment: Object.freeze({ DISPLAY: `:${display}`, XAUTHORITY: authPath }),
      assertAvailable() {
        if (exited) throw new RuntimeLostError("Private browser display ended");
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
