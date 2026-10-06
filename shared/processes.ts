import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ActionResultSchema, ContainerSnapshotSchema, PressureStateSchema } from "./contracts";

/**
 * The Processes tab: the heaviest processes this daemon's user runs, the
 * container's memory against its own limit, runaways, and an ask-first stop.
 *
 * Unlike `monitor.*`, which lists only processes inside Paseo projects, this
 * report lists every process the daemon's user owns, because a runaway is
 * often outside any project (a stuck build, a forgotten dev server). Seeing a
 * process is not the same as being allowed to stop it: each row says whether
 * it can be stopped here and, if not, why. Commands are redacted server-side;
 * the only handle to a process is an opaque signed token, re-verified at use.
 */

export const REPORT_LIMIT_MAX = 200;
export const STOP_BATCH_MAX = 20;
/** How long a stopped process gets to exit before it is stopped forcefully. */
export const STOP_GRACE_SECONDS = 10;
/** A process that holds a full CPU core this long is a runaway. */
export const RUNAWAY_CPU_SECONDS = 120;
/** A single process holding this share of the memory limit is flagged. */
export const MEMORY_HEAVY_PERCENT = 40;

export const JobKindSchema = z.enum(["dev-server", "build", "test", "typecheck", "install"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const OwnerKindSchema = z.enum(["paseo", "plugin", "agent", "terminal", "project", "paseo-started", "infrastructure", "other"]);
export type OwnerKind = z.infer<typeof OwnerKindSchema>;

export const ProcessFlagSchema = z.object({ code: z.enum(["cpu-runaway", "memory-heavy", "pressure-driver"]), text: z.string() });

export const ProcessRowSchema = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().min(0),
  name: z.string(),
  /** Redacted, length-bounded command line, for display only. */
  command: z.string(),
  cwd: z.string().nullable(),
  state: z.string(),
  /** Share of one core; a busy multi-threaded process can pass 100. */
  cpuPercent: z.number().min(0).nullable(),
  cpuSustained: z.number().min(0).nullable(),
  /** Seconds it has held about a full core. */
  hotSeconds: z.number().min(0),
  rssBytes: z.number().min(0),
  /** Share of the container's memory limit, or of the machine's memory without one. */
  memoryPercent: z.number().min(0),
  ageSeconds: z.number().min(0),
  ports: z.array(z.number().int()),
  job: z.object({ kind: JobKindSchema, label: z.string() }).nullable(),
  /** Counted toward "heavy jobs at once": a job none of whose parents is a job. */
  jobRoot: z.boolean(),
  /** This process plus the descendants this user owns. */
  tree: z.object({ count: z.number().int().min(1), cpuPercent: z.number().min(0).nullable(), rssBytes: z.number().min(0) }),
  owner: z.object({ kind: OwnerKindSchema, label: z.string(), project: z.string().nullable(), workspace: z.string().nullable() }),
  flags: z.array(ProcessFlagSchema),
  stoppable: z.boolean(),
  /** Plain words on why it can't be stopped here; null when it can. */
  protectedReason: z.string().nullable(),
  actionToken: z.string().nullable(),
});
export type ProcessRow = z.infer<typeof ProcessRowSchema>;

export const RunawayCodeSchema = z.enum(["cpu-runaway", "memory-heavy", "memory-near-limit", "too-many-jobs", "cpu-busy"]);
export type RunawayCode = z.infer<typeof RunawayCodeSchema>;

export const RunawaySchema = z.object({
  code: RunawayCodeSchema,
  severity: z.enum(["warning", "critical"]),
  /** One plain sentence, outcome first. */
  title: z.string(),
  pids: z.array(z.number().int()),
  /** Home-relative directory of the process it is about, when it is about one. */
  cwd: z.string().nullable(),
});
export type Runaway = z.infer<typeof RunawaySchema>;

