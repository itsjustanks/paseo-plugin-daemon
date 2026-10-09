import { execFile } from "node:child_process";
import { normalize, resolve } from "node:path";
import { readdir, readFile, readlink } from "node:fs/promises";
import { mapLimit } from "./platform";

/**
 * One look at this user's processes for clearing (0.16.0, ported from the
 * reviewed 0.14 cleanup branch and tightened after its third review): what
 * runs (argv), where (cwd) and what it has open, read in a single pass that is
 * either COMPLETE or refuses. Clearing and cache commands need a complete
 * snapshot; anything less is "can't tell", and nothing runs. It doesn't use
 * the monitor's process reader, which skips what it can't read and caps the
 * list for display.
 *
 *  - Linux, /proc: a process is skipped only when /proc/<pid>/status shows a
 *    different user (real and effective uid). For this user's processes the
 *    command line, working directory and every fd must be readable; one that
 *    exited meanwhile is fine. No cap.
 *  - macOS: `ps -axo pid=,uid=,stat=,command=` for what runs and one
 *    `lsof -Fpfn -u <uid>` for each process's cwd and open files. Any error,
 *    timeout or nonzero exit, even with partial output, makes it incomplete;
 *    so does a listed process of this user with no lsof record that is still
 *    alive and not a zombie (0.16.0: no record means "can't tell", not "uses
 *    nothing").
 */

/**
 * `ppid`: its parent, so an "idle" shell with a child at work is seen as busy.
 * `stdin`: what fd 0 is: a terminal ("tty"), a file or a pipe (a shell reading
 * a script: `bash < build.sh`), nothing, or something else; null when unknown.
 */
export type StdinKind = "tty" | "file" | "pipe" | "none" | "other";
export interface SnapshotProcess { pid: number; ppid: number | null; argv: string[]; cwd: string | null; stdin?: StdinKind | null }

/** Linux: what /proc/<pid>/fd/0 points at. */
export function stdinFromLink(target: string | null): StdinKind {
  if (target === null) return "none";
  if (/^\/dev\/(pts\/|tty)/.test(target)) return "tty";
  if (target.startsWith("pipe:")) return "pipe";
  if (target.startsWith("/")) return "file";
  return "other";
}
export interface HostSnapshot { processes: SnapshotProcess[]; open: string[]; complete: boolean; why: string | null }

export interface SnapshotDeps {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  run(file: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  /** Is this PID still running? (kill 0; ESRCH = gone.) */
  alive?(pid: number): boolean;
  /** macOS: this PID's start time now ("ps -o lstart= -p"), or null when it's gone. */
  startOf?(pid: number): Promise<string | null>;
}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

const realDeps: SnapshotDeps = {
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
  readFile: (path) => readFile(path, "utf8"),
  run: (file, args) => new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin", LC_ALL: "C" } }, (error, stdout) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? "") });
    });
  }),
};

/** `/proc/<pid>/status` → its real and effective uid, or null when the line isn't there. */
export function statusUids(text: string): number[] | null {
  const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** `lsof -Fpfn`: per process, its cwd (`fcwd`) and every absolute path it has open. */
export function parseLsof(text: string): { cwd: Map<number, string>; open: string[]; stdin: Map<number, StdinKind> } {
  const cwd = new Map<number, string>();
  const open: string[] = [];
  const stdin = new Map<number, StdinKind>();
  let pid: number | null = null, fd = "", type = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); fd = ""; type = ""; }
    else if (line.startsWith("f")) { fd = line.slice(1); type = ""; }
    else if (line.startsWith("t")) {
      type = line.slice(1);
      // fd 0: a terminal (CHR on a tty device, settled by its name below), a pipe, a file, or something else.
      if (fd === "0" && pid !== null) stdin.set(pid, type === "PIPE" || type === "FIFO" ? "pipe" : type === "REG" ? "file" : type === "CHR" ? "other" : "other");
    } else if (line.startsWith("n")) {
      const name = line.slice(1);
      if (fd === "0" && pid !== null && type === "CHR") stdin.set(pid, /^\/dev\/(ttys?\d|pts\/|tty)/.test(name) ? "tty" : "other");
      if (!name.startsWith("/")) continue;
      const path = name.replace(/ \((deleted|stat: .*)\)$/, "");
      open.push(path);
      if (fd === "cwd" && pid !== null) cwd.set(pid, path);
    }
  }
  return { cwd, open, stdin };
}

/**
 * `ps -axo pid=,ppid=,uid=,stat=,lstart=,command=` rows for one user. Lossy
 * argv (space-split), which is enough to spot a build or an install; `start`
 * is ps's start time ("Thu Oct  8 17:01:23 2026"), so a reused PID is told apart.
 */
