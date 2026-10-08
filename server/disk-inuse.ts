import { execFile } from "node:child_process";
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

export interface SnapshotProcess { pid: number; argv: string[]; cwd: string | null }
export interface HostSnapshot { processes: SnapshotProcess[]; open: string[]; complete: boolean; why: string | null }

export interface SnapshotDeps {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  run(file: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  /** Is this PID still running? (kill 0; ESRCH = gone.) */
  alive?(pid: number): boolean;
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
export function parseLsof(text: string): { cwd: Map<number, string>; open: string[] } {
  const cwd = new Map<number, string>();
  const open: string[] = [];
  let pid: number | null = null, fd = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); fd = ""; }
    else if (line.startsWith("f")) fd = line.slice(1);
    else if (line.startsWith("n/")) {
      const path = line.slice(1).replace(/ \((deleted|stat: .*)\)$/, "");
      open.push(path);
      if (fd === "cwd" && pid !== null) cwd.set(pid, path);
    }
  }
  return { cwd, open };
}

/** `ps -axo pid=,uid=,stat=,command=` rows for one user. Lossy argv (space-split), which is enough to spot a build or an install. */
export function parsePs(text: string, uid: number): Array<{ pid: number; argv: string[]; zombie: boolean }> {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === uid ? [{ pid: Number(match[1]), argv: match[4]!.trim().split(/\s+/), zombie: match[3]!.startsWith("Z") }] : [];
  });
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
      deps.run("ps", ["-axo", "pid=,uid=,stat=,command="]).catch(() => ({ code: null, stdout: "" })),
      deps.run("lsof", ["-nP", "-w", "-Fpfn", "-u", String(uid)]).catch(() => ({ code: null, stdout: "" })),
    ]);
    if (ps.code !== 0) return incomplete("The process list (ps) couldn't be read completely.");
    if (lsof.code !== 0) return incomplete("What's open (lsof) couldn't be read completely.");
    const files = parseLsof(lsof.stdout);
    const seen = lsofPids(lsof.stdout);
    const rows = parsePs(ps.stdout, uid);
    const alive = deps.alive ?? isAlive;
    // A live process of this user that lsof said nothing about: Hosts can't tell what it has open.
    const unseen = rows.find((row) => !row.zombie && !seen.has(row.pid) && alive(row.pid));
    if (unseen) return incomplete(`What one of your processes (PID ${unseen.pid}) has open couldn't be read.`);
    return { processes: rows.filter((row) => !row.zombie).map((row) => ({ pid: row.pid, argv: row.argv, cwd: files.cwd.get(row.pid) ?? null })), open: files.open, complete: true, why: null };
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
    processes.push({ pid: Number(pid), argv: cmdline.split("\0").filter(Boolean), cwd });
    open.push(cwd);
    for (const fd of fds) {
      try { const target = await deps.readlink(`/proc/${pid}/fd/${fd}`); if (target.startsWith("/")) open.push(clean(target)); }
      catch (error) { if (!gone(error)) fail(); }
    }
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
 * Why a process in a workspace stops Hosts clearing anything there, or null
 * only for an idle interactive shell (bash, zsh… with no -c script). Anything
 * else in the workspace (an install, a build, a test, a dev server, a package
 * manager running a script, an agent, an editor, something Hosts doesn't
 * know) counts as using it.
 */
export function busyInWorkspace(argv: readonly string[], classify: (argv: string[]) => string | null): string | null {
  const words = titleArgv(argv);
  if (!words.length) return "a process Hosts can't identify";
  const first = base(words[0]);
  if (SHELLS.test(first) && !words.slice(1).some((word) => word === "-c" || word.startsWith("-c"))) return null;
  const tool = words.slice(0, 6).map((word) => base(word).replace(/^(npm|npx)-cli(\.js)?$/, "$1")).find((word) => PACKAGE_TOOLS.test(word));
  if (tool) return `${tool} ${words.slice(1).find((word) => !word.startsWith("-") && !word.includes("/")) ?? ""}`.trim();
  return classify(words) ?? first ?? "a running program";
}
