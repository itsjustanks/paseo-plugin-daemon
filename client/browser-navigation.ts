import type { PluginClientContext } from "@getpaseo/plugin/client";

/** Documented installation-scoped panel API, bound to this Hosts installation. */
export function workspaceBrowserOpener(client: Pick<PluginClientContext, "openPanel">) {
  if (typeof client.openPanel !== "function") return undefined;
  return (workspaceId: string) => client.openPanel("hosts-browser", { workspaceId });
}
