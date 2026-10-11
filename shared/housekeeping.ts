import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Housekeeping (0.18.0): the daemon keeps its own Linux host tidy. On a busy
 * daemon dozens of agents share a few cores; finished agents leave headless
 * Chrome sessions running (one box had 32, about 30 GB), a `supabase db
 * query` can hang for hours, Turborepo caches grow without bound, and heavy
 * builds compete with Paseo itself at the same priority.
 *
 * Four jobs, Linux only (default intervals; the first three are configurable):
 *  - every minute: lower the priority of builds, tests and agent browsers;
 *  - every hour: close agent browsers and stuck queries left by chats that
 *    Paseo says are closed or archived (never running, idle or unknown);
 *  - every day: delete Turborepo cache entries older than a week;
 *  - every minute: put back /tmp/gate.sh and /tmp/heavy-run.sh if missing.
 * It starts in preview: it logs what it would do and changes nothing until
 * the person confirms live mode.
 */

export const HOUSEKEEPING_JOBS = ["renice", "reap", "turbo", "helpers"] as const;
export const HousekeepingJobSchema = z.enum(HOUSEKEEPING_JOBS);
export type HousekeepingJob = z.infer<typeof HousekeepingJobSchema>;

/** Nice values only ever go up, and only inside what Linux allows an ordinary user (0 to 19). */
export const NICE_MIN = 1;
export const NICE_MAX = 19;

export const HousekeepingSettingsSchema = z.object({
  /** The loop runs at all. */
  enabled: z.boolean().default(true),
  /** Preview: decide and log, change nothing. On by default, including on existing installs. */
  dryRun: z.boolean().default(true),
  /** Priority pass interval; the loop wakes once a minute. */
  reniceIntervalMinutes: z.number().int().min(1).max(60).default(1),
  /** Finished-owner leftover pass interval. */
  reapIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  /** Old Turborepo cache pass interval. */
  turboIntervalHours: z.number().int().min(1).max(168).default(24),
  /** An agent browser older than this with no Chrome left is reported (closing still needs a finished chat). */
  browserMaxAgeHours: z.number().int().min(1).max(168).default(6),
  /** An orphaned `supabase db query` older than this, whose chat is finished, is closed. */
  stuckQueryMaxHours: z.number().int().min(1).max(72).default(2),
  /** Turborepo cache entries older than this many days are deleted. */
  turboCacheMaxDays: z.number().int().min(1).max(365).default(7),
  /** Builds, tests and type checks are lowered to this priority (higher is gentler). */
  heavyNice: z.number().int().min(NICE_MIN).max(NICE_MAX).default(10),
  /** Agent browsers are lowered to this priority. */
  browserNice: z.number().int().min(NICE_MIN).max(NICE_MAX).default(5),
});
export type HousekeepingSettings = z.infer<typeof HousekeepingSettingsSchema>;
export const HOUSEKEEPING_DEFAULTS: HousekeepingSettings = HousekeepingSettingsSchema.parse({});

/** Intervals are elapsed time from the last completed pass, checked on each minute beat. */
export function jobIntervalMs(job: HousekeepingJob, settings: HousekeepingSettings): number {
  switch (job) {
    case "renice": return settings.reniceIntervalMinutes * 60_000;
    case "reap": return settings.reapIntervalMinutes * 60_000;
    case "turbo": return settings.turboIntervalHours * 60 * 60_000;
    default: return 60_000;
  }
}

export const HousekeepingOutcomeSchema = z.enum(["done", "preview", "kept", "skipped", "failed", "blocked"]);
export type HousekeepingOutcome = z.infer<typeof HousekeepingOutcomeSchema>;

/**
 * One line of the housekeeping log. Plain words only: a program name, a
 * count, a size and why. Never a command line, an environment or a path
 * outside a workspace's own cache folder.
 */
export const HousekeepingEntrySchema = z.object({
  at: z.number(),
  job: HousekeepingJobSchema.or(z.literal("cycle")),
  outcome: HousekeepingOutcomeSchema,
  /** What it was about: "Chrome session (6 processes)", "Turborepo cache in Website". */
  what: z.string().max(200),
  /** Why it was done, kept or refused, in plain words. */
  why: z.string().max(300),
  count: z.number().int().min(0).optional(),
  bytes: z.number().min(0).optional(),
});
export type HousekeepingEntry = z.infer<typeof HousekeepingEntrySchema>;

export const JobRunSchema = z.object({
  at: z.number(),
  outcome: HousekeepingOutcomeSchema,
  summary: z.string().max(300),
});
export type JobRun = z.infer<typeof JobRunSchema>;

export const HousekeepingStateSchema = z.enum(["unsupported", "off", "starting", "preview", "live", "passive", "blocked"]);
export type HousekeepingState = z.infer<typeof HousekeepingStateSchema>;

