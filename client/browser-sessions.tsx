import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, ScrollView, Text, View } from "react-native";
import { browserSessions, browserViewClose, browserViewFrame, browserViewOpen, BROWSER_FRAME_INTERVAL_MS, type BrowserFrame, type BrowserSession, type BrowserTab } from "../shared/browser";
import { observeBrowserVisibility } from "./browser-visibility";

export type BrowserSessionsProps = PluginSurfaceProps & { workspaceId?: string; visible?: boolean };
export function BrowserSessions({ theme, layout, host, navigation, workspaceId, visible = true }: BrowserSessionsProps) {
  const read = useRpc(browserSessions); const open = useRpc(browserViewOpen); const capture = useRpc(browserViewFrame); const close = useRpc(browserViewClose);
  const [appActive, setAppActive] = useState(AppState.currentState == null || AppState.currentState === "active");
  const [inView, setInView] = useState(true);
  const visibilityCleanup = useRef<() => void>(() => {});
  const root = useCallback((node: unknown) => { visibilityCleanup.current(); visibilityCleanup.current = observeBrowserVisibility(node, setInView); }, []);
  useEffect(() => () => visibilityCleanup.current(), []);
  useEffect(() => { const subscription = AppState.addEventListener("change", (state) => setAppActive(state === "active")); return () => subscription.remove(); }, []);
  const active = visible && appActive && inView;
  const [all, setAll] = useState(false);
  const context = `${host.id}\0${workspaceId ?? ""}`;
  const [selection, setSelection] = useState<{ value: BrowserSession; context: string } | null>(null);
  const session = selection?.context === context ? selection.value : null;
  const [tabId, setTabId] = useState<string | null>(null);
  const selectedTab = useRef<string | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [retry, setRetry] = useState(0);
  const query = useQuery({ queryKey: ["hosts-browser", host.id, all ? null : workspaceId], queryFn: () => read({ ...(!all && workspaceId ? { workspaceId } : {}) }),
    enabled: active, refetchInterval: active ? 5_000 : false, refetchIntervalInBackground: false, retry: 1, gcTime: 0 });
  // Capture bytes are component state only; never put screenshots in the host query cache.
  useEffect(() => { setSelection(null); selectedTab.current = null; setTabId(null); setTabs([]); setFrame(null); setMessage(null); }, [host.id, workspaceId]);
  useEffect(() => {
    if (session && query.data && !query.data.sessions.some((item) => item.id === session.id)) { setSelection(null); setFrame(null); setMessage(null); }
  }, [query.data, session?.id]);
  useEffect(() => {
    if (!active || !following || !session) { setFrame(null); return; }
    let cancelled = false; let viewerId: string | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    setFrame(null); setMessage("Connecting to the browser on this host…");
    const release = (id: string) => { void close({ viewerId: id }).catch(() => undefined); };
    async function tick() {
      if (cancelled || !viewerId) return;
      const target = selectedTab.current;
      if (!target) { setMessage("No page tabs are open. Open a page from the agent, then reconnect."); return; }
      try {
        const result = await capture({ viewerId, tabId: target });
        if (cancelled) return;
        setTabs(result.tabs);
        if (selectedTab.current === target) { setFrame(result.frame); setMessage(result.message); }
        timer = setTimeout(() => { void tick(); }, BROWSER_FRAME_INTERVAL_MS);
      } catch (error) {
        if (!cancelled) { setFrame(null); setMessage(error instanceof Error ? error.message : "This browser view disconnected. Reconnect to keep watching."); }
        if (viewerId) release(viewerId);
      }
    }
    void open({ sessionId: session.id }).then((result) => {
      if (cancelled) { release(result.viewerId); return; }
      viewerId = result.viewerId; setTabs(result.tabs);
      // Pick once on initial open. Reordering or a closed tab never selects another tab.
      if (selectedTab.current === null && result.tabs[0]) { selectedTab.current = result.tabs[0].id; setTabId(result.tabs[0].id); }
      void tick();
    }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "The browser could not be opened."); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); if (viewerId) release(viewerId); };
  }, [host.id, session?.id, active, following, retry, open, capture, close]);
  const c = theme.colors;
  const body = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 13 };
  function button(label: string, action: () => void, selected = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={action} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: selected ? c.accent : c.border, borderRadius: 8, backgroundColor: selected ? c.surface2 : c.surface1 }}><Text style={{ ...body, color: selected ? c.accent : c.foreground }}>{label}</Text></Pressable>;
  }
  function choose(value: BrowserSession) { selectedTab.current = null; setTabId(null); setTabs([]); setFrame(null); setSelection({ value, context }); setFollowing(true); setRetry((n) => n + 1); }
  const tab = tabs.find((candidate) => candidate.id === tabId);
  return <View ref={root} style={{ backgroundColor: c.surface0, padding: layout.compact ? 16 : 24, gap: 16 }}>
    <View style={{ gap: 6 }}><Text style={{ ...body, fontSize: 22, fontWeight: "600" }}>Agent browsers</Text><Text style={muted}>Watch a browser running on {host.label}. The browser keeps running on the selected host; your agent keeps control.</Text></View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {button("Refresh sessions", () => { void query.refetch(); })}
      {workspaceId ? button(all ? "Show this workspace" : "Show all host sessions", () => setAll(!all), all) : null}
    </View>
    {query.isPending ? <Text style={muted}>Looking for existing Agent Browser sessions…</Text> : null}
    {query.error ? <Text style={{ ...body, color: c.statusDanger }}>Sessions could not be read. {query.error instanceof Error ? query.error.message : "Refresh to try again."}</Text> : null}
    {query.data?.sessions.length === 0 ? <View style={{ gap: 8 }}><Text style={body}>{workspaceId && !all ? "No browser is linked to this workspace yet." : "No running Agent Browser sessions found."}</Text><Text style={muted}>Ask your agent to open a browser on this host, then refresh. Hosts discovers existing sessions; it does not install or start a browser.{workspaceId && !all ? " Show all host sessions to find browsers with unknown workspace ownership." : ""}</Text></View> : null}
    {query.data?.sessions.map((item) => <View key={item.id} style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: item.id === session?.id ? c.accent : c.border, borderRadius: 10, backgroundColor: c.surface1 }}>
      <Text style={{ ...body, fontWeight: "600" }}>{item.name}</Text>
      <Text style={muted}>{item.chat ?? item.workspace ?? "Workspace ownership could not be verified"} · PID {item.pid}{item.version ? ` · Agent Browser ${item.version}` : ""}</Text>
      {item.attribution === "workspace" ? <Text style={muted}>The originating chat could not be verified.</Text> : null}
      {item.limitation ? <Text style={muted}>{item.limitation}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{item.viewable ? button(item.id === session?.id ? "Reconnect view" : `Watch ${item.name}`, () => choose(item)) : null}
        {item.chatId && navigation?.openAgent ? button("Open chat", () => navigation.openAgent({ agentId: item.chatId! })) : null}</View>
    </View>)}
    {session ? <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{button(following ? "Pause view" : "Follow live", () => { setFollowing(!following); setFrame(null); })}{button("Reconnect", () => { setFollowing(true); setRetry((n) => n + 1); })}{button("Close view", () => { setSelection(null); setFrame(null); setMessage(null); })}</View>
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{tabs.map((item) => <View key={item.id}>{button(item.title || "Untitled tab", () => { selectedTab.current = item.id; setTabId(item.id); setFrame(null); setMessage("Waiting for this tab's next image…"); }, item.id === tabId)}</View>)}</ScrollView>
      {tab ? <Text style={muted} numberOfLines={2}>{tab.url}</Text> : null}
      <Text style={muted}>{!active ? "View paused while this panel is hidden." : !following ? "View paused. The browser is still running." : message ?? "Following live · about one image per second"}</Text>
      {active && following && frame && frame.tabId === tabId ? <Image accessibilityLabel={`Live browser image: ${tab?.title || "selected tab"}`} source={{ uri: `data:image/jpeg;base64,${frame.data}` }} resizeMode="contain" style={{ width: "100%", aspectRatio: frame.width / frame.height, backgroundColor: c.surface1, borderRadius: 8 }} /> : null}
      <Text style={muted}>Viewing only. Choosing a tab here does not change the agent's active tab. Closing this view leaves the browser running.</Text>
    </View> : null}
    {query.data?.warnings.map((warning) => <Text key={warning} style={muted}>{warning}</Text>)}
  </View>;
}
export function BrowserWorkspacePanel(props: PluginWorkspacePanelProps) {
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}><BrowserSessions {...props} /></ScrollView>;
}
