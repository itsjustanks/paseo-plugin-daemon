import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Every RPC lives under `monitor.*`. Nothing secret crosses this boundary:
// commands are redacted server-side, and the only handle a client ever gets to
// a process is an opaque signed token that the server re-verifies at use time.

export const SNAPSHOT_LIMIT_MAX = 200;
export const SNAPSHOT_LIMIT_DEFAULT = 60;
export const QUERY_MAX_LENGTH = 120;

export const ProcessSortSchema = z.enum(["cpu", "memory", "name", "pid"]);
export type ProcessSort = z.infer<typeof ProcessSortSchema>;

export const PressureStateSchema = z.enum(["normal", "high", "critical"]);
export type PressureState = z.infer<typeof PressureStateSchema>;

export const ProcessImpactSchema = z.enum(["idle", "normal", "high", "pressure-driver"]);
export type ProcessImpact = z.infer<typeof ProcessImpactSchema>;

export const ProcessStateSchema = z.enum(["running", "sleeping", "disk-wait", "stopped", "zombie", "idle", "unknown"]);
export type ProcessState = z.infer<typeof ProcessStateSchema>;

export const ServiceKindSchema = z.enum(["dev-server", "listener"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const ServiceConfidenceSchema = z.enum(["high", "medium", "low"]);
export type ServiceConfidence = z.infer<typeof ServiceConfidenceSchema>;

export const SamplingStateSchema = z.enum(["sampling", "live"]);

export const CpuSnapshotSchema = z.object({
  percent: z.number().min(0).max(100).nullable(),
  cores: z.number().int().min(1),
  load1: z.number().min(0),
  load5: z.number().min(0),
  load15: z.number().min(0),
  /** Linux PSI "some" avg10 for CPU, when the kernel exposes it. */
  psiSome10: z.number().min(0).max(100).nullable(),
  pressure: PressureStateSchema,
  reasons: z.array(z.string()),
});
export type CpuSnapshot = z.infer<typeof CpuSnapshotSchema>;

export const MemorySnapshotSchema = z.object({
  totalBytes: z.number().min(0),
  usedBytes: z.number().min(0),
  availableBytes: z.number().min(0),
  swapTotalBytes: z.number().min(0),
  swapUsedBytes: z.number().min(0),
  /** Linux PSI "some" avg10 for memory, when the kernel exposes it. */
  psiSome10: z.number().min(0).max(100).nullable(),
  /** macOS `memory_pressure` level or Linux-derived equivalent, when known. */
  pressureSignal: z.enum(["normal", "warn", "critical"]).nullable(),
  pressure: PressureStateSchema,
  reasons: z.array(z.string()),
});
export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>;

export const ProjectMatchSchema = z.object({
  id: z.string(), name: z.string(), path: z.string(), workspace: z.string().nullable(),
  shareablePorts: z.array(z.number().int()).optional(),
  kind: z.enum(["dev-server", "agent", "project-tool"]), shareable: z.boolean(), canStop: z.boolean(),
});
export const ProjectScopeSchema = z.object({
  status: z.enum(["ready", "unavailable"]), message: z.string(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
});

export const ProcessSchema = z.object({
  pid: z.number().int().positive(),
  project: ProjectMatchSchema.nullable().optional(),
  ppid: z.number().int().min(0),
  name: z.string(),
  /** Redacted, length-bounded command line for display only. */
  command: z.string(),
  /** Home-relative working directory (`~/...`) or null when unreadable. */
  cwd: z.string().nullable(),
  state: ProcessStateSchema,
  cpuPercent: z.number().min(0).nullable(),
  rssBytes: z.number().min(0),
  memoryPercent: z.number().min(0).max(100),
  ageSeconds: z.number().min(0),
  ports: z.array(z.number().int().min(1).max(65535)),
  impact: ProcessImpactSchema,
  reasons: z.array(z.string()),
  service: z
    .object({ kind: ServiceKindSchema, confidence: ServiceConfidenceSchema, label: z.string(), reasons: z.array(z.string()) })
    .nullable(),
  actionable: z.boolean(),
  protectedReason: z.string().nullable(),
  /** Opaque, signed, short-lived. Null when the process is not actionable. */
  actionToken: z.string().nullable(),
});
export type ProcessView = z.infer<typeof ProcessSchema>;

export const SnapshotSchema = z.object({
  scope: ProjectScopeSchema.optional(),
  hiddenProcesses: z.number().optional(),
  timestamp: z.number(),
  sampling: SamplingStateSchema,
  platform: z.enum(["linux", "darwin", "unsupported"]),
  supported: z.boolean(),
  warnings: z.array(z.string()),
  uptimeSeconds: z.number().min(0),
  cpu: CpuSnapshotSchema,
  memory: MemorySnapshotSchema,
  services: z.array(ProcessSchema),
  processes: z.array(ProcessSchema),
  totalProcesses: z.number().int().min(0),
  matchedProcesses: z.number().int().min(0),
  truncated: z.boolean(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotInputSchema = z.object({
  direction: z.enum(["asc", "desc"]).optional(),
  offset: z.number().int().min(0).max(4096).optional(),
  query: z.string().max(QUERY_MAX_LENGTH).default(""),
  sort: ProcessSortSchema.default("cpu"),
  limit: z.number().int().min(1).max(SNAPSHOT_LIMIT_MAX).default(SNAPSHOT_LIMIT_DEFAULT),
});
export type SnapshotInput = z.input<typeof SnapshotInputSchema>;

export const monitorSnapshot = defineRpc({
  name: "monitor.snapshot",
  input: SnapshotInputSchema,
  output: SnapshotSchema,
});

export const ActionInputSchema = z.object({ token: z.string().min(1).max(512) });

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  /** Machine-readable outcome; the client maps it to copy. */
  status: z.enum(["signaled", "already-exited", "denied", "needs-graceful-first", "failed"]),
  message: z.string(),
  pid: z.number().int().positive().nullable(),
  /** Descendants that received the same signal. */
  signaledCount: z.number().int().min(0),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const monitorStop = defineRpc({
  name: "monitor.stop",
  input: ActionInputSchema,
  output: ActionResultSchema,
});

export const monitorForceStop = defineRpc({
  name: "monitor.force-stop",
  input: ActionInputSchema,
  output: ActionResultSchema,
});
