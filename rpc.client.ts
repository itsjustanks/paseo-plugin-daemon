/**
 * The single seam between the dashboard and the RPC contract.
 *
 * Everything under the surface imports contract types and hooks from here, so
 * if the backend's `contracts.shared.ts` names a field differently the fix is
 * one adapter, not a sweep through the UI.
 */
import { useRpc } from "@getpaseo/plugin";
import {
  monitorForceStop,
  monitorSnapshot,
  monitorStop,
  type ActionResult,
  type Impact,
  type PressureState,
  type Process,
  type Snapshot,
  type Sort,
} from "./contracts.shared";

export type { ActionResult, Impact, PressureState, Process, Snapshot, Sort };

export const SORTS: ReadonlyArray<{ id: Sort; label: string }> = [
  { id: "cpu", label: "CPU" },
  { id: "memory", label: "Memory" },
  { id: "name", label: "Name" },
  { id: "pid", label: "PID" },
];

/** Processes page size. The server bounds this too; the client just asks for one screenful. */
export const PROCESS_LIMIT = 60;

export function useMonitorRpc() {
  const snapshot = useRpc(monitorSnapshot);
  const stop = useRpc(monitorStop);
  const forceStop = useRpc(monitorForceStop);
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
