import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createConnection } from "node:net";
import { parseCmdline, parseProcPidStat, parseProcStatus } from "../linux";
import { hashArgv } from "../redaction";
import { parseMacExecutables } from "../process-tags";
import { browserDataRoot, ownedMetadata, readPrivateFile, type UpgradeBinding } from "./browser-upgrade-receipt";
import { resolveSupervisorPaths } from "./supervisor-paths";

export type BoundProcess = UpgradeBinding["owner"];
export interface UpgradeProcess extends BoundProcess { ppid: number; command: string; }
export type UpgradeExec = (file: string, args: readonly string[], timeoutMs?: number) => string;
const HASH = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const RUNTIME = /^\.runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Shipped 0.21.x provenance pins (scripts/browser/artifacts.mjs). No downloads.
const LEGACY_ARTIFACTS: Record<string, { node: string; chrome: string; chromePlatform: string }> = {
  "darwin-arm64": { node: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8", chrome: "529a71bd61aaa2ef266a4d4bd300ae9572ba6a3468a8d55c3023ffeffb5b6b4e", chromePlatform: "mac-arm64" },
  "linux-x64": { node: "855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec", chrome: "55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea", chromePlatform: "linux64" },
};
const REFUSALS = {
  unsupported: "Automatic browser runtime restart supports macOS arm64 and Linux x64 only. No signal was sent. Restart this host's container or computer to release its previous runtime.",
  overlap: "An orphaned or unverified plugin process may overlap the browser restart. No signal was sent. Resolve that process before inspecting again, or restart this host's container or computer.",
  custom: "Custom browser executable paths require manual review. No signal was sent. Restart this host's container or computer to release its previous runtime.",
} as const;
export class BrowserUpgradeRefusal extends Error {
  constructor(reason: keyof typeof REFUSALS) { super(REFUSALS[reason]); }
}
const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
function within(deadline: number): void { if (Date.now() > deadline) throw new Error("Browser restart observation deadline exceeded"); }
export const upgradeExec: UpgradeExec = (file, args, timeoutMs = 5000) => {
  const result = spawnSync(file, [...args], { timeout: Math.max(1, Math.min(5000, Math.floor(timeoutMs))), maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8", env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.stderr?.trim() || (result.status !== 0 && !(result.status === 1 && file === "/bin/ps" && args.includes("-p") && !result.stdout?.trim()))) throw new Error("Browser restart process visibility is unavailable");
  return result.stdout ?? "";
};

/** Strict parser: a truncated or hidden row is not an absence proof. Never emit commands. */
export function parseUpgradeProcesses(text: string): Array<{ pid: number; ppid: number; uid: number; birth: string; command: string }> {
  const lines = text.split("\n").filter(line => line.trim());
  if (!lines.length || lines.length > 4096) throw new Error("Browser restart process census is incomplete");
  const rows = lines.map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+((?:\S+\s+){4}\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Browser restart process census is incomplete");
    return { pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), birth: match[4]!, command: match[5]! };
  });
  if (new Set(rows.map(row => row.pid)).size !== rows.length) throw new Error("Browser restart process census is ambiguous");
  return rows;
}

function bound(row: UpgradeProcess): BoundProcess {
  return { pid: row.pid, uid: row.uid, birth: row.birth, argvHash: row.argvHash, executable: row.executable };
}
export function sameBoundProcess(a: BoundProcess, b: BoundProcess): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.birth === b.birth && a.argvHash === b.argvHash && a.executable === b.executable;
}

export function ownedUnixListenerInode(text: string, socket: string): string {
  const rows = text.split("\n").slice(1).map(row => row.trim().split(/\s+/)).filter(row => row[7] === socket);
  if (rows.length !== 1 || rows[0]![3] !== "00010000" || rows[0]![4] !== "0001" || rows[0]![5] !== "01" || !/^\d+$/.test(rows[0]![6]!)) throw new Error("Previous browser listener is unverified");
  return rows[0]![6]!;
}

