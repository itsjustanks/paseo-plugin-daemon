import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { BrowserSession } from "../shared/browser";
import type { PlatformAdapter, ProcessIdentity, RawProcess, TcpEndpoint } from "./platform";
import { mapLimit } from "./platform";
import { hashArgv, redactSecrets } from "./redaction";
import { containsDirectory, type ProjectScope } from "./scope";
import { readCdpEndpoint } from "./browser-cdp";

const MAX_SESSIONS = 32;
const MAX_DIRS = 32;
export const BROWSER_DISCOVERY_MS = 8_000;
const SESSION_NAME = /^[a-zA-Z0-9_-]{1,100}$/;
type FileStamp = { dev: number; ino: number };
export interface DiscoveredBrowser {
  row: BrowserSession; socket: string; pidFile: string; directory: string;
  socketStamp: FileStamp; directoryStamp: FileStamp; agent: RawProcess;
  browser: RawProcess | null; endpoint: TcpEndpoint | null;
}
export function sameProcess(expected: RawProcess, actual: ProcessIdentity | null): boolean {
  return !!actual && actual.pid === expected.pid && actual.uid === expected.uid && actual.startId === expected.startId &&
    actual.executable === expected.executable && actual.argvHash === hashArgv(expected.argv);
}
export function isAgentBrowser(process: RawProcess): boolean {
  const exe = basename(process.executable ?? "");
  if (/^agent-browser(?:-(?:darwin|linux|linux-musl)-(?:arm64|x64))?$/.test(exe)) return true;
  // Older Node-backed Agent Browser distributions. Executable identity still has to be Node.
  return /^node(?:js)?$/.test(exe) && process.argv.slice(1, 4).some((arg) => /[/\\]agent-browser[/\\]dist[/\\]daemon\.js$/.test(arg));
}
function isChrome(process: RawProcess): boolean {
  return /^(?:chrome|chrome-headless-shell|headless_shell|chromium|chromium-browser|Google Chrome(?: for Testing)?|Chromium)$/.test(basename(process.executable ?? "")) &&
    process.argv.some((arg) => /^--remote-debugging-port=\d+$/.test(arg)) && !process.argv.some((arg) => arg.startsWith("--type="));
}
export function descendsFrom(child: RawProcess, parent: RawProcess, processes: readonly RawProcess[]): boolean {
  const rows = new Map(processes.map((p) => [p.pid, p]));
  const seen = new Set<number>(); let current: RawProcess | undefined = child;
  while (current && !seen.has(current.pid) && seen.size < 100) {
    if (current.uid !== parent.uid) return false;
    if (current.pid === parent.pid) return current.startId === parent.startId;
    seen.add(current.pid); current = rows.get(current.ppid);
  }
  return false;
}
/** Accept 0755: other users may read but must not replace endpoint metadata. Never follows a file link. */
async function owned(path: string, uid: number, kind: "directory" | "socket" | "file") {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0 ||
      !(kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile())) throw new Error("Browser IPC metadata is not owned safely by this user.");
  return stat;
}
async function smallFile(path: string, uid: number, max: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0 || stat.size > max) throw new Error("Invalid browser IPC metadata.");
    const bytes = Buffer.alloc(max + 1); const result = await file.read(bytes, 0, max + 1, 0);
    if (result.bytesRead > max) throw new Error("Browser IPC metadata is too large.");
    return bytes.subarray(0, result.bytesRead).toString("utf8").trim();
  } finally { await file.close(); }
}
export function browserSocketRoots(environment = process.env, home = homedir()): string[] {
  // All paths originate on the daemon. Clients cannot submit paths, ports, commands, or URLs.
  return [...new Set([environment.AGENT_BROWSER_SOCKET_DIR, environment.XDG_RUNTIME_DIR ? join(environment.XDG_RUNTIME_DIR, "agent-browser") : null,
    join(home, ".agent-browser"), join(tmpdir(), "agent-browser")].filter((path): path is string => !!path && isAbsolute(path)))];
}
export class BrowserDiscovery {
  private readonly secret = randomBytes(32);
  constructor(readonly options: {
    adapter: PlatformAdapter | null; uid: number; scope?: ProjectScope; daemonPid?: number; roots?: string[];
  }) {}

