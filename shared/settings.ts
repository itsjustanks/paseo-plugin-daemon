import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SNAPSHOT_INTERVAL_MIN = 5;
export const SNAPSHOT_INTERVAL_MAX = 120;
export const SNAPSHOT_INTERVAL_DEFAULT = 20;

/** Current stored-document version. Bump it together with `migrateHostsSettings`. */
export const HOSTS_SETTINGS_VERSION = 2;

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
  /** Show the per-agent composer pill summarising the workspace's dev servers and problems. */
  showComposerPill: z.boolean().default(true),
});
export type HostsSettings = z.infer<typeof HostsSettingsSchema>;

/** Schema defaults; also what the server falls back to when the stored document is unreadable. */
export const HOSTS_SETTINGS_DEFAULTS: HostsSettings = HostsSettingsSchema.parse({});

/**
 * Bring an older stored document up to the current shape. Every field added
 * since version 1 has a schema default, so carrying the old values through
 * untouched is enough; the parse fills in the rest. Unknown versions are
 * returned as-is so the parse reports them instead of guessing.
 */
export function migrateHostsSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion === 1 && values && typeof values === "object") return { ...values };
  return values;
}

export const hostsSettings = defineSettings({
  id: "hosts",
  scope: "host",
  version: HOSTS_SETTINGS_VERSION,
  schema: HostsSettingsSchema,
  migrate: migrateHostsSettings,
});