/** Synchronous final identity read: no async work between this return and SIGTERM. */
export function readUpgradeProcess(pid: number, platform = process.platform, exec = upgradeExec): UpgradeProcess | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Browser restart PID is invalid");
  if (platform === "linux") {
    try {
      const base = `/proc/${pid}`;
      const first = parseProcPidStat(readFileSync(join(base, "stat"), "utf8"));
      const status = parseProcStatus(readFileSync(join(base, "status"), "utf8"));
      const executable = readlinkSync(join(base, "exe"));
      const argv = parseCmdline(readFileSync(join(base, "cmdline")));
      const final = parseProcPidStat(readFileSync(join(base, "stat"), "utf8"));
      const finalArgv = parseCmdline(readFileSync(join(base, "cmdline")));
      if (first.startTicks !== final.startTicks || hashArgv(argv) !== hashArgv(finalArgv) || executable !== readlinkSync(join(base, "exe")) || status.uid !== parseProcStatus(readFileSync(join(base, "status"), "utf8")).uid) throw new Error("Browser process changed during identity read");
      if (["Z", "X"].includes(final.state)) return null;
      if (!argv.length) throw new Error("Browser process arguments are unavailable");
      return { pid, ppid: final.ppid, uid: status.uid, birth: String(final.startTicks), executable, argvHash: hashArgv(argv), command: argv.join(" ") };
    } catch (error) { if (gone(error)) return null; throw new Error("Browser process identity is unverified"); }
  }
  if (platform !== "darwin") throw new Error("Browser runtime restart supports macOS and Linux only");
  const read = () => {
    const output = exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "pid=,ppid=,uid=,state=,lstart=,command="]);
    return output.trim() ? parseUpgradeProcesses(output).find(row => row.pid === pid) : null;
  };
  const first = read();
  if (!first) return null;
  const executableIdentity = () => {
    const comm = exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="]).trim();
    const executable = comm.startsWith("/") ? comm : parseMacExecutables(exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fpn"])).get(pid);
    return { comm, executable };
  };
  const before = executableIdentity();
  const final = read();
  if (!final) return null;
  const after = executableIdentity();
  if (!before.executable || before.executable !== after.executable || before.comm !== after.comm || first.birth !== final.birth || first.uid !== final.uid || first.command !== final.command) throw new Error("Browser process changed during identity read");
  return { ...final, executable: before.executable, argvHash: hashArgv(final.command.split(" ")) };
}

function hashAsset(home: string, file: string, executable = false): string {
  const stat = ownedMetadata(home, file, "file", executable ? 0o700 : 0o600);
  if (stat.size > 256 * 1024 * 1024) throw new Error("Browser asset exceeds verification bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  try {
    const first = fstatSync(fd);
    if (first.ino !== stat.ino || first.dev !== stat.dev) throw new Error("Browser asset changed");
    const deadline = Date.now() + 5000;
    for (let offset = 0; offset < first.size;) {
      if (Date.now() > deadline) throw new Error("Browser asset verification timed out");
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, first.size - offset), offset);
      if (!n) throw new Error("Browser asset changed");
      hash.update(buffer.subarray(0, n)); offset += n;
    }
    const last = fstatSync(fd);
    if (last.size !== first.size || last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs) throw new Error("Browser asset changed");
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function profileDirectories(home: string): UpgradeBinding["profiles"] {
  const root = join(browserDataRoot(home), "profiles"), rows: UpgradeBinding["profiles"] = [];
  const record = (file: string) => {
    const s = ownedMetadata(home, file, "directory");
    rows.push({ path: relative(root, file), dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode & 0o777 });
  };
  try { record(root); } catch (error) { if (gone(error)) return rows; throw error; }
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length >= 10000) throw new Error("Saved profile inventory exceeds verification bound");
  // Each top-level folder is one saved workspace profile. Chrome owns its inner
  // cache/database lifecycle; do not mistake normal flushes or cache removal for deletion.
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Saved profile ownership is unverified");
    if (entry.isDirectory()) record(join(root, entry.name));
  }
  return rows;
}

