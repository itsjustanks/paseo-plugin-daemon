import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { BROWSER_CHAT_KIND, BROWSER_CHAT_VERSION, BrowserChatDataSchema, browserStepLabel, browserStepMessage, transformBrowserStep, type BrowserChatData } from "../shared/browser-chat";
import type { OpenChatBrowser } from "./browser-chat-navigation";

export function browserStepCard(open: OpenChatBrowser) {
  return function BrowserStep({ theme, agentId, item, timestamp }: PluginTimelineItemProps<BrowserChatData>) {
    // Navigation is bound to the selected host's live agent placement, never a tool-supplied workspace.
    const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
    const data = item.data;
    const canOpen = !!workspaceId && (!data.workspaceId || data.workspaceId === workspaceId);
    const openLabel = data.tabId ? "Open this tab in Hosts Browser" : "Open Hosts Browser";
    const colors = theme.colors;
    const at = new Date(timestamp);
    const time = Number.isFinite(at.getTime()) ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, marginVertical: 4, gap: 6, minWidth: 0, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Globe" size={16} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foreground, fontWeight: "600", flex: 1, flexShrink: 1 }}>{browserStepLabel(data)}</Text>
        {time ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{time}</Text> : null}
      </View>
      {data.title ? <Text numberOfLines={2} style={{ color: colors.foreground }}>{data.title}</Text> : null}
      {data.origin ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{data.origin}</Text> : null}
      <Text style={{ color: data.status === "failed" ? colors.statusDanger : colors.foregroundMuted, fontSize: 13 }}>{browserStepMessage(data)}</Text>
      {canOpen ? <Pressable accessibilityRole="button" accessibilityLabel={openLabel} onPress={() => open(workspaceId, agentId, data.tabId)} style={{ minHeight: 44, alignSelf: "flex-start", justifyContent: "center", paddingHorizontal: 8 }}>
        <Text style={{ color: colors.accent, fontWeight: "500" }}>{openLabel}</Text>
      </Pressable> : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>The original workspace is no longer available here.</Text>}
    </View>;
  };
}

/** The provider's native screenshot items stay in the timeline; no duplicate capture or background polling. */
export function registerBrowserChat(client: PluginClientContext, open: OpenChatBrowser): () => void {
  if (typeof client.addTimelineTransformer !== "function" || typeof client.addTimelineRenderer !== "function") return () => {};
  const cleanups: Array<() => void | Promise<void>> = [];
  try {
    cleanups.push(client.addTimelineRenderer({ kind: BROWSER_CHAT_KIND, version: BROWSER_CHAT_VERSION,
      schema: BrowserChatDataSchema, Component: browserStepCard(open) }));
    cleanups.push(client.addTimelineTransformer({ id: "hosts-browser-steps", query: { itemType: "tool_call" }, transform: transformBrowserStep }));
  } catch {
    for (const remove of cleanups.splice(0)) void remove();
  }
  return () => { for (const remove of cleanups.splice(0)) void remove(); };
}
