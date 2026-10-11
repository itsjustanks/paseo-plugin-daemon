import { isAgentTool, isInfrastructure } from "./scope";
import { isPaseoInternal, isPluginHost, isTerminalWorker } from "./jobs";
import { hashArgv } from "./redaction";
import { CREDENTIAL_PATTERN, TOP_SOURCE_PATTERN } from "../shared/disk";

/**
 * Housekeeping's decisions, pure (0.18.0): given a process table, the owners
 * Paseo reported and the settings, what to lower, what to close and which
 * cache files to delete. Nothing here reads the system or acts; the caller
 * scans, asks Paseo, and re-runs these same rules on fresh reads right before
 * every effect.
 */

export interface HkProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** Start ticks: the same PID started again reads differently. */
  startId: string;
  /** The real executable (readlink /proc/<pid>/exe), or null when unreadable. */
  exe: string | null;
  comm: string;
  argv: string[];
  ageSeconds: number;
  /** The main thread's nice value. */
  nice: number | null;
  /** PASEO_AGENT_ID from the environment, read only for browser-family processes. */
  agentId: string | null;
  /** AGENT_BROWSER_DAEMON present in the environment (agent-browser's own daemon). */
  browserDaemon: boolean;
  cwd: string | null;
  /** False when another user's paths cannot be read: profile removal cannot prove non-use. */
  pathsKnown?: boolean;
}

/** Only the parts of a process table the plan needs. Rows of other users carry pid/ppid/uid only. */
export interface ProcTable {
  processes: HkProcess[];
  /** Every PID in /proc was read (or had exited). Anything less refuses every close and every profile removal. */
  complete: boolean;
}

export type OwnerKind = "closed" | "archived" | "running" | "idle" | "unknown";
export const isFinished = (kind: OwnerKind | undefined) => kind === "closed" || kind === "archived";

const base = (path: string | null | undefined) => (path ?? "").split("/").pop()!.replace(/ \(deleted\)$/, "");

// ------------------------------------------------------------------ program families

const CHROME_EXE = /^(?:chrome|chromium|chromium-browser|google-chrome|chrome-headless-shell|headless_shell)$/;
const AGENT_BROWSER_EXE = /^agent-browser(?:-linux(?:-musl)?-(?:x64|arm64))?$/;
const HEAVY_EXE = /^(?:node|nodejs|bun|deno|turbo)$/;
export const PROFILE_DIR = /^\/tmp\/agent-browser-chrome-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isChrome = (p: Pick<HkProcess, "exe">) => !!p.exe?.startsWith("/") && CHROME_EXE.test(base(p.exe));
export const isCrashpad = (p: Pick<HkProcess, "exe">) => !!p.exe?.startsWith("/") && base(p.exe) === "chrome_crashpad_handler";
export const isAgentBrowserDaemon = (p: Pick<HkProcess, "exe" | "browserDaemon">) => !!p.exe?.startsWith("/") && AGENT_BROWSER_EXE.test(base(p.exe)) && p.browserDaemon;
export function isSupabaseQuery(p: Pick<HkProcess, "exe" | "argv">): boolean {
  if (!p.exe?.startsWith("/") || base(p.exe) !== "supabase") return false;
  const words = p.argv.slice(1, 8).filter((arg) => !arg.startsWith("-"));
  return words[0] === "db" && words[1] === "query";
}
/** The processes whose environment is worth reading (bounded, same user): only the browser family and supabase. */
export const wantsEnvironment = (p: Pick<HkProcess, "exe" | "argv">) => !!p.exe?.startsWith("/") && (CHROME_EXE.test(base(p.exe)) || base(p.exe) === "chrome_crashpad_handler" || AGENT_BROWSER_EXE.test(base(p.exe)) || base(p.exe) === "supabase");

/**
 * The agent-browser profile a Chrome or crashpad process names: exactly
 * `/tmp/agent-browser-chrome-<uuid>`, wherever it appears in its command line
 * (`--user-data-dir=…`, crashpad's `--database=…/Crashpad`). Null when none;
 * "conflict" when it names two, or carries a look-alike that isn't exact.
 */
export function profileOf(argv: readonly string[]): string | null | "conflict" {
  const found = new Set<string>();
  let fragments = 0, exact = 0;
  for (const arg of argv) {
    fragments += arg.split("agent-browser-chrome-").length - 1;
    for (const match of arg.matchAll(PROFILE_IN_ARG)) { found.add(match[1]!); exact++; }
  }
  if (fragments !== exact || found.size > 1) return "conflict";
  return found.size ? [...found][0]! : null;
}
const PROFILE_IN_ARG = /(?:^|[=\s])(\/tmp\/agent-browser-chrome-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|\/)/g;

