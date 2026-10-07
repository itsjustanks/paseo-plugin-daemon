import { describe, expect, it } from "vitest";
import type { Launch } from "../server/daemon-log";
import type { CliResult } from "../server/paseo-cli";
import { cliCandidates, PaseoCli, parsePluginList } from "../server/paseo-cli";
import type { ProcessIdentity } from "../server/platform";
import type { PluginHost } from "../server/plugin-procs";
import { PluginRestarter, brief } from "../server/plugin-restart";
import { RestartOutcomeSchema } from "../shared/guard";
import type { ActionLogEntry } from "../shared/processes";

const DAEMON = 4242;
const SELF = 300;
const UID = 1000;

interface FakeProcess { pid: number; startId: string; argvHash: string; startMs: number; alive: boolean; ignoresTerm: boolean; plugin: string }

/**
 * A daemon whose plugin manager wedges the way a real one did: while the
 * stuck plugin's process is alive, every `paseo plugin reload` hangs until
 * its timeout. Once that process is gone, the queued reload completes and the
 * plugin comes back with a fresh process (and a "Plugin ready" log line).
 */
class FakeDaemon {
  now = 1_800_000_000_000;
  wedged = true;
  /** The reload queued while wedged completes when the wedge clears. */
  queued = false;
  /** Reloads that hang even after the wedge clears (a second, unrelated fault). */
  stillHangs = false;
  failWith: string | null = null;
  reloads: string[] = [];
  kills: Array<[number, string]> = [];
  log: ActionLogEntry[] = [];
  readyAt = new Map<string, number>();
  launches = new Map<string, Launch[]>();
  processes = new Map<number, FakeProcess>();
  nextPid = 900;
  /** Called right before an identity read, to change the world mid-restart. */
  beforeIdentity: ((pid: number) => void) | null = null;

  constructor() {
    this.launch("activity", 1000, false);
    this.launch("ai-router", 1001, false);
  }

  launch(plugin: string, pid: number, ready = true): FakeProcess {
    const startMs = this.now;
    const list = this.launches.get(plugin) ?? [];
    list.push({ loadingAt: startMs - 1000, readyAt: startMs + 1000, stoppingAt: null, stoppedAt: null, daemonPid: DAEMON });
    this.launches.set(plugin, list);
    const process: FakeProcess = { pid, startId: `t${pid}-${startMs}`, argvHash: "plugin-process", startMs, alive: true, ignoresTerm: false, plugin };
    this.processes.set(pid, process);
    if (ready) this.readyAt.set(plugin, startMs + 1000);
    this.now += 60_000;
    return process;
  }

  cli = {
    canReload: async () => true,
    reload: async (pluginId: string, timeoutMs: number): Promise<CliResult> => {
      this.reloads.push(pluginId);
      if (this.failWith) return { code: 1, stdout: "", stderr: this.failWith, timedOut: false };
      if (this.wedged || this.stillHangs) { this.queued = true; this.now += timeoutMs; return { code: null, stdout: "", stderr: "", timedOut: true }; }
      this.relaunch(pluginId);
      return { code: 0, stdout: "reloaded", stderr: "", timedOut: false };
    },
  };

  private relaunch(pluginId: string) {
    for (const process of this.processes.values()) if (process.plugin === pluginId) process.alive = false;
    this.launch(pluginId, this.nextPid++);
  }

