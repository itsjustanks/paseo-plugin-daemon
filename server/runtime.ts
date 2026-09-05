import type { PluginHandlerContext } from "@getpaseo/plugin";
import { createMonitorHandlers } from "./handlers";
import { createServiceLease } from "./lease";
import { LinkManager } from "./links";
import { PeerManager } from "./peers";
import { ProjectScope } from "./scope";
import { TunnelManager } from "./tunnels";

export function createRuntime() {
  const scope = new ProjectScope();
  const monitor = createMonitorHandlers({ scope });
  const lease = (port: number) => createServiceLease(port, async (owner, servicePort) => {
    await scope.refresh();
    return scope.match(owner, [servicePort])?.shareable === true;
  });
  const links = new LinkManager(undefined, new TunnelManager(lease));
  const peers = new PeerManager(undefined, lease, async () => {
    await scope.refresh();
    const snapshot = await monitor.snapshot({});
    const ports = new Map<number, { port: number; label: string; project: string | null }>();
    for (const process of snapshot.services) {
      if (!process.project?.shareable || process.protectedReason) continue;
      for (const port of process.ports) ports.set(port, {
        port, label: process.service?.kind === "dev-server" ? process.service.label : "Project service",
        project: process.project.name,
      });
    }
    return [...ports.values()];
  });
  return {
    links, peers, monitor,
    withContext<T>(context: PluginHandlerContext, action: () => T): T { scope.bind(context.paseo); return action(); },
  };
}
