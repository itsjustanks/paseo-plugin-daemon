/** The session daemon is signalled only while it is still the exact process this runtime launched. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { RUNTIME_OWNER_VARIABLE } from "./process-identity";

const probe = vi.hoisted(() => ({
  unreadable: false,
  /** Simulated /proc ownership for platforms without it: pid -> start ticks. */
  simulated: null as Map<number, string> | null,
}));
vi.mock("./process-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process-identity")>();
  return {
    ...actual,
    probeProcess: (pid: number, nonce: string) => {
      if (probe.unreadable) return Promise.resolve({ status: "unknown" as const });
      if (!probe.simulated) return actual.probeProcess(pid, nonce);
      // Simulated ownership (platforms without /proc): a stable start time for owned pids,
      // real liveness so a killed child is observed absent rather than owned forever.
      if (!actual.processExists(pid)) return Promise.resolve({ status: "absent" as const });
      const startTicks = probe.simulated.get(pid);
      return Promise.resolve(
        startTicks === undefined
          ? { status: "foreign" as const }
          : { status: "owned" as const, identity: { pid, startTicks } },
      );
    },
  };
});

const cli = vi.hoisted(() => ({ onClose: null as null | (() => void), closes: 0 }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: null, result: { stdout: string }) => void,
  ) => {
    if (args.includes("close")) {
      cli.closes += 1;
      cli.onClose?.();
    }
    callback(null, { stdout: args.includes("--version") ? "0.37.1\n" : "{}\n" });
  },
}));

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  cli.onClose = null;
  cli.closes = 0;
  probe.unreadable = false;
  probe.simulated = null;
  vi.restoreAllMocks();
});

/** A harmless process this test owns; `nonce` makes it descend from the runtime's own launch. */
async function ownChild(nonce?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: nonce ? { ...process.env, [RUNTIME_OWNER_VARIABLE]: nonce } : process.env,
  });
  children.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));

async function fixture(waitMs = 400) {
  const directory = await mkdtemp(join(tmpdir(), "hosts-browser-daemon-"));
  directories.push(directory);
  const ipc = join(directory, "ipc");
  const profile = join(directory, "profile");
  await mkdir(ipc, { recursive: true });
  const runtime = new AgentBrowserRuntime({
    binaryPath: process.execPath,
    executablePath: join(directory, "unlaunched-chromium"),
    profilePath: profile,
    ipcDirectory: ipc,
    session: "owned",
    daemonExitWaitMs: waitMs,
  });
  const native = runtime as unknown as {
    ownerNonce: string;
    daemonLaunched: boolean;
    captureDaemon(): Promise<void>;
    daemon: { pid: number; identity: { pid: number; startTicks: string } | null } | null;
  };
  const recordPid = async (pid: number) => {
    await mkdir(profile, { recursive: true });
    await writeFile(join(ipc, "owned.pid"), String(pid));
    await writeFile(join(ipc, "owned.sock"), "");
    native.daemonLaunched = true;
    await native.captureDaemon();
  };
  return { runtime, native, recordPid, ipc, profile };
}

