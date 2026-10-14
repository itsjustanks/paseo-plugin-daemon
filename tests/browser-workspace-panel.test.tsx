import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ presence: vi.fn(async () => ({ workspaceIds: [] as string[] })), upgrade: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: any) => contract.name === "daemon-link.browser.runtime.upgrade" ? fixture.upgrade : fixture.presence }));
vi.mock("@getpaseo/plugin", () => ({ defineRpc: (value: unknown) => value }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("../client/browser-sessions", () => ({ BrowserWorkspacePanel: () => null }));
vi.mock("../client/managed-browser/browser", async () => {
  const { createElement } = await import("react");
  return { ManagedBrowserPanel: (props: Record<string, unknown>) => createElement("ManagedBrowser", props) };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Modal: Object.assign(({ open, children }: any) => open ? children : null, { Content: ({ children }: any) => children }),
}));
vi.mock("../client/managed-browser/browser-runtime-upgrade", async importOriginal => {
  const actual = await importOriginal<typeof import("../client/managed-browser/browser-runtime-upgrade")>();
  const { createElement } = await import("react");
  return { BrowserRuntimeUpgradeAction: (props: Parameters<typeof actual.BrowserRuntimeUpgradeAction>[0]) =>
    createElement("RuntimeUpgrade", props, createElement(actual.BrowserRuntimeUpgradeAction, props)) };
});
import { WorkspaceBrowserPanel } from "../client/managed-browser/panel";
import { createBrowserChatNavigation } from "../client/browser-chat-navigation";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let query: QueryClient;
const props = { host: { id: "host-a", label: "Host" }, workspaceId: "workspace-a", theme: { colors: {} },
  layout: { compact: true, platform: "ios" }, context: "workspace" } as Parameters<typeof WorkspaceBrowserPanel>[0];
beforeEach(() => { fixture.presence.mockReset().mockResolvedValue({ workspaceIds: [] });
  fixture.upgrade.mockReset().mockResolvedValue({ status: "confirmation-required", message: "Fixture", approvalToken: "a".repeat(64), expiresAt: Date.now() + 60_000 });
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
  const open = buttons.find(button => button.props.accessibilityLabel === "Open Hosts Browser");
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
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Open Hosts Browser" })).toHaveLength(0);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  fixture.presence.mockResolvedValue({ workspaceIds: [] });
  await act(async () => { upgrade.props.onVerified(); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fixture.presence).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Open Hosts Browser" })).toHaveLength(1);
});

const legacyError = () => new Error("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: fixture");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function mountBlocked() {
  fixture.presence.mockRejectedValue(legacyError());
  await act(async () => { renderer = create(<QueryClientProvider client={query}><WorkspaceBrowserPanel {...props} /></QueryClientProvider>); });
  await flush();
  const presence = query.getQueryCache().find({ queryKey: ["hosts-managed-browser-presence", "host-a", "workspace-a"] })!;
  expect(presence.isActive()).toBe(true);
  return presence;
}
async function pressRestart() {
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: "Restart Hosts browser runtime" }).props.onPress());
}
async function beginRefetch(presence: Query) {
  const gate = deferred<{ workspaceIds: string[] }>();
  fixture.presence.mockImplementation(() => gate.promise);
  let pending!: Promise<unknown>;
  await act(async () => { pending = presence.fetch().catch(() => undefined); });
  await flush();
  expect(presence.state.error).toBeNull(); expect(presence.state.status).toBe("pending");
  return async () => { await act(async () => { gate.reject(legacyError()); await pending; }); await flush(); };
}
it("retains a delayed preview through pending presence refetch and the same legacy error", async () => {
  const presence = await mountBlocked();
  const original = renderer!.root.findByType("RuntimeUpgrade" as never);
  const preview = deferred<any>(); fixture.upgrade.mockImplementation(() => preview.promise);
  await pressRestart();
  const finish = await beginRefetch(presence);
  expect(renderer!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  await act(async () => { preview.resolve({ status: "confirmation-required", message: "Fixture", approvalToken: "a".repeat(64), expiresAt: Date.now() + 60_000 }); });
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Cancel" })).toHaveLength(1);
  await finish();
  expect(renderer!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Cancel" })).toHaveLength(1);
  expect(fixture.upgrade.mock.calls.map(([input]) => input.action)).toEqual(["preview"]);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
});
it("retains mounted confirmation and pauses automatic polling until verified", async () => {
  const presence = await mountBlocked(); await pressRestart();
  const original = renderer!.root.findByType("RuntimeUpgrade" as never);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Cancel" })).toHaveLength(1);
  vi.useFakeTimers();
  try { await act(async () => { await vi.advanceTimersByTimeAsync(6_000); }); }
  finally { vi.useRealTimers(); }
  expect(fixture.presence).toHaveBeenCalledOnce();
  const finish = await beginRefetch(presence);
  expect(renderer!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Cancel" })).toHaveLength(1);
  await finish();
  expect(fixture.upgrade.mock.calls.map(([input]) => input.action)).toEqual(["preview"]);
});
it.each(["host", "workspace"])("resets generic maintenance and pending approval on %s replacement", async changed => {
  await mountBlocked(); const preview = deferred<any>(); fixture.upgrade.mockImplementation(() => preview.promise);
  await pressRestart(); fixture.presence.mockResolvedValue({ workspaceIds: [] });
  const other = changed === "host" ? { ...props, host: { id: "host-b", label: "Other" } } : { ...props, workspaceId: "workspace-b" };
  await act(async () => renderer!.update(<QueryClientProvider client={query}><WorkspaceBrowserPanel {...other} /></QueryClientProvider>));
  await flush();
  await act(async () => { preview.resolve({ status: "confirmation-required", message: "Old scope", approvalToken: "a".repeat(64) }); });
  expect(renderer!.root.findAllByType("RuntimeUpgrade" as never)).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Open Hosts Browser" })).toHaveLength(1);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  await act(async () => renderer!.update(<QueryClientProvider client={query}><WorkspaceBrowserPanel {...props} /></QueryClientProvider>));
  await flush();
  expect(renderer!.root.findAllByType("RuntimeUpgrade" as never)).toHaveLength(0);
  expect(fixture.upgrade.mock.calls.map(([input]) => input.action)).toEqual(["preview"]);
});

it("keeps maintenance after a successful presence refetch or Cancel until verified", async () => {
  const presence = await mountBlocked(); await pressRestart();
  const original = renderer!.root.findByType("RuntimeUpgrade" as never);
  fixture.presence.mockResolvedValue({ workspaceIds: ["workspace-a"] });
  await act(async () => { await presence.fetch(); }); await flush();
  expect(renderer!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  fixture.upgrade.mockResolvedValue({ status: "cancelled", message: "Cancelled" });
  await act(async () => renderer!.root.findByProps({ accessibilityLabel: "Cancel" }).props.onPress());
  expect(renderer!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(renderer!.root.findAllByProps({ accessibilityLabel: "Restart Hosts browser runtime" })).toHaveLength(1);
  expect(renderer!.root.findAllByType("ManagedBrowser" as never)).toHaveLength(0);
  expect(fixture.upgrade.mock.calls.map(([input]) => input.action)).toEqual(["preview", "cancel"]);
});
