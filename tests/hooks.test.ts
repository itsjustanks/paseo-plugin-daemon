import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHookWorkspace, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { closeWorkspaceTunnels, hostsSettingsFile, readHostsSettings, registerHooks, tunnelsForWorkspace, type HooksRuntime } from "../server/hooks";
import type { Snapshot } from "../shared/contracts";
import type { Tunnel } from "../shared/link";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";

const tunnel = (id: string, port: number, state: Tunnel["state"] = "connected"): Tunnel => ({ id, port, state, message: "", createdAt: Date.now(), expiresAt: Date.now() + 60_000, url: null });
const process_ = (pid: number, cwd: string | null, ports: number[]) => ({ pid, cwd, ports }) as unknown as Snapshot["processes"][number];
const workspace: PluginHookWorkspace = { id: "ws-1", projectId: "p1", cwd: "/home/alice/app/.worktrees/feature", name: "feature", archivedAt: "2026-09-09T00:00:00Z" };

function fakeRuntime(snapshot: Pick<Snapshot, "services" | "processes">, tunnels: Tunnel[], failOn: string[] = []) {
  const stopped: string[] = [];
  const runtime: HooksRuntime = {
    monitor: { snapshot: vi.fn(async () => snapshot as Snapshot) },
    links: { tunnels: { list: () => tunnels.filter((t) => !stopped.includes(t.id)), stop: vi.fn(async (id: string) => { if (failOn.includes(id)) throw new Error("boom"); stopped.push(id); return { ok: true }; }) } },
  };
  return { runtime, stopped };
}

describe("tunnelsForWorkspace", () => {
  it("selects only live tunnels whose port belongs to a process under the workspace cwd", () => {
    const snapshot = {
      services: [process_(1, "~/app/.worktrees/feature", [3000]), process_(2, "~/app/.worktrees/other", [3001])],
      processes: [process_(3, "~/app/.worktrees/feature/api", [4000]), process_(4, "~/app", [5173])],
    };
    const tunnels = [tunnel("a", 3000), tunnel("b", 3001), tunnel("c", 4000, "starting"), tunnel("d", 5173), tunnel("e", 3000, "stopped")];
    expect(tunnelsForWorkspace(tunnels, snapshot, workspace.cwd).map((t) => t.id)).toEqual(["a", "c"]);
    expect(tunnelsForWorkspace(tunnels, { services: [], processes: [] }, workspace.cwd)).toEqual([]);
  });
});

describe("closeWorkspaceTunnels", () => {
  const snapshot = { services: [process_(1, "~/app/.worktrees/feature", [3000]), process_(2, "~/app/.worktrees/other", [3001])], processes: [] };
  it("does nothing when the setting is off and never reads the snapshot", async () => {
    const { runtime, stopped } = fakeRuntime(snapshot, [tunnel("a", 3000)]);
    expect(await closeWorkspaceTunnels(runtime, workspace, { ...HOSTS_SETTINGS_DEFAULTS, closeTunnelsOnArchive: false })).toEqual({ skipped: "disabled", stopped: [], failed: [] });
    expect(runtime.monitor.snapshot).not.toHaveBeenCalled();
    expect(stopped).toEqual([]);
  });
  it("skips the snapshot when no tunnels are open", async () => {
    const { runtime } = fakeRuntime(snapshot, []);
    expect(await closeWorkspaceTunnels(runtime, workspace, HOSTS_SETTINGS_DEFAULTS)).toEqual({ skipped: "no-tunnels", stopped: [], failed: [] });
    expect(runtime.monitor.snapshot).not.toHaveBeenCalled();
  });
  it("stops the workspace's tunnels, leaves other workspaces alone, and reports failures", async () => {
    const { runtime, stopped } = fakeRuntime(snapshot, [tunnel("a", 3000), tunnel("b", 3001), tunnel("c", 3000)], ["c"]);
    expect(await closeWorkspaceTunnels(runtime, workspace, HOSTS_SETTINGS_DEFAULTS)).toEqual({ skipped: null, stopped: [3000], failed: [3000] });
    expect(stopped).toEqual(["a"]);
  });
});

