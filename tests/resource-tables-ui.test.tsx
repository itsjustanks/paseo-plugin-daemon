import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesProcess, processOrder, type ProcessReport, type ProcessRow } from "../shared/processes";
import { DiskReportSchema } from "../shared/disk";
import { clearItem, processReportFixture, processRow, workspaceUsage } from "./resource-table-fixtures";

const rpc = vi.hoisted(() => ({ report: vi.fn(), preview: vi.fn(), stop: vi.fn(), other: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => contract.name === "daemon-link.processes.report" ? rpc.report : contract.name === "daemon-link.processes.preview" ? rpc.preview : contract.name === "daemon-link.processes.stop" ? rpc.stop : rpc.other,
  usePaseo: () => null,
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, useToast: undefined, copyText: undefined, Modal: undefined }));
// Housekeeping has its own settings/RPC tests; these tests exercise table actions only.
vi.mock("../client/housekeeping", () => ({ HousekeepingSection: () => null }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  return Object.fromEntries(["View", "Text", "Pressable", "TextInput", "ScrollView", "ActivityIndicator"].map((name) => [name, make(name)]));
});
const { ProcessesTab, processesKey, ProcessItem } = await import("../client/processes");
const { WorkspaceList, WorkspaceRow, CacheList } = await import("../client/workspaces");
const { ResourceCells, ResourceTable } = await import("../client/resource-table");
const theme = { colors: new Proxy({}, { get: () => "#336699" }) } as never;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const renderers: ReactTestRenderer[] = [];
const clients: QueryClient[] = [];
let source: ProcessRow[];
let serial = 0;
const hostId = "resource-ui-test";
const say = vi.fn();
const text = (node: ReturnType<ReactTestRenderer["toJSON"]>): string => !node ? "" : Array.isArray(node) ? node.map(text).join(" ") : typeof node === "string" ? node : (node.children ?? []).map((child) => typeof child === "string" ? child : text(child)).join(" ");
const buttons = (r: ReactTestRenderer, label: string) => r.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === label);
async function press(r: ReactTestRenderer, label: string) { await act(async () => { const button = buttons(r, label)[0]; expect(button, label).toBeDefined(); expect(button?.props.disabled).not.toBe(true); button!.props.onPress(); }); }
async function search(r: ReactTestRenderer, label: string, value: string) { await act(async () => r.root.findAll((node) => (node.type as unknown) === "TextInput" && node.props.accessibilityLabel === label)[0]!.props.onChangeText(value)); }
async function rendered(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); assertion(); });
}
async function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}>{children}</QueryClientProvider>); });
  renderers.push(renderer);
  return { renderer, client };
}
async function mountProcesses() {
  const result = await mount(<ProcessesTab theme={theme} compact={false} hostId={hostId} say={say} />);
  await rendered(() => expect(result.renderer.root.findAllByType(ProcessItem)).toHaveLength(source.length > 25 ? 25 : source.length));
  return result;
}
beforeEach(() => {
  vi.clearAllMocks(); serial = 0;
  source = [processRow(), processRow({ pid: 43, name: "sleep", actionToken: "token-second", rssBytes: 10 })];
  rpc.report.mockImplementation(async (input) => {
    const rows = source.filter((row) => matchesProcess(row, input)).sort(processOrder(input.sort, input.filter === "jobs", input.direction));
    return { ...processReportFixture(source), checkedAt: ++serial, matched: rows.length, processes: rows.slice(input.offset, input.offset + input.limit) };
  });
  rpc.preview.mockImplementation(async ({ tokens }) => ({ graceSeconds: 10, targets: source.filter((row) => tokens.includes(row.actionToken)).map((row) => ({ pid: row.pid, name: row.name, ok: row.stoppable, reason: row.protectedReason, outsidePaseo: true, rssBytes: row.rssBytes, cpuPercent: row.cpuPercent, children: [] })) }));
  rpc.stop.mockResolvedValue({ escalateAfterSeconds: 10, results: [] });
});
afterEach(async () => { for (const r of renderers.splice(0)) await act(async () => r.unmount()); for (const c of clients.splice(0)) c.clear(); });

