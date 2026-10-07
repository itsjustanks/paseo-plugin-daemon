import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonLogTail, PluginLogState, parseLogLine, scanLaunches, splitTarget, type LogEvent, type LogFs } from "../server/daemon-log";

const FIXTURE = join(__dirname, "fixtures", "daemon-log.jsonl");
const fixtureLines = async () => (await readFile(FIXTURE, "utf8")).split("\n").filter(Boolean);

const json = (record: Record<string, unknown>) => JSON.stringify({ level: 30, pid: 4242, hostname: "example-host", ...record });
const timeoutLine = (at: number, target: string) => json({ level: 50, time: at, module: "session", err: { type: "Error", message: `Plugin RPC timed out: ${target}`, stack: `Error: Plugin RPC timed out: ${target}\n    at x` }, msg: "Error handling message" });
const lifecycle = (at: number, pluginId: string, message: string) => json({ time: at, module: "plugins", pluginId, stream: "stdout", message: `[paseo] ${message}`, msg: "Plugin output" });

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

describe("daemon log lines", () => {
  it("reads the four kinds of line the daemon writes, and nothing else", async () => {
    const events = (await fixtureLines()).map(parseLogLine);
    const kinds = events.map((event) => event?.kind ?? null);
    expect(kinds.slice(0, 12)).toEqual(["loading", "ready", "stopping", "loading", "stopped", "ready", "loading", "ready", "loading", "ready", "loading", "ready"]);
    // The hook failure (plugin output) and the app request (session error, stack included) are one timeout each.
    expect(events[12]).toEqual({ kind: "timeout", at: 1791340600000, target: "activity.hook" });
    expect(events[13]).toEqual({ kind: "timeout", at: 1791340602000, target: "activity.invoke" });
    expect(events[14]).toEqual({ kind: "slow", at: 1791340603000, requestType: "plugin.rpc.invoke.request", durationMs: 2917 });
    // A slow request that isn't a plugin's, a non-JSON line and an unrelated line are skipped.
    expect(events.slice(15)).toEqual([null, null, null]);
    expect(events[0]).toEqual({ kind: "loading", at: 1791272228066, pluginId: "daemon-link", daemonPid: 4242 });
  });

  it("fails closed on odd input", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("Plugin RPC timed out: activity.invoke")).toBeNull();
    expect(parseLogLine(JSON.stringify({ msg: "Plugin output", message: "[paseo] Plugin ready", pluginId: "x" }))).toBeNull();
    expect(parseLogLine(lifecycle(1, "Bad Id!", "Plugin ready"))).toBeNull();
    expect(parseLogLine(JSON.stringify({ time: 5, timestamp: "2026-10-05T01:14:44.732Z", msg: "x", message: "Plugin RPC timed out: a.b" }))).toEqual({ kind: "timeout", at: 5, target: "a.b" });
    expect(parseLogLine(JSON.stringify({ timestamp: "2026-10-05T01:14:44.732Z", message: "Plugin RPC timed out: a.b." }))).toEqual({ kind: "timeout", at: Date.parse("2026-10-05T01:14:44.732Z"), target: "a.b" });
  });

  it("splits plugin and method, preferring the longest known plugin id", () => {
    expect(splitTarget("paseo-mcp.hook", ["paseo-mcp", "paseo"])).toEqual({ pluginId: "paseo-mcp", method: "hook" });
    expect(splitTarget("ai-router.provider.catalog_key", ["ai-router"])).toEqual({ pluginId: "ai-router", method: "provider.catalog_key" });
    expect(splitTarget("my.plugin.invoke", ["my.plugin"])).toEqual({ pluginId: "my.plugin", method: "invoke" });
    expect(splitTarget("unknown.invoke", [])).toEqual({ pluginId: "unknown", method: "invoke" });
  });
});