export const MachineSchema = z.object({
  /** Free memory against the container's limit where there is one, else the machine. */
  freeBytes: z.number().min(0),
  totalBytes: z.number().min(0),
  basis: z.enum(["container", "machine"]),
  load1: z.number().min(0),
  cores: z.number().int().min(1),
});
export type Machine = z.infer<typeof MachineSchema>;

export const HousekeepingStatusSchema = z.object({
  state: HousekeepingStateSchema,
  /** One plain sentence for the state: why it's paused, blocked or unsupported, or what it's doing. */
  message: z.string(),
  enabled: z.boolean(),
  dryRun: z.boolean(),
  lastRuns: z.object({ renice: JobRunSchema.nullable(), reap: JobRunSchema.nullable(), turbo: JobRunSchema.nullable(), helpers: JobRunSchema.nullable() }),
  actions: z.array(HousekeepingEntrySchema).max(20),
  machine: MachineSchema.nullable(),
  checkedAt: z.number(),
});
export type HousekeepingStatus = z.infer<typeof HousekeepingStatusSchema>;

export const housekeepingStatus = defineRpc({ name: "daemon-link.housekeeping.status", input: z.object({}), output: HousekeepingStatusSchema });

/** The exact lock path the standalone script holds; held by us for a whole cycle. */
export const STANDALONE_LOCK = ".local/state/agent-housekeeper.lock";

export const JOB_LABEL: Readonly<Record<HousekeepingJob, string>> = {
  renice: "Lower heavy-job priority",
  reap: "Close finished chats' browsers",
  turbo: "Trim old build caches",
  helpers: "Keep the heavy-job gate scripts",
};

/** The state in plain words, for the Overview row. */
export function stateWords(status: Pick<HousekeepingStatus, "state" | "message">): { title: string; tone: "success" | "warning" | "danger" | "neutral" } {
  switch (status.state) {
    case "live": return { title: "On: tidying this host", tone: "success" };
    case "preview": return { title: "Preview: shows what it would do", tone: "neutral" };
    case "passive": return { title: "Paused: another housekeeper is running", tone: "neutral" };
    case "blocked": return { title: "Waiting: it can't run safely yet", tone: "warning" };
    case "starting": return { title: "Starting…", tone: "neutral" };
    case "off": return { title: "Off", tone: "neutral" };
    default: return { title: "Linux hosts only", tone: "neutral" };
  }
}

/**
 * The two helper scripts agents call by path, shipped exactly as written.
 * Cooperative and advisory: they only help agents that choose to call them.
 */
export const GATE_SH = `#!/bin/bash
# Wait until the shared host has <4 heavy jobs and no tsc. Counted by EXECUTABLE (readlink /proc/<pid>/exe = node),
# because a node process's comm can read MainThread; a wrapper shell mentioning tsc never matches.
# GATE_NOT_TSC=1: the caller's next step is not a type check, so only the heavy-job cap applies (one tsc host-wide still holds).
heavy() { local n=0 p; for p in $(pgrep -f 'bin/tsc|vitest|jest|node --test|next build|next dev|vite build|vite-nowatch|app-canvas-browser-server|vite.js'); do [ "$(basename "$(readlink /proc/$p/exe 2>/dev/null)")" = node ] && n=$((n+1)); done; echo $n; }
tsc_running() { local p; for p in $(pgrep -f '[t]ypescript/bin/tsc|[n]ode_modules/\\.bin/tsc'); do [ "$(basename "$(readlink /proc/$p/exe 2>/dev/null)")" = node ] && return 0; done; return 1; }
while :; do
  if [ "$(heavy)" -lt 4 ] && { [ -n "$GATE_NOT_TSC" ] || ! tsc_running; }; then break; fi
  sleep 20
done
`;

export const HEAVY_RUN_SH = `#!/bin/bash
# Run a heavy tsc/build chain under ONE host-wide lock, so another session's chain can't slip in between its tsc
# steps. /tmp/gate.sh only polls before the first step. Tests, browsers and servers do NOT belong here: run them
# with \`GATE_NOT_TSC=1 bash /tmp/gate.sh && <cmd>\`.
# -o (--close): the lock fd is closed before the command runs, so a server or other background child can never
# inherit it and keep the lock after this chain exits.
# Usage: /tmp/heavy-run.sh pnpm --filter @ikit/studio type-check
exec flock -o /tmp/heavy-chain.lock bash -c 'bash /tmp/gate.sh && exec "$@"' _ "$@"
`;

export const HELPER_SCRIPTS: ReadonlyArray<{ name: string; content: string }> = [
  { name: "gate.sh", content: GATE_SH },
  { name: "heavy-run.sh", content: HEAVY_RUN_SH },
];
