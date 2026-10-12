/** Per-instance display context reaches native CLI children without changing host or session authority. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const exec = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; env: NodeJS.ProcessEnv }[],
}));
// Records the exact child launch instead of running a platform-specific script.
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: null, result: { stdout: string }) => void,
  ) => {
    exec.calls.push({ file, args, env: options.env });
    callback(null, { stdout: args.includes("--version") ? "0.38.2\n" : "{}\n" });
  },
}));

async function fixture(launchEnvironment?: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "hosts-browser-runtime-env-"));
  temporary.push(directory);
  const binary = join(directory, "owned-cli");
  const runtime = new AgentBrowserRuntime({
    binaryPath: binary,
    executablePath: join(directory, "unlaunched-chromium"),
    profilePath: join(directory, "owned-profile"),
    ipcDirectory: join(directory, "owned-ipc"),
    session: "owned-environment",
    ...(launchEnvironment ? { launchEnvironment } : {}),
  });
  const native = runtime as unknown as {
    assertVersion(): Promise<void>;
    invoke(args: string[]): Promise<unknown>;
  };
  /** Environment the owned CLI child received for the call with these arguments. */
  const launched = (args: string[]) => {
    const call = exec.calls.find(
      (candidate) => candidate.file === binary && candidate.args.join() === args.join(),
    );
    if (!call) throw new Error(`CLI was not launched with ${args.join(" ")}`);
    return {
      display: call.env.DISPLAY ?? null,
      authority: call.env.XAUTHORITY ?? null,
      wayland: call.env.WAYLAND_DISPLAY ?? null,
      socket: call.env.AGENT_BROWSER_SOCKET_DIR,
    };
  };
  return { directory, runtime, native, launched };
}

describe("trusted private display launch environment", () => {
  it("passes display/auth to every CLI child, copies settings, and keeps host environment unchanged", async () => {
    const before = {
      display: process.env.DISPLAY,
      authority: process.env.XAUTHORITY,
      wayland: process.env.WAYLAND_DISPLAY,
    };
    const environment = { DISPLAY: ":24701", XAUTHORITY: "/tmp/owned-private-auth" };
    const f = await fixture(environment);
    environment.DISPLAY = ":24702";
    await f.native.assertVersion();
    for (const args of [["owned-request"], ["owned-reconnect"], ["--version"]]) {
      if (args[0] !== "--version") await f.native.invoke(args);
      expect(f.launched(args)).toEqual({
        display: ":24701",
        authority: "/tmp/owned-private-auth",
        wayland: null,
        socket: join(f.directory, "owned-ipc"),
      });
    }
    expect({
      display: process.env.DISPLAY,
      authority: process.env.XAUTHORITY,
      wayland: process.env.WAYLAND_DISPLAY,
    }).toEqual(before);
    await f.runtime.shutdown();
  });
  it("preserves the ordinary host display path when no private environment is provided", async () => {
    const f = await fixture();
    await f.native.invoke(["ordinary"]);
    expect(f.launched(["ordinary"])).toMatchObject({
      display: process.env.DISPLAY ?? null,
      authority: process.env.XAUTHORITY ?? null,
      wayland: process.env.WAYLAND_DISPLAY ?? null,
      socket: join(f.directory, "owned-ipc"),
    });
    await f.runtime.shutdown();
  });
  it("refuses missing, remote or extra values that could override managed IPC/profile/session identity", async () => {
    for (const value of [
      { DISPLAY: ":24701" },
      { DISPLAY: "remote.example:0", XAUTHORITY: "/tmp/auth" },
      { DISPLAY: ":24701", XAUTHORITY: "relative-auth" },
      { DISPLAY: ":24701", XAUTHORITY: "/tmp/auth", AGENT_BROWSER_SOCKET_DIR: "/tmp/other-ipc" },
      { DISPLAY: ":24701", XAUTHORITY: "/tmp/auth", HOME: "/tmp/other-home" },
    ]) {
      await expect(fixture(value)).rejects.toThrow("display environment is invalid");
    }
  });
});
