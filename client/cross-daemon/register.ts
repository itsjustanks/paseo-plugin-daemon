import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createDaemonPort } from "./peer-sync.client";
import { registerDaemon } from "./sync-scheduler.client";

/** Call once per connected Hosts installation and include the remover in parent cleanup. */
export function contributeCrossDaemonClient(client: PluginClientContext): () => void {
  return registerDaemon(createDaemonPort(client.rpc));
}
