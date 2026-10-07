import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PLUGIN_ID, STUCK_STOPPING_SECONDS, STUCK_TIMEOUTS, STUCK_TIMEOUTS_CRITICAL, TIMEOUT_WINDOW_MINUTES, isHostsPlugin, pluginName } from "../shared/guard";

/**
 * The daemon's own log, read for plugin health (0.13.0).
 *
 * Paseo writes one JSON object per line to `$PASEO_HOME/daemon.log` and
 * rotates it to `YYYYMMDD-HHMM-NN-daemon.log` at about 10 MB. Four kinds of
 * line matter here:
 *  - "Plugin RPC timed out: <plugin>.<method>" (an RPC to a plugin waited 30 s);
 *  - `ws_slow_request` for `plugin.*` requests (slow, but not attributed);
 *  - a plugin's lifecycle lines, "[paseo] Loading plugin" / "Plugin ready" /
 *    "Stopping plugin" / "Plugin stopped", which carry `pluginId` and the
 *    daemon's `pid`. A plugin's process is forked between its Loading and
 *    Ready lines, which is how its PID is found (see plugin-procs.ts).
 * Anything else, and any line that isn't JSON, is skipped. The format is the
 * daemon's, not a contract: when no line parses, plugin health reports
 * "unknown" rather than "fine".
 */

export type LifecycleKind = "loading" | "ready" | "stopping" | "stopped";
export type LogEvent =
  | { kind: "timeout"; at: number; target: string }
  | { kind: "slow"; at: number; requestType: string; durationMs: number }
  | { kind: LifecycleKind; at: number; pluginId: string; daemonPid: number | null };

const LIFECYCLE: Record<string, LifecycleKind> = {
  "[paseo] Loading plugin": "loading",
  "[paseo] Plugin ready": "ready",
  "[paseo] Stopping plugin": "stopping",
  "[paseo] Plugin stopped": "stopped",
};
const TIMEOUT = /Plugin RPC timed out: ([A-Za-z0-9][\w.-]{0,160})/;

/** One line, or null when it isn't one of the four kinds. Cheap substring checks run before any JSON parse. */
export function parseLogLine(line: string): LogEvent | null {
  const timeout = line.includes("Plugin RPC timed out");
  const slow = !timeout && line.includes("ws_slow_request");
  const lifecycle = !timeout && !slow && line.includes("[paseo] ");
  if (!timeout && !slow && !lifecycle) return null;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    record = parsed as Record<string, unknown>;
  } catch { return null; }
  const at = typeof record.time === "number" ? record.time : typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  if (timeout) {
    const match = TIMEOUT.exec(line);
    return match ? { kind: "timeout", at, target: match[1]!.replace(/\.+$/, "") } : null;
  }
  if (slow) {
    if (record.msg !== "ws_slow_request" || typeof record.requestType !== "string" || !record.requestType.startsWith("plugin.")) return null;
    return { kind: "slow", at, requestType: record.requestType, durationMs: typeof record.durationMs === "number" ? record.durationMs : 0 };
  }
  const kind = typeof record.message === "string" ? LIFECYCLE[record.message] : undefined;
  if (!kind || typeof record.pluginId !== "string" || !PLUGIN_ID.test(record.pluginId)) return null;
  return { kind, at, pluginId: record.pluginId, daemonPid: typeof record.pid === "number" ? record.pid : null };
}

/** "paseo-mcp.hook" → plugin "paseo-mcp", method "hook"; the longest known plugin id wins ("a.b" vs "a"). */
export function splitTarget(target: string, known: Iterable<string>): { pluginId: string; method: string } {
  let best: string | null = null;
  for (const id of known) if (target.startsWith(`${id}.`) && (!best || id.length > best.length)) best = id;
  if (best) return { pluginId: best, method: target.slice(best.length + 1) };
  const dot = target.indexOf(".");
  return dot > 0 ? { pluginId: target.slice(0, dot), method: target.slice(dot + 1) } : { pluginId: target, method: "" };
}

/** One start of a plugin's process: when Paseo began loading it, when it was ready, and when it was asked to stop. */
export interface Launch { loadingAt: number | null; readyAt: number | null; stoppingAt: number | null; stoppedAt: number | null; daemonPid: number | null }

export interface StuckReading { id: string; name: string; timeouts: number; lastAt: number | null; stopping: boolean; severity: "warning" | "critical"; methods: string[] }

const KEEP_LAUNCHES = 12;
/**
 * A plugin's Ready line belongs to its Loading line only if it follows within
 * this long (a load is seconds). A later Ready with no Loading of its own
 * (the Loading line rotated away or fell outside the read budget) starts a
 * launch with no Loading time, which never identifies a process.
 */
