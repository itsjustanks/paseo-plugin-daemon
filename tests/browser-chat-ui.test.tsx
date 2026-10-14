import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { BrowserChatData } from "../shared/browser-chat";
const agent = vi.hoisted(() => ({ workspaceId: "workspace-a" as string | undefined }));
vi.mock("@getpaseo/plugin/client", () => ({ useAgent: (_: string, select: (a: typeof agent) => unknown) => select(agent) }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null }));
vi.mock("@getpaseo/plugin", () => ({ defineRpc: (value: unknown) => value }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return Object.fromEntries(["View", "Text", "Pressable"].map((name) => [name, (props: Record<string, unknown>) => createElement(name, props, props.children as React.ReactNode)]));
});
const { browserStepCard, registerBrowserChat } = await import("../client/browser-chat");
const { createBrowserChatNavigation } = await import("../client/browser-chat-navigation");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
const props: PluginTimelineItemProps<BrowserChatData> = { theme: { colors: { foreground: "#eee", foregroundMuted: "#aaa", border: "#333", surface1: "#111", statusDanger: "#f77", accent: "#aaf" } } as never, layout: { compact: true, platform: "ios" }, host: { id: "host-a", label: "Server" }, agentId: "agent-a", timestamp: new Date("2026-10-14T00:00:00Z"), item: { type: "plugin", kind: "hosts-browser-step", version: 1, data: { operation: "capture", status: "completed", captured: true, title: "Page", origin: "https://example.test", workspaceId: "workspace-a", tabId: "tab-a" } } };
beforeEach(() => { agent.workspaceId = "workspace-a"; });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });
it.each([true, false])("renders themed compact status with a 44px action, no live reads (%s)", async (dark) => {
  const open = vi.fn(); const Card = browserStepCard(open);
  const theme = { ...props.theme, colors: { ...props.theme.colors, foreground: dark ? "#eee" : "#111" } };
  await act(async () => { renderer = create(<Card {...props} theme={theme} />); });
  const buttons = renderer!.root.findAll((x) => (x.type as unknown) === "Pressable");
  expect(buttons).toHaveLength(1); expect(buttons[0]!.props.style.minHeight).toBe(44); expect(open).not.toHaveBeenCalled();
  await act(async () => buttons[0]!.props.onPress()); expect(open).toHaveBeenCalledExactlyOnceWith("workspace-a", "agent-a", "tab-a");
  for (const text of renderer!.root.findAll((x) => (x.type as unknown) === "Text")) expect(text.props.style.color).toBeTruthy();
});
it.each([undefined, "other-workspace"])("does not navigate a moved or missing agent: %s", async (workspaceId) => {
  agent.workspaceId = workspaceId; const open = vi.fn(); const Card = browserStepCard(open);
  await act(async () => { renderer = create(<Card {...props} />); });
  expect(renderer!.root.findAll((x) => (x.type as unknown) === "Pressable")).toHaveLength(0); expect(open).not.toHaveBeenCalled();
});
it("registers a deterministic transformer and removes both registrations exactly once", () => {
  const removeRenderer = vi.fn(); const removeTransformer = vi.fn();
  const client = { addTimelineRenderer: vi.fn(() => removeRenderer), addTimelineTransformer: vi.fn(() => removeTransformer) } as unknown as PluginClientContext;
  const cleanup = registerBrowserChat(client, vi.fn()); cleanup(); cleanup();
  expect(removeRenderer).toHaveBeenCalledOnce(); expect(removeTransformer).toHaveBeenCalledOnce();
});
it("undoes partial registration and leaves unsupported clients unchanged", () => {
  const remove = vi.fn(); const client = { addTimelineRenderer: vi.fn(() => remove), addTimelineTransformer: vi.fn(() => { throw new Error("unsupported"); }) } as unknown as PluginClientContext;
  registerBrowserChat(client, vi.fn())(); expect(remove).toHaveBeenCalledOnce();
  registerBrowserChat({} as PluginClientContext, vi.fn())();
});
it("keeps tab hints scoped to the installation and selected workspace", async () => {
  const openPanel = vi.fn(); const navigation = createBrowserChatNavigation({ openPanel });
  const received: Array<{ workspaceId: string; initialTabId?: string }> = [];
  const Panel = navigation.wrap((p) => { received.push(p); return null; });
  const panelProps = { ...props, context: "workspace" as const, workspaceId: "workspace-a", openPanel: vi.fn(), openScreen: vi.fn(), openSettings: vi.fn() };
  await act(async () => { renderer = create(<Panel {...panelProps} />); });
  await act(async () => navigation.open("workspace-a", "agent-a", "tab-a"));
  expect(received.at(-1)?.initialTabId).toBe("tab-a"); expect(openPanel).toHaveBeenCalledWith("hosts-browser", { workspaceId: "workspace-a", agentId: "agent-a" });
  await act(async () => navigation.open("workspace-a", "agent-a"));
  expect(received.at(-1)?.initialTabId).toBeUndefined();
  await act(async () => navigation.open("workspace-a", "agent-a", "tab-a"));
  await act(async () => renderer!.update(<Panel {...panelProps} workspaceId="workspace-b" />)); expect(received.at(-1)?.initialTabId).toBeUndefined();
  const other = createBrowserChatNavigation({ openPanel: vi.fn() }); const Other = other.wrap((p) => { received.push(p); return null; });
  await act(async () => renderer!.update(<Other {...panelProps} />)); expect(received.at(-1)?.initialTabId).toBeUndefined();
  navigation.stop(); navigation.open("workspace-a", "agent-a", "tab-b"); expect(openPanel).toHaveBeenCalledTimes(3); other.stop();
});
it.each([false, true])("consumes a chat tab hint on its first mount, including StrictMode=%s", async (strict) => {
  const navigation = createBrowserChatNavigation({ openPanel: vi.fn() });
  const received: Array<string | undefined> = [];
  const Panel = navigation.wrap((p) => { received.push(p.initialTabId); return null; });
  const panelProps = { ...props, context: "workspace" as const, workspaceId: "workspace-a", openPanel: vi.fn(), openScreen: vi.fn(), openSettings: vi.fn() };
  const mount = () => strict ? <React.StrictMode><Panel {...panelProps} /></React.StrictMode> : <Panel {...panelProps} />;
  navigation.open("workspace-a", "agent-a", "tab-old");
  await act(async () => { renderer = create(mount()); });
  expect(received.at(-1)).toBe("tab-old");
  await act(async () => renderer!.unmount()); received.length = 0;
  await act(async () => { renderer = create(mount()); });
  expect(received.length).toBeGreaterThan(0);
  expect(received.every(tabId => tabId === undefined)).toBe(true);
  navigation.stop();
});
it("does not restore a consumed hint after leaving and returning to a workspace", async () => {
  const navigation = createBrowserChatNavigation({ openPanel: vi.fn() });
  const received: Array<string | undefined> = [];
  const Panel = navigation.wrap((p) => { received.push(p.initialTabId); return null; });
  const panelProps = { ...props, context: "workspace" as const, workspaceId: "workspace-a", openPanel: vi.fn(), openScreen: vi.fn(), openSettings: vi.fn() };
  navigation.open("workspace-a", "agent-a", "tab-old");
  await act(async () => { renderer = create(<Panel {...panelProps} />); });
  await act(async () => renderer!.update(<Panel {...panelProps} workspaceId="workspace-b" />));
  await act(async () => renderer!.update(<Panel {...panelProps} />));
  expect(received.at(-1)).toBeUndefined(); navigation.stop();
});
