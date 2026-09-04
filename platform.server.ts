import type { ProcessState } from "./contracts.shared";

/**
 * The adapter boundary. Adapters read raw operating-system facts and nothing
 * else: no classification, no redaction, no signalling. Everything above them
 * is pure and fixture-testable.
 */

export interface RawSystemSample {
  /** Monotonic-ish counters in arbitrary but consistent units; only deltas matter. */
  cpuBusy: number;
  cpuTotal: number;
  cores: number;
  load1: number;
  load5: number;
  load15: number;
  /** Linux PSI "some" avg10 percentages; null when unavailable. */
  psiCpuSome10: number | null;
  psiMemorySome10: number | null;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** Kernel-reported memory pressure level when the platform exposes one. */
  pressureSignal: "normal" | "warn" | "critical" | null;
  uptimeSeconds: number;
}

export interface RawProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** Kernel short name (comm). */
  comm: string;
  /** Raw argv. Never leaves the daemon unredacted. */
  argv: string[];
  /**
   * True when argv was recovered by splitting a space-joined command line
   * (macOS `ps`), so a quoted secret may span several tokens. Redaction
   * treats such argv more aggressively.
   */
  argvLossy?: boolean;
  state: ProcessState;
  /** Cumulative CPU time in seconds (user + system). */
  cpuSeconds: number;
  /** Stable start identity for this PID incarnation (start ticks on Linux, lstart on macOS). */
  startId: string;
  rssBytes: number;
  ageSeconds: number;
  cwd: string | null;
}

/** What safety re-reads before signalling. Must be derived from a fresh read. */
export interface ProcessIdentity {
  pid: number;
  ppid: number;
  uid: number;
  startId: string;
  argvHash: string;
  state: ProcessState;
}

/** One row of the whole process table, carrying enough identity to re-verify a descendant. */
export interface TreeRow {
  pid: number;
  ppid: number;
  uid: number;
  /** Same start identity as `RawProcess.startId` / `ProcessIdentity.startId`. */
  startId: string;
}

export interface PortScanResult {
  /** pid → sorted, de-duplicated listening TCP ports. */
  ports: Map<number, number[]>;
  warnings: string[];
}

export interface PlatformAdapter {
  readonly platform: "linux" | "darwin";
  sampleSystem(): Promise<RawSystemSample>;
  /** Only processes owned by `uid`. Kernel threads and other users are never returned. */
  sampleProcesses(uid: number): Promise<{ processes: RawProcess[]; warnings: string[] }>;
  /** Listening TCP ports for the given same-user PIDs. */
  listeningPorts(pids: readonly number[]): Promise<PortScanResult>;
  /**
   * Fresh identity for one PID. Resolves null only when the process
   * demonstrably no longer exists; rejects when the read itself failed, so
   * callers can fail closed instead of mistaking an error for an exit.
   */
  readIdentity(pid: number): Promise<ProcessIdentity | null>;
  /**
   * Fresh rows for the whole table (every user), for ancestor protection and
   * descendant resolution. Never truncated: a missing ancestor would silently
   * lose its protection. Rejects when the table cannot be read.
   */
  readTree(): Promise<TreeRow[]>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Maps a single-letter kernel state to the shared enum. */
export function mapState(letter: string): ProcessState {
  switch (letter[0]) {
    case "R":
      return "running";
    case "S":
      return "sleeping";
    case "D":
    case "U":
      return "disk-wait";
    case "T":
    case "t":
      return "stopped";
    case "Z":
      return "zombie";
    case "I":
      return "idle";
    default:
      return "unknown";
  }
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
