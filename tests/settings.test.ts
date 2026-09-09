import { describe, expect, it } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS, HostsSettingsSchema, hostsSettings } from "../shared/settings";

describe("hosts settings document", () => {
  it("is a host-scoped version 1 document whose empty parse is complete", () => {
    expect(hostsSettings).toMatchObject({ id: "hosts", scope: "host", version: 1 });
    expect(HOSTS_SETTINGS_DEFAULTS).toEqual({ closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 20 });
  });
  it("bounds the snapshot interval and rejects unknown panel scopes", () => {
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 4 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 121 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ snapshotIntervalSeconds: 7.5 }).success).toBe(false);
    expect(HostsSettingsSchema.safeParse({ panelScope: "agent" }).success).toBe(false);
    expect(HostsSettingsSchema.parse({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false }))
      .toEqual({ panelScope: "host", snapshotIntervalSeconds: 120, closeTunnelsOnArchive: false });
  });
});