  kill = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    this.kills.push([pid, signal]);
    const process = this.processes.get(pid);
    if (!process || !process.alive) { const error = new Error("ESRCH") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; }
    if (signal === "SIGTERM" && process.ignoresTerm) return;
    process.alive = false;
    if (process.plugin === "activity") {
      this.wedged = false;
      if (this.queued && !this.stillHangs) { this.queued = false; this.relaunch("activity"); }
    }
  };

  deps(overrides: Partial<ConstructorParameters<typeof PluginRestarter>[0]> = {}) {
    return {
      cli: this.cli,
      launches: async () => this.launches,
      hosts: async (): Promise<PluginHost[]> => [...this.processes.values()].filter((process) => process.alive).map(({ pid, startId, startMs, argvHash }) => ({ pid, startId, startMs, argvHash })),
      identity: async (pid: number): Promise<ProcessIdentity | null> => {
        this.beforeIdentity?.(pid);
        const process = this.processes.get(pid);
        if (pid === SELF) return { pid, ppid: DAEMON, uid: UID, startId: "self", argvHash: "plugin-process", state: "running" };
        return process?.alive ? { pid, ppid: DAEMON, uid: UID, startId: process.startId, argvHash: process.argvHash, state: "sleeping" } : null;
      },
      kill: this.kill,
      self: { pid: SELF, startMs: async () => null },
      uid: UID,
      daemonPid: DAEMON,
      log: async (entry: ActionLogEntry) => { this.log.push(entry); },
      readyAfter: async (pluginId: string, since: number) => (this.readyAt.get(pluginId) ?? 0) > since,
      now: () => this.now,
      sleep: async (ms: number) => { this.now += ms; },
      ...overrides,
    };
  }
}

