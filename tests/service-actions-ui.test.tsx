import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Process } from "../client/rpc";

const rpc = vi.hoisted(() => ({ preview: vi.fn(), stop: vi.fn(), forceStop: vi.fn(), other: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: { name: string }) => contract.name === "daemon-link.processes.preview" ? rpc.preview : rpc.other, usePaseo: () => null, useSettings: () => ({ status: "loading" }) }));
vi.mock("@getpaseo/plugin/client/ui", async () => { const React = await import("react"); return { SettingsSelect: (props: any) => React.createElement("SettingsSelect", props) }; });
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, Modal: undefined, useToast: undefined }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return Object.fromEntries(["Text", "View", "Pressable", "ScrollView", "TextInput", "ActivityIndicator"].map((name) => [name, make(name)]));
});
const { ServiceCard, ProcessRow, ForceStopModal, useProcessActions } = await import("../client/surface");
const { ServiceTable } = await import("../client/service-table");
const { ResourceTable, ResourceCells } = await import("../client/resource-table");
const { TokensProvider, tokens } = await import("../client/ui");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const theme = { colors: new Proxy({}, { get: () => "#888888" }) } as never;
const process: Process = { pid: 42, ppid: 1, name: "python3", command: "python3 -m http.server", cwd: null, state: "sleeping", cpuPercent: 0, rssBytes: 100, memoryPercent: 1, ageSeconds: 10, ports: [8000], classification: { kind: "dev-server", label: "Python HTTP server", reasons: [] }, impact: "normal", impactReasons: [], actionable: true, protectedReason: null, actionToken: "reviewed-token" };
const clients: QueryClient[] = [], renderers: ReactTestRenderer[] = [];
const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const buttons = (r: ReactTestRenderer, label: string) => r.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === label);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function press(r: ReactTestRenderer, label: string) { await act(async () => { const button = buttons(r, label)[0]; expect(button, label).toBeDefined(); button.props.onPress({}); await flush(); }); }
function Harness({ token = "reviewed-token", pending = false, protectedRow = false }: { token?: string; pending?: boolean; protectedRow?: boolean }) {
  const row = { ...process, actionToken: protectedRow ? null : token, actionable: !protectedRow, protectedReason: protectedRow ? "Protected system service" : null };
  const pendingStops: Parameters<typeof useProcessActions>[0]["pendingStops"] = { pending: pending ? { "42:python3": { key: "42:python3", pid: 42, name: "python3", startedAt: Date.now(), survivedPolls: 3 } } : {}, mark: vi.fn(), clear: vi.fn() };
  const actions = useProcessActions({ theme, rpc: rpc as never, snapshot: undefined, pendingStops, refresh: () => undefined });
  return <><ServiceCard process={row} actions={actions.actions} />{actions.stopReview}<ForceStopModal theme={theme} target={actions.liveForceTarget} plan={actions.forcePlan} busy={actions.forceMutation.isPending} onCancel={() => actions.setForceTarget(null)} onConfirm={(target) => actions.forceMutation.mutate(target)} /></>;
}
const wrap = (child: React.ReactNode, client: QueryClient) => <QueryClientProvider client={client}><TokensProvider value={tokens(theme, false)}>{child}</TokensProvider></QueryClientProvider>;
async function mount(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  let renderer!: ReactTestRenderer; await act(async () => { renderer = create(wrap(child, client)); await flush(); }); renderers.push(renderer); return { renderer, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.preview.mockResolvedValue({ graceSeconds: 10, targets: [{ pid: 42, name: "python3", ok: true, reason: null, rssBytes: 100, cpuPercent: 0, children: [], outsidePaseo: true, workspaceWarnings: ["Inside Sandbox, but Paseo didn't start it"], tagWarnings: ["Tagged as started by chat Build Website, but Paseo can't confirm it"] }] });
  rpc.stop.mockResolvedValue({ ok: true, status: "signaled", message: "Requested stop" }); rpc.forceStop.mockResolvedValue({ ok: true, status: "signaled" });
});
afterEach(async () => { await act(async () => renderers.splice(0).forEach((r) => r.unmount())); clients.splice(0).forEach((c) => c.clear()); });

