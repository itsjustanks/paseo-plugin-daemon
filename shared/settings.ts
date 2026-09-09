import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SNAPSHOT_INTERVAL_MIN = 5;
export const SNAPSHOT_INTERVAL_MAX = 120;
export const SNAPSHOT_INTERVAL_DEFAULT = 20;

export const PanelScopeSchema = z.enum(["workspace", "host"]);
export type PanelScope = z.infer<typeof PanelScopeSchema>;

export const HostsSettingsSchema = z.object({
  /** Stop browser links for a workspace's processes when that workspace is archived. */
  closeTunnelsOnArchive: z.boolean().default(true),
  /** What the workspace panel shows: only the workspace's processes, or the whole host surface. */
  panelScope: PanelScopeSchema.default("workspace"),
  /** How often the workspace panel refreshes its monitor snapshot. */
  snapshotIntervalSeconds: z.number().int().min(SNAPSHOT_INTERVAL_MIN).max(SNAPSHOT_INTERVAL_MAX).default(SNAPSHOT_INTERVAL_DEFAULT),
});
export type HostsSettings = z.infer<typeof HostsSettingsSchema>;

/** Schema defaults; also what the server falls back to when the stored document is unreadable. */
export const HOSTS_SETTINGS_DEFAULTS: HostsSettings = HostsSettingsSchema.parse({});

export const hostsSettings = defineSettings({
  id: "hosts",
  scope: "host",
  version: 1,
  schema: HostsSettingsSchema,
});
