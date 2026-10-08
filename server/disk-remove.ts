import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, rename, rmdir } from "node:fs/promises";
import { setPriority } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * How Hosts deletes (0.14.0, reviewed): no hand-written recursive walk.
 *
 *  1. Move the item into a fresh private quarantine folder beside it
 *     (`mkdtemp`, mode 700, owned by this user, same parent so same device).
 *     A rename is atomic: the project never sees a half-deleted folder.
 *  2. Check the moved item is the very inode that was checked, a real folder.
 *  3. Look inside with `find -xdev` (physical: it never follows links) for a
 *     .env file or a .git folder. Any hit, or any error: move it back and refuse.
 *  4. Delete the quarantine folder with the system `rm -rf` and its
 *     stay-on-this-disk flag (`--one-file-system` on GNU, `-x` on macOS),
 *     through execFile with an argv array, `--`, and no shell. rm walks with
 *     fts physically (openat on GNU, verified chdir on BSD), so a folder
 *     swapped for a symlink mid-walk is unlinked as a link, never followed.
 *     A Linux without GNU rm gets no deletes at all.
 * Every child runs at the lowest priority in its own process group, so
 * unloading Hosts can kill it and everything it started.
 */

export interface DeleteResult { ok: boolean; removedBytes: number; leftovers: number; partial: boolean; error?: string }
export interface ChildResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; killed: boolean }

/** Children Hosts started for disk work; `killAll` ends each one's whole process group. */
export class ChildGroup {
  private readonly pids = new Set<number>();
  closed = false;

  /** Spawn at the lowest priority, in its own process group; resolves when it exits. */
  run(file: string, args: readonly string[], options: { timeoutMs: number; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } ): Promise<ChildResult> {
    if (this.closed) return Promise.resolve({ code: null, stdout: "", stderr: "Hosts is unloading.", timedOut: false, killed: true });
    return new Promise((resolve) => {
      let stdout = "", stderr = "", timedOut = false, done = false;
      const child = spawn(file, [...args], { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd, env: options.env ?? { ...process.env, LC_ALL: "C" }, windowsHide: true });
      const finish = (code: number | null, killed: boolean) => {
        if (done) return; done = true; clearTimeout(timer);
        if (child.pid) this.pids.delete(child.pid);
        resolve({ code, stdout, stderr, timedOut, killed });
      };
      const timer = setTimeout(() => { timedOut = true; this.kill(child.pid); }, options.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      if (child.pid) {
        this.pids.add(child.pid);
        lowPriority(child.pid);
      }
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
      child.on("error", (error) => { stderr += error.message; finish(null, false); });
      child.on("close", (code, signal) => finish(code, signal !== null));
      child.stdin?.end(options.input ?? "");
    });
  }

  /** Track a child started elsewhere (the scan worker); returns how to stop tracking it. */
  track(pid: number): () => void {
    this.pids.add(pid);
    if (this.closed) this.kill(pid);
    return () => { this.pids.delete(pid); };
  }

  private kill(pid: number | undefined) {
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* Gone already. */ } }
  }

  /** Stop taking work and kill every running child's process group. */
  killAll(): void {
    this.closed = true;
    for (const pid of this.pids) this.kill(pid);
  }

  get running(): number { return this.pids.size; }
}

export function lowPriority(pid: number): void {
  try { setPriority(pid, 19); } catch { /* Best effort. */ }
  if (process.platform === "linux") {
    const io = spawn("ionice", ["-c", "3", "-p", String(pid)], { stdio: "ignore" });
    io.on("error", () => undefined);
  }
}

export type RmFlavour = "gnu" | "bsd" | null;
let flavour: Promise<RmFlavour> | null = null;
/** Which `rm` this system has: macOS's BSD rm (-x), GNU coreutils (--one-file-system), or neither (no deletes). */
export function rmFlavour(platform: NodeJS.Platform = process.platform): Promise<RmFlavour> {
  if (platform === "darwin") return Promise.resolve("bsd");
  flavour ??= new Promise((resolve) => execFile("rm", ["--version"], { timeout: 5000 }, (error, stdout) => resolve(!error && /GNU coreutils/.test(String(stdout)) ? "gnu" : null)));
  return flavour;
}
export const rmArgs = (kind: Exclude<RmFlavour, null>, path: string) => (kind === "gnu" ? ["-rf", "--one-file-system", "--", path] : ["-rf", "-x", "--", path]);

export interface RemoveDeps {
  group: ChildGroup;
  flavour?: () => Promise<RmFlavour>;
  /** Tests only: runs after the item is quarantined and checked, just before rm. */
  beforeRemove?: (quarantined: string) => Promise<void> | void;
  timeoutMs?: number;
}

/** Quarantine, verify, look for .env/.git, then rm. `expected` is the inode the checks approved. */
export async function quarantineAndRemove(target: string, expected: { dev: number; ino: number; bytes: number }, deps: RemoveDeps): Promise<DeleteResult> {
  const refuse = (error: string): DeleteResult => ({ ok: false, removedBytes: 0, leftovers: 0, partial: false, error });
  const kind = await (deps.flavour ?? rmFlavour)();
  if (!kind) return refuse("This system's rm can't promise to stay on one disk, so Hosts doesn't delete anything here.");
  let quarantine: string;
  try { quarantine = await mkdtemp(join(dirname(target), ".hosts-quarantine-")); } catch { return refuse("It couldn't be moved aside to clear, so it was left."); }
  const q = await lstat(quarantine).catch(() => null);
  if (!q || !q.isDirectory() || q.isSymbolicLink() || q.dev !== expected.dev || (typeof process.getuid === "function" && q.uid !== process.getuid())) {
    await rmdir(quarantine).catch(() => undefined);
    return refuse("It's on a different disk from its folder, so Hosts leaves it.");
  }
  const moved = join(quarantine, basename(target));
  try { await rename(target, moved); } catch { await rmdir(quarantine).catch(() => undefined); return refuse("It couldn't be moved aside to clear, so it was left."); }
  const putBack = async (error: string): Promise<DeleteResult> => {
    try { await rename(moved, target); await rmdir(quarantine); return refuse(error); }
    catch { return refuse(`${error} It couldn't be put back, so it's set aside, untouched, in ${basename(quarantine)} beside where it was.`); }
  };
  const st = await lstat(moved).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory() || st.ino !== expected.ino || st.dev !== expected.dev) return putBack("It changed just before it was cleared, so it was put back.");
  const found = await deps.group.run("find", [moved, "-xdev", "(", "-name", ".git", "-o", "-name", ".env", "-o", "-name", ".env.*", ")", "-print", "-quit"], { timeoutMs: 5 * 60_000 });
  if (found.code !== 0 || found.timedOut || found.killed) return putBack("Hosts couldn't look inside it to be sure, so it was put back.");
  if (found.stdout.trim()) return putBack("It has a .env file or a .git folder inside, so it was put back.");
  await deps.beforeRemove?.(moved);
  const removed = await deps.group.run("rm", rmArgs(kind, quarantine), { timeoutMs: deps.timeoutMs ?? 20 * 60_000 });
  const gone = !(await lstat(quarantine).catch(() => null));
  if (removed.code === 0 && gone) return { ok: true, removedBytes: expected.bytes, leftovers: 0, partial: false };
  return { ok: false, removedBytes: 0, leftovers: 1, partial: true, error: removed.killed || removed.timedOut ? "Clearing was stopped before it finished; what's left is set aside in a .hosts-quarantine folder." : "Some of it couldn't be removed (on another disk, or in use); what's left is set aside in a .hosts-quarantine folder." };
}