describe("which plugins aren't answering", () => {
  const T0 = 1_800_000_000_000;
  const feed = (state: PluginLogState, lines: string[]) => { for (const line of lines) { const event = parseLogLine(line); if (event) state.feed(event); } };

  it("flags the incident: one plugin timing out about 30 times a minute", () => {
    const state = new PluginLogState();
    feed(state, [lifecycle(T0, "activity", "Loading plugin"), lifecycle(T0 + 3000, "activity", "Plugin ready"), lifecycle(T0, "ai-router", "Loading plugin"), lifecycle(T0 + 2000, "ai-router", "Plugin ready")]);
    const start = T0 + 60_000;
    for (let i = 0; i < 300; i += 1) feed(state, [timeoutLine(start + i * 2000, i % 3 ? "activity.invoke" : "activity.hook")]);
    const now = start + 300 * 2000;
    const stuck = state.stuck(now);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ id: "activity", name: "Activity", timeouts: 300, stopping: false, severity: "critical", methods: ["hook", "invoke"] });
    // Only the last 10 minutes count.
    expect(state.stuck(now + 5 * 60_000)[0]!.timeouts).toBe(150);
  });

  it("ignores a blip, and forgets timeouts from before the plugin last started", () => {
    const state = new PluginLogState();
    feed(state, [lifecycle(T0, "progress", "Loading plugin"), lifecycle(T0 + 1000, "progress", "Plugin ready")]);
    feed(state, [timeoutLine(T0 + 10_000, "progress.invoke"), timeoutLine(T0 + 20_000, "progress.invoke")]);
    expect(state.stuck(T0 + 30_000)).toEqual([]);
    feed(state, [timeoutLine(T0 + 25_000, "progress.invoke")]);
    expect(state.stuck(T0 + 30_000)).toMatchObject([{ id: "progress", timeouts: 3, severity: "warning" }]);
    // Restarted: the old timeouts no longer count.
    feed(state, [lifecycle(T0 + 40_000, "progress", "Stopping plugin"), lifecycle(T0 + 40_100, "progress", "Plugin stopped"), lifecycle(T0 + 40_100, "progress", "Loading plugin"), lifecycle(T0 + 43_000, "progress", "Plugin ready")]);
    expect(state.stuck(T0 + 50_000)).toEqual([]);
  });

  it("flags a plugin that began stopping over a minute ago and never finished (the wedged plugin manager)", () => {
    const state = new PluginLogState();
    feed(state, [lifecycle(T0, "paseo-mcp", "Loading plugin"), lifecycle(T0 + 5000, "paseo-mcp", "Plugin ready"), lifecycle(T0 + 100_000, "paseo-mcp", "Stopping plugin")]);
    expect(state.stuck(T0 + 130_000)).toEqual([]);
    expect(state.stuck(T0 + 170_000)).toMatchObject([{ id: "paseo-mcp", stopping: true, severity: "critical", timeouts: 0 }]);
    feed(state, [lifecycle(T0 + 175_000, "paseo-mcp", "Plugin stopped")]);
    expect(state.stuck(T0 + 180_000)).toEqual([]);
  });

  it("pairs a reload's out-of-order lines to the right launch", () => {
    const state = new PluginLogState();
    feed(state, [lifecycle(T0, "x", "Loading plugin"), lifecycle(T0 + 1000, "x", "Plugin ready"), lifecycle(T0 + 5000, "x", "Stopping plugin"), lifecycle(T0 + 5001, "x", "Loading plugin"), lifecycle(T0 + 5001, "x", "Plugin stopped"), lifecycle(T0 + 8000, "x", "Plugin ready")]);
    expect(state.launches.get("x")).toEqual([
      { loadingAt: T0, readyAt: T0 + 1000, stoppingAt: T0 + 5000, stoppedAt: T0 + 5001, daemonPid: 4242 },
      { loadingAt: T0 + 5001, readyAt: T0 + 8000, stoppingAt: null, stoppedAt: null, daemonPid: 4242 },
    ]);
    expect(state.lastReady("x")).toBe(T0 + 8000);
  });

  it("never lists Hosts itself, and counts slow plugin requests as context", async () => {
    const state = new PluginLogState();
    for (let i = 0; i < 5; i += 1) feed(state, [timeoutLine(T0 + i, "daemon-link.invoke"), timeoutLine(T0 + i, "daemon-link-buildcheck.invoke")]);
    feed(state, await fixtureLines());
    expect(state.stuck(T0 + 10)).toEqual([]);
    expect(state.slowRequests(1791340603000 + 1000)).toBe(1);
  });
});

