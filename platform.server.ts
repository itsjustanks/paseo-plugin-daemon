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
  /** Fresh identity for one PID, or null when it no longer exists. */
  readIdentity(pid: number): Promise<ProcessIdentity | null>;
  /** Fresh (pid, ppid, uid) triples for the whole table, for descendant resolution. */
  readTree(): Promise<Array<{ pid: number; ppid: number; uid: number }>>;
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
