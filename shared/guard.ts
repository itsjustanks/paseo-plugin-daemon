import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 0.13.0: the two things that took a daemon down, caught early.
 *
 * 1. A stuck plugin. When one plugin stops answering, Paseo logs
 *    "Plugin RPC timed out: <plugin>.<method>" for every call to it and its
 *    plugin manager can wedge, so adding, updating or reloading any plugin
 *    times out. Hosts reads those lines from the daemon's own log and offers
 *    a one-press restart of just that plugin.
 * 2. A runaway job. One test run grew to 36 GB in 26 minutes, filled memory
 *    and swap, and the daemon stopped answering. Hosts flags a process that
 *    holds a big share of memory or grows fast, and any rise in memory
 *    pressure, in plain words; an optional guard (off by default) can stop
 *    the biggest stoppable job when memory stays nearly full.
 *
 * Everything here is pure: parsing, thresholds and the words. The server
 * reads files and signals; the client renders.
 */

// ----------------------------------------------------------- thresholds

/** Timeouts are counted over this window. */
export const TIMEOUT_WINDOW_MINUTES = 10;
/** This many timeouts in the window and a plugin "isn't answering". One is a blip. */
export const STUCK_TIMEOUTS = 3;
/** This many and it is shown as urgent. */
export const STUCK_TIMEOUTS_CRITICAL = 10;
/** A plugin that started stopping this long ago and never finished is stuck too. */
export const STUCK_STOPPING_SECONDS = 60;

/** A process holding this share of memory is flagged. */
export const RUNAWAY_SHARE_PERCENT = 25;
/** This share, or any share while memory is under pressure, is urgent. */
export const RUNAWAY_CRITICAL_PERCENT = 50;
/** Fast growth: at least this share of memory added within GROWTH_WINDOW_SECONDS… */
export const GROWTH_SHARE_PERCENT = 10;
/** …and never less than this many bytes, so small hosts aren't nagged about a few hundred MB. */
export const GROWTH_MIN_BYTES = 2 * 1024 ** 3;
/** …by a process already holding at least this share. */
export const GROWTH_FLOOR_PERCENT = 10;
export const GROWTH_WINDOW_SECONDS = 5 * 60;

/** The auto-guard acts only after memory has been critical this long. */
export const AUTO_GUARD_SECONDS = 60;
/** It never picks a process smaller than this share of memory: the pressure must be its doing. */
export const AUTO_GUARD_MIN_PERCENT = 10;
/** After one stop it waits this long for memory to recover before it considers another. */
export const AUTO_GUARD_COOLDOWN_SECONDS = 90;
/** How long the status dot keeps saying an automatic stop happened. */
export const AUTO_STOP_NOTICE_MINUTES = 30;

// ------------------------------------------------------- memory pressure

export interface PsiLine { avg10: number; avg60: number; avg300: number }
export interface Psi { some: PsiLine | null; full: PsiLine | null }

/**
 * `/proc/pressure/memory` or a cgroup's `memory.pressure`:
 *   some avg10=0.00 avg60=2.21 avg300=44.29 total=6456231441
 *   full avg10=0.00 avg60=1.87 avg300=37.23 total=5148385536
 * "some" is the share of time at least one task waited on memory; "full"
 * the share of time every running task did (the machine got nothing done).
 */