describe("Restart <plugin>", () => {
  it("just reloads when Paseo isn't stuck, and stops nothing", async () => {
    const daemon = new FakeDaemon();
    daemon.wedged = false;
    const outcome = RestartOutcomeSchema.parse(await new PluginRestarter(daemon.deps()).restart("activity"));
    expect(outcome).toMatchObject({ ok: true, outcome: "reloaded" });
    expect(daemon.kills).toEqual([]);
    expect(daemon.log.map((entry) => [entry.action, entry.status])).toEqual([["plugin-reload", "done"]]);
  });

  it("escalates when the reload hangs: stops only the stuck plugin's process, and Paseo finishes the reload", async () => {
    const daemon = new FakeDaemon();
    const outcome = RestartOutcomeSchema.parse(await new PluginRestarter(daemon.deps()).restart("activity"));
    expect(outcome).toMatchObject({ ok: true, outcome: "stopped-and-reloaded" });
    expect(daemon.kills).toEqual([[1000, "SIGTERM"]]);
    expect(daemon.processes.get(1001)!.alive).toBe(true);
    expect(daemon.reloads).toEqual(["activity"]);
    expect(daemon.log.map((entry) => [entry.action, entry.status, entry.pid])).toEqual([["plugin-reload", "timed-out", null], ["plugin-stop", "signaled", 1000]]);
    expect(outcome.steps.map((step) => step.text).join(" ")).toMatch(/plugin manager looks stuck.*Asked Activity's process \(PID 1000\) to stop/);
  });

  it("forces it after the grace period only if the very same process is still there", async () => {
    const daemon = new FakeDaemon();
    daemon.processes.get(1000)!.ignoresTerm = true;
    const outcome = await new PluginRestarter(daemon.deps({ graceMs: 10_000 })).restart("activity");
    expect(outcome.ok).toBe(true);
    expect(daemon.kills).toEqual([[1000, "SIGTERM"], [1000, "SIGKILL"]]);
    expect(daemon.log.map((entry) => entry.action)).toEqual(["plugin-reload", "plugin-stop", "plugin-force-stop"]);
  });

  it("reloads again itself when the queued reload doesn't finish on its own", async () => {
    const daemon = new FakeDaemon();
    // The stop clears the wedge, but the reload that was queued is lost: nothing comes back by itself.
    const kill = (pid: number, signal: "SIGTERM" | "SIGKILL") => { daemon.kills.push([pid, signal]); daemon.processes.get(pid)!.alive = false; daemon.wedged = false; };
    const outcome = await new PluginRestarter(daemon.deps({ kill, readyAfter: async () => false })).restart("activity");
    expect(outcome).toMatchObject({ ok: true, outcome: "stopped-and-reloaded" });
    expect(daemon.reloads).toEqual(["activity", "activity"]);
    expect(daemon.kills).toEqual([[1000, "SIGTERM"]]);
  });

  it("says so plainly when even the second reload hangs", async () => {
    const daemon = new FakeDaemon();
    daemon.stillHangs = true;
    const outcome = await new PluginRestarter(daemon.deps({ readyAfter: async () => false })).restart("activity");
    expect(outcome).toMatchObject({ ok: false, outcome: "failed" });
    expect(outcome.message).toContain('paseo plugin reload activity');
    expect(daemon.kills).toEqual([[1000, "SIGTERM"]]);
  });

  it("keeps the paseo command's error readable", () => {
    expect(brief("Error: Request failed: Plugin is not configured: example-plugin requestType=plugin.reload.request code=handler_error\n")).toBe("Plugin is not configured: example-plugin");
  });

  it("stops nothing when the reload fails for another reason", async () => {
    const daemon = new FakeDaemon();
    daemon.failWith = "Plugin is not configured: activity";
    const outcome = await new PluginRestarter(daemon.deps()).restart("activity");
    expect(outcome).toMatchObject({ ok: false, outcome: "failed" });
    expect(outcome.message).toContain("Nothing was stopped");
    expect(daemon.kills).toEqual([]);
  });

  it("stops nothing when the PID changed between finding it and signalling it", async () => {
    const daemon = new FakeDaemon();
    daemon.beforeIdentity = (pid) => { const process = daemon.processes.get(pid); if (process) process.startId = "reused"; };
    const outcome = await new PluginRestarter(daemon.deps()).restart("activity");
    expect(outcome).toMatchObject({ ok: false, outcome: "failed" });
    expect(daemon.kills).toEqual([]);
  });

  it("stops nothing when the plugin's process can't be told apart", async () => {
    const daemon = new FakeDaemon();
    // A second plugin process started inside activity's window: ambiguous.
    daemon.processes.set(1002, { ...daemon.processes.get(1000)!, pid: 1002, startId: "t1002", plugin: "unknown" });
    const outcome = await new PluginRestarter(daemon.deps()).restart("activity");
    expect(outcome).toMatchObject({ ok: false, outcome: "failed" });
    expect(outcome.message).toMatch(/^Hosts stopped nothing: /);
    expect(daemon.kills).toEqual([]);
  });

  it("never touches Hosts, the daemon, or a process that isn't the daemon's child", async () => {
    const daemon = new FakeDaemon();
    expect(await new PluginRestarter(daemon.deps()).restart("daemon-link")).toMatchObject({ ok: false, outcome: "refused" });
    expect(await new PluginRestarter(daemon.deps()).restart("daemon-link-buildcheck")).toMatchObject({ ok: false, outcome: "refused" });
    expect(await new PluginRestarter(daemon.deps()).restart("../../etc")).toMatchObject({ ok: false, outcome: "refused" });
    // The log claims the daemon's own PID is the plugin's process: refused at signal time.
    const lying = daemon.deps({ hosts: async () => [{ pid: DAEMON, startId: "d", startMs: daemon.processes.get(1000)!.startMs, argvHash: "plugin-process" }] });
    expect(await new PluginRestarter(lying).restart("activity")).toMatchObject({ ok: false });
    // A process that is no longer the daemon's child (re-parented) is refused too.
    const orphan = daemon.deps({ identity: async (pid) => ({ pid, ppid: 1, uid: UID, startId: daemon.processes.get(pid)?.startId ?? "", argvHash: "plugin-process", state: "sleeping" }) });
    expect(await new PluginRestarter(orphan).restart("activity")).toMatchObject({ ok: false });
    expect(daemon.kills).toEqual([]);
  });

  it("asks for the paseo command first, and runs one restart at a time", async () => {
    const daemon = new FakeDaemon();
    expect(await new PluginRestarter(daemon.deps({ cli: { ...daemon.cli, canReload: async () => false } })).restart("activity")).toMatchObject({ ok: false, outcome: "refused", message: expect.stringContaining("paseo command") });
    daemon.wedged = false;
    const restarter = new PluginRestarter(daemon.deps());
    const [first, second] = await Promise.all([restarter.restart("activity"), restarter.restart("ai-router")]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, outcome: "refused" });
  });
});