/** An in-memory file that grows, rotates and can't be read on demand. */
class FakeLog implements LogFs {
  text = "";
  ino = 1;
  broken = false;
  reads: Array<[number, number]> = [];
  async stat() { if (this.broken) throw new Error("ENOENT"); return { size: Buffer.byteLength(this.text), ino: this.ino }; }
  async read(_path: string, position: number, length: number) { this.reads.push([position, length]); return Buffer.from(this.text).subarray(position, position + length); }
}

describe("following the log with a fixed budget", () => {
  const line = (n: number) => timeoutLine(1_800_000_000_000 + n, `p${n % 2}.invoke`);

  it("starts from the tail, skips the cut-off first line, then reads only what was added", async () => {
    const fs = new FakeLog();
    fs.text = Array.from({ length: 50 }, (_, i) => line(i)).join("\n") + "\n";
    const tail = new DaemonLogTail("/x/daemon.log", fs, 4096, 2048);
    const seen: LogEvent[] = [];
    await tail.poll((event) => seen.push(event));
    expect(tail.readable).toBe(true);
    expect(fs.reads[0]![1]).toBe(2048);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.length).toBeLessThan(50);
    expect(seen.every((event) => event.kind === "timeout")).toBe(true);
    const before = seen.length;
    fs.text += line(100) + "\n" + line(101).slice(0, 40);
    await tail.poll((event) => seen.push(event));
    expect(seen.length).toBe(before + 1);
    // The half-written line completes on the next poll.
    fs.text += line(101).slice(40) + "\n";
    await tail.poll((event) => seen.push(event));
    expect(seen.length).toBe(before + 2);
  });

  it("never reads more than its budget, even when the log floods", async () => {
    const fs = new FakeLog();
    fs.text = line(0) + "\n";
    const tail = new DaemonLogTail("/x/daemon.log", fs, 1024, 1024);
    await tail.poll(() => undefined);
    fs.text += Array.from({ length: 500 }, (_, i) => line(i)).join("\n") + "\n";
    let count = 0;
    await tail.poll(() => { count += 1; });
    expect(fs.reads[1]![1]).toBe(1024);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it("starts over after a rotation, and says when the log can't be read", async () => {
    const fs = new FakeLog();
    fs.text = line(1) + "\n" + line(2) + "\n";
    const tail = new DaemonLogTail("/x/daemon.log", fs);
    let count = 0;
    await tail.poll(() => { count += 1; });
    expect(count).toBe(2);
    fs.ino = 2; fs.text = line(3) + "\n";
    await tail.poll(() => { count += 1; });
    expect(count).toBe(3);
    fs.broken = true;
    await tail.poll(() => { count += 1; });
    expect(tail.readable).toBe(false);
  });
});

describe("launch history from the retained logs", () => {
  it("reads rotated files oldest first, then the current one, for lifecycle lines only", async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-log-"));
    await writeFile(join(dir, "20261006-0211-01-daemon.log"), [lifecycle(1000, "old", "Loading plugin"), lifecycle(2000, "old", "Plugin ready"), timeoutLine(2500, "old.invoke")].join("\n") + "\n");
    await writeFile(join(dir, "20261006-0530-01-daemon.log"), lifecycle(3000, "old", "Stopping plugin") + "\n");
    await writeFile(join(dir, "daemon.log"), [lifecycle(3100, "old", "Plugin stopped"), lifecycle(3100, "old", "Loading plugin"), lifecycle(4000, "old", "Plugin ready")].join("\n") + "\n");
    await writeFile(join(dir, "daemon.log.txt"), "pointer file\n");
    const state = await scanLaunches(dir);
    expect(state.launches.get("old")).toEqual([
      { loadingAt: 1000, readyAt: 2000, stoppingAt: 3000, stoppedAt: 3100, daemonPid: 4242 },
      { loadingAt: 3100, readyAt: 4000, stoppingAt: null, stoppedAt: null, daemonPid: 4242 },
    ]);
    expect(state.stuck(4500)).toEqual([]);
    expect(await scanLaunches(join(dir, "missing"))).toBeInstanceOf(PluginLogState);
  });
});