export function parsePs(text: string, uid: number): Array<{ pid: number; ppid: number; argv: string[]; zombie: boolean; start: string }> {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    return match && Number(match[3]) === uid ? [{ pid: Number(match[1]), ppid: Number(match[2]), argv: match[6]!.trim().split(/\s+/), zombie: match[4]!.startsWith("Z"), start: match[5]!.replace(/\s+/g, " ") }] : [];
  });
}

/** `/proc/<pid>/status` → its parent PID, or null. */
export function statusPpid(text: string): number | null {
  const match = /^PPid:\s+(\d+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** Which PIDs lsof said anything about (a `p<pid>` line). */
export function lsofPids(text: string): Set<number> {
  const pids = new Set<number>();
  for (const line of text.split("\n")) if (/^p\d+$/.test(line)) pids.add(Number(line.slice(1)));
  return pids;
}

const gone = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "");
const clean = (path: string) => path.replace(/ \(deleted\)$/, "");

export async function hostSnapshot(platform: "linux" | "darwin", uid: number, deps: SnapshotDeps = realDeps): Promise<HostSnapshot> {
  const incomplete = (why: string): HostSnapshot => ({ processes: [], open: [], complete: false, why });
  if (platform === "darwin") {
    const [ps, lsof] = await Promise.all([
      deps.run("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart=,command="]).catch(() => ({ code: null, stdout: "" })),
      deps.run("lsof", ["-nP", "-w", "-Fpftn", "-u", String(uid)]).catch(() => ({ code: null, stdout: "" })),
    ]);
    if (ps.code !== 0) return incomplete("The process list (ps) couldn't be read completely.");
    if (lsof.code !== 0) return incomplete("What's open (lsof) couldn't be read completely.");
    const files = parseLsof(lsof.stdout);
    const seen = lsofPids(lsof.stdout);
    const rows = parsePs(ps.stdout, uid);
    const alive = deps.alive ?? isAlive;
    // Both ways. A ps row lsof said nothing about: if that process has exited, or its PID now belongs to a
    // process that started later, it's dropped; a live one with the same start time is unexplained, so the
    // picture is incomplete. A live process lsof saw that ps didn't list is unexplained too.
    const startOf = deps.startOf ?? (async (pid: number) => { const out = await deps.run("ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => ({ code: null, stdout: "" })); return out.code === 0 && out.stdout.trim() ? out.stdout.trim().replace(/\s+/g, " ") : null; });
    const kept: typeof rows = [];
    for (const row of rows) {
      if (row.zombie) continue;
      if (seen.has(row.pid)) { kept.push(row); continue; }
      if (!alive(row.pid)) continue;
      const now = await startOf(row.pid);
      if (now === null || now !== row.start) continue;
      return incomplete(`What one of your processes (PID ${row.pid}) has open couldn't be read.`);
    }
    const listed = new Set(rows.map((row) => row.pid));
    const unlisted = [...seen].find((pid) => !listed.has(pid) && alive(pid));
    if (unlisted !== undefined) return incomplete(`One of your processes (PID ${unlisted}) started while Hosts was looking, so the picture isn't complete.`);
    return { processes: kept.map((row) => ({ pid: row.pid, ppid: row.ppid, argv: row.argv, cwd: files.cwd.get(row.pid) ?? null, stdin: files.stdin.get(row.pid) ?? "none" })), open: files.open, complete: true, why: null };
  }
  let pids: string[];
  try { pids = (await deps.readdir("/proc")).filter((entry) => /^\d+$/.test(entry)); } catch { return incomplete("/proc couldn't be read."); }
  const processes: SnapshotProcess[] = [];
  const open: string[] = [];
  let why: string | null = null;
  const fail = () => { why ??= "Some of this user's processes couldn't be read completely."; };
  await mapLimit(pids, 16, async (pid) => {
    let status: string;
    try { status = await deps.readFile(`/proc/${pid}/status`); } catch (error) { if (!gone(error)) fail(); return; }
    const uids = statusUids(status);
    if (!uids) { fail(); return; }
    if (uids.every((id) => id !== uid)) return; // another user's: Hosts never clears anything it holds anyway
    let cmdline: string, cwd: string, fds: string[];
    try {
      cmdline = await deps.readFile(`/proc/${pid}/cmdline`);
      cwd = clean(await deps.readlink(`/proc/${pid}/cwd`));
      fds = await deps.readdir(`/proc/${pid}/fd`);
    } catch (error) { if (!gone(error)) fail(); return; }
    let stdin: StdinKind = "none";
    open.push(cwd);
    for (const fd of fds) {
      try {
        const target = await deps.readlink(`/proc/${pid}/fd/${fd}`);
        if (fd === "0") stdin = stdinFromLink(target);
        if (target.startsWith("/")) open.push(clean(target));
      } catch (error) { if (!gone(error)) fail(); }
    }
    processes.push({ pid: Number(pid), ppid: statusPpid(status), argv: cmdline.split("\0").filter(Boolean), cwd, stdin });
  });
  return why ? incomplete(why) : { processes, open, complete: true, why: null };
}

/** The first open path at or beneath `target`, or null. */
export function usedBeneath(target: string, open: readonly string[]): string | null {
  const prefix = target.endsWith("/") ? target : `${target}/`;
  return open.find((path) => path === target || path.startsWith(prefix)) ?? null;
}

const SHELLS = /^-?(bash|zsh|fish|sh|dash|ksh|tcsh|csh)$/;
const PACKAGE_TOOLS = /^(npm|pnpm|yarn|bun|npx|pnpx|bunx|corepack|node-gyp)$/;
const base = (word: string | undefined) => (word ?? "").split("/").pop() ?? "";

/**
 * argv as the program sees it (0.16.0 review fix): npm, pnpm and yarn rewrite
 * their process title, so /proc's cmdline can be one string such as
 * "npm install" or "npm exec vite". A single argument with spaces is split.
 */
export function titleArgv(argv: readonly string[]): string[] {
  return argv.length === 1 && /\s/.test(argv[0] ?? "") ? argv[0]!.trim().split(/\s+/) : [...argv];
}

/**
 * Why a process in a workspace stops Hosts deleting anything there, or null
 * ONLY for an idle interactive shell (0.16.0 review fix): argv is just the
 * shell's name ("zsh", or "-zsh" for a login shell), with no arguments at
 * all, and (checked by the caller) no child process. A shell with a script,
 * -c, -s, -l or anything else is busy, as is everything else in the
 * workspace (an install, a build, a test, a dev server, a package manager
 * running a script, an agent, an editor, something Hosts doesn't know).
 */
export function busyInWorkspace(argv: readonly string[], classify: (argv: string[]) => string | null): string | null {
  const words = titleArgv(argv);
  if (!words.length) return "a process Hosts can't identify";
  const first = base(words[0]);
  if (words.length === 1 && SHELLS.test(first)) return null;
  if (SHELLS.test(first)) return `a ${first.replace(/^-/, "")} script`;
  const tool = words.slice(0, 6).map((word) => base(word).replace(/^(npm|npx)-cli(\.js)?$/, "$1")).find((word) => PACKAGE_TOOLS.test(word));
  if (tool) return `${tool} ${words.slice(1).find((word) => !word.startsWith("-") && !word.includes("/")) ?? ""}`.trim();
  return classify(words) ?? first ?? "a running program";
}

/**
 * Paths a process names on its command line (second review): every argv
 * token, also split at "=", resolved against its folder. `python3 -m
 * http.server --directory /app/dist` names /app/dist wherever it runs.
 */
export function argvPaths(proc: Pick<SnapshotProcess, "argv" | "cwd">): string[] {
  const out: string[] = [];
  for (const token of titleArgv(proc.argv)) {
    for (const part of token.split("=")) {
      if (!part || part.startsWith("-") && !part.includes("/")) continue;
      if (part.startsWith("/")) out.push(normalize(part));
      else if (proc.cwd && (part.includes("/") || part === "." || part === "..")) out.push(resolve(proc.cwd, part));
    }
  }
  return out;
}

/**
 * Everything that uses `root`, from one snapshot: a process whose folder is
 * there, or whose command line names a path there, unless it's an idle
 * shell (bare argv, no child, stdin a terminal); an idle-looking shell with
 * a child or reading a script; and a process whose folder can't be told.
 */
export function workspaceUsers(snap: Pick<HostSnapshot, "processes">, root: string, classify: (argv: string[]) => string | null): { why: string; unknownFolder: boolean } | null {
  const parents = new Set(snap.processes.map((proc) => proc.ppid).filter((ppid): ppid is number => ppid !== null));
  const base = root.replace(/\/+$/, "");
  const inside = (path: string) => path === base || path.startsWith(`${base}/`);
  for (const proc of snap.processes) {
    const why = busyInWorkspace(proc.argv, classify)
      ?? (parents.has(proc.pid) ? "a shell with something running in it" : null)
      ?? (proc.stdin !== "tty" ? "a shell reading a script, or not attached to a terminal" : null);
    const named = argvPaths(proc).some(inside);
    if (named) return { why: why ?? "a program working on files here", unknownFolder: false };
    if (proc.cwd === null) { if (why) return { why, unknownFolder: true }; continue; }
    if (inside(proc.cwd) && why) return { why, unknownFolder: false };
  }
  return null;
}
