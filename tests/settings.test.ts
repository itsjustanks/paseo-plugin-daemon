import { describe, expect, it } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS, HOSTS_SETTINGS_VERSION, HostsSettingsSchema, hostsSettings, migrateHostsSettings } from "../shared/settings";

describe("hosts settings document", () => {
  it("is a host-scoped version 3 document whose empty parse is complete", () => {
    expect(HOSTS_SETTINGS_VERSION).toBe(3);
    expect(hostsSettings).toMatchObject({ id: "hosts", scope: "host", version: 3 });
    expect(hostsSettings.migrate).toBe(migrateHostsSettings);
    expect(HOSTS_SETTINGS_DEFAULTS).toEqual({ closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 20, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: 120 });
  });
  it("bounds the snapshot interval, the link duration, and rejects unknown panel scopes", () => {
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 4 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 121 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 7.5 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ panelScope: "agent" }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ tunnelMinutes: 45 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ tunnelMinutes: 1440 }).success).toBe(false);
    expect(HostsSettingsSchema.parse({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false, tunnelMinutes: 480 }))
      .toEqual({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false, tunnelMinutes: 480 });
  });
  it("migrates version 1 and 2 documents by keeping their values and defaulting the new fields", () => {
    const v1 = { closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 45 };
    const fromV1 = migrateHostsSettings(v1, 1);
    expect(fromV1).not.toBe(v1);
    expect(HostsSettingsSchema.parse(fromV1)).toEqual({ ...v1, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: 120 });
    // The 0.7.0/0.8.0 document: nothing the user chose may reset when 0.9.0 bumps the version.
    const v2 = { closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 90, backgroundHealthChecks: false, showComposerPill: false };
    const fromV2 = migrateHostsSettings(v2, 2);
    expect(fromV2).not.toBe(v2);
    expect(HostsSettingsSchema.parse(fromV2)).toEqual({ ...v2, tunnelMinutes: 120 });
    // Anything else passes through untouched so the schema, not the migration, reports it.
    expect(migrateHostsSettings(null, 1)).toBeNull();
    expect(migrateHostsSettings(v2, 7)).toBe(v2);
  });
});
