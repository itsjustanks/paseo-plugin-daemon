/**
 * Roll a workspace's processes up into one resource figure.
 *
 * The snapshot reports per-process `cpuPercent` in one-core units (a process
 * at 100% saturates one core; the server caps it at `cores * 100`) and resident
 * memory as `rssBytes`. Host totals come from the same sample: `cpu.percent`
 * is the whole machine's load on a 0–100 scale, `cpu.cores` its core count,
 * and `memory.totalBytes` / `usedBytes` its memory. Shares are only reported
 * when the host figure they divide by is present and non-zero; everything
 * else is null so the panel can say "unknown" instead of printing 0.
 */

export interface ResourceProcessLike {
  pid: number;
  name: string;
  /** Null until the server has sampled the process twice. */
  cpuPercent?: number | null;
  rssBytes?: number | null;
}

export interface HostTotalsLike {
  cpu?: { percent?: number | null; cores?: number | null } | null;
  memory?: { totalBytes?: number | null; usedBytes?: number | null } | null;
}

export interface ResourceRollup {
  /** Distinct processes counted; a row present in both `services` and `processes` counts once. */
  processCount: number;
  /** Summed CPU in one-core units, or null while no process has a measurement yet. */
  cpuPercent: number | null;
  /** Processes whose CPU has been measured; the rest are still sampling. */
  cpuSampled: number;
  /** The same CPU as a share of the whole machine's capacity; null without a core count. */
  cpuOfHostPercent: number | null;
  /** Share of the host's current load this workspace accounts for; null when the host load is unknown or idle. */
  cpuOfHostLoadPercent: number | null;
  /** Summed resident memory, or null when no process reported it. */
  rssBytes: number | null;
  /** Processes whose RSS is known. */
  memorySampled: number;
  /** RSS as a share of the host's total memory; null when the total is unknown. */
  memoryOfHostPercent: number | null;
  /** RSS as a share of the host's used memory; null when usage is unknown or zero. */
  memoryOfHostUsedPercent: number | null;
}

export const EMPTY_ROLLUP: ResourceRollup = {
  processCount: 0, cpuPercent: null, cpuSampled: 0, cpuOfHostPercent: null, cpuOfHostLoadPercent: null,
  rssBytes: null, memorySampled: 0, memoryOfHostPercent: null, memoryOfHostUsedPercent: null,
};

/**
 * Stable identity for a process row across the two snapshot lists. The PID
 * plus name is what the client keys rows on too; a reused PID with a new
 * program has a new name in the common case.
 */
export function processIdentity(process: Pick<ResourceProcessLike, "pid" | "name">): string {
  return `${process.pid}:${process.name}`;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round1 = (value: number) => Math.round(value * 10) / 10;
/** Percent of `part` in `whole`, clamped to 0–100; null when the whole is missing or zero. */
const share = (part: number, whole: number | null | undefined): number | null => (finite(whole) && whole > 0 ? round1(Math.min(100, (part / whole) * 100)) : null);

/** Sum the workspace's processes once each and relate them to the host. Pure. */
export function rollupResources(processes: readonly ResourceProcessLike[], host: HostTotalsLike | null | undefined): ResourceRollup {
  const seen = new Set<string>();
  let cpu = 0, cpuSampled = 0, rss = 0, memorySampled = 0;
  for (const process of processes) {
    const key = processIdentity(process);
    if (seen.has(key)) continue;
    seen.add(key);
    if (finite(process.cpuPercent)) { cpu += process.cpuPercent; cpuSampled += 1; }
    if (finite(process.rssBytes)) { rss += process.rssBytes; memorySampled += 1; }
  }
  if (seen.size === 0) return EMPTY_ROLLUP;
  const cores = host?.cpu?.cores;
  const cpuOfHost = cpuSampled > 0 && finite(cores) && cores >= 1 ? round1(Math.min(100, cpu / cores)) : null;
  return {
    processCount: seen.size,
    cpuPercent: cpuSampled > 0 ? round1(cpu) : null,
    cpuSampled,
    cpuOfHostPercent: cpuOfHost,
    cpuOfHostLoadPercent: cpuOfHost === null ? null : share(cpuOfHost, host?.cpu?.percent),
    rssBytes: memorySampled > 0 ? rss : null,
    memorySampled,
    memoryOfHostPercent: memorySampled > 0 ? share(rss, host?.memory?.totalBytes) : null,
    memoryOfHostUsedPercent: memorySampled > 0 ? share(rss, host?.memory?.usedBytes) : null,
  };
}
