import { describe, expect, it } from "vitest";
import { PluginLogState, parseLogLine, type Launch } from "../server/daemon-log";
import { identify, launchWindow, listPluginHosts, matchHosts, startClock, type PluginHost } from "../server/plugin-procs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter, proc } from "./fake-adapter";

const PLUGIN = "/opt/npm-global/lib/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js";
const DAEMON = 4242;

/** Launches from the fixture log, whose times are a real daemon's (2026-10-06), neutralised. */
async function fixtureLaunches(): Promise<Map<string, Launch[]>> {
  const state = new PluginLogState();
  for (const line of (await readFile(join(__dirname, "fixtures", "daemon-log.jsonl"), "utf8")).split("\n")) {
    const event = parseLogLine(line);
    if (event) state.feed(event);
  }
  return state.launches;
}

const host = (pid: number, startMs: number): PluginHost => ({ pid, startId: `s${pid}`, startMs, argvHash: `h${pid}` });

/** Process start times measured on the same host: each fell inside its plugin's Loading→Ready window. */
const MEASURED = {
  hosts: 232982, // started 1791272231290: inside daemon-link's window
  mcp: 356608, // 1791274748220: paseo-mcp
  memories: 661583, // 1791282036020: paseo-memories
  router: 1726330, // 1791334246720: ai-router
  activity: 2350624, // 1791340002000: activity
};

describe("matching plugin processes to plugins", () => {
  it("matches each process of a real host to its plugin by start time", async () => {
    const launches = await fixtureLaunches();
    const hosts = [host(MEASURED.mcp, 1791274748220), host(MEASURED.memories, 1791282036020), host(MEASURED.router, 1791334246720), host(MEASURED.activity, 1791340002000)];
    const assigned = matchHosts(launches, hosts, DAEMON);
    expect([...assigned].map(([pid, hit]) => [pid, hit.pluginId, hit.current])).toEqual([
      [MEASURED.mcp, "paseo-mcp", true], [MEASURED.memories, "paseo-memories", true], [MEASURED.router, "ai-router", true], [MEASURED.activity, "activity", true],
    ]);
  });

  it("refuses to guess: two processes in one window, a process in two windows, or none", () => {
    const one: Launch = { loadingAt: 10_000, readyAt: 14_000, stoppingAt: null, stoppedAt: null, daemonPid: DAEMON };
    const overlapping: Launch = { loadingAt: 13_000, readyAt: 20_000, stoppingAt: null, stoppedAt: null, daemonPid: DAEMON };
    expect(matchHosts(new Map([["a", [one]]]), [host(1, 12_000), host(2, 13_000)], DAEMON).size).toBe(0);
    expect(matchHosts(new Map([["a", [one]], ["b", [overlapping]]]), [host(1, 13_500)], DAEMON).size).toBe(0);
    expect(matchHosts(new Map([["a", [one]]]), [host(1, 50_000)], DAEMON).size).toBe(0);
    // A launch logged by an earlier daemon never matches.
    expect(matchHosts(new Map([["a", [{ ...one, daemonPid: 999 }]]]), [host(1, 12_000)], DAEMON).size).toBe(0);
  });

  it("windows: loading to ready with slack; open launches are capped; ready-only is narrow", () => {
    expect(launchWindow({ loadingAt: 10_000, readyAt: 14_000, stoppingAt: null, stoppedAt: null, daemonPid: null })).toEqual([8_000, 16_000]);
    expect(launchWindow({ loadingAt: 10_000, readyAt: null, stoppingAt: null, stoppedAt: null, daemonPid: null })).toEqual([8_000, 132_000]);
    expect(launchWindow({ loadingAt: null, readyAt: 50_000, stoppingAt: null, stoppedAt: null, daemonPid: null })).toEqual([35_000, 52_000]);
    expect(launchWindow({ loadingAt: null, readyAt: null, stoppingAt: 1, stoppedAt: null, daemonPid: null })).toBeNull();
  });
});