  async list(): Promise<{ sessions: DiscoveredBrowser[]; warnings: string[] }> {
    let stopped = false;
    const deadline = Date.now() + BROWSER_DISCOVERY_MS;
    const check = () => { if (stopped || Date.now() >= deadline) throw new Error("Browser discovery exceeded its eight-second budget. Refresh to try again."); };
    // A deadline bounds the RPC even if a filesystem or OS read stalls. The scan
    // checks cancellation between stages, so late work cannot start another scan/probe.
    let timer!: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([this.scan(check), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { stopped = true; reject(new Error("Browser discovery exceeded its eight-second budget. Refresh to try again.")); }, BROWSER_DISCOVERY_MS);
      })]);
    } finally { stopped = true; clearTimeout(timer); }
  }

  private async scan(check: () => void): Promise<{ sessions: DiscoveredBrowser[]; warnings: string[] }> {
    const { adapter, uid } = this.options;
    if (!adapter || uid < 0) return { sessions: [], warnings: ["Remote browser discovery supports same-user Linux and macOS daemons."] };
    const warnings = ["Only existing same-user Agent Browser sessions in this daemon's IPC directories are discovered. Custom per-agent socket directories and externally connected browsers may be unavailable."];
    const processes = (await adapter.sampleProcesses(uid)).processes;
    check();
    const directories: string[] = [];
    for (const root of this.options.roots ?? browserSocketRoots()) {
      check();
      try { await owned(root, uid, "directory"); directories.push(root); } catch { continue; }
      const namespaces = join(root, "namespaces");
      try {
        await owned(namespaces, uid, "directory");
        for (const name of await this.names(namespaces, MAX_DIRS, check)) {
          check();
          if (!SESSION_NAME.test(name)) continue;
          const namespace = join(namespaces, name); const run = join(namespace, "run");
          try { await owned(namespace, uid, "directory"); await owned(run, uid, "directory"); directories.push(run); } catch { /* unsafe/missing */ }
        }
      } catch { /* Old distributions do not have namespaces. */ }
    }
    const sessions: DiscoveredBrowser[] = [];
    for (const directory of directories.slice(0, MAX_DIRS)) {
      check();
      const names = await this.names(directory, 512, check).catch(() => []);
      if (names.length === 512) warnings.push("A browser IPC directory reached the 512-entry scan limit; some sessions may be omitted.");
      for (const name of names.filter((name) => name.endsWith(".sock")).sort()) {
        if (sessions.length >= MAX_SESSIONS) break;
        const sessionName = name.slice(0, -5);
        if (!SESSION_NAME.test(sessionName)) continue;
        try {
          check();
          const directoryStamp = await owned(directory, uid, "directory");
          const socket = join(directory, name); const pidFile = join(directory, `${sessionName}.pid`);
          const socketStamp = await owned(socket, uid, "socket");
          const pid = Number(await smallFile(pidFile, uid, 16));
          const agent = processes.find((p) => p.pid === pid && p.uid === uid && isAgentBrowser(p));
          if (!agent) continue;
          const freshAgent = await adapter.readIdentity(pid);
          if (!sameProcess(agent, freshAgent)) continue;
          check();
          const versionRaw = await smallFile(join(directory, `${sessionName}.version`), uid, 40).catch(() => "");
          const version = /^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?$/.test(versionRaw) ? versionRaw : null;
          const children = processes.filter((p) => p.uid === uid && isChrome(p) && descendsFrom(p, agent, processes));
          // More than one browser child is ambiguous: never silently pick another browser.
          const browser = children.length === 1 ? children[0]! : null;
          // No compatibility fallback to cached, port-number-only evidence.
          const endpoints = browser && typeof adapter.freshListeningEndpoints === "function" ? await adapter.freshListeningEndpoints(browser.pid).catch(() => []) : [];
          check();
          const endpoint = new Set(endpoints.map((value) => value.port)).size === 1 ? endpoints[0]! : null;
          const id = this.secretId(`${directory}\0${socketStamp.dev}:${socketStamp.ino}\0${pid}\0${agent.startId}\0${hashArgv(agent.argv)}\0${browser?.pid}:${browser?.startId}:${browser ? hashArgv(browser.argv) : ""}`);
          const attribution = await this.attribute({ ...agent, cwd: freshAgent!.cwd ?? null }, processes, check);
          check();
          const session: DiscoveredBrowser = { directory, directoryStamp, socket, pidFile, socketStamp, agent, browser, endpoint,
            row: { id, name: redactSecrets(sessionName).slice(0, 160), pid, version, ...attribution, viewable: !!browser && endpoint !== null,
              limitation: browser && endpoint !== null ? null : "No unambiguous local Chrome CDP listener could be verified beneath this Agent Browser daemon. Hosts cannot safely attach. Ask the agent to use a local Chromium session with CDP enabled; externally connected or pipe-only browsers are not supported." } };
          await this.verify(session);
          check();
          sessions.push(session);
        } catch { /* Stale, replaced, unreadable, or other-user endpoints are never probed or removed. */ }
      }
    }
    return { sessions, warnings: warnings.slice(0, 10) };
  }

  private async names(path: string, limit: number, check: () => void): Promise<string[]> {
    const directory = await opendir(path); const names: string[] = [];
    // Iteration closes the handle on break/error, and allocates at most `limit` names.
    for await (const entry of directory) { check(); names.push(entry.name); if (names.length >= limit) break; }
    return names;
  }

  private secretId(value: string): string { return createHmac("sha256", this.secret).update(value).digest("hex"); }

  private async attribute(agent: RawProcess, processes: RawProcess[], check: () => void): Promise<Pick<BrowserSession, "workspaceId" | "workspace" | "chatId" | "chat" | "attribution">> {
    const unknown = { workspaceId: null, workspace: null, chatId: null, chat: null, attribution: "unknown" as const };
    const scope = this.options.scope;
    if (!scope || !agent.cwd) return unknown;
    // Match only registered workspace directories, never a broad project root or name heuristic.
    const descriptors = await scope.workspaceDescriptors().catch(() => []);
    check();
    const cwd = await realpath(agent.cwd).catch(() => null);
    if (!cwd) return unknown;
    const candidates = (await mapLimit(descriptors.slice(0, 2000), 4, async (value) => {
      check();
      if (!value || typeof value !== "object") return [];
      const w = value as { id?: unknown; name?: unknown; workspaceDirectory?: unknown };
      if (typeof w.id !== "string" || typeof w.name !== "string" || typeof w.workspaceDirectory !== "string") return [];
      const directory = await realpath(w.workspaceDirectory).catch(() => null);
      return directory && directory !== "/" && directory !== homedir() && containsDirectory(directory, cwd) ? [{ id: w.id, name: w.name, workspaceDirectory: directory }] : [];
    })).flat().sort((a, b) => b.workspaceDirectory.length - a.workspaceDirectory.length);
    const workspace = candidates[0];
    if (!workspace) return unknown;
    const chat = scope.agent(agent.agentId);
    const daemon = processes.find((p) => p.pid === this.options.daemonPid);
    // Environment tags alone do not prove a chat launched this daemon. Detached sessions retain workspace attribution only.
    const verifiedChat = chat?.workspaceId === workspace.id && daemon && descendsFrom(agent, daemon, processes) ? chat : null;
    return { workspaceId: workspace.id, workspace: redactSecrets(workspace.name).slice(0, 240),
      chatId: verifiedChat?.id ?? null, chat: verifiedChat ? redactSecrets(verifiedChat.title).slice(0, 240) : null, attribution: verifiedChat ? "chat" : "workspace" };
  }

  async verify(session: DiscoveredBrowser): Promise<void> {
    let expired = false;
    const check = () => { if (expired) throw new Error("Browser ownership check timed out. Refresh to try again."); };
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([this.verifyOwned(session, check), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Browser ownership check timed out. Refresh to try again.")); }, 3_000);
      })]);
    } finally { expired = true; clearTimeout(timer); }
  }

  private async verifyOwned(session: DiscoveredBrowser, check: () => void): Promise<void> {
    const { uid, adapter } = this.options;
    if (!adapter) throw new Error("Browser discovery is unavailable on this host.");
    const directory = await owned(session.directory, uid, "directory");
    check();
    const socket = await owned(session.socket, uid, "socket");
    check();
    const pid = Number(await smallFile(session.pidFile, uid, 16));
    check();
    const agent = await adapter.readIdentity(session.agent.pid);
    check();
    if (directory.dev !== session.directoryStamp.dev || directory.ino !== session.directoryStamp.ino || socket.dev !== session.socketStamp.dev || socket.ino !== session.socketStamp.ino ||
        pid !== session.agent.pid || !sameProcess(session.agent, agent)) throw new Error("The browser session changed. Refresh the session list.");
    if (session.browser) {
      if (!sameProcess(session.browser, await adapter.readIdentity(session.browser.pid))) throw new Error("The browser process changed. Refresh the session list.");
      check();
      if (session.endpoint !== null) {
        if (typeof adapter.freshListeningEndpoints !== "function") throw new Error("Fresh browser endpoint ownership is unavailable.");
        const endpoints = await adapter.freshListeningEndpoints(session.browser.pid);
        check();
        if (!endpoints.some((endpoint) => endpoint.address === session.endpoint!.address && endpoint.family === session.endpoint!.family && endpoint.port === session.endpoint!.port)) throw new Error("The browser listener changed. Refresh the session list.");
      }
      check();
    }
  }

  async endpoint(session: DiscoveredBrowser): Promise<string> {
    if (!session.row.viewable || session.endpoint === null) throw new Error(session.row.limitation ?? "This browser cannot be viewed safely.");
    await this.verify(session);
    const endpoint = await readCdpEndpoint(session.endpoint);
    await this.verify(session);
    return endpoint;
  }
}
