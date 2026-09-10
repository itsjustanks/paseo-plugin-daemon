import { describe, expect, it } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS, HOSTS_SETTINGS_VERSION, HostsSettingsSchema, hostsSettings, migrateHostsSettings } from "../shared/settings";

describe("hosts settings document", () => {
  it("is a host-scoped version 2 document whose empty parse is complete", () => {
    expect(HOSTS_SETTINGS_VERSION).toBe(2);
    expect(hostsSettings).toMatchObject({ id: "hosts", scope: "host", version: 2 });
    expect(hostsSettings.migrate).toBe(migrateHostsSettings);
    expect(HOSTS_SETTINGS_DEFAULTS).toEqual({ closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 20, backgroundHealthChecks: true, showComposerPill: true });
  });
  it("bounds the snapshot interval and rejects unknown panel scopes", () => {
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 4 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 121 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 7.5 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ panelScope: "agent" }).success).toBe(false);
    expect(HostsSettingsSchema.parse({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false }))
      .toEqual({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false });
  });
  it("migrates a version 1 document by keeping its values and defaulting the new switches on", () => {
    const saved = { closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 45 };
    const migrated = migrateHostsSettings(saved, 1);
    expect(migrated).not.toBe(saved);
    expect(HostsSettingsSchema.parse(migrated)).toEqual({ ...saved, backgroundHealthChecks: true, showComposerPill: true });
    // Anything else passes through untouched so the schema, not the migration, reports it.
    expect(migrateHostsSettings(null, 1)).toBeNull();
    expect(migrateHostsSettings(saved, 7)).toBe(saved);
  });
});
