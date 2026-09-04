/**
 * The single seam between the dashboard and the RPC contract.
 *
 * The surface renders a small view model (`Snapshot`, `Process`) that is
 * shaped for display. `toSnapshotView` maps the wire schema in
 * `contracts.shared.ts` onto it, so contract drift is fixed here and nowhere
 * in the UI.
 */
import { useRpc } from "@getpaseo/plugin";
import { useCallback } from "react";
import {
  monitorForceStop,
  monitorSnapshot,
  monitorStop,
  SNAPSHOT_LIMIT_DEFAULT,
  type ActionResult,
  type PressureState,
  type ProcessImpact,
  type ProcessSort,
  type ProcessView,
  type Snapshot as WireSnapshot,
} from "./contracts.shared";

export type { ActionResult, PressureState };
export type Impact = ProcessImpact;
export type Sort = ProcessSort;

export interface Pressure {
  state: PressureState;
  reasons: string[];
}

export interface Classification {
  kind: "dev-server" | "listening" | "process";
  label: string;
  reasons: string[];
}

export interface Process {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  cwd: string | null;
  state: string;
  cpuPercent: number | null;
  rssBytes: number;
  memoryPercent: number;
  ageSeconds: number;
  ports: number[];
  classification: Classification;
  impact: Impact;
  impactReasons: string[];
  actionable: boolean;
  protectedReason: string | null;
  actionToken: string | null;
}

export interface Snapshot {
  /** ISO timestamp; also the history/ring-buffer key. */
  timestamp: string;
  sampling: boolean;
  platform: string;
  supported: boolean;
  warnings: string[];
  system: {
    cpu: { percent: number | null; cores: number; load: readonly [number, number, number]; pressure: Pressure };
    memory: {
      usedBytes: number;
      availableBytes: number;
      totalBytes: number;
      swapUsedBytes: number;
      swapTotalBytes: number;
      pressure: Pressure;
    };
    uptimeSeconds: number;
  };
  services: Process[];
  processes: { items: Process[]; total: number; truncated: boolean };
}

export const SORTS: ReadonlyArray<{ id: Sort; label: string }> = [
  { id: "cpu", label: "CPU" },
  { id: "memory", label: "Memory" },
  { id: "name", label: "Name" },
  { id: "pid", label: "PID" },
];

/** Processes page size. The server bounds this too; the client just asks for one screenful. */
export const PROCESS_LIMIT = SNAPSHOT_LIMIT_DEFAULT;

function toProcess(process: ProcessView): Process {
  const service = process.service;
  const classification: Classification = service
    ? { kind: service.kind === "dev-server" ? "dev-server" : "listening", label: service.label, reasons: service.reasons }
    : { kind: "process", label: "Process", reasons: [] };
  return {
    pid: process.pid,
    ppid: process.ppid,
    name: process.name,
    command: process.command,
    cwd: process.cwd,
    state: process.state,
    cpuPercent: process.cpuPercent,
    rssBytes: process.rssBytes,
    memoryPercent: process.memoryPercent,
    ageSeconds: process.ageSeconds,
    ports: process.ports,
    classification,
    impact: process.impact,
    impactReasons: process.reasons,
    actionable: process.actionable,
    protectedReason: process.protectedReason,
    actionToken: process.actionToken,
  };
}

export function toSnapshotView(wire: WireSnapshot): Snapshot {
  return {
    timestamp: new Date(wire.timestamp).toISOString(),
    sampling: wire.sampling === "sampling",
    platform: wire.platform,
    supported: wire.supported,
    warnings: wire.warnings,
    system: {
      cpu: {
        percent: wire.cpu.percent,
        cores: wire.cpu.cores,
        load: [wire.cpu.load1, wire.cpu.load5, wire.cpu.load15],
        pressure: { state: wire.cpu.pressure, reasons: wire.cpu.reasons },
      },
      memory: {
        usedBytes: wire.memory.usedBytes,
        availableBytes: wire.memory.availableBytes,
        totalBytes: wire.memory.totalBytes,
        swapUsedBytes: wire.memory.swapUsedBytes,
        swapTotalBytes: wire.memory.swapTotalBytes,
        pressure: { state: wire.memory.pressure, reasons: wire.memory.reasons },
      },
      uptimeSeconds: wire.uptimeSeconds,
    },
    services: wire.services.map(toProcess),
    processes: { items: wire.processes.map(toProcess), total: wire.matchedProcesses, truncated: wire.truncated },
  };
}

export function useMonitorRpc() {
  const callSnapshot = useRpc(monitorSnapshot);
  const stop = useRpc(monitorStop);
  const forceStop = useRpc(monitorForceStop);
  const snapshot = useCallback(
    async (input: { query: string; sort: Sort; limit: number }) => toSnapshotView(await callSnapshot(input)),
    [callSnapshot],
  );
  return { snapshot, stop, forceStop };
}

/**
 * Stable client-side identity for a row across polls. The action token is
 * opaque and may rotate, so a PID plus name is what we key pending stops on.
 * A PID reused by a different program within one poll window would look like
 * "still alive"; the server's identity check makes that harmless (the stale
 * token is denied), and the name check catches the common case.
 */
export function processKey(process: Pick<Process, "pid" | "name">): string {
  return `${process.pid}:${process.name}`;
}