export const PAIRING_MS = 120_000;
const KEEP_TIMEOUTS = 5000;
const KEEP_SLOW = 5000;

/** What the log has said so far, kept small: launches per plugin, and recent timeouts. Pure; tests feed it events. */
export class PluginLogState {
  readonly launches = new Map<string, Launch[]>();
  private timeouts: Array<{ at: number; target: string }> = [];
  private slow: number[] = [];
  /** Lines that parsed: zero means this daemon's log isn't one Hosts understands. */
  events = 0;

  feed(event: LogEvent): void {
    this.events += 1;
    if (event.kind === "timeout") { this.timeouts.push({ at: event.at, target: event.target }); if (this.timeouts.length > KEEP_TIMEOUTS) this.timeouts.splice(0, this.timeouts.length - KEEP_TIMEOUTS); return; }
    if (event.kind === "slow") { this.slow.push(event.at); if (this.slow.length > KEEP_SLOW) this.slow.splice(0, this.slow.length - KEEP_SLOW); return; }
    const list = this.launches.get(event.pluginId) ?? [];
    const latest = list[list.length - 1];
    if (event.kind === "loading") {
      list.push({ loadingAt: event.at, readyAt: null, stoppingAt: null, stoppedAt: null, daemonPid: event.daemonPid });
    } else if (event.kind === "ready") {
      if (latest && latest.loadingAt !== null && latest.readyAt === null && latest.stoppingAt === null && event.at - latest.loadingAt <= PAIRING_MS) latest.readyAt = event.at;
      else list.push({ loadingAt: null, readyAt: event.at, stoppingAt: null, stoppedAt: null, daemonPid: event.daemonPid });
    } else if (event.kind === "stopping") {
      // The newest launch that is running, i.e. not already stopping.
      const running = [...list].reverse().find((launch) => launch.stoppingAt === null && launch.stoppedAt === null);
      if (running) running.stoppingAt = event.at;
      else list.push({ loadingAt: null, readyAt: null, stoppingAt: event.at, stoppedAt: null, daemonPid: event.daemonPid });
    } else {
      // Reload logs "Stopping" (old), "Loading" (new), "Plugin stopped" (old): close the newest launch that was stopping.
      const stopping = [...list].reverse().find((launch) => launch.stoppingAt !== null && launch.stoppedAt === null);
      if (stopping) stopping.stoppedAt = event.at;
    }
    if (list.length > KEEP_LAUNCHES) list.splice(0, list.length - KEEP_LAUNCHES);
    this.launches.set(event.pluginId, list);
  }

  knownIds(): string[] { return [...this.launches.keys()]; }

  /** When the plugin's current process became ready, if the log says. */
  lastReady(id: string): number | null {
    const list = this.launches.get(id) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index]!.readyAt !== null) return list[index]!.readyAt;
    return null;
  }

  slowRequests(now: number, windowMs = TIMEOUT_WINDOW_MINUTES * 60_000): number {
    return this.slow.filter((at) => now - at <= windowMs && at <= now).length;
  }

  /**
   * Plugins that aren't answering: STUCK_TIMEOUTS or more timeouts in the
   * window since the plugin last became ready (a restart clears the count),
   * or a stop that began over a minute ago and never finished.
   */
  stuck(now: number, windowMs = TIMEOUT_WINDOW_MINUTES * 60_000): StuckReading[] {
    const known = this.knownIds();
    const byId = new Map<string, { count: number; lastAt: number; methods: Set<string> }>();
    this.timeouts = this.timeouts.filter((entry) => now - entry.at <= windowMs * 3);
    for (const entry of this.timeouts) {
      if (now - entry.at > windowMs || entry.at > now + 60_000) continue;
      const { pluginId, method } = splitTarget(entry.target, known);
      const ready = this.lastReady(pluginId);
      if (ready !== null && entry.at < ready) continue;
      const slot = byId.get(pluginId) ?? { count: 0, lastAt: 0, methods: new Set<string>() };
      slot.count += 1; slot.lastAt = Math.max(slot.lastAt, entry.at); if (method) slot.methods.add(method);
      byId.set(pluginId, slot);
    }
    const out: StuckReading[] = [];
    const ids = new Set([...byId.keys(), ...known]);
    for (const id of ids) {
      if (isHostsPlugin(id) || !PLUGIN_ID.test(id)) continue;
      const slot = byId.get(id);
      const list = this.launches.get(id) ?? [];
      const latest = list[list.length - 1];
      const stopping = !!latest && latest.stoppingAt !== null && latest.stoppedAt === null && now - latest.stoppingAt >= STUCK_STOPPING_SECONDS * 1000;
      const timeouts = slot?.count ?? 0;
      if (timeouts < STUCK_TIMEOUTS && !stopping) continue;
      out.push({ id, name: pluginName(id), timeouts, lastAt: slot?.lastAt ?? latest?.stoppingAt ?? null, stopping, severity: stopping || timeouts >= STUCK_TIMEOUTS_CRITICAL ? "critical" : "warning", methods: [...(slot?.methods ?? [])].sort() });
    }
    return out.sort((a, b) => b.timeouts - a.timeouts || a.id.localeCompare(b.id));
  }
}

