import { readFile } from "node:fs/promises";

/** Proof that a PID is a process launched by this runtime and has not been replaced since. */
export interface ProcessIdentity {
  pid: number;
  /** Kernel start time in clock ticks; a recycled PID has a different value. */
  startTicks: string;
}

/** Environment variable carrying the per-runtime ownership nonce through the launch chain. */
export const RUNTIME_OWNER_VARIABLE = "HOSTS_BROWSER_RUNTIME_OWNER";

/** Positive outcomes are distinct from "could not tell": only `absent` proves disappearance. */
export type ProcessProbe =
  | { status: "owned"; identity: ProcessIdentity }
  /** The process exists and was read, but is not this runtime's (no nonce): proven replacement. */
  | { status: "foreign" }
  /** The kernel reports no such process (ENOENT/ESRCH): positive exit. */
  | { status: "absent" }
  /** Unreadable, unsupported platform or malformed data: nothing is proven either way. */
  | { status: "unknown" };

/**
 * Probes `pid` for this runtime's private nonce, i.e. a descendant of its own launch (JS
 * launcher, native CLI, daemon) rather than merely a process running some executable.
 */
export async function probeProcess(pid: number, nonce: string): Promise<ProcessProbe> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0)
    return { status: "unknown" };
  try {
    const [stat, environment] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/environ`, "utf8"),
    ]);
    if (!environment.split("\0").includes(`${RUNTIME_OWNER_VARIABLE}=${nonce}`))
      return { status: "foreign" };
    // Fields after the parenthesised command name; starttime is field 22 overall.
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return startTicks && /^\d+$/.test(startTicks)
      ? { status: "owned", identity: { pid, startTicks } }
      : { status: "unknown" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
      ? { status: "absent" }
      : { status: "unknown" };
  }
}

/** Signal-0 probe: only ESRCH proves the process is gone; EPERM means it is still alive. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
