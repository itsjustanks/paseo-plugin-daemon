import type { PlatformAdapter, PortScanResult, ProcessIdentity, RawProcess, RawSystemSample, TreeRow } from "../server/platform";
import { hashArgv } from "../server/redaction";

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

export function system(overrides: Partial<RawSystemSample> = {}): RawSystemSample {
  return {
    cpuBusy: 1000,
    cpuTotal: 10000,
    cores: 8,
    load1: 0.5,
    load5: 0.5,
    load15: 0.5,
    psiCpuSome10: null,
    psiMemorySome10: null,
    memoryTotalBytes: 32 * GB,
    memoryAvailableBytes: 24 * GB,
    swapTotalBytes: 8 * GB,
    swapUsedBytes: 0,
    pressureSignal: null,
    uptimeSeconds: 100_000,
    ...overrides,
  };
}

export function proc(overrides: Partial<RawProcess> & { pid: number }): RawProcess {
  return {
    ppid: 1,
    uid: 1000,
    comm: "node",
    argv: ["node", "app.js"],
    state: "sleeping",
    cpuSeconds: 0,
    startId: `start-${overrides.pid}`,
    rssBytes: 50 * MB,
    ageSeconds: 60,
    cwd: "/home/alice/app",
    ...overrides,
  };
}

/**
 * In-memory adapter. Tests mutate `processes` / `sample` between calls to
 * simulate time passing, PID reuse, exits, and so on.
 */
export class FakeAdapter implements PlatformAdapter {
  readonly platform = "linux" as const;
  sample: RawSystemSample = system();
  processes: RawProcess[] = [];
  ports = new Map<number, number[]>();
  portWarnings: string[] = [];
  portScans = 0;
  identityReads: number[] = [];
  /** Test seams: make identity or tree reads fail like a broken procfs/ps. */
  identityReadError: Error | null = null;
  treeReadError: Error | null = null;
  /** Optional hook run before each identity read, to mutate state mid-action. */
  beforeIdentityRead: ((pid: number) => void) | null = null;

  async sampleSystem(): Promise<RawSystemSample> {
    return { ...this.sample };
  }

  async sampleProcesses(uid: number): Promise<{ processes: RawProcess[]; warnings: string[] }> {
    return { processes: this.processes.filter((p) => p.uid === uid).map((p) => ({ ...p, argv: [...p.argv] })), warnings: [] };
  }

  async listeningPorts(pids: readonly number[]): Promise<PortScanResult> {
    this.portScans += 1;
    const ports = new Map<number, number[]>();
    for (const pid of pids) {
      const list = this.ports.get(pid);
      if (list) ports.set(pid, [...list]);
    }
    return { ports, warnings: [...this.portWarnings] };
  }

  async readIdentity(pid: number): Promise<ProcessIdentity | null> {
    this.identityReads.push(pid);
    if (this.identityReadError) throw this.identityReadError;
    this.beforeIdentityRead?.(pid);
    const found = this.processes.find((p) => p.pid === pid);
    if (!found) return null;
    return { pid: found.pid, ppid: found.ppid, uid: found.uid, startId: found.startId, argvHash: hashArgv(found.argv), state: found.state };
  }

  async readTree(): Promise<TreeRow[]> {
    if (this.treeReadError) throw this.treeReadError;
    return this.processes.map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid, startId: p.startId }));
  }
}

export class FakeClock {
  constructor(public value = 1_000_000) {}
  now = () => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}