// --------------------------------------------------------------- files

export const daemonLogDirectory = () => process.env.PASEO_HOME || join(homedir(), ".paseo");
export const CURRENT_LOG = "daemon.log";
const ROTATED = /^\d{8}-\d{4}-\d+-daemon\.log$/;

/** What the tail needs from the filesystem; tests hand in a fake. */
export interface LogFs {
  stat(path: string): Promise<{ size: number; ino: number }>;
  read(path: string, position: number, length: number): Promise<Buffer>;
}

const realFs: LogFs = {
  stat: async (path) => { const info = await stat(path); return { size: info.size, ino: info.ino }; },
  read: async (path, position, length) => {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  },
};

/**
 * Follows `daemon.log` with a fixed byte budget per poll, so a flood of log
 * lines (or a starved machine) never turns a check into a long read. The
 * first poll reads the last `seedBytes`; later polls read only what was
 * added, at most `budgetBytes` (anything beyond that is skipped, newest
 * kept). A rotation (new inode, or a shorter file) starts the new file over.
 */
export class DaemonLogTail {
  private position: { ino: number; offset: number } | null = null;
  private partial = "";
  /** The file exists and could be read on the last poll. */
  readable = false;

  constructor(
    private readonly file = join(daemonLogDirectory(), CURRENT_LOG),
    private readonly fs: LogFs = realFs,
    private readonly budgetBytes = 1024 * 1024,
    private readonly seedBytes = 4 * 1024 * 1024,
  ) {}

  /** Read what's new and hand each recognised line to `sink`. Never throws. */
  async poll(sink: (event: LogEvent) => void): Promise<void> {
    let info: { size: number; ino: number };
    try { info = await this.fs.stat(this.file); } catch { this.readable = false; return; }
    let start: number;
    let skipFirst = false;
    if (!this.position || this.position.ino !== info.ino || info.size < this.position.offset) {
      start = Math.max(0, info.size - (this.position ? this.budgetBytes : this.seedBytes));
      skipFirst = start > 0;
      this.partial = "";
    } else {
      start = this.position.offset;
      if (info.size - start > this.budgetBytes) { start = info.size - this.budgetBytes; skipFirst = true; this.partial = ""; }
    }
    const length = info.size - start;
    if (length <= 0) { this.position = { ino: info.ino, offset: info.size }; this.readable = true; return; }
    let chunk: Buffer;
    try { chunk = await this.fs.read(this.file, start, length); } catch { this.readable = false; return; }
    this.readable = true;
    this.position = { ino: info.ino, offset: start + chunk.length };
    const lines = (this.partial + chunk.toString("utf8")).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > 256 * 1024) this.partial = "";
    for (let index = skipFirst ? 1 : 0; index < lines.length; index += 1) {
      const event = parseLogLine(lines[index]!);
      if (event) sink(event);
    }
  }
}

/**
 * Every plugin launch the retained logs remember, oldest file first, for
 * finding a plugin's process (on demand only, when a restart needs it).
 * Reads at most `maxFiles` files and `maxBytes` in all; lines are streamed.
 */
export async function scanLaunches(directory = daemonLogDirectory(), maxFiles = 6, maxBytes = 96 * 1024 * 1024): Promise<PluginLogState> {
  const state = new PluginLogState();
  let names: string[];
  try { names = await readdir(directory); } catch { return state; }
  const rotated = names.filter((name) => ROTATED.test(name)).sort();
  const files = [...rotated, ...(names.includes(CURRENT_LOG) ? [CURRENT_LOG] : [])].slice(-maxFiles);
  let budget = maxBytes;
  for (const name of files) {
    const path = join(directory, name);
    let size: number;
    try { size = (await stat(path)).size; } catch { continue; }
    if (size > budget) continue;
    budget -= size;
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes("[paseo] ")) continue;
        const event = parseLogLine(line);
        if (event && event.kind !== "timeout" && event.kind !== "slow") state.feed(event);
      }
    } catch { /* A file rotated away mid-read: what was read still counts. */ }
  }
  return state;
}