/** Paseo itself, a plugin host, terminals, or an agent program: never touched in any way. */
export function protectedProgram(p: Pick<HkProcess, "exe" | "comm" | "argv">): string | null {
  if (!p.exe?.startsWith("/")) return "Its program couldn't be verified";
  const program = { argv: p.argv, comm: p.comm, executable: p.exe };
  if (isPaseoInternal(program) || isPluginHost(program) || isTerminalWorker(program)) return "Part of Paseo";
  if (isAgentTool({ ...program, argv: [p.exe, p.comm, ...p.argv] })) return "An agent program";
  return null;
}

/**
 * A live agent program, plugin host or service above it means its chat (or
 * something else) still owns it. `chain` is its ancestors, nearest first,
 * stopping before PID 1. Paseo's daemon itself may be an ancestor: an orphan
 * is re-parented to it when it is a subreaper.
 */
export function ancestorProblem(chain: readonly HkProcess[], uid: number): string | null {
  for (const current of chain) {
    if (current.uid !== uid || !current.exe) return "Its parent program could not be verified";
    const program = { argv: current.argv, comm: current.comm, executable: current.exe };
    if (isAgentTool({ ...program, argv: [current.exe ?? "", current.comm, ...current.argv] })) return "Its agent program is still running above it";
    if (isPluginHost(program) || isTerminalWorker(program)) return "It runs under part of Paseo";
    if (current.exe && isInfrastructure({ executable: current.exe, argv: current.argv }) && !isAgentBrowserDaemon(current)) return "It runs under a database or system service";
  }
  return null;
}

/** Its ancestors from a table, nearest first, up to (not including) PID 1. Null when the chain breaks or loops. */
export function ancestorsIn(p: HkProcess, byPid: ReadonlyMap<number, HkProcess>): HkProcess[] | null {
  const chain: HkProcess[] = [];
  const seen = new Set<number>([p.pid]);
  let ppid = p.ppid;
  for (let hops = 0; hops < 64; hops++) {
    if (ppid <= 1) return chain;
    if (seen.has(ppid)) return null;
    const parent = byPid.get(ppid);
    if (!parent) return null;
    seen.add(ppid);
    chain.push(parent);
    ppid = parent.ppid;
  }
  return null;
}

function protectedAncestor(p: HkProcess, byPid: ReadonlyMap<number, HkProcess>, uid: number): string | null {
  const chain = ancestorsIn(p, byPid);
  return chain ? ancestorProblem(chain, uid) : "Its parent processes couldn't all be read";
}

// ------------------------------------------------------------------ renice

export const HEAVY_PATTERNS = ["bin/tsc", "type-check-worker", "vitest", "jest", "node --test", "next build", "next dev", "vite build", "vite.js", "turbo ", "eslint", "playwright test", "webpack"] as const;
export const BROWSER_PATTERNS = ["agent-browser-chrome-", "ms-playwright/"] as const;

export interface ReniceTarget { pid: number; startId: string; kind: "heavy" | "browser"; target: number; from: number; name: string }

/** Which family a process is for renice, by executable first, then its command line. */
export function reniceKind(p: Pick<HkProcess, "exe" | "argv">): "heavy" | "browser" | null {
  if (!p.exe?.startsWith("/")) return null;
  const line = p.argv.join(" ");
  if (CHROME_EXE.test(base(p.exe)) && BROWSER_PATTERNS.some((pattern) => line.includes(pattern))) return "browser";
  if (HEAVY_EXE.test(base(p.exe)) && HEAVY_PATTERNS.some((pattern) => line.includes(pattern))) return "heavy";
  return null;
}

export interface ReniceContext { uid: number; protectedPids: ReadonlySet<number>; heavyNice: number; browserNice: number }

/** Same user, matching family, not Paseo or an agent, and only when it would raise the nice value. */
export function planRenice(table: ProcTable, ctx: ReniceContext): ReniceTarget[] {
  const out: ReniceTarget[] = [];
  for (const p of table.processes) {
    if (p.uid !== ctx.uid || p.pid <= 1 || ctx.protectedPids.has(p.pid) || p.nice === null) continue;
    if (protectedProgram(p) || (p.exe && isInfrastructure({ executable: p.exe, argv: p.argv }))) continue;
    const kind = reniceKind(p);
    if (!kind) continue;
    const target = clampNice(kind === "heavy" ? ctx.heavyNice : ctx.browserNice);
    if (p.nice >= target) continue;
    out.push({ pid: p.pid, startId: p.startId, kind, target, from: p.nice, name: displayName(p) });
  }
  return out;
}

