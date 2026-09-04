import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * CLIENT DRAFT of the Monitor RPC contract.
 *
 * The backend track owns the authoritative `contracts.shared.ts`. This file
 * exists so the dashboard can be typed against the approved plan (section 2)
 * before the backend lands. On integration: keep the backend's file and
 * reconcile any field-name drift in `rpc.client.ts`, which is the only client
 * module that imports from here directly.
 *
 * Boundaries that must hold on both sides:
 *   - one snapshot per 2 s query; headline and process rows describe one sample;
 *   - processes are already filtered/sorted/bounded server-side;
 *   - `actionToken` is opaque, short-lived, and the only thing stop/forceStop accept;
 *   - no raw argv, env, home paths, or secrets cross this boundary.
 */

export const SortSchema = z.enum(["cpu", "memory", "name", "pid"]);
export type Sort = z.infer<typeof SortSchema>;

export const PressureStateSchema = z.enum(["normal", "high", "critical"]);
export type PressureState = z.infer<typeof PressureStateSchema>;

export const PressureSchema = z.object({
  state: PressureStateSchema,
  reasons: z.array(z.string()),
});

export const ImpactSchema = z.enum(["idle", "normal", "high", "pressure-driver"]);
export type Impact = z.infer<typeof ImpactSchema>;

export const ClassificationSchema = z.object({
  kind: z.enum(["dev-server", "listening", "process"]),
  /** Short human label, e.g. "Vite dev server" or "Listening process". */
  label: z.string(),
  reasons: z.array(z.string()),
});

export const ProcessSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  /** Safe display name (basename of the executable or package runner). */
  name: z.string(),
  /** Bounded, redacted display command. */
  command: z.string(),
  /** Home-relative working directory, or null when not readable. */
  cwd: z.string().nullable(),
  /** Platform state letter/word, e.g. "running", "sleeping", "zombie". */
  state: z.string(),
  /** Recent CPU share in percent of one core-normalised machine; null until two samples exist. */
  cpuPercent: z.number().nullable(),
  rssBytes: z.number(),
  memoryPercent: z.number(),
  ageSeconds: z.number(),
  ports: z.array(z.number().int()),
  classification: ClassificationSchema,
  impact: ImpactSchema,
  impactReasons: z.array(z.string()),
  actionable: z.boolean(),
  protectedReason: z.string().nullable(),
  /** Opaque, short-lived stop token. Null when the process is not actionable. */
  actionToken: z.string().nullable(),
});
export type Process = z.infer<typeof ProcessSchema>;

export const SnapshotSchema = z.object({
  timestamp: z.string(),
  /** True while the collector still needs a second sample for CPU deltas. */
  sampling: z.boolean(),
  platform: z.string(),
  supported: z.boolean(),
  /** Degraded-detail warnings (e.g. lsof missing, cwd unreadable). */
  warnings: z.array(z.string()),
  system: z.object({
    cpu: z.object({
      percent: z.number().nullable(),
      cores: z.number().int(),
      load: z.tuple([z.number(), z.number(), z.number()]),
      pressure: PressureSchema,
    }),
    memory: z.object({
      usedBytes: z.number(),
      availableBytes: z.number(),
      totalBytes: z.number(),
      swapUsedBytes: z.number(),
      swapTotalBytes: z.number(),
      pressure: PressureSchema,
    }),
    uptimeSeconds: z.number(),
  }),
  /** Detected dev servers and other listening services (same shape as a process row). */
  services: z.array(ProcessSchema),
  processes: z.object({
    items: z.array(ProcessSchema),
    /** Total same-user processes matching the query before the limit was applied. */
    total: z.number().int(),
    truncated: z.boolean(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const monitorSnapshot = defineRpc({
  name: "monitor.snapshot",
  input: z.object({
    query: z.string(),
    sort: SortSchema,
    limit: z.number().int().positive(),
  }),
  output: SnapshotSchema,
});

export const monitorStop = defineRpc({
  name: "monitor.stop",
  input: z.object({ token: z.string() }),
  output: ActionResultSchema,
});

export const monitorForceStop = defineRpc({
  name: "monitor.forceStop",
  input: z.object({ token: z.string() }),
  output: ActionResultSchema,
});