export function parsePsi(text: string): Psi {
  const line = (kind: "some" | "full"): PsiLine | null => {
    const match = new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)\\s+avg300=([\\d.]+)`, "m").exec(text);
    return match ? { avg10: Number(match[1]), avg60: Number(match[2]), avg300: Number(match[3]) } : null;
  };
  return { some: line("some"), full: line("full") };
}

export const MemoryLevelSchema = z.enum(["normal", "high", "critical"]);
export type MemoryLevel = z.infer<typeof MemoryLevelSchema>;

export interface MemorySignal {
  /** PSI avg10 percentages; null where the kernel doesn't expose them (macOS, old kernels). */
  some10: number | null;
  full10: number | null;
  /** Working set as a share of the limit (container) or of the machine; null when unknown. */
  percent: number | null;
  /** Processes the kernel killed for memory since the last sample. */
  newOomKills: number;
  /** macOS's own pressure level (it has no PSI); absent elsewhere. Never turned into a made-up percentage. */
  osLevel?: "normal" | "warn" | "critical" | null;
}

/**
 * How bad memory is, for the guard. Stricter than "getting full": critical
 * means the machine is mostly stalled waiting for memory (full ≥ 20%, or
 * some ≥ 50%), or the kernel is already killing processes while nearly full.
 */
export function memoryLevel(signal: MemorySignal): MemoryLevel {
  const { some10, full10, percent, newOomKills } = signal;
  if ((full10 ?? 0) >= 20 || (some10 ?? 0) >= 50 || signal.osLevel === "critical") return "critical";
  if (newOomKills > 0 && (percent ?? 0) >= 90) return "critical";
  if ((full10 ?? 0) >= 5 || (some10 ?? 0) >= 20 || newOomKills > 0 || (percent ?? 0) >= 90 || signal.osLevel === "warn") return "high";
  return "normal";
}

/** The pressure in plain words, or null when calm. */
export function pressureSentence(signal: MemorySignal, level: MemoryLevel): string | null {
  if (level === "normal") return null;
  const stalled = signal.full10 !== null && signal.full10 >= 5 ? `programs are stalled waiting for memory ${Math.round(signal.full10)}% of the time`
    : signal.some10 !== null && signal.some10 >= 20 ? `programs are waiting for memory ${Math.round(signal.some10)}% of the time`
    : null;
  const os = !stalled && signal.osLevel === "critical" ? "macOS reports critical memory pressure" : !stalled && signal.osLevel === "warn" ? "macOS reports memory pressure" : null;
  const killed = signal.newOomKills > 0 ? `the system had to stop ${signal.newOomKills === 1 ? "a program" : `${signal.newOomKills} programs`} to free memory` : null;
  const full = signal.percent !== null && signal.percent >= 90 ? `${Math.round(signal.percent)}% of it is in use` : null;
  const why = [stalled, os, killed, full].filter(Boolean).join(", and ");
  const lead = level === "critical" ? "Memory is nearly full" : "Memory is getting tight";
  return why ? `${lead}: ${why}.` : `${lead}.`;
}

// ---------------------------------------------------------- runaway words

export type JobWord = "test" | "build" | "typecheck" | "install" | "dev-server";
const WHAT: Record<JobWord, string> = { test: "A test run", build: "A build", typecheck: "A type check", install: "A package install", "dev-server": "A dev server" };

export function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export interface RunawayFacts {
  /** The job kind when known; otherwise the program's name is used. */
  job: JobWord | null;
  name: string;
  rssBytes: number;
  /** Share of this computer's memory (the container's limit when it has one). */
  percent: number;
  /** Bytes added over the growth window, when measured. */
  growthBytes: number | null;
  level: MemoryLevel;
}

/** "A test run is using 36 GB, 61% of this computer's memory. The computer will slow to a crawl soon." */
export function runawaySentence(facts: RunawayFacts): string {
  const who = facts.job ? WHAT[facts.job] : facts.name;
  const grew = facts.growthBytes !== null && facts.growthBytes > 0 ? ` It grew by ${formatGB(facts.growthBytes)} in the last 5 minutes.` : "";
  const first = `${who} is using ${formatGB(facts.rssBytes)}, ${Math.round(facts.percent)}% of this computer's memory.`;
  if (facts.level !== "normal" || facts.percent >= RUNAWAY_CRITICAL_PERCENT) return `${first}${grew} The computer will slow to a crawl soon.`;
  if (grew) return `${first}${grew} It may fill memory soon.`;
  return `${first} If it keeps growing, the computer will slow down.`;
}

export interface GrowthPoint { at: number; rssBytes: number }

/** Bytes added over the trailing window (newest minus the oldest point inside it), or null with under a minute of history. */
export function growthOver(points: readonly GrowthPoint[], now: number, windowSeconds = GROWTH_WINDOW_SECONDS): number | null {
  const inside = points.filter((point) => now - point.at <= windowSeconds * 1000);
  if (inside.length < 2) return null;
  const first = inside[0]!, last = inside[inside.length - 1]!;
  if (last.at - first.at < 60_000) return null;
  return last.rssBytes - first.rssBytes;
}

