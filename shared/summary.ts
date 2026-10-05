import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { HealthVerdict } from "./health";

/**
 * A small, stable read of this host's health for other plugins (the AI
 * Router asked for one). Two ways in, both versioned:
 *  - the RPC `daemon-link.host.summary`, for anything holding a Paseo daemon
 *    client (`invokePluginRpc("daemon-link", "daemon-link.host.summary", {})`);
 *  - the file `$PASEO_HOME/daemon-link/host-summary.json`, rewritten after
 *    every health check, for another plugin's server on the same daemon.
 *    Its absence means Daemon Link isn't installed (or hasn't checked yet).
 * No paths, commands, URLs or tokens: issue sentences, figures and names.
 */
export const HOST_SUMMARY_VERSION = 1;

export const HostSummarySchema = z.object({
  version: z.literal(HOST_SUMMARY_VERSION),
  plugin: z.literal("daemon-link"),
  checkedAt: z.number(),
  status: z.enum(["ok", "warning", "critical", "unknown"]),
  issues: z.array(z.object({ code: z.string(), severity: z.enum(["warning", "critical"]), message: z.string() })),
  load: z.object({
    memoryUsedBytes: z.number(), memoryLimitBytes: z.number(), memoryBasis: z.enum(["container", "machine"]),
    cpuPercent: z.number().nullable(), heavyJobs: z.number().int(), heavyJobLimit: z.number().int(),
  }).nullable(),
  watched: z.array(z.object({ name: z.string(), state: z.enum(["up", "slow", "down", "unknown"]), latencyMs: z.number().nullable(), usualMs: z.number().nullable(), message: z.string() })),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;

export const hostSummary = defineRpc({ name: "daemon-link.host.summary", input: z.object({}), output: HostSummarySchema });

export function summarize(verdict: HealthVerdict): HostSummary {
  return {
    version: HOST_SUMMARY_VERSION,
    plugin: "daemon-link",
    checkedAt: verdict.checkedAt,
    status: verdict.status,
    issues: verdict.issues.map(({ code, severity, message }) => ({ code, severity, message })),
    load: verdict.load ?? null,
    watched: (verdict.watched ?? []).map(({ name, state, latencyMs, usualMs, message }) => ({ name, state, latencyMs, usualMs, message })),
  };
}
