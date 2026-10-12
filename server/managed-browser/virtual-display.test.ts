import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { createPrivateVirtualDisplay, encodeDisplayAuthority } from "./virtual-display";

/** Host-native path: production joins with the platform separator. */
const fixtureDirectory = join(tmpdir(), "private-display-fixture");

const fake = vi.hoisted(() => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  spawn: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("node:fs/promises", () => fake);
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("node:net", () => ({ createConnection: fake.connect }));

let child: EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdio: unknown[];
  kill: ReturnType<typeof vi.fn>;
};
let ready: Readable;
beforeEach(() => {
  vi.clearAllMocks();
  fake.access.mockResolvedValue(undefined);
  fake.chmod.mockResolvedValue(undefined);
  fake.mkdtemp.mockResolvedValue(fixtureDirectory);
  fake.writeFile.mockResolvedValue(undefined);
  fake.rm.mockResolvedValue(undefined);
  ready = new Readable({ read() {} });
  child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    stdio: [null, null, null, ready],
    kill: vi.fn(() => {
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    }),
  });
  fake.spawn.mockImplementation((_path, args) => {
    queueMicrotask(() => ready.push(`${args[0].slice(1)}\n`));
    return child;
  });
  fake.connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn((packet: Buffer) => {
        const response = Buffer.alloc(8);
        response[0] = packet.readUInt16LE(8) === 16 ? 1 : 0;
        response.writeUInt16LE(11, 2);
        queueMicrotask(() => socket.emit("data", response));
      }),
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
});

it("keeps non-Linux and missing Xvfb on the original path without side effects", async () => {
  expect(await createPrivateVirtualDisplay({ platform: "win32" })).toBeNull();
  expect(fake.access).not.toHaveBeenCalled();
  fake.access.mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" }));
  expect(await createPrivateVirtualDisplay({ platform: "linux" })).toBeNull();
  expect(fake.spawn).not.toHaveBeenCalled();
  expect(fake.mkdtemp).not.toHaveBeenCalled();
});

it("uses an authenticated private high abstract-only display and idempotent cleanup", async () => {
  const originalDisplay = process.env.DISPLAY;
  const display = await createPrivateVirtualDisplay({ platform: "linux" });
  expect(display).not.toBeNull();
  const args = fake.spawn.mock.calls[0]![1] as string[];
  expect(Number(args[0]!.slice(1))).toBeGreaterThanOrEqual(20_000);
  expect(args).toEqual([
    args[0],
    "-screen",
    "0",
    "3840x3840x24",
    "-nolisten",
    "unix",
    "-nolisten",
    "tcp",
    "-nolock",
    "-auth",
    join(fixtureDirectory, "authority"),
    "-displayfd",
    "3",
  ]);
  expect(fake.chmod).toHaveBeenCalledWith(fixtureDirectory, 0o700);
  expect(fake.writeFile.mock.calls[0]![2]).toEqual({ mode: 0o600, flag: "wx" });
  expect(fake.connect).toHaveBeenCalledTimes(2); // Authorized and anonymous denial.
  expect(fake.connect.mock.calls[0]![0].path).toBe(`\0/tmp/.X11-unix/X${args[0]!.slice(1)}`);
  expect(process.env.DISPLAY).toBe(originalDisplay);
  display!.assertAvailable();
  await display!.stop();
  await display!.stop();
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fake.rm).toHaveBeenCalledTimes(1);
  expect(() => display!.assertAvailable()).toThrow("ended");
});

it("refuses a changed readiness identity before transmitting the secret", async () => {
  fake.spawn.mockImplementation(() => {
    queueMicrotask(() => ready.push("0\n"));
    return child;
  });
  await expect(createPrivateVirtualDisplay({ platform: "linux" })).rejects.toThrow(
    "identity changed",
  );
  expect(fake.connect).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fake.rm).toHaveBeenCalledTimes(1);
});

it("bounds a never-ready child and removes its authority file", async () => {
  fake.spawn.mockReturnValue(child);
  await expect(createPrivateVirtualDisplay({ platform: "linux", timeoutMs: 5 })).rejects.toThrow(
    "not ready",
  );
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fake.rm).toHaveBeenCalledTimes(1);
});

it("handles spawn failure and prevents silent headless fallback", async () => {
  fake.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("error", new Error("fixture spawn failure")));
    return child;
  });
  await expect(createPrivateVirtualDisplay({ platform: "linux" })).rejects.toThrow(
    "failed to start",
  );
  expect(fake.rm).toHaveBeenCalledTimes(1);
});

it("refuses a display which accepts clients without the private cookie", async () => {
  fake.connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: () => {
        const response = Buffer.alloc(8);
        response[0] = 1;
        response.writeUInt16LE(11, 2);
        queueMicrotask(() => socket.emit("data", response));
      },
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  await expect(createPrivateVirtualDisplay({ platform: "linux" })).rejects.toThrow(
    "unauthenticated",
  );
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("invalidates on unexpected child exit without starting a replacement", async () => {
  const display = await createPrivateVirtualDisplay({ platform: "linux" });
  child.exitCode = 1;
  child.emit("exit", 1);
  expect(() => display!.assertAvailable()).toThrow("ended");
  await display!.stop();
  expect(fake.spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});

it("encodes the display-scoped authority format and rejects malformed inputs", () => {
  const cookie = Buffer.alloc(16, 7);
  const authority = encodeDisplayAuthority("23067", cookie);
  expect(authority.readUInt16BE(0)).toBe(65_535);
  expect(authority.includes(Buffer.from("MIT-MAGIC-COOKIE-1"))).toBe(true);
  expect(authority.subarray(-16)).toEqual(cookie);
  expect(() => encodeDisplayAuthority("0", cookie)).toThrow();
  expect(() => encodeDisplayAuthority("23067", Buffer.alloc(2))).toThrow();
});
