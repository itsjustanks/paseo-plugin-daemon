import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceBrowserPanel } from "../../client/managed-browser/panel";
import { BrowserWorkspacePanel } from "../../client/browser-sessions";
import { registerPreviewDaemons } from "./headless-fixtures";
import { DaemonSurface } from "../../client/daemon";
import { HostsSettings } from "../../client/settings";
import { WorkspacePanel } from "../../client/workspace-panel";
import { makeQuickHealth } from "../../client/quick";
const QuickHealth = makeQuickHealth("daemon-link");
const queryClient = new QueryClient();
const stopPreviewDaemons = registerPreviewDaemons();
const params = new URLSearchParams(location.search);
const light = params.has("light");
/** `?view=panel` mounts the workspace tab, `?view=settings` the Hosts settings screen; the default is the sidebar surface. */
const view = params.get("view") || "surface";
const colors = light ? {
  surface0: "#f5f6f8", surface1: "#ffffff", surface2: "#edf0f4", border: "#d7dbe1", foreground: "#20252d",
  foregroundMuted: "#606b78", accent: "#4f46e5", accentForeground: "#ffffff", statusSuccess: "#15803d", statusWarning: "#a16207", statusDanger: "#b91c1c",
} : {
  surface0: "#11151b", surface1: "#1a2029", surface2: "#252d38", border: "#394352", foreground: "#eef1f6",
  foregroundMuted: "#a2adbc", accent: "#a5b4fc", accentForeground: "#14192c", statusSuccess: "#6ee7a0", statusWarning: "#facc6b", statusDanger: "#fda4af",
};
function Preview() {
  const [compact, setCompact] = useState(innerWidth < 640);
  useEffect(() => stopPreviewDaemons, []);
  useEffect(() => { const resize = () => setCompact(innerWidth < 640); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  const host = { theme: { colors }, host: { id: "preview", label: "Always-on helper" }, layout: { compact, platform: "web" as const } };
  const onWatchBrowser = (workspaceId: string) => { location.href = `/?view=browser&workspace=${encodeURIComponent(workspaceId)}${light ? "&light" : ""}`; };
  return <QueryClientProvider client={queryClient}>
    <div style={{ width: params.has("nested") ? Math.min(Number(params.get("nested")) || 680, innerWidth) : "100%", maxWidth: "100%", margin: "0 auto", background: colors.surface0, minHeight: "100vh", ...(params.has("managed") ? { height: "100vh", display: "flex", flexDirection: "column" as const } : {}), color: colors.foreground }}>
    {params.has("managed") ? <WorkspaceBrowserPanel {...host} context="workspace" workspaceId="ws-fixture" /> : view === "browser" ? <BrowserWorkspacePanel {...host} context="workspace" workspaceId={params.get("workspace") ?? "ws-fixture"} /> : view === "panel" ? <WorkspacePanel {...host} context="workspace" workspaceId="ws-fixture" onWatchBrowser={onWatchBrowser} /> : view === "settings" ? <HostsSettings {...host} /> : view === "popover" ? <div style={{ maxWidth: 380, margin: 24, background: colors.surface1, border: `1px solid ${colors.border}`, borderRadius: 12 }}><QuickHealth theme={host.theme as never} close={() => {}} openScreen={() => {}} /></div> : <DaemonSurface {...host} shortcuts onWatchBrowser={onWatchBrowser} params={{ tab: params.get("tab") ?? "overview", open: params.get("open") ?? "" }} initialTab={(params.get("tab") as never) || undefined} />}
    </div>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
