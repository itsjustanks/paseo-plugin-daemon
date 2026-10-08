import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";

/**
 * Children Hosts starts for the disk scan (0.14.0): the read-only walk, git's
 * read-only queries. Each runs at the lowest priority in
 * its own process group, with a timeout; `killAll` (on unload) ends every
 * group and refuses new work.
 */

export interface ChildResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; killed: boolean }

/** After the leader exits, how long its pipes may stay open (an escaped descendant holding them) before Hosts stops reading. */
export const PIPE_GRACE_MS = 2000;

/**
 * Children Hosts started for disk work; `killAll` ends each one's whole process group.
 *
 * Signals go only to a leader Hosts hasn't seen exit. Until Node reports
 * 'exit' the child is unreaped, so its PID (and its process group's id)
 * can't belong to anything else; after 'exit' Hosts never signals it again,
 * even if a descendant keeps a pipe open. Every pipe has an 'error' handler:
 * a child that dies while Hosts is still writing its input (EPIPE) is a
 * result, never a crash.
 */
export class ChildGroup {
  private readonly live = new Set<number>();
  closed = false;

  /** Spawn at the lowest priority, in its own process group; resolves when it exits. */
  run(file: string, args: readonly string[], options: { timeoutMs: number; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } ): Promise<ChildResult> {
    if (this.closed) return Promise.resolve({ code: null, stdout: "", stderr: "Hosts is unloading.", timedOut: false, killed: true });
    return new Promise((resolve) => {
      let stdout = "", stderr = "", timedOut = false;
      const child = spawn(file, [...args], { detached: true, stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd, env: options.env ?? { ...process.env, LC_ALL: "C" }, windowsHide: true });
      const pid = child.pid;
      const timer = setTimeout(() => { timedOut = true; this.signal(pid); }, options.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      if (pid) { this.live.add(pid); lowPriority(pid); }
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
      watchChild(child, () => { if (pid) this.live.delete(pid); }, (code, killed, error) => {
        clearTimeout(timer);
        if (error) stderr += error;
        resolve({ code, stdout, stderr, timedOut, killed });
      });
      child.stdin?.end(options.input ?? "");
    });
  }

  /** Track a child started elsewhere (the scan worker) until it exits; returns how to stop tracking it. */
  track(pid: number): () => void {
    this.live.add(pid);
    if (this.closed) this.signal(pid);
    return () => { this.live.delete(pid); };
  }

  /** Kill a tracked leader's process group. Never a PID Hosts has seen exit. */
  signal(pid: number | undefined): void {
    if (!pid || !this.live.has(pid)) return;
    try { process.kill(-pid, "SIGKILL"); } catch {
      // No group (setsid failed): the leader itself, which is still unreaped and so still ours.
      if (this.live.has(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* Gone already. */ }
    }
  }

  /** Stop taking work and kill every running child's process group. */
  killAll(): void {
    this.closed = true;
    for (const pid of [...this.live]) this.signal(pid);
  }

  get running(): number { return this.live.size; }
}

/**
 * Every pipe gets an 'error' handler (EPIPE when a child dies mid-write);
 * `onExit` runs at 'exit' (stop signalling), `onDone` once at 'close', or
 * PIPE_GRACE_MS after 'exit' when a descendant keeps the pipes open.
 */
export function watchChild(child: ChildProcess, onExit: () => void, onDone: (code: number | null, killed: boolean, error: string | null) => void): void {
  let done = false, exitCode: number | null = null, exitKilled = false, failure: string | null = null;
  const finish = (code: number | null, killed: boolean) => { if (done) return; done = true; onExit(); onDone(code, killed, failure); };
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", (error: Error) => { failure ??= error.message; });
  child.on("error", (error) => { failure ??= error.message; finish(null, false); });
  child.on("exit", (code, signal) => {
    exitCode = code; exitKilled = signal !== null;
    onExit();
    const grace = setTimeout(() => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      finish(exitCode, exitKilled);
    }, PIPE_GRACE_MS);
    (grace as { unref?: () => void }).unref?.();
    child.once("close", () => clearTimeout(grace));
  });
  child.on("close", (code, signal) => finish(code ?? exitCode, signal !== null || exitKilled));
}

export function lowPriority(pid: number): void {
  try { setPriority(pid, 19); } catch { /* Best effort. */ }
  if (process.platform === "linux") {
    const io = spawn("ionice", ["-c", "3", "-p", String(pid)], { stdio: "ignore" });
    io.on("error", () => undefined);
  }
}

