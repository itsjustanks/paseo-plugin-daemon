import { describe, expect, it } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS, HOSTS_SETTINGS_VERSION, HostsSettingsSchema, hostsSettings, migrateHostsSettings } from "../shared/settings";

describe("hosts settings document", () => {
  it("is a host-scoped version 5 document whose empty parse is complete and safe for a team daemon", () => {
    expect(HOSTS_SETTINGS_VERSION).toBe(5);
    expect(hostsSettings).toMatchObject({ id: "hosts", scope: "host", version: 5 });
    expect(hostsSettings.migrate).toBe(migrateHostsSettings);
    expect(HOSTS_SETTINGS_DEFAULTS).toEqual({ closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 30, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: 120, maxHeavyJobs: 4, autoStopRunaways: false, watchedServices: [] });
  });
  it("bounds the snapshot interval, the link duration, and rejects unknown panel scopes", () => {
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 4 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 121 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 7.5 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ panelScope: "agent" }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ tunnelMinutes: 45 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ tunnelMinutes: 1440 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ maxHeavyJobs: 0 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ maxHeavyJobs: 33 }).success).toBe(false);
    expect(HostsSettingsSchema.parse({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false, tunnelMinutes: 480, maxHeavyJobs: 8 }))
      .toEqual({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false, backgroundHealthChecks: false, showComposerPill: false, tunnelMinutes: 480, maxHeavyJobs: 8, autoStopRunaways: false, watchedServices: [] });
  });
  it("accepts watched services only with http(s) URLs that carry no secrets", () => {
    const ok = { id: "omniroute", name: "OmniRoute", url: "http://10.0.0.9:20128/api/health/ping" };
    expect(HostsSettingsSchema.parse({ watchedServices: [ok] }).watchedServices).toEqual([{ ...ok, expectedStatus: null }]);
    for (const url of ["ftp://host/x", "http://user:pw@host/x", "https://host/x?token=abc", "https://host/x?api_key=1", "file:///etc/passwd", "not a url"]) {
      expect(HostsSettingsSchema.safeParse({ watchedServices: [{ ...ok, url }] }).success, url).toBe(false);
    }
    expect(HostsSettingsSchema.safeParse({ watchedServices: [{ ...ok, id: "Bad Id" }] }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ watchedServices: Array.from({ length: 11 }, (_, i) => ({ ...ok, id: `s${i}` })) }).success).toBe(false);
  });
  it("migrates version 1, 2 and 3 documents by keeping their values and defaulting the new fields", () => {
    const v1 = { closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 45 };
    const fromV1 = migrateHostsSettings(v1, 1);
    expect(fromV1).not.toBe(v1);
    expect(HostsSettingsSchema.parse(fromV1)).toEqual({ ...v1, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: 120, maxHeavyJobs: 4, autoStopRunaways: false, watchedServices: [] });
    // The 0.7.0/0.8.0 document: nothing the user chose may reset when 0.9.0 bumps the version.
    const v2 = { closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 90, backgroundHealthChecks: false, showComposerPill: false };
    const fromV2 = migrateHostsSettings(v2, 2);
    expect(fromV2).not.toBe(v2);
    expect(HostsSettingsSchema.parse(fromV2)).toEqual({ ...v2, tunnelMinutes: 120, maxHeavyJobs: 4, autoStopRunaways: false, watchedServices: [] });
    // The 0.9.0 document: its link duration survives the version 4 bump.
    const v3 = { ...v2, tunnelMinutes: 480 };
    expect(HostsSettingsSchema.parse(migrateHostsSettings(v3, 3))).toEqual({ ...v3, maxHeavyJobs: 4, autoStopRunaways: false, watchedServices: [] });
    // Anything else passes through untouched so the schema, not the migration, reports it.
    expect(migrateHostsSettings(null, 1)).toBeNull();
    expect(migrateHostsSettings(v2, 7)).toBe(v2);
  });
});
