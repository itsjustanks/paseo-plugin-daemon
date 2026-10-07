import { readFile } from "node:fs/promises";
import { isHostsPlugin } from "../shared/guard";
import type { Launch } from "./daemon-log";
import { isPluginHost } from "./jobs";
import { defaultReadClockTicks } from "./linux";
import type { PlatformAdapter } from "./platform";
import { hashArgv } from "./redaction";

/**
 * Which process is which plugin (0.13.0).
 *
 * Paseo runs every plugin's server in its own `plugin-process.js`, forked by
 * the daemon. Nothing in its argv, environment or working directory names
 * the plugin. What does: the daemon logs "[paseo] Loading plugin" just
 * before it forks a plugin's process and "[paseo] Plugin ready" just after,
 * and the plugin manager starts plugins one at a time. So a plugin process
 * belongs to the plugin whose Loading→Ready window contains its start time.
 *
 * A process is matched only when the answer is unambiguous both ways:
 *  - it is a plugin host (argv ends in plugin-process.js), a direct child of
 *    this daemon, owned by this user, and not Hosts' own process;
 *  - its start time falls inside exactly one launch window (any plugin);
 *  - that window contains no other plugin process.
 * The launch whose window holds Hosts' own start time is Hosts itself, and
 * is never a target. Anything else is "can't tell", and nothing is stopped.
 */

/** Seconds of slack around a window: log timestamps are milliseconds, process start times can be a second coarse (macOS `lstart`). */
export const WINDOW_SLACK_MS = 2000;
/** A launch the log saw start but not finish is open for at most this long. */
export const OPEN_WINDOW_MS = 120_000;
/** With only a Ready line, the fork happened at most this long before it. */
export const READY_ONLY_MS = 15_000;

export interface PluginHost { pid: number; startId: string; startMs: number; argvHash: string }
export interface Assignment { pluginId: string; launch: Launch; current: boolean }

export function launchWindow(launch: Launch, slackMs = WINDOW_SLACK_MS): [number, number] | null {
  if (launch.loadingAt !== null) {
    const end = launch.readyAt ?? launch.stoppingAt ?? launch.loadingAt + OPEN_WINDOW_MS;
    return [launch.loadingAt - slackMs, end + slackMs];
  }
  if (launch.readyAt !== null) return [launch.readyAt - READY_ONLY_MS, launch.readyAt + slackMs];
  return null;
}

/**
 * Pure matching: plugin process → its plugin and launch, or nothing when it
 * fits no window, several windows, or shares its window with another process.
 * `daemonPid` drops launches logged by an earlier daemon.
 */
export function matchHosts(launches: ReadonlyMap<string, readonly Launch[]>, hosts: readonly PluginHost[], daemonPid: number | null, slackMs = WINDOW_SLACK_MS): Map<number, Assignment> {
  const fits = new Map<number, Assignment[]>();
  for (const host of hosts) {
    const found: Assignment[] = [];
    for (const [pluginId, list] of launches) {
      list.forEach((launch, index) => {
        if (daemonPid !== null && launch.daemonPid !== null && launch.daemonPid !== daemonPid) return;
        const window = launchWindow(launch, slackMs);
        if (window && host.startMs >= window[0] && host.startMs <= window[1]) found.push({ pluginId, launch, current: index === list.length - 1 });
      });
    }
    fits.set(host.pid, found);
  }
  const perLaunch = new Map<Launch, number>();
  for (const found of fits.values()) if (found.length === 1) perLaunch.set(found[0]!.launch, (perLaunch.get(found[0]!.launch) ?? 0) + 1);
  const out = new Map<number, Assignment>();
  for (const [pid, found] of fits) if (found.length === 1 && perLaunch.get(found[0]!.launch) === 1) out.set(pid, found[0]!);
  return out;
}

export interface Identification { ok: true; targets: Array<PluginHost & { current: boolean }> }
export interface Refusal { ok: false; reason: string }

/** The process (or processes: an old copy stuck stopping, plus the new one) of one plugin, or why it can't be told apart. */
export function identify(pluginId: string, launches: ReadonlyMap<string, readonly Launch[]>, hosts: readonly PluginHost[], self: { pid: number; startMs: number | null }, daemonPid: number | null): Identification | Refusal {
  if (isHostsPlugin(pluginId)) return { ok: false, reason: "Hosts never restarts itself." };
  if (!launches.has(pluginId)) return { ok: false, reason: "The daemon's log doesn't say when this plugin started, so its process can't be told apart from the others." };
  // Hosts' own window is Hosts, whatever it is called (a build-check copy has another id).
  const others = hosts.filter((host) => host.pid !== self.pid);
  const withSelf = self.startMs === null ? others : [...others, { pid: self.pid, startId: "self", startMs: self.startMs, argvHash: "" }];
  const assigned = matchHosts(launches, withSelf, daemonPid);
  const selfId = assigned.get(self.pid)?.pluginId ?? null;
  if (selfId === pluginId) return { ok: false, reason: "That is Hosts' own process, and Hosts never restarts itself." };
  const targets = others.flatMap((host) => {
    const hit = assigned.get(host.pid);
    return hit && hit.pluginId === pluginId ? [{ ...host, current: hit.current }] : [];
  });
  if (targets.length === 0) return { ok: false, reason: "No running process matches when this plugin started, so Hosts can't tell which one is its." };
  return { ok: true, targets };
}

// ------------------------------------------------------------- reading

export interface ProcessReadDeps {
  adapter: PlatformAdapter;
  uid: number;
  daemonPid: number;
  selfPid: number;
  /** A start identity (`RawProcess.startId`) as epoch milliseconds. */
  startMs(startId: string): Promise<number | null>;
}

/** Plugin processes this daemon forked, other than Hosts' own. */
export async function listPluginHosts(deps: ProcessReadDeps): Promise<PluginHost[]> {
  const { processes } = await deps.adapter.sampleProcesses(deps.uid);
  const out: PluginHost[] = [];
  for (const raw of processes) {
    if (raw.pid === deps.selfPid || raw.ppid !== deps.daemonPid || raw.uid !== deps.uid || !isPluginHost(raw)) continue;
    const startMs = await deps.startMs(raw.startId);
    if (startMs !== null) out.push({ pid: raw.pid, startId: raw.startId, startMs, argvHash: hashArgv(raw.argv) });
  }
  return out;
}

/**
 * Start identities to epoch milliseconds. Linux: boot time (`btime` in
 * /proc/stat) plus the start ticks over CLK_TCK. macOS: `ps`'s lstart, which
 * is local time to the second.
 */
export function startClock(platform: "linux" | "darwin", read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"), ticks: () => Promise<number> = defaultReadClockTicks): (startId: string) => Promise<number | null> {
  if (platform === "darwin") return async (startId) => { const at = Date.parse(startId.replace(/\s+/g, " ")); return Number.isFinite(at) ? at : null; };
  let base: Promise<{ btime: number; hz: number } | null> | null = null;
  return async (startId) => {
    base ??= (async () => {
      try {
        const match = /^btime\s+(\d+)/m.exec(await read("/proc/stat"));
        return match ? { btime: Number(match[1]), hz: await ticks().catch(() => 100) } : null;
      } catch { return null; }
    })();
    const known = await base;
    const startTicks = Number(startId);
    return known && Number.isFinite(startTicks) ? Math.round(known.btime * 1000 + (startTicks * 1000) / known.hz) : null;
  };
}
