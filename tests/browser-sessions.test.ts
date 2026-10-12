import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter, proc } from "./fake-adapter";
import { BrowserDiscovery, browserSocketRoots, BROWSER_DISCOVERY_MS, type DiscoveredBrowser } from "../server/browser-discovery";
import { BrowserSessions, browserDisplayUrl, browserDisplayTitle } from "../server/browser-sessions";
import { localCdpEndpoint, type BrowserCdp } from "../server/browser-cdp";
import { browserViewOpen, browserViewFrame, BROWSER_LEASE_MS, BROWSER_MAX_BASE64 } from "../shared/browser";
import { SYNTHETIC_ANTHROPIC_KEY } from "./synthetic-secrets";

const uid = process.getuid!();
let directory: string; let socket: Server; let adapter: FakeAdapter; let discovery: BrowserDiscovery;
let services: BrowserSessions[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hosts-browser-test-")); await chmod(directory, 0o755);
  socket = createServer(() => { throw new Error("Discovery must never send session commands or connect to IPC."); });
  await new Promise<void>((resolve) => socket.listen(join(directory, "default.sock"), resolve));
  await writeFile(join(directory, "default.pid"), "42"); await writeFile(join(directory, "default.version"), "0.27.0");
  adapter = new FakeAdapter();
  adapter.processes = [proc({ pid: 42, uid, executable: "/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64", argv: ["/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64"] }),
    proc({ pid: 43, uid, ppid: 42, executable: "/opt/chrome/chrome", argv: ["/opt/chrome/chrome", "--remote-debugging-port=0"] })];
  adapter.ports.set(43, [9222]); discovery = new BrowserDiscovery({ adapter, uid, roots: [directory] });
});
afterEach(async () => { services.forEach((s) => s.close()); services = []; vi.useRealTimers(); await new Promise<void>((resolve) => socket.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

describe("same-user IPC discovery without session commands", () => {
  it("accepts non-writable 0755 IPC directories and native 0.27.0 executables with stable session IDs", async () => {
    const first = await discovery.list(); const second = await discovery.list();
    expect(first.sessions).toHaveLength(1); expect(first.sessions[0]!.row).toMatchObject({ version: "0.27.0", viewable: true, attribution: "unknown" });
    expect(first.sessions[0]!.row.id).toBe(second.sessions[0]!.row.id);
    expect(JSON.stringify(first.sessions[0]!.row)).not.toContain(directory);
  });
  it("rejects writable IPC directories, pid symlinks, stale PIDs and unrelated executables", async () => {
    await chmod(directory, 0o777); expect((await discovery.list()).sessions).toEqual([]); await chmod(directory, 0o755);
    await rm(join(directory, "default.pid")); await symlink(join(directory, "default.version"), join(directory, "default.pid")); expect((await discovery.list()).sessions).toEqual([]);
    await rm(join(directory, "default.pid")); await writeFile(join(directory, "default.pid"), "999"); expect((await discovery.list()).sessions).toEqual([]);
    await writeFile(join(directory, "default.pid"), "42"); adapter.processes[0]!.executable = "/usr/bin/sleep"; expect((await discovery.list()).sessions).toEqual([]);
  });
  it("reports a precise limitation for external, missing, or ambiguous Chrome listeners", async () => {
    adapter.processes[1]!.ppid = 1;
    const external = (await discovery.list()).sessions[0]!;
    expect(external.row.viewable).toBe(false); expect(external.row.limitation).toContain("externally connected or pipe-only");
    adapter.processes[1]!.ppid = 42; adapter.ports.set(43, [9222, 9223]); expect((await discovery.list()).sessions[0]!.row.viewable).toBe(false);
  });
  it("invalidates an identity when Chrome is replaced or the PID file changes", async () => {
    const first = (await discovery.list()).sessions[0]!;
    adapter.processes[1]!.startId = "replacement";
    expect((await discovery.list()).sessions[0]!.row.id).not.toBe(first.row.id);
    await expect(discovery.verify(first)).rejects.toThrow("process changed");
    await writeFile(join(directory, "default.pid"), "44"); await expect(discovery.verify(first)).rejects.toThrow("session changed");
  });
  it("never treats another same-user browser as this session's child", async () => {
    adapter.processes[1]!.ppid = 999; expect((await discovery.list()).sessions[0]!.browser).toBeNull();
  });
  it("takes roots only from daemon configuration and includes the standard home directory", () => {
    expect(browserSocketRoots({ AGENT_BROWSER_SOCKET_DIR: "/custom", XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/paseo")).toContain("/home/paseo/.agent-browser");
    expect(browserSocketRoots({ AGENT_BROWSER_SOCKET_DIR: "relative" }, "/home/paseo")).not.toContain("relative");
  });
  it("admits the common headless-shell layout with the same process/listener proof", async () => {
    adapter.processes[1]!.executable = "/cache/chrome-headless-shell-linux64/chrome-headless-shell";
    adapter.processes[1]!.argv[0] = adapter.processes[1]!.executable;
    expect((await discovery.list()).sessions[0]!.row.viewable).toBe(true);
  });
  it("bounds the complete discovery even if an OS read stalls", async () => {
    vi.useFakeTimers(); let resume!: (value: { processes: never[]; warnings: never[] }) => void;
    vi.spyOn(adapter, "sampleProcesses").mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
    const read = discovery.list(); const rejected = expect(read).rejects.toThrow("eight-second");
    await vi.advanceTimersByTimeAsync(BROWSER_DISCOVERY_MS + 1); await rejected;
    resume({ processes: [], warnings: [] }); await Promise.resolve(); expect(adapter.portScans).toBe(0);
  });
  it("avoids network/listener churn for stale or missing IPC metadata", async () => {
    await writeFile(join(directory, "default.pid"), "999"); await discovery.list(); await discovery.list(); expect(adapter.portScans).toBe(0);
    await rm(join(directory, "default.pid")); expect((await discovery.list()).sessions).toEqual([]); expect(adapter.portScans).toBe(0);
  });
  it("attributes canonical workspace membership, requiring live daemon ancestry for chat attribution", async () => {
    adapter.processes[0]!.cwd = directory; adapter.processes[0]!.agentId = "chat-a";
    const scope = { workspaceDescriptors: async () => [{ id: "workspace-a", name: "Browser workspace", workspaceDirectory: directory }], agent: () => ({ id: "chat-a", title: "Browser chat", workspaceId: "workspace-a" }) } as never;
    const linked = new BrowserDiscovery({ adapter, uid, roots: [directory], scope, daemonPid: 44 });
    expect((await linked.list()).sessions[0]!.row).toMatchObject({ attribution: "workspace", chatId: null, workspaceId: "workspace-a" });
    adapter.processes.push(proc({ pid: 44, uid })); adapter.processes[0]!.ppid = 44;
    expect((await linked.list()).sessions[0]!.row).toMatchObject({ attribution: "chat", chatId: "chat-a" });
  });
});

function jpeg(width = 800, height = 600) {
  const bytes = Buffer.from([255,216,255,192,0,11,8,0,0,0,0,1,1,17,0]); bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes.toString("base64");
}
async function fixture() {
  const session = (await discovery.list()).sessions[0]!;
  const commands: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const state = { targets: [{ targetId: "tab-a", type: "page", title: `Token ${SYNTHETIC_ANTHROPIC_KEY}`, url: "https://user:password@example.com/a?code=private#fragment" }, { targetId: "tab-b", type: "page", title: "Second", url: "about:blank" }], data: jpeg() };
  const closed = vi.fn();
  const connection: BrowserCdp = { close: closed, send: vi.fn(async (method, params = {}, sessionId) => {
    commands.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: state.targets };
    if (method === "Target.attachToTarget") return { sessionId: `capture-${params.targetId}` };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1600, clientHeight: 1200 } };
    if (method === "Page.captureScreenshot") return { data: state.data };
    return {};
  }) as BrowserCdp["send"] };
  const verify = vi.fn(async (_session: DiscoveredBrowser) => {});
  let time = 100_000;
  const service = new BrowserSessions({ list: async () => ({ sessions: [session], warnings: [] }), verify, endpoint: async () => "ws://127.0.0.1:9222/devtools/browser/test" }, async () => connection, () => time);
  services.push(service);
  return { service, session, commands, state, closed, connection, verify, advance: (ms: number) => { time += ms; } };
}
describe("observer capture and viewer lifetime", () => {
  it("attaches only to the explicitly selected target and uses bounded screenshots without activation or emulation", async () => {
    const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    expect(view.tabs[0]!.url).toBe("https://example.com/a"); expect(view.tabs[0]!.title).not.toContain(SYNTHETIC_ANTHROPIC_KEY);
    const result = await f.service.frame({ viewerId: view.viewerId, tabId: "tab-b" });
    expect(result.frame?.tabId).toBe("tab-b");
    expect(f.commands.find((c) => c.method === "Target.attachToTarget")?.params).toEqual({ targetId: "tab-b", flatten: true });
    const screenshot = f.commands.find((c) => c.method === "Page.captureScreenshot")!;
    expect(screenshot.params).toMatchObject({ quality: 55, captureBeyondViewport: false, clip: { scale: 0.75 } });
    expect(f.commands.every((c) => ["Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget", "Page.getLayoutMetrics", "Page.captureScreenshot"].includes(c.method))).toBe(true);
    f.service.closeView({ viewerId: view.viewerId }); expect(f.closed).toHaveBeenCalledOnce(); expect(adapter.processes).toHaveLength(2);
  });
  it("never follows a different tab when the selected target closes or lists reorder", async () => {
    const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    await f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" }); f.advance(1001);
    f.state.targets = [f.state.targets[1]!];
    const result = await f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" });
    expect(result.frame).toBeNull(); expect(result.message).toContain("selected tab closed");
    expect(f.commands.filter((c) => c.method === "Target.attachToTarget")).toHaveLength(1);
  });
  it("rate limits captures, caps concurrent viewers, and expires idle connections without further capture", async () => {
    vi.useFakeTimers(); const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    await f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" }); await f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" });
    expect(f.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(1);
    await Promise.all(Array.from({ length: 3 }, () => f.service.open({ sessionId: f.session.row.id })));
    await expect(f.service.open({ sessionId: f.session.row.id })).rejects.toThrow("Four");
    f.advance(BROWSER_LEASE_MS + 1); await vi.advanceTimersByTimeAsync(1001); expect(f.closed).toHaveBeenCalledTimes(4);
    await expect(f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" })).rejects.toThrow("expired");
  });
  it("drops in-flight captures after close and rejects concurrent frame requests", async () => {
    const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    let resolve!: () => void; f.verify.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const capture = f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" });
    await expect(f.service.frame({ viewerId: view.viewerId, tabId: "tab-b" })).rejects.toThrow("already");
    f.service.closeView({ viewerId: view.viewerId }); resolve(); await expect(capture).rejects.toThrow("closed");
    expect(f.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(0);
  });
  it.each(["oversized bytes", "oversized dimensions", "invalid JPEG"])("rejects %s and releases capture resources", async (kind) => {
    const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    f.state.data = kind === "oversized bytes" ? "A".repeat(BROWSER_MAX_BASE64 + 1) : kind === "oversized dimensions" ? jpeg(2000, 2000) : "AAAA";
    await expect(f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" })).rejects.toThrow(); expect(f.closed).toHaveBeenCalledOnce();
  });
  it("fails closed when runtime ownership changes and detaches on plugin shutdown", async () => {
    const f = await fixture(); const view = await f.service.open({ sessionId: f.session.row.id });
    f.verify.mockRejectedValueOnce(new Error("process changed")); await expect(f.service.frame({ viewerId: view.viewerId, tabId: "tab-a" })).rejects.toThrow("changed");
    expect(f.closed).toHaveBeenCalledOnce(); await f.service.open({ sessionId: f.session.row.id }); f.service.close(); expect(f.closed).toHaveBeenCalledTimes(2);
  });
  it("does not create a connection after shutdown while endpoint discovery is pending", async () => {
    const f = await fixture(); let finish!: (url: string) => void; const connect = vi.fn(async () => f.connection);
    const service = new BrowserSessions({ list: async () => ({ sessions: [f.session], warnings: [] }), verify: f.verify, endpoint: () => new Promise((resolve) => { finish = resolve; }) }, connect);
    services.push(service);
    const opening = service.open({ sessionId: f.session.row.id }); const rejected = expect(opening).rejects.toThrow("closed");
    await vi.waitFor(() => expect(finish).toBeDefined()); service.close(); finish("ws://127.0.0.1:9222/devtools/browser/test"); await rejected;
    expect(connect).not.toHaveBeenCalled();
  });
});
describe("workspace inventory", () => {
  it("filters exact verified workspaces, includes unknown sessions only in host inventory, and refreshes after the cache expires", async () => {
    const session = (await discovery.list()).sessions[0]!;
    const rows = [session, { ...session, row: { ...session.row, id: "known-a", workspaceId: "a" } }, { ...session, row: { ...session.row, id: "known-b", workspaceId: "b" } }];
    const list = vi.fn(async () => ({ sessions: rows, warnings: ["scope warning"] })); let time = 10000;
    const service = new BrowserSessions({ list, verify: discovery.verify.bind(discovery), endpoint: discovery.endpoint.bind(discovery) }, undefined, () => time); services.push(service);
    expect((await service.list({ workspaceId: "a" })).sessions.map(row => row.id)).toEqual(["known-a"]);
    expect((await service.list({ workspaceId: "missing" })).sessions).toEqual([]);
    expect((await service.list()).sessions).toHaveLength(3); expect(list).toHaveBeenCalledOnce();
    rows.pop(); time += 5001;
    expect((await service.list({ workspaceId: "b" })).sessions).toEqual([]); expect(list).toHaveBeenCalledTimes(2);
    expect((await service.list()).warnings).toEqual(["scope warning"]);
  });
});
describe("RPC and endpoint boundary", () => {
  it("rejects arbitrary endpoint URLs, methods and unknown input fields", () => {
    expect(browserViewOpen.input.safeParse({ sessionId: "known", endpoint: "http://private" }).success).toBe(false);
    expect(browserViewFrame.input.safeParse({ viewerId: "known", tabId: "tab-a", method: "Browser.close" }).success).toBe(false);
  });
  it.each(["ws://evil.com:9222/devtools/browser/test", "wss://127.0.0.1:9222/devtools/browser/test", "ws://127.0.0.1:9223/devtools/browser/test", "ws://user:pass@127.0.0.1:9222/devtools/browser/test", "ws://127.0.0.1:9222/devtools/browser/test?secret=yes", "ws://127.0.0.1:9222/arbitrary"])("refuses unverified endpoint %s", (url) => { expect(() => localCdpEndpoint(url, { address: "127.0.0.1", family: 4, port: 9222 })).toThrow(); });
  it("normalizes localhost to the literal verified listener and strips URL secrets", () => {
    expect(localCdpEndpoint("ws://localhost:9222/devtools/browser/test", { address: "127.0.0.1", family: 4, port: 9222 })).toBe("ws://127.0.0.1:9222/devtools/browser/test");
    expect(browserDisplayUrl("data:text/html,private")).toBe("Private or internal page");
    expect(browserDisplayUrl("https://a:b@example.com/?not_named_secret=private#fragment")).toBe("https://example.com/");
    expect(browserDisplayTitle("Visit https://user:password@example.com/a?anything=private#fragment token=abcdefg")).not.toMatch(/password|anything|private|abcdefg/);
  });
});
