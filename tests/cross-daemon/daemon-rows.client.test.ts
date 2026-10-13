// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { describe, expect, it } from "vitest";
import { buildDaemonRows } from "../../client/cross-daemon/daemon-rows.client";

const host = (serverId: string, label: string, status: "online" | "offline" = "online") => ({ serverId, label, status });
const peer = (serverId: string, name: string) => ({ serverId, name });
const daemon = (serverId: string, switchedOn: boolean, peers: { serverId: string; name: string }[] = []) => ({ serverId, switchedOn, peers });

describe("buildDaemonRows", () => {
  it("lists every connected host with its switch and the daemons it can reach", () => {
    const rows = buildDaemonRows([host("srv_tower", "Storage host"), host("srv_mac", "MacBook")], {
      daemons: [daemon("srv_tower", true, [peer("srv_mac", "workstation.example.test")]), daemon("srv_mac", false)],
      failedCount: 0,
    });
    expect(rows).toEqual([
      { serverId: "srv_tower", label: "Storage host", state: "on", detail: "Shared peers: MacBook" },
      { serverId: "srv_mac", label: "MacBook", state: "off", detail: "Off: no links are shared. Previously shared links are not revoked." },
    ]);
  });

  it("names a peer the app is not connected to by its hostname", () => {
    const [row] = buildDaemonRows([host("srv_tower", "Storage host")], { daemons: [daemon("srv_tower", true, [peer("srv_laptop", "laptop.local")])], failedCount: 0 });
    expect(row.detail).toBe("Shared peers: laptop.local");
  });

  it("says when a switched-on daemon has no peers yet", () => {
    const [row] = buildDaemonRows([host("srv_tower", "Storage host")], { daemons: [daemon("srv_tower", true)], failedCount: 0 });
    expect(row.detail).toBe("Shared peers: none yet. Switch on at least one other daemon.");
  });

  it("marks a host without the plugin, which cannot be switched", () => {
    const [row] = buildDaemonRows([host("srv_phone", "Old laptop")], { daemons: [], failedCount: 0 });
    expect(row).toEqual({
      serverId: "srv_phone",
      label: "Old laptop",
      state: "unavailable",
      detail: "Cross-daemon is unavailable. Check that Paseo and Hosts are up to date.",
    });
  });

  it("says it is checking while the daemons have not answered yet", () => {
    const [row] = buildDaemonRows([host("srv_mac", "MacBook")], null);
    expect(row).toEqual({ serverId: "srv_mac", label: "MacBook", state: "checking", detail: "Waiting for this computer's agent-access status." });
  });

  it("does not claim the plugin is missing when a daemon failed to answer", () => {
    const [row] = buildDaemonRows([host("srv_mac", "MacBook")], { daemons: [], failedCount: 1 });
    expect(row.detail).toBe("Could not read this host. Reconnect it and check that Paseo and Hosts are up to date.");
  });

  it("marks a host that is offline", () => {
    const [row] = buildDaemonRows([host("srv_mac", "MacBook", "offline")], { daemons: [daemon("srv_mac", true)], failedCount: 0 });
    expect(row.state).toBe("unavailable");
    expect(row.detail).toBe("Offline.");
  });
});
