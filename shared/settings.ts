import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { TUNNEL_MINUTES_DEFAULT, TunnelMinutesSchema } from "./tunnel-lease";
import { WatchedServiceSchema } from "./watch";

export const SNAPSHOT_INTERVAL_MIN = 5;
export const SNAPSHOT_INTERVAL_MAX = 120;
export const SNAPSHOT_INTERVAL_DEFAULT = 30;

export const MAX_HEAVY_JOBS_DEFAULT = 4;
export const WATCHED_SERVICES_MAX = 10;

/** Current stored-document version. Bump it together with `migrateHostsSettings`. */
export const HOSTS_SETTINGS_VERSION = 4;

export const PanelScopeSchema = z.enum(["workspace", "host"]);
export type PanelScope = z.infer<typeof PanelScopeSchema>;

export const HostsSettingsSchema = z.object({
  /** Stop browser links for a workspace's processes when that workspace is archived. */
  closeTunnelsOnArchive: z.boolean().default(true),
  /** What the workspace panel shows: only the workspace's processes, or the whole host surface. */
  panelScope: PanelScopeSchema.default("workspace"),
  /** How often the workspace panel refreshes its monitor snapshot, and how often the host health check runs. */
  snapshotIntervalSeconds: z.number().int().min(SNAPSHOT_INTERVAL_MIN).max(SNAPSHOT_INTERVAL_MAX).default(SNAPSHOT_INTERVAL_DEFAULT),
  /** Re-check host health on the daemon on the snapshot interval, even when no app is open. */
  backgroundHealthChecks: z.boolean().default(true),
  /** Show a composer chip when an agent's workspace needs attention (a stopped dev server, a failed link, a job driving the load). */
  showComposerPill: z.boolean().default(true),
  /** How long a temporary browser link lives when Open creates one, and how much Extend adds. */
  tunnelMinutes: TunnelMinutesSchema.default(TUNNEL_MINUTES_DEFAULT),
  /** More builds, tests, type checks, installs and dev servers than this at once is flagged. Nothing is stopped automatically. */
  maxHeavyJobs: z.number().int().min(1).max(32).default(MAX_HEAVY_JOBS_DEFAULT),
  /** Health URLs on other machines (such as OmniRoute) that the daemon checks on the health-check schedule. */
  watchedServices: z.array(WatchedServiceSchema).max(WATCHED_SERVICES_MAX).default([]),
});
export type HostsSettings = z.infer<typeof HostsSettingsSchema>;

/** Schema defaults; also what the server falls back to when the stored document is unreadable. */
export const HOSTS_SETTINGS_DEFAULTS: HostsSettings = HostsSettingsSchema.parse({});

/**
 * Bring an older stored document up to the current shape. Every field added
 * since version 1 has a schema default, so carrying the old values through
 * untouched is enough; the parse fills in the rest. Versions 1 to 3 all
 * migrate this way (2 added the health switches, 3 the link duration, 4 the
 * heavy-job limit and watched services).
 * Unknown versions are returned as-is so the parse reports them instead of
 * guessing.
 */
export function migrateHostsSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 1 && fromVersion < HOSTS_SETTINGS_VERSION && values && typeof values === "object") return { ...values };
  return values;
}

export const hostsSettings = defineSettings({
  id: "hosts",
  scope: "host",
  version: HOSTS_SETTINGS_VERSION,
  schema: HostsSettingsSchema,
  migrate: migrateHostsSettings,
});
