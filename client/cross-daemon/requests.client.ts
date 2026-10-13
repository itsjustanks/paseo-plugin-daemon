import type { DaemonPort } from "./peer-sync.client";

export const DAEMON_REQUEST_MS = 5_000;
type Operation = "describe" | "status" | "authority" | "listPeers" | "setPeers";
declare global {
  var __hostsCrossDaemonPendingV1: WeakMap<DaemonPort, Set<Operation>> | undefined;
}
// Like the scheduler, slots must span separately evaluated host installations.
const pending = globalThis.__hostsCrossDaemonPendingV1 ??= new WeakMap<DaemonPort, Set<Operation>>();

/** A deadline releases the reader, not the underlying RPC. Keep its slot until settlement.
 * In particular, never replay or overlap an uncertain peer write. Do not reuse an old
 * status promise in a new authority check: it may have started before a settings change.
 */
export async function daemonRequest<T>(port: DaemonPort, operation: Operation, run: () => Promise<T>): Promise<T> {
  const operations = pending.get(port) ?? new Set<Operation>();
  if (operations.has(operation)) throw new Error("A previous computer request is still pending");
  pending.set(port, operations);
  operations.add(operation);
  const request = (async () => run())();
  void request.then(() => operations.delete(operation), () => operations.delete(operation));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Computer did not reply in time")), DAEMON_REQUEST_MS);
    })]);
  } finally { if (deadline !== undefined) clearTimeout(deadline); }
}
