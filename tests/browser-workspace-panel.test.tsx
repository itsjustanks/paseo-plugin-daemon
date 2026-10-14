import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ presence: vi.fn(async () => ({ workspaceIds: [] as string[] })) }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => fixture.presence }));
vi.mock("@getpaseo/plugin", () => ({ defineRpc: (value: unknown) => value }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("../client/browser-sessions", () => ({ BrowserWorkspacePanel: () => null }));
vi.mock("../client/managed-browser/browser", async () => {
  const { createElement } = await import("react");
  return { ManagedBrowserPanel: (props: Record<string, unknown>) => createElement("ManagedBrowser", props) };
});
vi.mock("../client/managed-browser/browser-runtime-upgrade", async () => {
  const { createElement } = await import("react");
  return { BrowserRuntimeUpgradeAction: (props: Record<string, unknown>) => createElement("RuntimeUpgrade", props) };
});
import { WorkspaceBrowserPanel } from "../client/managed-browser/panel";
import { createBrowserChatNavigation } from "../client/browser-chat-navigation";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let query: QueryClient;
const props = { host: { id: "host-a", label: "Host" }, workspaceId: "workspace-a", theme: { colors: {} },
  layout: { compact: true, platform: "ios" }, context: "workspace" } as Parameters<typeof WorkspaceBrowserPanel>[0];
beforeEach(() => { fixture.presence.mockReset().mockResolvedValue({ workspaceIds: [] });
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; query.clear(); });
it("routes a historical tab directly to observation, then restores normal startup on a later generic mount", async () => {
  const navigation = createBrowserChatNavigation({ openPanel: vi.fn() });
  const Panel = navigation.wrap(WorkspaceBrowserPanel);
  const mount = () => <QueryClientProvider client={query}><Panel {...props} /></QueryClientProvider>;
  navigation.open("workspace-a", "agent-a", "closed-tab");
  await act(async () => { renderer = create(mount()); });
  const managed = renderer!.root.findByType("ManagedBrowser" as never);
  expect(managed.props.initialTabId).toBe("closed-tab");
  expect(managed.props.createIfMissing).toBe(false);
  expect(fixture.presence).not.toHaveBeenCalled();
  await act(async () => renderer!.unmount());
  await act(async () => { renderer = create(mount()); });
  expect(fixture.presence).toHaveBeenCalledOnce();
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  const buttons = renderer!.root.findAllByType("Pressable" as never);
  const open = buttons.find(button => button.props.accessibilityLabel === "Open browser");
  expect(open).toBeDefined();
  await act(async () => open!.props.onPress());
  expect(renderer!.root.findByType("ManagedBrowser" as never).props.createIfMissing).toBe(true);
  navigation.stop();
});
it("offers the selected host's restart flow without opening a browser after verification", async () => {
  fixture.presence.mockRejectedValue(new Error("Request failed: HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: restart required requestType=plugin.rpc.invoke.request code=handler_error"));
  await act(async () => { renderer = create(<QueryClientProvider client={query}><WorkspaceBrowserPanel {...props} /></QueryClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const upgrade = renderer!.root.findByType("RuntimeUpgrade" as never);
  expect(upgrade.props.hostLabel).toBe("Host");
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Open browser" })).toHaveLength(0);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  fixture.presence.mockResolvedValue({ workspaceIds: [] });
  await act(async () => { upgrade.props.onVerified(); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fixture.presence).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Open browser" })).toHaveLength(1);
});
