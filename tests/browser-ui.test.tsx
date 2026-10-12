import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../shared/browser";

const rpc = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn(), frame: vi.fn(), close: vi.fn(), appState: new Set<(state: string) => void>() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: { name: string }) => ({ "daemon-link.browser.sessions": rpc.list, "daemon-link.browser.open": rpc.open, "daemon-link.browser.frame": rpc.frame, "daemon-link.browser.close": rpc.close })[contract.name] }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  return { ...Object.fromEntries(["View", "Text", "Pressable", "ScrollView", "Image"].map((name) => [name, make(name)])), Platform: { OS: "ios" },
    AppState: { currentState: "active", addEventListener: (_: string, listener: (state: string) => void) => { rpc.appState.add(listener); return { remove: () => rpc.appState.delete(listener) }; } } };
});
const { BrowserSessions } = await import("../client/browser-sessions");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const session: BrowserSession = { id: "session-a", name: "default", pid: 42, version: "0.27.0", workspaceId: "workspace-a", workspace: "My workspace", chatId: null, chat: null, attribution: "workspace", viewable: true, limitation: null };
const tabs = [{ id: "tab-a", title: "First", url: "https://example.com/first" }, { id: "tab-b", title: "Second", url: "about:blank" }];
const colors = { foreground: "#f5f5f5", foregroundMuted: "#aaaaaa", surface0: "#101010", surface1: "#202020", surface2: "#303030", border: "#454545", accent: "#77aaff", statusDanger: "#ff6666" };
const props = { theme: { colors } as never, layout: { compact: true, platform: "ios" as const }, host: { id: "host-a", label: "Remote host" }, workspaceId: "workspace-a" };
let renderers: ReactTestRenderer[] = []; let clients: QueryClient[] = [];
async function mount(overrides = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  let renderer!: ReactTestRenderer;
  const render = (extra = {}) => <QueryClientProvider client={client}><BrowserSessions {...props} {...overrides} {...extra} /></QueryClientProvider>;
  await act(async () => { renderer = create(render()); }); renderers.push(renderer);
  return { renderer, client, update: async (extra: Record<string, unknown>) => { await act(async () => renderer.update(render(extra))); } };
}
async function ready(assert: () => void) { await vi.waitFor(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); assert(); }, { timeout: 3000 }); }
async function press(renderer: ReactTestRenderer, label: string) { await act(async () => renderer.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === label)[0]!.props.onPress()); }
beforeEach(() => {
  vi.clearAllMocks(); rpc.appState.clear();
  rpc.list.mockResolvedValue({ sessions: [session], warnings: [] }); rpc.open.mockResolvedValue({ viewerId: "viewer-a", tabs, expiresInMs: 15000 });
  rpc.frame.mockImplementation(async ({ tabId }) => ({ frame: { tabId, data: "aGVsbG8=", width: 800, height: 600, capturedAt: 1 }, tabs, message: null })); rpc.close.mockResolvedValue({ ok: true });
});
afterEach(async () => { for (const renderer of renderers) await act(async () => renderer.unmount()); for (const client of clients) client.clear(); renderers = []; clients = []; });
describe("native browser viewer", () => {
  it.each([true, false])("renders readable text and a native image in compact dark/light mode (%s)", async (dark) => {
    const theme = { colors: { ...colors, foreground: dark ? "#f5f5f5" : "#111111", foregroundMuted: dark ? "#aaaaaa" : "#555555", surface0: dark ? "#101010" : "#ffffff" } };
    const { renderer } = await mount({ theme, layout: { compact: dark, platform: "ios" } });
    await ready(() => expect(rpc.list).toHaveBeenCalledWith({ workspaceId: "workspace-a" }));
    await press(renderer, "Watch default"); await ready(() => expect(renderer.root.findAll((node) => (node.type as unknown) === "Image")).toHaveLength(1));
    for (const node of renderer.root.findAll((node) => (node.type as unknown) === "Text")) expect(node.props.style.color).toBeTruthy();
    // Embeddable content has no nested vertical scrolling or flex:1 measurement dependency.
    expect(renderer.root.findAll((node) => (node.type as unknown) === "ScrollView" && !node.props.horizontal)).toHaveLength(0);
    expect(rpc.frame).toHaveBeenCalledWith({ viewerId: "viewer-a", tabId: "tab-a" });
    await press(renderer, "Close view"); expect(rpc.close).toHaveBeenCalledWith({ viewerId: "viewer-a" });
  });
  it("releases capture when hidden, in the background, or on host/workspace change", async () => {
    const { renderer, update } = await mount(); await ready(() => expect(rpc.list).toHaveBeenCalled()); await press(renderer, "Watch default"); await ready(() => expect(rpc.frame).toHaveBeenCalledOnce());
    await update({ visible: false }); expect(rpc.close).toHaveBeenCalledOnce(); const count = rpc.frame.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1100)); expect(rpc.frame).toHaveBeenCalledTimes(count);
    await update({ visible: true }); await ready(() => expect(rpc.open).toHaveBeenCalledTimes(2));
    await act(async () => { rpc.appState.forEach((listener) => listener("background")); }); expect(rpc.close).toHaveBeenCalledTimes(2);
    await act(async () => { rpc.appState.forEach((listener) => listener("active")); }); await ready(() => expect(rpc.open).toHaveBeenCalledTimes(3));
    await update({ host: { id: "host-b", label: "Other host" } }); expect(rpc.close).toHaveBeenCalledTimes(3); expect(rpc.open).toHaveBeenCalledTimes(3);
    await update({ workspaceId: "workspace-b" }); expect(rpc.open).toHaveBeenCalledTimes(3);
  });
  it("releases a late open response after unmount and never requests a frame", async () => {
    let finish!: (value: unknown) => void; rpc.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { renderer } = await mount(); await ready(() => expect(rpc.list).toHaveBeenCalled()); await press(renderer, "Watch default");
    await act(async () => renderer.unmount()); renderers = [];
    await act(async () => finish({ viewerId: "late-view", tabs, expiresInMs: 15000 }));
    expect(rpc.close).toHaveBeenCalledWith({ viewerId: "late-view" }); expect(rpc.frame).not.toHaveBeenCalled();
  });
  it("keeps selection by tab ID and drops old pixels immediately on tab selection", async () => {
    const { renderer } = await mount(); await ready(() => expect(rpc.list).toHaveBeenCalled()); await press(renderer, "Watch default"); await ready(() => expect(rpc.frame).toHaveBeenCalledOnce());
    rpc.frame.mockImplementation(async ({ tabId }) => ({ frame: { tabId, data: "bmV3", width: 800, height: 600, capturedAt: 2 }, tabs: [...tabs].reverse(), message: null }));
    await press(renderer, "Second"); expect(renderer.root.findAll((node) => (node.type as unknown) === "Image")).toHaveLength(0);
    await ready(() => expect(rpc.frame).toHaveBeenLastCalledWith({ viewerId: "viewer-a", tabId: "tab-b" }));
    const button = renderer.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === "Second")[0]!;
    expect(button.props.accessibilityState.selected).toBe(true);
  });
});