/** Whether one process deserves a flag, and how loudly. */
export function runawayVerdict(rssBytes: number, basisBytes: number, growthBytes: number | null, level: MemoryLevel): { flagged: boolean; severity: "warning" | "critical"; growing: boolean } {
  if (basisBytes <= 0) return { flagged: false, severity: "warning", growing: false };
  const percent = (rssBytes / basisBytes) * 100;
  const growing = growthBytes !== null && percent >= GROWTH_FLOOR_PERCENT && growthBytes >= Math.max(GROWTH_MIN_BYTES, (basisBytes * GROWTH_SHARE_PERCENT) / 100);
  const flagged = percent >= RUNAWAY_SHARE_PERCENT || growing;
  const critical = flagged && (percent >= RUNAWAY_CRITICAL_PERCENT || level !== "normal");
  return { flagged, severity: critical ? "critical" : "warning", growing };
}

// ---------------------------------------------------------- plugin names

const UPPER = new Set(["ai", "mcp", "ui", "api", "ssh", "url"]);

/** "ai-router" → "AI Router", "paseo-mcp" → "Paseo MCP". Plugins have no display name the daemon shares. */
export function pluginName(id: string): string {
  return id.split(/[-_.]+/).filter(Boolean).map((word) => (UPPER.has(word.toLowerCase()) ? word.toUpperCase() : `${word[0]!.toUpperCase()}${word.slice(1)}`)).join(" ") || id;
}

/** What a plugin id may look like before it goes anywhere near a command line. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Hosts never restarts itself (its build-check copy included). */
export const isHostsPlugin = (id: string) => id === "daemon-link" || id.startsWith("daemon-link-");

// ------------------------------------------------------------- wire types

export const StuckPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Timeouts in the window, since the plugin last started. */
  timeouts: z.number().int().min(0),
  windowMinutes: z.number().int(),
  lastAt: z.number().nullable(),
  /** It began stopping a while ago and never finished: the plugin manager is likely wedged on it. */
  stopping: z.boolean(),
  severity: z.enum(["warning", "critical"]),
  /** Whether "Restart" can be offered here, and if not, why. */
  restartable: z.boolean(),
  reason: z.string().nullable(),
});
export type StuckPlugin = z.infer<typeof StuckPluginSchema>;

export const AutoStopSchema = z.object({ at: z.number(), pid: z.number().int().nullable(), name: z.string(), rssBytes: z.number(), message: z.string() });
export type AutoStop = z.infer<typeof AutoStopSchema>;

export const GuardStateSchema = z.object({
  checkedAt: z.number(),
  /** False when the daemon's log can't be read here (an unfamiliar Paseo or a moved home): plugin health is then unknown, not fine. */
  logReadable: z.boolean(),
  plugins: z.array(StuckPluginSchema),
  /** Slow plugin requests in the window; the daemon doesn't say which plugin, so this is context only. */
  slowPluginRequests: z.number().int().min(0),
  memory: z.object({
    level: MemoryLevelSchema,
    some10: z.number().nullable(),
    full10: z.number().nullable(),
    percent: z.number().nullable(),
    /** When memory became critical, while it still is. */
    criticalSince: z.number().nullable(),
    sentence: z.string().nullable(),
  }),
  autoGuard: z.object({ enabled: z.boolean(), last: AutoStopSchema.nullable() }),
});
export type GuardState = z.infer<typeof GuardStateSchema>;

export const RestartStepSchema = z.object({ at: z.number(), text: z.string() });
export const RestartOutcomeSchema = z.object({
  ok: z.boolean(),
  /** "running": still going (a wedged restart can take two minutes, longer than one call may wait); ask again with pluginRestartStatus. */
  outcome: z.enum(["running", "reloaded", "stopped-and-reloaded", "answering", "refused", "failed"]),
  pluginId: z.string().optional(),
  /** One plain sentence for the message bar. */
  message: z.string(),
  steps: z.array(RestartStepSchema),
});
export type RestartOutcome = z.infer<typeof RestartOutcomeSchema>;

/** Starts a restart and waits up to RESTART_WAIT_MS for it; a longer one answers "running". */
export const pluginRestart = defineRpc({ name: "daemon-link.plugins.restart", input: z.object({ pluginId: z.string().min(1).max(64) }), output: RestartOutcomeSchema });
/** The restart in progress or last finished, for polling. */
export const pluginRestartStatus = defineRpc({ name: "daemon-link.plugins.restart-status", input: z.object({ pluginId: z.string().min(1).max(64) }), output: RestartOutcomeSchema });
/** Paseo gives a plugin call 30 seconds; answer well inside that. */
export const RESTART_WAIT_MS = 20_000;
export const guardState = defineRpc({ name: "daemon-link.guard.state", input: z.object({}), output: GuardStateSchema });