describe.skipIf(process.platform !== "linux")("owned daemon shutdown", () => {
  it("waits for the acknowledged close to finish the daemon without signalling it, preserving the profile", async () => {
    const f = await fixture();
    const daemon = await ownChild(f.native.ownerNonce);
    await f.recordPid(daemon.pid as number);
    expect(f.native.daemon?.identity?.pid).toBe(daemon.pid);
    const kill = vi.spyOn(process, "kill");
    cli.onClose = () => void setTimeout(() => daemon.kill("SIGTERM"), 100);
    await f.runtime.shutdown();
    await exited(daemon);
    expect(kill).not.toHaveBeenCalledWith(daemon.pid, "SIGKILL");
    await expect(readFile(join(f.ipc, "owned.sock"))).rejects.toThrow();
    await expect(readFile(join(f.profile, "."))).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("force-terminates a daemon that outlives the bounded wait and confirms exit before returning", async () => {
    const f = await fixture(200);
    const daemon = await ownChild(f.native.ownerNonce);
    await f.recordPid(daemon.pid as number);
    const kill = vi.spyOn(process, "kill");
    await f.runtime.shutdown();
    // exit was confirmed before shutdown returned; the OS only has to deliver the status
    await exited(daemon);
    // Portable contract (signalCode is POSIX-only): the runtime asked for SIGKILL of the
    // owned pid, and that process is observably gone.
    expect(kill).toHaveBeenCalledWith(daemon.pid, "SIGKILL");
    expect(daemon.pid && alive(daemon.pid)).toBe(false);
    expect(cli.closes).toBe(1);
    await expect(readFile(join(f.ipc, "owned.pid"))).rejects.toThrow();
  });

  it("fails shutdown instead of reporting success when a signalled daemon does not exit", async () => {
    const f = await fixture(200);
    const daemon = await ownChild(f.native.ownerNonce);
    await f.recordPid(daemon.pid as number);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(f.runtime.shutdown(true)).rejects.toThrow("not confirmed");
    expect(kill).toHaveBeenCalledWith(daemon.pid, "SIGKILL");
    expect(daemon.pid && alive(daemon.pid)).toBe(true);
  });

  it("never signals a verified PID that was recycled after capture", async () => {
    const f = await fixture(200);
    const recorded = await ownChild(f.native.ownerNonce);
    await f.recordPid(recorded.pid as number);
    const identity = f.native.daemon?.identity;
    expect(identity).toBeTruthy();
    // Same PID, different birth: the recorded start time no longer matches.
    f.native.daemon = {
      pid: recorded.pid as number,
      identity: { ...(identity as { pid: number; startTicks: string }), startTicks: "1" },
    };
    const kill = vi.spyOn(process, "kill");
    await f.runtime.shutdown(true);
    expect(kill).not.toHaveBeenCalledWith(recorded.pid, "SIGKILL");
    expect(recorded.pid && alive(recorded.pid)).toBe(true);
  });

  it("does not own a same-executable process from another session named by the PID file", async () => {
    const f = await fixture(200);
    // Same executable as the runtime's own children, but not launched by this runtime.
    const otherSession = await ownChild();
    await f.recordPid(otherSession.pid as number);
    expect(f.native.daemon?.identity).toBeNull();
    const kill = vi.spyOn(process, "kill");
    await expect(f.runtime.shutdown(true)).rejects.toThrow("not confirmed");
    expect(kill).not.toHaveBeenCalledWith(otherSession.pid, "SIGKILL");
    expect(otherSession.pid && alive(otherSession.pid)).toBe(true);
  });
});

describe("unverifiable daemon identity (platforms without /proc, unowned PIDs)", () => {
  it("accepts a graceful close once the recorded process is observed gone, without signalling", async () => {
    const f = await fixture();
    const daemon = await ownChild();
    await f.recordPid(daemon.pid as number);
    const kill = vi.spyOn(process, "kill");
    cli.onClose = () => void setTimeout(() => daemon.kill("SIGTERM"), 100);
    await f.runtime.shutdown();
    expect(kill).not.toHaveBeenCalledWith(daemon.pid, "SIGKILL");
    await expect(readFile(join(f.ipc, "owned.sock"))).rejects.toThrow();
  });

  it("neither signals nor reports success when the recorded process stays alive", async () => {
    const f = await fixture(150);
    const daemon = await ownChild();
    await f.recordPid(daemon.pid as number);
    const kill = vi.spyOn(process, "kill");
    await expect(f.runtime.shutdown()).rejects.toThrow("not confirmed");
    expect(kill).not.toHaveBeenCalledWith(daemon.pid, "SIGKILL");
  });

  it("has nothing to observe or signal for a runtime that never launched", async () => {
    // Never launched: ordinary cleanup has nothing to observe.
    const f = await fixture(150);
    await f.native.captureDaemon();
    expect(f.native.daemon).toBeNull();
    await expect(f.runtime.shutdown()).resolves.toBeUndefined();
  });
});

/** Real /proc ownership on Linux; an explicit simulation of it everywhere (macOS, Windows have no /proc). */
const ownershipModes =
  process.platform === "linux" ? (["real", "simulated"] as const) : (["simulated"] as const);
describe.each(ownershipModes)(
  "unknown daemon state is never confirmed exit (%s ownership)",
  (mode) => {
    /** Marks a child as this runtime's own daemon when ownership is simulated. */
    const own = (daemon: ChildProcess) => {
      if (mode === "simulated") probe.simulated = new Map([[daemon.pid as number, "42"]]);
    };
    it("fails closed, then recovers once the PID record is observable, when capture found no PID", async () => {
      const f = await fixture(150);
      const daemon = await ownChild(f.native.ownerNonce);
      own(daemon);
      f.native.daemonLaunched = true; // launched, but the PID file is unreadable at capture
      await f.native.captureDaemon();
      expect(f.native.daemon).toBeNull();
      const kill = vi.spyOn(process, "kill");
      await expect(f.runtime.shutdown()).rejects.toThrow("not confirmed");
      await expect(f.runtime.shutdown(true)).rejects.toThrow("not confirmed");
      expect(kill).not.toHaveBeenCalledWith(daemon.pid, "SIGKILL");
      expect(daemon.pid && alive(daemon.pid)).toBe(true);
      // The record becomes readable again: shutdown re-captures, re-verifies and finishes.
      await writeFile(join(f.ipc, "owned.pid"), String(daemon.pid));
      await f.runtime.shutdown(true);
      await exited(daemon);
      // Portable contract (signalCode is POSIX-only): the runtime asked for SIGKILL of the
      // owned pid, and that process is observably gone.
      expect(kill).toHaveBeenCalledWith(daemon.pid, "SIGKILL");
      expect(daemon.pid && alive(daemon.pid)).toBe(false);
    });

    it("does not treat a later unreadable identity as exit and never signals on it", async () => {
      const f = await fixture(150);
      const daemon = await ownChild(f.native.ownerNonce);
      own(daemon);
      await f.recordPid(daemon.pid as number);
      expect(f.native.daemon?.identity).toBeTruthy();
      probe.unreadable = true;
      const kill = vi.spyOn(process, "kill");
      await expect(f.runtime.shutdown()).rejects.toThrow("not confirmed");
      await expect(f.runtime.shutdown(true)).rejects.toThrow("not confirmed");
      expect(kill).not.toHaveBeenCalledWith(daemon.pid, "SIGKILL");
      expect(daemon.pid && alive(daemon.pid)).toBe(true);
      await expect(readFile(join(f.ipc, "owned.sock"))).resolves.toBeDefined(); // metadata kept
      // Identity is readable again: the original verification authorises the forced exit.
      probe.unreadable = false;
      await f.runtime.shutdown(true);
      await exited(daemon);
      // Portable contract (signalCode is POSIX-only): the runtime asked for SIGKILL of the
      // owned pid, and that process is observably gone.
      expect(kill).toHaveBeenCalledWith(daemon.pid, "SIGKILL");
      expect(daemon.pid && alive(daemon.pid)).toBe(false);
    });

    it("shares one in-flight shutdown and never reports success after a failed one", async () => {
      const f = await fixture(150);
      const daemon = await ownChild();
      await f.recordPid(daemon.pid as number); // unowned: observable, not signalled
      const outcomes = await Promise.allSettled([f.runtime.shutdown(), f.runtime.shutdown()]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      await expect(f.runtime.shutdown()).rejects.toThrow("not confirmed");
      daemon.kill("SIGKILL");
      await exited(daemon);
      await expect(f.runtime.shutdown()).resolves.toBeUndefined();
      await expect(f.runtime.shutdown()).resolves.toBeUndefined();
    });
  },
);
