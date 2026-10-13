import type { DescribedDaemon } from "./daemon-rows.client";
import type { DaemonPort } from "./peer-sync.client";
import { daemonRequest } from "./requests.client";

export type DaemonReading = DescribedDaemon & { port: DaemonPort };

/** Status only: pairing offers never enter the UI query cache. */
export async function describeDaemons(ports: readonly DaemonPort[]) {
  const results = await Promise.allSettled(ports.map(async (port): Promise<DaemonReading> => {
    const description = await daemonRequest(port, "status", () => port.status());
    // Off computers have no shared peers. Avoid making their available switch depend
    // on a second, unnecessary request.
    const peers = description.switchedOn
      ? await daemonRequest(port, "listPeers", () => port.listPeers()) : [];
    return { ...description, peers, port };
  }));
  return { daemons: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []), failedCount: results.filter((result) => result.status === "rejected").length };
}