describe("identifying one plugin's process", () => {
  it("finds the stuck plugin's process and nothing else", async () => {
    const launches = await fixtureLaunches();
    const hosts = [host(MEASURED.mcp, 1791274748220), host(MEASURED.activity, 1791340002000)];
    const self = { pid: MEASURED.hosts, startMs: 1791272231290 };
    expect(identify("activity", launches, hosts, self, DAEMON)).toEqual({ ok: true, targets: [{ ...hosts[1]!, current: true }] });
  });

  it("never targets Hosts, by id or by its own window, whatever it is called", async () => {
    const launches = await fixtureLaunches();
    const self = { pid: MEASURED.hosts, startMs: 1791272231290 };
    expect(identify("daemon-link", launches, [], self, DAEMON)).toMatchObject({ ok: false });
    expect(identify("daemon-link-buildcheck", launches, [], self, DAEMON)).toMatchObject({ ok: false });
    // A build-check copy under another id: its window holds Hosts' own start, so it is Hosts.
    const renamed = new Map(launches);
    renamed.set("hosts-copy", renamed.get("daemon-link")!);
    renamed.delete("daemon-link");
    expect(identify("hosts-copy", renamed, [], self, DAEMON)).toMatchObject({ ok: false, reason: expect.stringContaining("Hosts' own process") });
    // Another process sharing that window makes it ambiguous: still refused.
    expect(identify("hosts-copy", renamed, [host(77, 1791272230000)], self, DAEMON)).toMatchObject({ ok: false });
  });

  it("says why when it can't tell", async () => {
    const launches = await fixtureLaunches();
    expect(identify("never-seen", launches, [], { pid: 1, startMs: null }, DAEMON)).toMatchObject({ ok: false, reason: expect.stringContaining("doesn't say when") });
    expect(identify("activity", launches, [], { pid: 1, startMs: null }, DAEMON)).toMatchObject({ ok: false, reason: expect.stringContaining("No running process") });
  });

  it("targets an old copy stuck stopping as well as the new one", () => {
    const launches = new Map<string, Launch[]>([["paseo-mcp", [
      { loadingAt: 1000, readyAt: 5000, stoppingAt: 90_000, stoppedAt: null, daemonPid: DAEMON },
      { loadingAt: 200_000, readyAt: 205_000, stoppingAt: null, stoppedAt: null, daemonPid: DAEMON },
    ]]]);
    const result = identify("paseo-mcp", launches, [host(10, 3000), host(11, 203_000), host(12, 400_000)], { pid: 99, startMs: null }, DAEMON);
    expect(result).toEqual({ ok: true, targets: [{ ...host(10, 3000), current: false }, { ...host(11, 203_000), current: true }] });
  });
});

describe("reading plugin processes", () => {
  it("lists only this daemon's plugin processes, never Hosts' own, with their start times", async () => {
    const adapter = new FakeAdapter();
    adapter.processes = [
      proc({ pid: DAEMON, ppid: 1, argv: ["Paseo Daemon"] }),
      proc({ pid: 10, ppid: DAEMON, argv: ["/usr/local/bin/node", PLUGIN], startId: "1000" }),
      proc({ pid: 11, ppid: DAEMON, argv: ["/usr/local/bin/node", PLUGIN], startId: "2000" }),
      proc({ pid: 12, ppid: 10, argv: ["/usr/local/bin/node", PLUGIN], startId: "3000" }), // a grandchild: not this daemon's
      proc({ pid: 13, ppid: DAEMON, argv: ["node", "something-else.js"], startId: "4000" }),
      proc({ pid: 14, ppid: DAEMON, uid: 0, argv: ["/usr/local/bin/node", PLUGIN], startId: "5000" }),
    ];
    const hosts = await listPluginHosts({ adapter, uid: 1000, daemonPid: DAEMON, selfPid: 11, startMs: async (id) => Number(id) * 10 });
    expect(hosts.map((item) => [item.pid, item.startMs])).toEqual([[10, 10_000]]);
  });

  it("turns start identities into wall-clock time: Linux boot time plus ticks, macOS lstart", async () => {
    const linux = startClock("linux", async () => "cpu 1 2 3\nbtime 1789478475\n", async () => 100);
    // A plugin process measured at 1791272231290: boot time plus 179,375,629.0 seconds of ticks.
    expect(await linux("179375629")).toBe(1789478475000 + 1793756290);
    expect(await linux("not-a-number")).toBeNull();
    const darwin = startClock("darwin");
    expect(await darwin("Tue Oct  6 07:37:11 2026")).toBe(new Date(2026, 9, 6, 7, 37, 11).getTime());
    expect(await startClock("linux", async () => { throw new Error("no proc"); })("1")).toBeNull();
  });
});