export const clampNice = (value: number) => Math.min(19, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
/** Monotonic: the value to set, or null when the current one is already as gentle. */
export const raisedNice = (current: number, target: number): number | null => (current < clampNice(target) ? clampNice(target) : null);

// ------------------------------------------------------------------ reap

export type ReapRole = "chrome" | "crashpad" | "agent-browser" | "supabase-query";

export interface ReapTarget {
  pid: number; startId: string; exe: string; argvHash: string; agentId: string; role: ReapRole;
  /** The Chrome session's profile, when it belongs to one. */
  profile: string | null;
  /** Groups the log line: one per session, daemon or query. */
  group: string;
}

export interface ReapGroup { key: string; what: string; why: string; agentId: string; owner: OwnerKind; profile: string | null; pids: number[] }
export interface KeptNote { what: string; why: string }

export interface ReapContext {
  uid: number;
  protectedPids: ReadonlySet<number>;
  stuckQueryMaxHours: number;
  browserMaxAgeHours: number;
}

export interface ReapPlan { targets: ReapTarget[]; groups: ReapGroup[]; kept: KeptNote[]; profiles: Array<{ path: string; agentId: string }> }

const ownerWords = (kind: OwnerKind | undefined) => kind === "closed" ? "its chat is closed" : kind === "archived" ? "its chat is archived" : kind === "running" ? "its chat is still running" : kind === "idle" ? "its chat is idle" : "Paseo couldn't confirm its chat is finished";
const hours = (seconds: number) => `${Math.floor(seconds / 3600)} h`;

/**
 * What the hourly pass may close. Each member is authorized on its own: same
 * user, its own exact executable family, its own PASEO_AGENT_ID, and that
 * chat closed or archived by Paseo's own answer. Running, idle, unknown, a
 * failed or timed-out lookup, a missing tag, mixed owners, a protected
 * program or a live agent above it all keep it. Age never authorizes.
 */
export function planReap(table: ProcTable, owners: ReadonlyMap<string, OwnerKind>, ctx: ReapContext): ReapPlan {
  const plan: ReapPlan = { targets: [], groups: [], kept: [], profiles: [] };
  if (!table.complete) return plan;
  const byPid = new Map(table.processes.map((p) => [p.pid, p]));
  const mine = table.processes.filter((p) => p.uid === ctx.uid && p.pid > 1 && !ctx.protectedPids.has(p.pid));
  const blocked = (p: HkProcess) => protectedProgram(p) ?? protectedAncestor(p, byPid, ctx.uid);
  const target = (p: HkProcess, role: ReapRole, group: string, profile: string | null): ReapTarget => ({ pid: p.pid, startId: p.startId, exe: p.exe!, argvHash: hashArgv(p.argv), agentId: p.agentId!, role, profile, group });

  // Chrome sessions: the processes naming one exact profile, plus Chrome children whose nearest named Chrome ancestor does.
  const sessionOf = new Map<number, string | "conflict" | null>();
  const resolve = (p: HkProcess, depth = 0): string | "conflict" | null => {
    if (sessionOf.has(p.pid)) return sessionOf.get(p.pid)!;
    let found = profileOf(p.argv);
    if (found === null && depth < 32) {
      const parent = byPid.get(p.ppid);
      found = parent && parent.uid === ctx.uid && (isChrome(parent) || isCrashpad(parent)) ? resolve(parent, depth + 1) : null;
    }
    sessionOf.set(p.pid, found);
    return found;
  };
  const sessions = new Map<string, HkProcess[]>();
  for (const p of mine) {
    if (!isChrome(p) && !isCrashpad(p)) continue;
    const profile = resolve(p);
    if (profile === "conflict") { plan.kept.push({ what: `${displayName(p)} (PID ${p.pid})`, why: "It names more than one browser profile, so it was left alone" }); continue; }
    if (profile) sessions.set(profile, [...(sessions.get(profile) ?? []), p]);
  }
  for (const [profile, members] of sessions) {
    const ids = new Set(members.map((p) => p.agentId));
    const what = `Chrome session (${members.length} process${members.length === 1 ? "" : "es"})`;
    if (ids.has(null) || ids.size !== 1) { plan.kept.push({ what, why: ids.size > 1 ? "Its processes belong to different chats, so it was left alone" : "Some of its processes carry no chat tag, so it was left alone" }); continue; }
    const agentId = [...ids][0]!;
    const owner = owners.get(agentId);
    if (!isFinished(owner)) { plan.kept.push({ what, why: `${ownerWords(owner)}, so it was left alone` }); continue; }
    const reason = members.map(blocked).find(Boolean);
    if (reason) { plan.kept.push({ what, why: `${reason}, so it was left alone` }); continue; }
    const key = `session:${profile}`;
    for (const p of members) plan.targets.push(target(p, isCrashpad(p) ? "crashpad" : "chrome", key, profile));
    plan.groups.push({ key, what, why: `${ownerWords(owner)}`, agentId, owner: owner!, profile, pids: members.map((p) => p.pid) });
    plan.profiles.push({ path: profile, agentId });
  }

  for (const p of mine) {
    const role: ReapRole | null = isAgentBrowserDaemon(p) ? "agent-browser" : isCrashpad(p) && !resolve(p) ? "crashpad" : isSupabaseQuery(p) ? "supabase-query" : null;
    if (!role) continue;
    const owner = p.agentId ? owners.get(p.agentId) : undefined;
    const name = role === "agent-browser" ? "agent-browser daemon" : role === "crashpad" ? "Chrome crash reporter" : "supabase db query";
    const what = `${name} (PID ${p.pid})`;
    if (role === "supabase-query") {
      // Orphaned (parent PID 1) and older than the limit, and its chat finished: stuck. Otherwise it's still someone's.
      if (p.ppid !== 1 || p.ageSeconds < ctx.stuckQueryMaxHours * 3600) continue;
      if (!p.agentId || !isFinished(owner)) { plan.kept.push({ what, why: `Orphaned for ${hours(p.ageSeconds)}, but ${p.agentId ? ownerWords(owner) : "it carries no chat tag"}. Stop it from Processes if it's stuck` }); continue; }
    } else if (!p.agentId || !isFinished(owner)) {
      if (role === "agent-browser" && p.ageSeconds >= ctx.browserMaxAgeHours * 3600 && !mine.some((child) => child.ppid === p.pid && isChrome(child))) {
        plan.kept.push({ what, why: `Running ${hours(p.ageSeconds)} with no browser open, but ${p.agentId ? ownerWords(owner) : "it carries no chat tag"}, so it was left alone` });
      }
      continue;
    }
    const reason = blocked(p);
    if (reason) { plan.kept.push({ what, why: `${reason}, so it was left alone` }); continue; }
    const key = `${role}:${p.pid}:${p.startId}`;
    plan.targets.push(target(p, role, key, null));
    plan.groups.push({ key, what, why: role === "supabase-query" ? `Orphaned for ${hours(p.ageSeconds)} and ${ownerWords(owner)}` : ownerWords(owner), agentId: p.agentId, owner: owner!, profile: null, pids: [p.pid] });
  }
  return plan;
}

/** The same process, unchanged: PID, start, user, executable, command line and chat tag. */
export function sameTarget(fresh: HkProcess | null, planned: Pick<ReapTarget, "pid" | "startId" | "exe" | "argvHash" | "agentId">, uid: number): boolean {
  return !!fresh && fresh.pid === planned.pid && fresh.uid === uid && fresh.startId === planned.startId && fresh.exe === planned.exe && hashArgv(fresh.argv) === planned.argvHash && fresh.agentId === planned.agentId;
}

/**
 * Right before one signal: the fresh process (already matched by
 * `sameTarget`) and its fresh ancestors still make it exactly what was
 * planned: the same family, the same Chrome profile, still orphaned and old
 * for a query, and nothing protected above it.
 */
export function qualifiesNow(fresh: HkProcess, chain: readonly HkProcess[], target: Pick<ReapTarget, "role" | "profile">, ctx: { uid: number; stuckQueryMaxHours: number; verifiedSession?: boolean }): boolean {
  if (protectedProgram(fresh) || ancestorProblem(chain, ctx.uid)) return false;
  const session = (): string | null | "conflict" => {
    const own = profileOf(fresh.argv);
    if (own !== null) return own;
    for (const parent of chain) {
      if (parent.uid !== ctx.uid || !(isChrome(parent) || isCrashpad(parent))) return null;
      const found = profileOf(parent.argv);
      if (found !== null) return found;
    }
    return null;
  };
  switch (target.role) {
    case "chrome": return isChrome(fresh) && target.profile !== null && (session() === target.profile || (ctx.verifiedSession === true && session() === null));
    case "crashpad": return isCrashpad(fresh) && (session() === target.profile || (target.profile !== null && ctx.verifiedSession === true && session() === null));
    case "agent-browser": return isAgentBrowserDaemon(fresh);
    default: return isSupabaseQuery(fresh) && fresh.ppid === 1 && fresh.ageSeconds >= ctx.stuckQueryMaxHours * 3600;
  }
}

/** The planned targets a fresh plan still agrees on, identity for identity. */
export function stillPlanned<T extends Pick<ReapTarget, "pid" | "startId" | "argvHash" | "agentId" | "role">>(earlier: readonly T[], fresh: ReapPlan): T[] {
  const now = new Set(fresh.targets.map((t) => `${t.pid}:${t.startId}:${t.argvHash}:${t.agentId}:${t.role}`));
  return earlier.filter((t) => now.has(`${t.pid}:${t.startId}:${t.argvHash}:${t.agentId}:${t.role}`));
}

/** Any process (of this user) still naming the profile, by its exact path or as a prefix of one. */
export function profileInUse(table: ProcTable, profile: string, boundary?: { uid: number; privateOwned: boolean }): boolean {
  if (!table.complete) return true;
  return table.processes.some((p) => (!boundary?.privateOwned || p.uid === boundary.uid) && (p.pathsKnown === false || p.argv.some((arg) => arg.includes(profile)) || (p.cwd !== null && (p.cwd === profile || p.cwd.startsWith(`${profile}/`)))));
}

// ------------------------------------------------------------------ turbo cache

export interface CacheEntry { name: string; isFile: boolean; isSymlink: boolean; uid: number; nlink: number; mtimeMs: number; size: number }

/** What Turborepo writes in .turbo/cache: `<hash>.tar.zst`, `<hash>.tar.gz`, `<hash>.tar` and `<hash>-meta.json`. */
export const TURBO_ENTRY = /^[0-9a-f]{16,64}(?:-meta\.json|\.tar(?:\.zst|\.gz)?)$/;
const credential = new RegExp(CREDENTIAL_PATTERN, "i");
const source = new RegExp(TOP_SOURCE_PATTERN, "i");

/** Old, regular, single-link files this user owns, named as Turborepo names them. Everything else stays. */
export function planTurbo(entries: readonly CacheEntry[], now: number, maxDays: number, uid: number): { remove: CacheEntry[]; kept: number } {
  const cutoff = now - Math.max(1, maxDays) * 24 * 3600 * 1000;
  const remove = entries.filter((entry) => entry.isFile && !entry.isSymlink && entry.uid === uid && entry.nlink === 1 && TURBO_ENTRY.test(entry.name) && !credential.test(entry.name) && !source.test(entry.name) && entry.mtimeMs < cutoff);
  return { remove, kept: entries.length - remove.length };
}

// ------------------------------------------------------------------ hand-over

export type LockOutcome = { kind: "held" } | { kind: "busy" } | { kind: "missing-flock" } | { kind: "unsafe"; reason: string } | { kind: "failed"; reason: string };

/** Busy means the standalone script (or another daemon of this user) is running a pass: stay passive. */
export function handover(lock: LockOutcome): { run: boolean; state: "live" | "passive" | "blocked"; message: string } {
  switch (lock.kind) {
    case "held": return { run: true, state: "live", message: "" };
    case "busy": return { run: false, state: "passive", message: "Standalone housekeeper active: another housekeeper on this host holds its lock, so Hosts stays passive." };
    case "missing-flock": return { run: false, state: "passive", message: "This host has no flock command, so Hosts can't make sure it's the only housekeeper. Install util-linux to let it run." };
    case "unsafe": return { run: false, state: "blocked", message: `The housekeeper lock isn't safe to use: ${lock.reason}.` };
    default: return { run: false, state: "blocked", message: `The housekeeper lock couldn't be taken: ${lock.reason}.` };
  }
}

export function displayName(p: Pick<HkProcess, "exe" | "comm" | "argv">): string {
  const exe = base(p.exe);
  if (/^(?:node|nodejs|bun|deno)$/.test(exe)) {
    const script = p.argv.slice(1, 6).find((arg) => !arg.startsWith("-"));
    if (script) return base(script).replace(/\.(?:c|m)?js$/, "").slice(0, 60) || exe;
  }
  return (exe || p.comm || "process").slice(0, 60);
}
