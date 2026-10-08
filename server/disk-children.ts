import { spawn } from "node:child_process";
import { setPriority } from "node:os";

/**
 * Children Hosts starts for the disk scan (0.14.0): the read-only walk, git's
 * read-only queries and `pnpm store path`. Each runs at the lowest priority in
 * its own process group, with a timeout; `killAll` (on unload) ends every
 * group and refuses new work.
 */

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