describe("a restart longer than one call may wait", () => {
  it("answers \"running\" inside Paseo's 30-second limit, then reports the outcome", async () => {
    const daemon = new FakeDaemon();
    let release: (result: CliResult) => void = () => undefined;
    const slow = { canReload: async () => true, reload: () => new Promise<CliResult>((resolve) => { release = resolve; }) };
    const restarter = new PluginRestarter(daemon.deps({ cli: slow }));
    const first = await restarter.begin("activity", 20);
    expect(first).toMatchObject({ ok: false, outcome: "running", pluginId: "activity" });
    expect(first.steps.map((step) => step.text)).toEqual(["Asked Paseo to reload Activity."]);
    // Asking again joins the same restart; another plugin has to wait.
    expect((await restarter.begin("activity", 5)).outcome).toBe("running");
    expect(await restarter.begin("ai-router", 5)).toMatchObject({ outcome: "refused" });
    release({ code: 0, stdout: "", stderr: "", timedOut: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(restarter.status("activity")).toMatchObject({ ok: true, outcome: "reloaded" });
    expect(restarter.status("ai-router")).toMatchObject({ ok: false, outcome: "failed" });
    // Finished: a new press starts a new restart.
    expect((await restarter.begin("ai-router", 5)).outcome).toBe("running");
    release({ code: 0, stdout: "", stderr: "", timedOut: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(restarter.status("ai-router")).toMatchObject({ ok: true, outcome: "reloaded", pluginId: "ai-router" });
  });
});

describe("the paseo command", () => {
  it("prefers the copy that ships with the daemon over PATH", () => {
    expect(cliCandidates("/opt/npm-global/lib/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js"))
      .toEqual(["/opt/npm-global/lib/node_modules/@getpaseo/cli/bin/paseo", "paseo"]);
    expect(cliCandidates("/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js"))
      .toEqual(["/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/cli/bin/paseo", "/Applications/Paseo.app/Contents/Resources/bin/paseo", "paseo"]);
    expect(cliCandidates("")).toEqual(["paseo"]);
  });

  it("feature-checks reload, validates ids, and reads the plugin list", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: readonly string[]): Promise<CliResult> => {
      calls.push([file, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: "0.11.0", stderr: "", timedOut: false };
      if (args.join(" ") === "plugin reload --help") return { code: 0, stdout: "Usage: paseo plugin reload [options] <id>", stderr: "", timedOut: false };
      if (args.join(" ") === "plugin ls --json") return { code: 0, stdout: JSON.stringify([{ id: "activity", enabled: false, status: "disabled" }, { id: "ai-router", enabled: true, status: "running" }]), stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const cli = new PaseoCli(run, ["paseo"]);
    expect(await cli.canReload()).toBe(true);
    expect(await cli.reload("bad id; rm -rf /", 1000)).toMatchObject({ code: null });
    await cli.reload("activity", 1000);
    expect(calls.at(-1)).toEqual(["paseo", "plugin", "reload", "activity"]);
    expect(await cli.list()).toEqual([{ id: "activity", status: "disabled", enabled: false }, { id: "ai-router", status: "running", enabled: true }]);
    expect(parsePluginList({ plugins: [{ plugin: "x", status: "running" }] })).toEqual([{ id: "x", status: "running", enabled: true }]);
    expect(parsePluginList("nope")).toBeNull();
    const old = new PaseoCli(async (_file, args) => ({ code: args[0] === "--version" ? 0 : 1, stdout: "", stderr: "unknown command", timedOut: false }), ["paseo"]);
    expect(await old.canReload()).toBe(false);
  });
});