export const ActionLogEntrySchema = z.object({
  at: z.number(),
  action: z.enum(["stop", "force-stop", "auto-force-stop"]),
  source: z.enum(["processes", "monitor"]),
  pid: z.number().int().nullable(),
  name: z.string(),
  owner: z.string().nullable(),
  status: ActionResultSchema.shape.status,
  /** Processes that received the signal, the target included. */
  signaled: z.number().int().min(0),
  message: z.string(),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

export const ReportSortSchema = z.enum(["cpu", "memory", "age", "name"]);
export type ReportSort = z.infer<typeof ReportSortSchema>;

export const ReportInputSchema = z.object({
  sort: ReportSortSchema.default("cpu"),
  query: z.string().max(120).default(""),
  /** "jobs": heavy job roots only; "stoppable": only what can be stopped here. */
  filter: z.enum(["all", "jobs", "stoppable"]).default("all"),
  limit: z.number().int().min(1).max(REPORT_LIMIT_MAX).default(25),
  offset: z.number().int().min(0).max(4096).default(0),
});
export type ReportInput = z.input<typeof ReportInputSchema>;

export const ProcessReportSchema = z.object({
  checkedAt: z.number(),
  platform: z.enum(["linux", "darwin", "unsupported"]),
  supported: z.boolean(),
  /** True until CPU has been measured twice. */
  sampling: z.boolean(),
  host: z.object({
    cores: z.number().int().min(1),
    cpuPercent: z.number().min(0).max(100).nullable(),
    load1: z.number().min(0),
    memoryTotalBytes: z.number().min(0),
    memoryUsedBytes: z.number().min(0),
    cpuPressure: PressureStateSchema,
    memoryPressure: PressureStateSchema,
  }),
  container: ContainerSnapshotSchema.nullable(),
  /** What memory shares are measured against. */
  memoryBasis: z.enum(["container", "machine"]),
  memoryBasisBytes: z.number().min(0),
  heavyJobs: z.object({ count: z.number().int().min(0), limit: z.number().int().min(1), pids: z.array(z.number().int()) }),
  runaways: z.array(RunawaySchema),
  processes: z.array(ProcessRowSchema),
  /** Every process this user owns, and how many match the query and filter. */
  total: z.number().int().min(0),
  matched: z.number().int().min(0),
  /** Memory held by Paseo itself (daemon, plugins, terminals). */
  paseoBytes: z.number().min(0),
  /** False while Paseo projects can't be verified: project names are missing, and only processes started from Paseo can be stopped. */
  projectsVerified: z.boolean(),
  warnings: z.array(z.string()),
  recentActions: z.array(ActionLogEntrySchema),
});
export type ProcessReport = z.infer<typeof ProcessReportSchema>;

export const processReport = defineRpc({ name: "daemon-link.processes.report", input: ReportInputSchema, output: ProcessReportSchema });

export const TokensInputSchema = z.object({ tokens: z.array(z.string().min(1).max(512)).min(1).max(STOP_BATCH_MAX) });

export const StopPlanSchema = z.object({
  targets: z.array(z.object({
    pid: z.number().int().nullable(),
    name: z.string(),
    ok: z.boolean(),
    /** Why it would be refused; null when it will be stopped. */
    reason: z.string().nullable(),
    rssBytes: z.number().min(0),
    cpuPercent: z.number().min(0).nullable(),
    /** Child processes that will be stopped with it, after the same checks. */
    children: z.array(z.object({ pid: z.number().int(), name: z.string() })),
  })),
  graceSeconds: z.number().int().min(0),
});
export type StopPlan = z.infer<typeof StopPlanSchema>;
export const processPreview = defineRpc({ name: "daemon-link.processes.preview", input: TokensInputSchema, output: StopPlanSchema });

export const StopOutcomeSchema = z.object({
  results: z.array(z.object({ pid: z.number().int().nullable(), name: z.string(), ok: z.boolean(), status: ActionResultSchema.shape.status, message: z.string(), signaled: z.number().int().min(0) })),
  /** Survivors are stopped forcefully after this many seconds. */
  escalateAfterSeconds: z.number().int().min(0),
});
export type StopOutcome = z.infer<typeof StopOutcomeSchema>;
export const processStop = defineRpc({ name: "daemon-link.processes.stop", input: TokensInputSchema, output: StopOutcomeSchema });

export const processLog = defineRpc({
  name: "daemon-link.processes.log",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ entries: z.array(ActionLogEntrySchema) }),
});

/** What a row looks like at a glance (0.12.1): rows that look the same also show their PID. */
export const sameness = (row: { name: string; owner: { label: string }; ports: readonly number[] }) => `${row.name}\u0000${row.owner.label}\u0000${row.ports.join(",")}`;

/** The looks shared by more than one row. */
export function twinKeys(rows: ReadonlyArray<{ name: string; owner: { label: string }; ports: readonly number[] }>): Set<string> {
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(sameness(row), (seen.get(sameness(row)) ?? 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key));
}