it("shows Stop without an active chat and previews warnings; Cancel never signals", async () => {
  const { renderer } = await mount(<Harness />);
  expect(text(renderer)).toContain("Listening · waiting for requests");
  await press(renderer, "Stop python3 (PID 42)…");
  expect(rpc.preview).toHaveBeenCalledExactlyOnceWith({ tokens: ["reviewed-token"] });
  expect(text(renderer)).toContain("This wasn't started by Paseo");
  expect(text(renderer)).toContain("Inside Sandbox, but Paseo didn't start it");
  expect(text(renderer)).toContain("Tagged as started by chat");
  expect(text(renderer)).toContain("review Force stop separately");
  expect(text(renderer)).not.toContain("after 10 seconds is stopped forcefully");
  expect(rpc.stop).not.toHaveBeenCalled();
  await press(renderer, "Cancel"); expect(rpc.stop).not.toHaveBeenCalled();
});
it("retains the reviewed token across snapshot refresh, refuses Enter, and confirms once", async () => {
  const { renderer, client } = await mount(<Harness />);
  await press(renderer, "Stop python3 (PID 42)…");
  await act(async () => renderer.update(wrap(<Harness token="replacement-token" />, client)));
  const approve = buttons(renderer, "Stop it")[0];
  await act(async () => approve.props.onPress({ nativeEvent: { key: "Enter" } }));
  expect(rpc.stop).not.toHaveBeenCalled();
  await act(async () => { approve.props.onPress({}); approve.props.onPress({}); await flush(); });
  expect(rpc.stop).toHaveBeenCalledExactlyOnceWith({ token: "reviewed-token" });
});
it("shows preview refusal without a destructive action", async () => {
  rpc.preview.mockResolvedValue({ graceSeconds: 10, targets: [{ pid: 42, name: "python3", ok: false, reason: "The process identity changed", rssBytes: 0, cpuPercent: null, children: [] }] });
  const { renderer } = await mount(<Harness />); await press(renderer, "Stop python3 (PID 42)…");
  expect(text(renderer)).toContain("The process identity changed");
  expect(buttons(renderer, "Stop it")).toHaveLength(0); expect(rpc.stop).not.toHaveBeenCalled();
});
it("previews Force separately, carries warnings and children, and Cancel leaves it running", async () => {
  const { renderer } = await mount(<Harness pending />); await press(renderer, "Force stop python3 (PID 42)");
  expect(rpc.preview).toHaveBeenCalledExactlyOnceWith({ tokens: ["reviewed-token"] });
  expect(text(renderer)).toContain("This wasn't started by Paseo");
  expect(rpc.forceStop).not.toHaveBeenCalled();
  await press(renderer, "Cancel force stop of python3"); expect(rpc.forceStop).not.toHaveBeenCalled();
});
it("force confirms once with its reviewed token, never a refreshed identity", async () => {
  const { renderer, client } = await mount(<Harness pending />); await press(renderer, "Force stop python3 (PID 42)");
  await act(async () => renderer.update(wrap(<Harness pending token="replacement-token" />, client)));
  const approve = buttons(renderer, "Confirm force stop of python3, PID 42")[0];
  await act(async () => { approve.props.onPress({}); approve.props.onPress({}); await flush(); });
  expect(rpc.forceStop).toHaveBeenCalledExactlyOnceWith({ token: "reviewed-token" });
});
it("keeps protection reasons visible without offering Stop", async () => {
  const { renderer } = await mount(<Harness protectedRow />); expect(text(renderer)).toContain("Protected system service");
  expect(buttons(renderer, "Stop python3 (PID 42)…")).toHaveLength(0); expect(rpc.preview).not.toHaveBeenCalled();
});
it("defaults to memory descending, retains CPU and adapts inside a narrow desktop panel", async () => {
  const { renderer } = await mount(<ServiceTable theme={theme} compact={false} services={[process, { ...process, pid: 43, name: "vite", rssBytes: 1000, cpuPercent: 80 }]} actions={{ pending: {}, onStop: vi.fn(), onForce: vi.fn(), stopping: undefined }} renderOpen={() => null} />);
  expect(buttons(renderer, "Sort by Memory, descending")).toHaveLength(1);
  expect(renderer.root.findAllByType(ResourceCells)[0].props.cells.app.props.children[1].props.children).toContain("vite");
  await press(renderer, "Sort by CPU"); expect(buttons(renderer, "Sort by CPU, descending")).toHaveLength(1);
  const table = renderer.root.findByType(ResourceTable);
  await act(async () => table.findByType("View" as never).props.onLayout({ nativeEvent: { layout: { width: 680 } } }));
  expect(renderer.root.findAllByType(ResourceCells).every((cell) => cell.props.compact)).toBe(true);
  expect(text(renderer)).toContain("Up to 50 listening apps"); expect(text(renderer)).toContain("Owner unknown");
  await act(async () => renderer.root.findAll((node) => (node.type as unknown) === "TextInput")[0].props.onChangeText("8000"));
  expect(renderer.root.findAllByType(ResourceCells)).toHaveLength(2);
});

