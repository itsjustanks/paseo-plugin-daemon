import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../server/adapter";
import { BrowserDiscovery } from "../server/browser-discovery";
import { BrowserSessions } from "../server/browser-sessions";

// Opt-in only. This creates and closes its own isolated Agent Browser session;
// it never discovers, commands, or cleans up a user's existing session.
const binary = process.env.HOSTS_BROWSER_SMOKE_BINARY;
const run = promisify(execFile);
it.skipIf(!binary)("captures an existing isolated Agent Browser 0.27.0 session without changing its active tab or closing Chrome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosts-browser-live-"));
  const ipc = join(directory, "ipc"); const session = "hosts-observer-test";
  const environment = { ...process.env, AGENT_BROWSER_SOCKET_DIR: ipc, AGENT_BROWSER_STREAM_PORT: "0", AGENT_BROWSER_IDLE_TIMEOUT_MS: "0", PASEO_AGENT_ID: undefined };
  // All commands below target the owned test IPC directory, never the standard directory.
  const command = async (...args: string[]) => JSON.parse((await run(binary!, ["--session", session, "--json", ...args], { env: environment, cwd: directory, timeout: 20_000, maxBuffer: 100_000 })).stdout.trim());
  let service: BrowserSessions | null = null;
  const adapter = createAdapter(); const ownedPids: number[] = [];
  try {
    expect((await run(binary!, ["--version"])).stdout.trim()).toBe("agent-browser 0.27.0");
    await command("open", "data:text/html,<title>Hosts observer first</title><h1>First tab</h1><script>setInterval(()=>document.querySelector('h1').textContent='Frame '+Date.now(),100)</script>");
    await command("tab", "new", "data:text/html,<title>Hosts observer second</title><h1>Second tab stays active</h1>");
    await chmod(ipc, 0o755);
    expect(adapter).not.toBeNull();
    const scope = { workspaceDescriptors: async () => [{ id: "smoke-workspace", name: "Isolated smoke", workspaceDirectory: directory }], agent: () => null } as never;
    const discovery = new BrowserDiscovery({ adapter, uid: process.getuid!(), roots: [ipc], scope });
    const inventory = await discovery.list();
    expect(inventory.sessions).toHaveLength(1);
    const owned = inventory.sessions[0]!;
    ownedPids.push(owned.agent.pid, owned.browser?.pid ?? 0);
    expect(await adapter!.freshListeningEndpoints(owned.browser!.pid)).toContainEqual(owned.endpoint);
    expect(owned.row).toMatchObject({ workspaceId: "smoke-workspace", attribution: "workspace" });
    expect(owned.row.viewable, owned.row.limitation ?? "missing Chrome ownership").toBe(true);
    const before = await command("tab", "list");
    service = new BrowserSessions(discovery);
    const view = await service.open({ sessionId: owned.row.id });
    const first = view.tabs.find((tab) => tab.title === "Hosts observer first")!; expect(first).toBeDefined();
    const frame = await service.frame({ viewerId: view.viewerId, tabId: first.id });
    expect(frame.frame?.data.length).toBeGreaterThan(1000); expect(frame.frame?.width).toBeLessThanOrEqual(1280);
    await writeFile("/tmp/hosts-browser-smoke-evidence.jpg", Buffer.from(frame.frame!.data, "base64"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const next = await service.frame({ viewerId: view.viewerId, tabId: first.id });
    expect(next.frame!.data).not.toBe(frame.frame!.data);
    service.closeView({ viewerId: view.viewerId });
    expect(await command("tab", "list")).toEqual(before);
    expect((await command("get", "title")).data.title).toBe("Hosts observer second");
    expect(await adapter!.readIdentity(owned.browser!.pid)).not.toBeNull();
    expect(Number(await readFile(join(ipc, `${session}.pid`), "utf8"))).toBe(owned.agent.pid);
    // Confirm independently that the preserved browser can still take its own screenshot.
    await command("screenshot", join(directory, "agent-after-detach.png"));
    await writeFile("/tmp/hosts-browser-smoke-evidence.json", JSON.stringify({
      agentBrowserVersion: owned.row.version, agentExecutable: owned.agent.executable,
      browserExecutable: owned.browser!.executable, verifiedEndpoint: owned.endpoint, freshCwdAttribution: owned.row.attribution, ipcDirectoryMode: "0755", width: frame.frame!.width, height: frame.frame!.height,
      changingBackgroundFrames: true, agentActiveTabPreserved: true, browserAliveAfterDetach: true, agentScreenshotAfterDetach: true,
    }, null, 2) + "\n");
  } finally {
    service?.close();
    // Lifecycle mutation is permitted only for this smoke-created test session.
    try {
      await command("close");
      for (const pid of ownedPids.filter((pid) => pid > 0)) await expect.poll(() => adapter!.readIdentity(pid), { timeout: 5000 }).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 60_000);