describe("native process table actions", () => {
  it("puts Stop on the collapsed no-chat row; preview then Cancel never mutates", async () => {
    const { renderer } = await mountProcesses();
    expect(buttons(renderer, "Copy details of node (PID 42)")).toHaveLength(0);
    await press(renderer, "Stop node (PID 42)…");
    await rendered(() => expect(buttons(renderer, "Cancel")).toHaveLength(1));
    expect(rpc.preview).toHaveBeenCalledWith({ tokens: ["token-original"] });
    expect(text(renderer.toJSON())).toContain("This wasn't started by Paseo. Make sure you don't need it.");
    expect(rpc.stop).not.toHaveBeenCalled();
    await press(renderer, "Cancel");
    expect(rpc.stop).not.toHaveBeenCalled();
    expect(buttons(renderer, "Cancel")).toHaveLength(0);
  });
  it("keeps a selection bound to its token when rows reorder, and drops it when the PID is reused", async () => {
    const { renderer, client } = await mountProcesses();
    await press(renderer, "Select node (PID 42) to stop");
    await act(async () => { client.setQueriesData<ProcessReport>({ queryKey: processesKey(hostId) }, (data) => data && { ...data, processes: [...data.processes].reverse() }); });
    await rendered(() => expect(buttons(renderer, "Stop 1 selected…")).toHaveLength(1));
    await press(renderer, "Stop 1 selected…");
    await rendered(() => expect(rpc.preview).toHaveBeenCalledWith({ tokens: ["token-original"] }));
    await press(renderer, "Cancel");
    await act(async () => { client.setQueriesData<ProcessReport>({ queryKey: processesKey(hostId) }, (data) => data && { ...data, processes: data.processes.map((row) => row.pid === 42 ? { ...row, actionToken: "reused-pid-token" } : row) }); });
    await rendered(() => expect(buttons(renderer, "Stop 1 selected…")).toHaveLength(0));
    expect(rpc.stop).not.toHaveBeenCalled();
  });
  it("keeps the reviewed token through refresh until confirmation", async () => {
    const { renderer, client } = await mountProcesses();
    await press(renderer, "Stop node (PID 42)…");
    await rendered(() => expect(buttons(renderer, "Cancel")).toHaveLength(1));
    await act(async () => { client.setQueriesData<ProcessReport>({ queryKey: processesKey(hostId) }, (data) => data && { ...data, processes: data.processes.map((row) => ({ ...row, actionToken: "new-token" })) }); });
    await press(renderer, "Stop it");
    await rendered(() => expect(rpc.stop).toHaveBeenCalledWith({ tokens: ["token-original"] }));
  });
  it("leaves protected reasons visible without a Stop button", async () => {
    source = [processRow({ name: "codex", stoppable: false, actionToken: null, protectedReason: "An agent. Stop it from its chat in Paseo." })];
    const { renderer } = await mountProcesses();
    expect(text(renderer.toJSON())).toContain("An agent. Stop it from its chat in Paseo.");
    expect(buttons(renderer, "Stop codex (PID 42)…")).toHaveLength(0);
    expect(rpc.preview).not.toHaveBeenCalled();
  });
  it("resets pagination for search, filter and sort; header presses toggle direction", async () => {
    source = Array.from({ length: 30 }, (_, i) => processRow({ pid: i + 1, name: `job-${i}`, actionToken: `token-${i}`, rssBytes: 100 + i }));
    const { renderer } = await mountProcesses();
    await press(renderer, "Next page");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25, limit: 25 })));
    await press(renderer, "Sort by Memory, descending");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, direction: "asc" })));
    await press(renderer, "Next page");
    await search(renderer, "Search processes", "job-29");
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(1));
    expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, query: "job-29" }));
    await search(renderer, "Search processes", "");
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(25));
    await press(renderer, "Next page");
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(5));
    await press(renderer, "Filter: Protected");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, filter: "protected" })));
    await rendered(() => expect(text(renderer.toJSON())).toContain("No processes match these filters"));
  });
  it("adapts a 420px panel to labelled stacked cells with a visible action", async () => {
    const { renderer } = await mountProcesses();
    const table = renderer.root.findByType(ResourceTable);
    await act(async () => table.findByType("View" as never).props.onLayout({ nativeEvent: { layout: { width: 420 } } }));
    expect(renderer.root.findAllByType(ResourceCells).every((cell) => cell.props.compact)).toBe(true);
    expect(text(renderer.toJSON())).toContain("Workspace / chat");
    expect(buttons(renderer, "Stop node (PID 42)…")).toHaveLength(1);
  });
});

describe("native disk table controls", () => {
  it("filters and sorts workspaces locally, resets pages, and keeps reviewed delete tokens", async () => {
    const onDelete = vi.fn();
    const report = DiskReportSchema.parse({ disks: [], scan: { state: "done", startedAt: 1, finishedAt: 1, done: 30, total: 30, partial: false, message: null }, caches: [], clearableBytes: 1, warnings: [], workspaces: Array.from({ length: 30 }, (_, i) => workspaceUsage({ id: `w${i}`, names: [`Workspace ${i}`], totalBytes: i, items: [clearItem({ safe: true, token: `delete-${i}` })] })) });
    const { renderer } = await mount(<WorkspaceList theme={theme} compact report={report} onDelete={onDelete} />);
    expect(renderer.root.findAllByType(WorkspaceRow)[0]?.props.workspace.id).toBe("w29");
    await press(renderer, "Next page");
    expect(renderer.root.findAllByType(WorkspaceRow)).toHaveLength(5);
    await search(renderer, "Search workspaces, projects, branches or paths", "Workspace 29");
    expect(renderer.root.findAllByType(WorkspaceRow)).toHaveLength(1);
    await press(renderer, "Details for Workspace 29");
    expect(onDelete).not.toHaveBeenCalled();
    await press(renderer, "Delete 1 build folder in Workspace 29. Shows a warning first.");
    expect(onDelete).toHaveBeenCalledWith(["delete-29"]);
    await search(renderer, "Search workspaces, projects, branches or paths", "missing");
    expect(text(renderer.toJSON())).toContain("No workspaces match");
    expect(rpc.other).not.toHaveBeenCalled();
  });
  it("shows caches globally by size, supports group/type search, and keeps partial/shared caveats", async () => {
    const groups = [{ id: "a", title: "A", totalBytes: 10, items: [clearItem({ name: "small", bytes: 10 })] }, { id: "b", title: "B", totalBytes: 900, items: [clearItem({ name: "large", bytes: 900, partial: true, sharedBytes: 300, what: "Temporary" })] }];
    const { renderer } = await mount(<CacheList theme={theme} compact groups={groups} />);
    expect(text(renderer.toJSON()).indexOf("large")).toBeLessThan(text(renderer.toJSON()).indexOf("small"));
    expect(text(renderer.toJSON())).toContain("at least");
    expect(text(renderer.toJSON())).toContain("shared; about");
    await press(renderer, "Filter: Temporary");
    expect(text(renderer.toJSON())).not.toContain("small");
    await search(renderer, "Search caches and temporary files", "missing");
    expect(text(renderer.toJSON())).toContain("No measured entries match");
    expect(rpc.other).not.toHaveBeenCalled();
  });
});
