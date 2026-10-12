import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ hosts: null as any, ports: [] as any[], sync: vi.fn() }));
vi.mock("../../client/cross-daemon/hosts.client", () => ({ useCrossDaemonHosts: () => fixture.hosts }));
vi.mock("../../client/cross-daemon/sync-scheduler.client", () => ({ listRegisteredDaemons: () => fixture.ports, requestPeerSync: () => fixture.sync() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Text: make("Text"), View: make("View"), Pressable: make("Pressable"), ActivityIndicator: make("ActivityIndicator"), TextInput: make("TextInput"), Clipboard: {} };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, Modal: undefined }));
const { Confirm } = await import("../../client/feedback");
const { CrossDaemonSection } = await import("../../client/cross-daemon/section");
const theme = { colors: new Proxy({}, { get: () => "#888888" }) } as never;
const renderers: ReactTestRenderer[] = [];
const clients: QueryClient[] = [];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function render() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(query);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><CrossDaemonSection theme={theme} layout={{ compact: false } as never} /></QueryClientProvider>); await flush(); });
  renderers.push(renderer);
  await act(flush);
  return renderer;
}
const matching = (renderer: ReactTestRenderer, name: string) => renderer.root.findAll((node) => node.type as unknown === name);
const output = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
beforeEach(() => {
  fixture.hosts = [{ serverId: "local", label: "My Mac", status: "online" }];
  fixture.ports = [{ status: vi.fn(async () => ({ serverId: "local", switchedOn: false, available: true })), describe: vi.fn(async () => { throw new Error("UI must never query credential transport"); }), listPeers: vi.fn(async () => []), setSwitch: vi.fn(async () => {}) }];
});
afterEach(async () => { await act(async () => renderers.splice(0).forEach((renderer) => renderer.unmount())); clients.splice(0).forEach((client) => client.clear()); vi.clearAllMocks(); });

it("asks for full authority with Cancel before enabling, using link-free status queries", async () => {
  const renderer = await render(); const port = fixture.ports[0];
  const toggle = matching(renderer, "Pressable").find((node) => node.props.accessibilityRole === "switch")!;
  expect(toggle.props.disabled).toBe(false);
  await act(async () => toggle.props.onPress());
  expect(port.setSwitch).not.toHaveBeenCalled();
  let confirm = renderer.root.findByType(Confirm);
  expect(confirm.props.open).toBe(true); expect(confirm.props.text).toContain("FULL CONTROL"); expect(confirm.props.text).toContain("beyond Hosts app and file grants");
  await act(async () => confirm.props.onCancel());
  expect(port.setSwitch).not.toHaveBeenCalled();
  await act(async () => toggle.props.onPress());
  confirm = renderer.root.findByType(Confirm);
  const approve = matching(renderer, "Pressable").find((node) => node.props.accessibilityLabel === "Share full daemon authority")!;
  await act(async () => { approve.props.onPress(); approve.props.onPress(); await flush(); });
  expect(port.setSwitch).toHaveBeenCalledExactlyOnceWith(true, true);
  expect(port.describe).not.toHaveBeenCalled();
  expect(output(renderer)).not.toContain("#offer=");
});

it("shows unsupported apps and hosts as unavailable, with no enabled switch", async () => {
  fixture.hosts = null;
  const renderer = await render();
  expect(output(renderer)).toContain("Update Paseo to use connected-host discovery");
  expect(fixture.ports[0].status).not.toHaveBeenCalled();
  expect(matching(renderer, "Pressable").filter((node) => node.props.accessibilityRole === "switch")).toEqual([]);
});

it("shows offline hosts truthfully and disables their switches", async () => {
  fixture.hosts[0].status = "offline";
  const renderer = await render();
  expect(output(renderer)).toContain("Offline.");
  expect(matching(renderer, "Pressable").find((node) => node.props.accessibilityRole === "switch")!.props.disabled).toBe(true);
});

it("closes a failed confirmation, refreshes status, and never implies successful enablement", async () => {
  const port = fixture.ports[0];
  port.setSwitch.mockRejectedValue(new Error("uncertain save"));
  const renderer = await render();
  const toggle = matching(renderer, "Pressable").find((node) => node.props.accessibilityRole === "switch")!;
  await act(async () => toggle.props.onPress());
  const approve = matching(renderer, "Pressable").find((node) => node.props.accessibilityLabel === "Share full daemon authority")!;
  await act(async () => { approve.props.onPress(); approve.props.onPress(); await flush(); });
  expect(port.setSwitch).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType(Confirm).props.open).toBe(false);
  expect(output(renderer)).toContain("change could not be confirmed");
  expect(port.status.mock.calls.length).toBeGreaterThan(1);
  expect(matching(renderer, "Pressable").find((node) => node.props.accessibilityRole === "switch")!.props.accessibilityState.checked).toBe(false);
});
