import { createAdapter } from "./adapter";
import type { RawProcess } from "./platform";
import { ProcessGuard } from "./safety";

/** Pin a discovered listener to a same-user process incarnation, not just a port. */
export async function createServiceLease(port: number, authorize?: (owner: RawProcess, port: number) => Promise<boolean>): Promise<() => Promise<boolean>> {
  const adapter = createAdapter();
  const uid = process.getuid?.();
  if (!adapter || uid === undefined) throw new Error("Service discovery requires Linux or macOS.");
  const { processes } = await adapter.sampleProcesses(uid);
  const ports = await adapter.listeningPorts(processes.map((p) => p.pid));
  const owners = processes.filter((p) => ports.ports.get(p.pid)?.includes(port));
  const policy = new ProcessGuard({ adapter, uid, selfPid: process.pid, alwaysProtected: [process.ppid] });
  const tree = new Map(processes.map((p) => [p.pid, p]));
  if (!owners.length || owners.some((p) => !policy.evaluate(p, tree).actionable)) {
    throw new Error("Select a listening service owned by this daemon's user. Protected daemon ports cannot be shared.");
  }
  if (authorize && (await Promise.all(owners.map((owner) => authorize(owner, port)))).some((ok) => !ok)) {
    throw new Error("Select a verified dev server in a registered Paseo project.");
  }
  return async () => {
    try {
      for (const owner of owners) {
        const now = await adapter.readIdentity(owner.pid);
        if (!now || now.uid !== uid || now.startId !== owner.startId) return false;
      }
      if (authorize) {
        const fresh = await adapter.sampleProcesses(uid);
        for (const owner of owners) {
          const raw = fresh.processes.find((p) => p.pid === owner.pid && p.startId === owner.startId);
          if (!raw || !await authorize(raw, port)) return false;
        }
      }
      const current = await adapter.listeningPorts(owners.map((p) => p.pid));
      return owners.some((p) => current.ports.get(p.pid)?.includes(port));
    } catch { return false; }
  };
}
