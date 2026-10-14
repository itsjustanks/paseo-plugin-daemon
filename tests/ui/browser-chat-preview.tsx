import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { browserStepCard } from "../../client/browser-chat";
import type { BrowserChatData } from "../../shared/browser-chat";

const Card = browserStepCard((workspaceId, agentId, tabId) => {
  (window as unknown as { __browserChatOpen: unknown }).__browserChatOpen = { workspaceId, agentId, tabId };
});
const steps: BrowserChatData[] = [
  { operation: "navigate", status: "completed", captured: false, workspaceId: "ws-fixture", tabId: "tab-a", title: "Checkout preview", origin: "https://preview.example.test" },
  { operation: "capture", status: "completed", captured: true, workspaceId: "ws-fixture", tabId: "tab-a", title: "Checkout preview", origin: "https://preview.example.test" },
  { operation: "input", status: "running", captured: false },
  { operation: "navigate", status: "failed", captured: false },
];
export function BrowserChatPreview(props: Pick<PluginTimelineItemProps, "theme" | "host" | "layout">) {
  return <div style={{ maxWidth: 720, margin: "0 auto", padding: 16, boxSizing: "border-box" }}>
    <p style={{ color: props.theme.colors.foregroundMuted, fontSize: 13 }}>Fictional chat preview · no browser requests</p>
    <p>Check the checkout page, then show me what it looks like.</p>
    {steps.map((data, index) => <Card key={index} {...props} agentId="a1" timestamp={new Date(1_790_000_000_000 + index * 60_000)} item={{ type: "plugin", kind: "hosts-browser-step", version: 1, data }} />)}
  </div>;
}
