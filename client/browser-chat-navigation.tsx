import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { type ComponentType, useEffect, useState, useSyncExternalStore } from "react";
import { browserTabIdSchema } from "../shared/managed-browser/browser";

export type OpenChatBrowser = (workspaceId: string, agentId: string, tabId?: string) => void;
export type ChatBrowserPanelProps = PluginWorkspacePanelProps & { initialTabId?: string };
type BrowserIntent = { workspaceId: string; tabId?: string; sequence: number };

/** Per-installation navigation intent. Paseo's documented panel route takes a workspace,
 * so only the local selected-tab hint lives here. It never grants input authority. */
export function createBrowserChatNavigation(client: Pick<PluginClientContext, "openPanel">) {
  let sequence = 0;
  let intent: BrowserIntent | null = null;
  const listeners = new Set<() => void>();
  let stopped = false;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const current = () => intent;
  const open: OpenChatBrowser = (workspaceId, agentId, tabId) => {
    if (stopped) return;
    const parsed = browserTabIdSchema.safeParse(tabId);
    intent = { workspaceId, sequence: ++sequence, ...(parsed.success ? { tabId: parsed.data } : {}) };
    for (const listener of listeners) listener();
    client.openPanel("hosts-browser", { workspaceId, agentId });
  };
  return {
    open,
    wrap(Component: ComponentType<ChatBrowserPanelProps>) {
      function MountedPanel(props: PluginWorkspacePanelProps) {
        const selected = useSyncExternalStore(subscribe, current, current);
        const [adopted, setAdopted] = useState<BrowserIntent | null>(null);
        const pending = selected?.workspaceId === props.workspaceId ? selected : null;
        const target = pending ?? adopted;
        useEffect(() => {
          if (!pending || intent !== pending) return;
          // Keep this mount's selection, but consume the shared hint. A later
          // generic panel mount must not inherit a historical chat selection.
          setAdopted(pending);
          intent = null;
          for (const listener of listeners) listener();
        }, [pending]);
        return <Component key={target?.sequence ?? 0} {...props} {...(target?.tabId ? { initialTabId: target.tabId } : {})} />;
      }
      return function ChatBrowserPanel(props: PluginWorkspacePanelProps) {
        return <MountedPanel key={`${props.host.id}:${props.workspaceId}`} {...props} />;
      };
    },
    stop() { stopped = true; intent = null; listeners.clear(); },
  };
}
