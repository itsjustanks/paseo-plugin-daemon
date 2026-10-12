/** Ownership must survive the shipped JS-launcher -> detached daemon chain, not just a native binary. */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const launcher = `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const dir = process.env.AGENT_BROWSER_SOCKET_DIR;
const session = args[args.indexOf("--session") + 1];
if (args.includes("--version")) console.log("0.37.1");
else if (args.includes("open")) {
  // Like the shipped launcher: the daemon is detached but inherits this process's environment.
  const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  daemon.unref();
  writeFileSync(join(dir, session + ".pid"), String(daemon.pid));
  console.log("{}");
} else if (args.includes("close")) {
  process.kill(Number(require("node:fs").readFileSync(join(dir, session + ".pid"), "utf8")), "SIGTERM");
  console.log("{}");
}
`;

it.skipIf(process.platform !== "linux")(
  "verifies the detached daemon through a script launcher and observes its exit without a signal",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosts-browser-chain-"));
    directories.push(directory);
    const binary = join(directory, "agent-browser");
    await writeFile(binary, launcher);
    await chmod(binary, 0o700);
    const runtime = new AgentBrowserRuntime({
      binaryPath: binary,
      executablePath: join(directory, "unlaunched-chromium"),
      profilePath: join(directory, "profile"),
      ipcDirectory: join(directory, "ipc"),
      session: "chain",
      daemonExitWaitMs: 3_000,
    });
    const native = runtime as unknown as {
      invoke(args: string[]): Promise<unknown>;
      captureDaemon(): Promise<void>;
      daemonLaunched: boolean;
      daemon: { pid: number; identity: unknown } | null;
    };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "ipc"), { recursive: true });
    await native.invoke(["--session", "chain", "--json", "open", "about:blank"]);
    native.daemonLaunched = true;
    await native.captureDaemon();
    expect(native.daemon?.identity).toBeTruthy();
    const pid = native.daemon?.pid as number;
    const kill = vi.spyOn(process, "kill");
    await runtime.shutdown();
    expect(kill).not.toHaveBeenCalledWith(pid, "SIGKILL");
    expect(() => process.kill(pid, 0)).toThrow();
  },
);
