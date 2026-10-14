import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { listOpenBrowserWorkspacesRpc } from "../../shared/managed-browser/browser";
import { isBrowserRuntimeUpgradeRequired } from "../../shared/managed-browser/browser-runtime-upgrade";
import { BrowserWorkspacePanel as ExternalBrowserPanel } from "../browser-sessions";
import { observeBrowserVisibility } from "../browser-visibility";
import { ManagedBrowserPanel } from "./browser";
import { BrowserRuntimeUpgradeAction } from "./browser-runtime-upgrade";
import type { ChatBrowserPanelProps } from "../browser-chat-navigation";

/** Full-height workspace browser. Visibility releases viewer/input authority;
 * the daemon-owned runtime and agent work survive the client going away. */
export function WorkspaceBrowserPanel(props: ChatBrowserPanelProps) {
  return <WorkspaceBrowser key={`${props.host.id}:${props.workspaceId}`} {...props} />;
}
function WorkspaceBrowser(props: ChatBrowserPanelProps) {
  const readPresence = useRpc(listOpenBrowserWorkspacesRpc);
  const [started, setStarted] = useState(false);
  const createPermit = useRef(false);
  const [external, setExternal] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState == null || AppState.currentState === "active");
  const [inView, setInView] = useState(true);
  const cleanup = useRef<() => void>(() => {});
  const root = useCallback((node: unknown) => {
    cleanup.current(); cleanup.current = observeBrowserVisibility(node, setInView);
  }, []);
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);
  const active = appActive && inView;
  const targeted = props.initialTabId !== undefined;
  const presence = useQuery({ queryKey: ["hosts-managed-browser-presence", props.host.id, props.workspaceId],
    queryFn: () => readPresence({}), enabled: active && !started && !targeted, retry: false,
    refetchInterval: active && !started && !targeted ? 5_000 : false, gcTime: 0 });
  const open = targeted || started || presence.data?.workspaceIds.includes(props.workspaceId);
  const upgradeRequired = isBrowserRuntimeUpgradeRequired(presence.error);
  const colors = props.theme.colors;
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} onPress={action} style={{ minHeight: 44, padding: 12, justifyContent: "center" }}>
    <Text style={{ color: colors.accent }}>{label}</Text></Pressable>;
  return <View ref={root} collapsable={false} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    {active ? external ? <>
      {button("Back to workspace browser", () => setExternal(false))}
      <ExternalBrowserPanel {...props} />
    </> : open ? <ManagedBrowserPanel {...props} createIfMissing={createPermit.current}
      onCreateAttempt={() => { createPermit.current = false; }} onWatchExternal={() => setExternal(true)} />
      : <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>Workspace browser</Text>
        <Text style={{ color: colors.foregroundMuted, maxWidth: 360, textAlign: "center" }}>
          You and new workspace agents use the same browser on this host. It keeps running when you disconnect.
        </Text>
        {upgradeRequired ? <>
          <Text style={{ color: colors.foregroundMuted, maxWidth: 360, textAlign: "center" }}>
            The previous Hosts browser runtime must be restarted before this browser can connect.
          </Text>
          <BrowserRuntimeUpgradeAction key={props.host.id} theme={props.theme} hostLabel={props.host.label}
            onVerified={() => {
              createPermit.current = false;
              setStarted(false);
              void presence.refetch();
            }} />
        </> : button("Open browser", () => { createPermit.current = true; setStarted(true); })}
        {button("Watch external browser", () => setExternal(true))}
        {presence.error && !upgradeRequired ? <Text style={{ color: colors.statusDanger }}>{presence.error.message}</Text> : null}
      </View> : null}
  </View>;
}