it("wraps workspace process names and groups figures in a narrow desktop panel", async () => {
  const name = "Python HTTP server with a deliberately long process name";
  const { renderer } = await mount(<ProcessRow process={{ ...process, name }} first expanded onToggle={() => undefined} actions={{ pending: {}, onStop: vi.fn(), onForce: vi.fn(), stopping: undefined }} />);
  const row = renderer.root.findByType(ProcessRow).findAllByType("View" as never).find((node) => node.props.onLayout)!;
  await act(async () => row.props.onLayout({ nativeEvent: { layout: { width: 680 } } }));
  const toggle = renderer.root.findAllByType("Pressable" as never).find((node) => node.props.accessibilityState?.expanded)!;
  expect(toggle.props.style({ pressed: false }).flexDirection).toBe("column");
  const title = renderer.root.findAllByType("Text" as never).find((node) => node.props.children === name)!;
  expect(title.props.numberOfLines).toBeUndefined();
  expect(buttons(renderer, `Stop ${name} (PID 42)…`)).toHaveLength(1);
});

it("filters existing app facts, counts matches, and resets an empty search without changing authority", async () => {
  const services = [process, { ...process, pid: 43, name: "vite", project: { name: "Website", workspace: "Sandbox" } as Process["project"], actionable: false, actionToken: null }];
  const { renderer } = await mount(<ServiceTable theme={theme} compact services={services} actions={{ pending: {}, onStop: vi.fn(), onForce: vi.fn(), stopping: undefined }} renderOpen={() => null} />);
  const select = () => renderer.root.findByType("SettingsSelect" as never);
  expect(select().props.options.map((option: any) => option.label)).toEqual(["All apps", "Can stop", "No workspace"]);
  await act(async () => select().props.onValueChange("can-stop"));
  expect(renderer.root.findAllByType(ResourceCells)).toHaveLength(1);
  expect(text(renderer)).toContain("1 of 2 apps in this snapshot");
  await act(async () => select().props.onValueChange("no-workspace"));
  expect(renderer.root.findAllByType(ResourceCells)[0].props.cells.workspace.props.children[0].props.children).toBe("No workspace identified");
  await act(async () => renderer.root.findAllByType("TextInput" as never)[0].props.onChangeText("missing"));
  expect(text(renderer)).toContain("0 of 2 apps in this snapshot");
  expect(text(renderer)).toContain("No apps match this search and filter");
  await press(renderer, "Clear app search and filter");
  expect(select().props.value).toBe("all");
  expect(renderer.root.findAllByType(ResourceCells)).toHaveLength(2);
  expect(buttons(renderer, "Sort by Memory, descending")).toHaveLength(1);
  expect(rpc.stop).not.toHaveBeenCalled(); expect(rpc.preview).not.toHaveBeenCalled();
});