describe("readHostsSettings", () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("uses schema defaults for a missing file and fails closed for anything unreadable", async () => {
    dir = await mkdtemp(join(tmpdir(), "hosts-settings-"));
    const file = join(dir, "hosts.json");
    expect(await readHostsSettings(file)).toEqual(HOSTS_SETTINGS_DEFAULTS);
    await writeFile(file, JSON.stringify({ version: 1, values: { closeTunnelsOnArchive: false, panelScope: "host" } }));
    // A version 1 document is migrated in place: old values kept, new switches default on.
    expect(await readHostsSettings(file)).toEqual({ closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 20, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: 120 });
    // A version 2 document (0.7.0 and 0.8.0) keeps every saved value and only gains the link duration.
    await writeFile(file, JSON.stringify({ version: 2, values: { closeTunnelsOnArchive: false, panelScope: "host", backgroundHealthChecks: false, snapshotIntervalSeconds: 45 } }));
    expect(await readHostsSettings(file)).toEqual({ closeTunnelsOnArchive: false, panelScope: "host", snapshotIntervalSeconds: 45, backgroundHealthChecks: false, showComposerPill: true, tunnelMinutes: 120 });
    await writeFile(file, JSON.stringify({ version: 3, values: { tunnelMinutes: 480 } }));
    expect(await readHostsSettings(file)).toEqual({ ...HOSTS_SETTINGS_DEFAULTS, tunnelMinutes: 480 });
    for (const raw of ["not json", JSON.stringify({ version: 4, values: {} }), JSON.stringify({ version: "1", values: {} }), JSON.stringify({ version: 1, values: { snapshotIntervalSeconds: 1 } }), JSON.stringify({ version: 3, values: { tunnelMinutes: 45 } })]) {
      await writeFile(file, raw);
      expect((await readHostsSettings(file)).closeTunnelsOnArchive).toBe(false);
    }
    expect(await readHostsSettings(dir)).toMatchObject({ closeTunnelsOnArchive: false });
    expect(hostsSettingsFile("/x", "daemon-link")).toBe(join("/x", "plugin-settings", "daemon-link", "hosts.json"));
  });
});

describe("registerHooks", () => {
  it("registers both workspace hooks, swallows failures, and removes them on cleanup", async () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const removed: string[] = [];
    const server = { on: vi.fn((name: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(name, handler); return () => { removed.push(name); }; }), before: vi.fn() } as unknown as PluginLifecycleRegistration;
    const { runtime, stopped } = fakeRuntime({ services: [process_(1, "~/app/.worktrees/feature", [3000])], processes: [] }, [tunnel("a", 3000)]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = registerHooks(server, runtime, async () => HOSTS_SETTINGS_DEFAULTS);
    expect([...handlers.keys()].sort()).toEqual(["workspace.archived", "workspace.created"]);
    await handlers.get("workspace.created")!({ workspace }, { paseo: {} });
    await handlers.get("workspace.archived")!({ workspace }, { paseo: {} });
    expect(stopped).toEqual(["a"]);
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      "daemon-link: workspace.created feature (ws-1)",
      "daemon-link: workspace.archived feature (ws-1); stopped browser links on ports 3000",
    ]);
    const offline = fakeRuntime({ services: [], processes: [] }, [tunnel("b", 3000)]).runtime;
    const broken = registerHooks(server, { ...offline, monitor: { snapshot: async () => { throw new Error("offline"); } } }, async () => HOSTS_SETTINGS_DEFAULTS);
    await expect(handlers.get("workspace.archived")!({ workspace }, { paseo: {} })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("daemon-link: workspace.archived cleanup failed", "Error");
    remove(); broken();
    expect(removed).toEqual(["workspace.created", "workspace.archived", "workspace.created", "workspace.archived"]);
    log.mockRestore(); error.mockRestore();
  });
});