export interface BrowserUpgradeIdentityOptions {
  home: string; platform?: NodeJS.Platform; arch?: string; exec?: UpgradeExec;
  readProcess?: (pid: number) => UpgradeProcess | null; uid?: number; pluginPid?: number;
}
export class BrowserUpgradeIdentity {
  readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly exec: UpgradeExec;
  private readonly readProcess: (pid: number) => UpgradeProcess | null;
  private readonly uid: number;
  private readonly pluginPid: number;
  private deadline = Infinity;
  constructor(options: BrowserUpgradeIdentityOptions) {
    this.home = resolve(options.home); this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    const exec = options.exec ?? upgradeExec;
    this.exec = (file, args) => { within(this.deadline); const result = exec(file, args, Math.min(5000, this.deadline - Date.now())); within(this.deadline); return result; };
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.pluginPid = options.pluginPid ?? process.pid;
    this.readProcess = options.readProcess ?? (pid => readUpgradeProcess(pid, this.platform, this.exec));
  }
  private bounded<T>(read: () => T, deadline = Infinity): T {
    const previous = this.deadline;
    this.deadline = Math.min(previous, deadline, Date.now() + 30_000);
    try { within(this.deadline); const result = read(); within(this.deadline); return result; }
    finally { this.deadline = previous; }
  }
  private census() {
    if (!["linux", "darwin"].includes(this.platform) || this.uid < 0) throw new Error("Browser runtime restart is unsupported on this platform");
    return parseUpgradeProcesses(this.exec("/bin/ps", ["-ww", "-axo", "pid=,ppid=,uid=,state=,lstart=,command="]));
  }
  private assertActivation() {
    const deadline = Date.now() + 20_000;
    const plugin = this.readProcess(this.pluginPid);
    within(deadline);
    if (!plugin || plugin.uid !== this.uid || !plugin.command.endsWith("/plugin-process.js")) throw new Error("Current plugin process identity is unverified");
    const worker = this.readProcess(plugin.ppid);
    within(deadline);
    if (!worker || worker.uid !== this.uid) throw new Error("Current daemon identity is unverified");
    const rows = this.census();
    within(deadline);
    // Official activation awaits the old child's close. Live siblings are other
    // plugin IDs; other live workers have their own private home. Only an orphan
    // or unobservable parent is ambiguous. Re-read the child around its parent.
    for (const row of rows) {
      if (row.pid === plugin.pid || row.uid !== this.uid || !row.command.endsWith("/plugin-process.js")) continue;
      const child = this.readProcess(row.pid); within(deadline);
      if (!child || child.uid !== this.uid || child.ppid !== row.ppid || child.command !== row.command || child.ppid <= 1) throw new BrowserUpgradeRefusal("overlap");
      const parent = child.ppid === worker.pid ? worker : this.readProcess(child.ppid); within(deadline);
      if (!parent || parent.uid !== child.uid) throw new BrowserUpgradeRefusal("overlap");
      const finalChild = this.readProcess(child.pid); within(deadline);
      if (!finalChild || !sameBoundProcess(child, finalChild) || finalChild.ppid !== parent.pid) throw new BrowserUpgradeRefusal("overlap");
    }
    return { plugin, worker, rows };
  }
  private assets(runtime: string) {
    const root = browserDataRoot(this.home);
    if (!RUNTIME.test(relative(root, runtime))) throw new Error("Previous browser runtime is not immutable private assets");
    ownedMetadata(this.home, runtime, "directory", 0o700);
    const provenance = JSON.parse(readPrivateFile(this.home, join(runtime, "provenance.json")).toString("utf8"));
    const target = `${this.platform}-${this.arch}`, pins = LEGACY_ARTIFACTS[target];
    if (!pins || provenance.reference !== "daed6eb12f4156ca392f71c48e7a9ccca231ae8c" || provenance.node !== "24.20.0" || provenance.agentBrowser !== "0.38.2" || provenance.chrome !== "155.0.8059.39" || provenance.chromeRevision !== "1697595" || provenance.target !== target || provenance.nodeSha256 !== pins.node || provenance.chromeSha256 !== pins.chrome || provenance.nodeUrl !== `https://nodejs.org/dist/v24.20.0/node-v24.20.0-${target}.tar.gz` || provenance.chromeUrl !== `https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/${pins.chromePlatform}/chrome-${pins.chromePlatform}.zip`) throw new Error("Previous browser provenance is unsupported");
    return { node: hashAsset(this.home, join(runtime, "node/bin/node"), true), supervisor: hashAsset(this.home, join(runtime, "supervisor.cjs")), provenance: HASH(JSON.stringify(provenance)) };
  }
  private assertSocket(pid: number): void {
    const paths = resolveSupervisorPaths(this.home, 2), stat = lstatSync(paths.socket);
    if (!stat.isSocket() || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o600) throw new Error("Previous browser socket identity is unverified");
    if (this.platform === "darwin") {
      const output = this.exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-U", "-Fpn"]);
      if (!output.split("\n").includes(`p${pid}`) || !output.split("\n").includes(`n${paths.socket}`)) throw new Error("Previous browser socket owner is unverified");
    } else {
      const inode = ownedUnixListenerInode(readFileSync("/proc/net/unix", "utf8"), paths.socket);
      const fds = readdirSync(`/proc/${pid}/fd`);
      if (fds.length > 16384 || !fds.some(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`; } catch (error) { if (gone(error)) return false; throw error; } })) throw new Error("Previous browser socket owner is unverified");
    }
  }
  private relevant(command: string, runtime: string): boolean {
    // Old MCPs only connect; they cannot claim a bridge or launch an owner.
    const root = browserDataRoot(this.home);
    const mcp = /^(.+)\/node\/bin\/node (.+)\/hosts-browser-mcp\.cjs$/.exec(command);
    if (mcp && mcp[1] === mcp[2] && RUNTIME.test(relative(root, mcp[1]!))) return false;
    const ipc = `/tmp/paseo-hosts-browser-${HASH(root).slice(0, 16)}`;
    return command.includes(root + "/") || command.includes(ipc) || (/\bXvfb\b/.test(command) && command.includes("paseo-browser-display-"));
  }
  private browserRows(rows: ReturnType<typeof parseUpgradeProcesses>, runtime: string) {
    const root = browserDataRoot(this.home), deadline = Date.now() + 20_000;
    const result: typeof rows = [];
    let examined = 0;
    for (const row of rows) {
      if (this.relevant(row.command, runtime)) {
        if (row.uid !== this.uid) throw new Error("Browser process ownership is unverified");
        result.push(row); continue;
      }
      // Native helpers may rewrite argv. Resolve only browser-shaped candidates,
      // then bind their executable; an unreadable candidate is not ignored.
      if (row.uid === this.uid && /chrome|chromium|agent-browser|native-video/i.test(row.command) && !row.command.endsWith("/hosts-browser-mcp.cjs")) {
        if (++examined > 128) throw new Error("Browser process census exceeds verification bound");
        const identity = this.readProcess(row.pid); within(deadline);
        if (!identity) throw new Error("Browser process census changed during observation");
        if (identity.executable.startsWith(root + "/")) result.push(row);
      }
    }
    return result;
  }
  observe(): { binding: UpgradeBinding; activeBrowserProcesses: number } {
    return this.bounded(() => this.observeWithinBudget());
  }
  private observeWithinBudget(): { binding: UpgradeBinding; activeBrowserProcesses: number } {
    const deadline = Date.now() + 30_000;
    if (!LEGACY_ARTIFACTS[`${this.platform}-${this.arch}`]) throw new BrowserUpgradeRefusal("unsupported");
    if (process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY || process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE) throw new BrowserUpgradeRefusal("custom");
    ownedMetadata(this.home, browserDataRoot(this.home), "directory", 0o700);
    const { plugin, worker, rows } = this.assertActivation(), paths = resolveSupervisorPaths(this.home, 2);
    within(deadline);
    ownedMetadata(this.home, paths.root, "directory", 0o700);
    ownedMetadata(this.home, paths.lock, "directory", 0o700);
    const pidText = readPrivateFile(this.home, join(paths.lock, "pid"), 32).toString("utf8").trim();
    if (!/^[1-9]\d*$/.test(pidText)) throw new Error("Previous browser lock identity is invalid");
    const owner = this.readProcess(Number(pidText));
    if (!owner || owner.uid !== this.uid) throw new Error("Previous browser owner is unverified");
    const root = browserDataRoot(this.home);
    const entries = readdirSync(root);
    if (entries.length > 128) throw new Error("Private browser inventory exceeds verification bound");
    const runtimes = entries.filter(name => RUNTIME.test(name));
    const matches = runtimes.map(name => join(root, name)).filter(runtime => owner.command === `${join(runtime, "node/bin/node")} ${join(runtime, "supervisor.cjs")}` && owner.executable === join(runtime, "node/bin/node"));
    if (matches.length !== 1) throw new Error("Previous browser executable and bundle identity are unverified");
    if (rows.some(row => row.pid !== owner.pid && row.command.includes(root + "/") && row.command.endsWith("/supervisor.cjs"))) throw new Error("Another browser coordinator overlaps the previous runtime");
    if (![1, worker.ppid].includes(owner.ppid)) throw new Error("Previous browser owner is not independently reparented");
    const endpointBytes = readPrivateFile(this.home, paths.endpoint, 4096);
    const endpoint = JSON.parse(endpointBytes.toString("utf8"));
    if (Object.keys(endpoint).sort().join(",") !== "socket,version" || endpoint.version !== 2 || endpoint.socket !== paths.socket) throw new Error("Previous browser endpoint identity is invalid");
    ownedMetadata(this.home, paths.token, "file", 0o600); // Never read or use its secret value.
    this.assertSocket(owner.pid);
    const runtime = matches[0]!, assetHashes = this.assets(runtime), profiles = profileDirectories(this.home);
    within(deadline);
    const childIds = new Set([owner.pid]);
    for (let n = 0; n < rows.length; n++) { const before = childIds.size; for (const row of rows) if (childIds.has(row.ppid)) childIds.add(row.pid); if (before === childIds.size) break; }
    const descendants: BoundProcess[] = [];
    for (const row of rows) if (row.pid !== owner.pid && childIds.has(row.pid)) {
      if (descendants.length >= 128) throw new Error("Browser descendant inventory exceeds verification bound");
      const identity = this.readProcess(row.pid);
      within(deadline);
      if (!identity || identity.uid !== this.uid) throw new Error("Previous browser descendant identity is unavailable");
      descendants.push(bound(identity));
    }
    const binding: UpgradeBinding = { owner: bound(owner), plugin: bound(plugin), worker: bound(worker), runtime,
      homeHash: HASH(this.home), endpointHash: HASH(endpointBytes), assetHashes, profiles, descendants };
    this.assertFinal(binding);
    within(deadline);
    return { binding, activeBrowserProcesses: this.browserRows(rows, runtime).filter(row => row.pid !== owner.pid).length };
  }
  assertFinal(binding: UpgradeBinding): void {
    return this.bounded(() => this.assertFinalWithinBudget(binding));
  }
  private assertFinalWithinBudget(binding: UpgradeBinding): void {
    const deadline = Date.now() + 30_000;
    const { plugin, worker, rows } = this.assertActivation();
    if (!sameBoundProcess(plugin, binding.plugin) || !sameBoundProcess(worker, binding.worker)) throw new Error("Daemon or plugin identity changed");
    if (rows.some(row => row.pid !== binding.owner.pid && row.command.includes(browserDataRoot(this.home) + "/") && row.command.endsWith("/supervisor.cjs"))) throw new Error("Another browser coordinator overlaps the previous runtime");
    const paths = resolveSupervisorPaths(this.home, 2);
    if (Number(readPrivateFile(this.home, join(paths.lock, "pid"), 32).toString("utf8").trim()) !== binding.owner.pid || HASH(readPrivateFile(this.home, paths.endpoint, 4096)) !== binding.endpointHash) throw new Error("Previous browser private identity changed");
    this.assertSocket(binding.owner.pid);
    within(deadline);
    const owner = this.readProcess(binding.owner.pid);
    within(deadline);
    if (!owner || !sameBoundProcess(owner, binding.owner) || ![1, worker.ppid].includes(owner.ppid)) throw new Error("Previous browser process identity changed");
  }
  async assertListenerLive(): Promise<void> {
    const socketPath = resolveSupervisorPaths(this.home, 2).socket;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const finish = (ok: boolean) => {
        clearTimeout(timer); socket.removeAllListeners(); socket.destroy();
        if (ok) resolve(); else reject(new Error("Previous browser listener is unavailable"));
      };
      const timer = setTimeout(() => finish(false), 250);
      socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    });
  }
  verifyStopped(binding: UpgradeBinding, deadline?: number, requireOriginalActor = true): boolean {
    return this.bounded(() => this.verifyStoppedWithinBudget(binding, requireOriginalActor), deadline);
  }
  private verifyStoppedWithinBudget(binding: UpgradeBinding, requireOriginalActor: boolean): boolean {
    const deadline = Date.now() + 30_000;
    if (binding.homeHash !== HASH(this.home)) throw new Error("Browser restart receipt belongs to another home");
    const owner = this.readProcess(binding.owner.pid);
    if (owner && owner.birth === binding.owner.birth) return false;
    within(deadline);
    for (const old of binding.descendants) { const now = this.readProcess(old.pid); within(deadline); if (now && now.birth === old.birth) return false; }
    const { plugin, worker, rows } = this.assertActivation();
    if (requireOriginalActor && (!sameBoundProcess(plugin, binding.plugin) || !sameBoundProcess(worker, binding.worker))) throw new Error("Daemon or plugin identity changed during shutdown verification");
    if (this.browserRows(rows, binding.runtime).length) return false;
    const paths = resolveSupervisorPaths(this.home, 2);
    try { lstatSync(paths.socket); return false; } catch (error) { if (!gone(error)) throw error; }
    const assets = this.assets(binding.runtime);
    if (JSON.stringify(assets) !== JSON.stringify(binding.assetHashes)) throw new Error("Previous immutable browser assets changed");
    const profiles = profileDirectories(this.home);
    within(deadline);
    for (const before of binding.profiles) if (!profiles.some(after => JSON.stringify(after) === JSON.stringify(before))) throw new Error("Saved browser profile directories changed or disappeared");
    return true;
  }
}
