import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesProcess, processOrder, type ProcessReport, type ProcessRow } from "../shared/processes";
import { DiskReportSchema } from "../shared/disk";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";
import { clearItem, processReportFixture, processRow, workspaceUsage } from "./resource-table-fixtures";

const settings = vi.hoisted(() => ({ state: {} as Record<string, unknown>, save: vi.fn() }));
const rpc = vi.hoisted(() => ({ report: vi.fn(), preview: vi.fn(), stop: vi.fn(), other: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => contract.name === "daemon-link.processes.report" ? rpc.report : contract.name === "daemon-link.processes.preview" ? rpc.preview : contract.name === "daemon-link.processes.stop" ? rpc.stop : rpc.other,
  usePaseo: () => null,
  useSettings: () => settings.state,
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return { SettingsCard: ({ children }: { children: React.ReactNode }) => React.createElement("SettingsCard", {}, children), SettingsSelect: (props: Record<string, unknown>) => React.createElement("SettingsSelect", props) };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, useToast: undefined, copyText: undefined, Modal: undefined }));
// Housekeeping has its own settings/RPC tests; these tests exercise table actions only.
vi.mock("../client/housekeeping", () => ({ HousekeepingSection: () => React.createElement("Text", {}, "Housekeeping fixture") }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  return Object.fromEntries(["View", "Text", "Pressable", "TextInput", "ScrollView", "ActivityIndicator"].map((name) => [name, make(name)]));
});
const { ProcessesTab, processesKey, ProcessItem } = await import("../client/processes");
const { WorkspaceList, WorkspaceRow, CacheList } = await import("../client/workspaces");
const { TabBar, TAB_IDS } = await import("../client/navigation");
const { heroState } = await import("../client/home");
const { HeavyJobSettings } = await import("../client/heavy-job-settings");
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
async function mountProcesses(compact = false) {
  const result = await mount(<ProcessesTab theme={theme} compact={compact} hostId={hostId} say={say} />);
  await rendered(() => expect(result.renderer.root.findAllByType(ProcessItem)).toHaveLength(source.length > 25 ? 25 : source.length));
  return result;
}
beforeEach(() => {
  vi.clearAllMocks(); serial = 0;
  settings.save.mockResolvedValue(true);
  settings.state = { status: "ready", values: { ...HOSTS_SETTINGS_DEFAULTS, maxHeavyJobs: 7, autoStopRunaways: true }, revision: "saved-revision", saving: false, saveError: null, save: settings.save };
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

describe("compact host resource summary", () => {
  it("folds measurement explanations while keeping all three drilldowns and threshold settings available", async () => {
    const { renderer } = await mountProcesses(true);
    expect(text(renderer.toJSON())).toContain("Host load");
    expect(text(renderer.toJSON())).not.toContain("Counts job roots");
    expect(buttons(renderer, "Threshold settings")).toHaveLength(1);
    expect(buttons(renderer, "Largest memory users")).toHaveLength(1);
    expect(buttons(renderer, "Busiest processes")).toHaveLength(1);
    expect(buttons(renderer, "Review heavy jobs")).toHaveLength(1);
    await press(renderer, "Busiest processes");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "cpu", direction: "desc" })));
    await press(renderer, "Largest memory users");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "memory", direction: "desc" })));
    await press(renderer, "Load details");
    expect(text(renderer.toJSON())).toContain("Counts job roots");
    expect(text(renderer.toJSON())).toContain("The warning threshold never stops or blocks jobs");
    await press(renderer, "Load details");
    expect(text(renderer.toJSON())).not.toContain("Counts job roots");
    await press(renderer, "Review heavy jobs");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "jobs" })));
    expect(rpc.stop).not.toHaveBeenCalled();
  });
  it("uses the actual panel width and leaves the desktop summary expanded", async () => {
    const { renderer } = await mountProcesses();
    expect(text(renderer.toJSON())).toContain("This host's load");
    expect(text(renderer.toJSON())).toContain("Counts job roots");
    const summary = renderer.root.findAll((node) => (node.type as unknown) === "View" && node.props.accessibilityLabel === "Host load summary")[0]!;
    await act(async () => summary.props.onLayout({ nativeEvent: { layout: { width: 420 } } }));
    expect(buttons(renderer, "Load details")).toHaveLength(1);
    expect(text(renderer.toJSON())).not.toContain("Counts job roots");
    await act(async () => summary.props.onLayout({ nativeEvent: { layout: { width: 1000 } } }));
    expect(text(renderer.toJSON())).toContain("This host's load");
    expect(text(renderer.toJSON())).toContain("Counts job roots");
  });
  it("leaves critical runaway warnings visible when resource details are folded", async () => {
    const report = rpc.report.getMockImplementation()!;
    rpc.report.mockImplementation(async (input) => ({ ...await report(input), runaways: [{ code: "memory-near-limit", severity: "critical", title: "This container's memory is nearly full", pids: [], cwd: null }] }));
    const { renderer } = await mountProcesses(true);
    expect(text(renderer.toJSON())).toContain("This container's memory is nearly full");
    expect(text(renderer.toJSON())).not.toContain("Counts job roots");
  });
});

describe("readable host navigation", () => {
  it("retains all labels in a horizontal scroller on compact screens", async () => {
    const select = vi.fn();
    const { renderer } = await mount(<TabBar theme={theme} compact tabs={TAB_IDS} active="processes" onSelect={select} />);
    const scroller = renderer.root.findByType("ScrollView" as never);
    expect(scroller.props.horizontal).toBe(true);
    for (const label of ["Overview", "Processes", "Workspaces", "Help"]) expect(text(renderer.toJSON())).toContain(label);
    await press(renderer, "Help");
    expect(select).toHaveBeenCalledWith("help");
  });
  it("switches to labelled scrolling when a desktop panel becomes narrow", async () => {
    const { renderer } = await mount(<TabBar theme={theme} compact={false} tabs={TAB_IDS} active="processes" onSelect={() => undefined} />);
    expect(renderer.root.findAllByType("ScrollView" as never)).toHaveLength(0);
    const bar = renderer.root.findAll((node) => (node.type as unknown) === "View" && node.props.accessibilityLabel === "Hosts navigation")[0]!;
    await act(async () => bar.props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
    expect(renderer.root.findByType("ScrollView" as never).props.horizontal).toBe(true);
    for (const label of ["Overview", "Processes", "Workspaces", "Help"]) expect(text(renderer.toJSON())).toContain(label);
  });
});

describe("process pivots and resource drilldown", () => {
  it("shows every heavy job beyond four, globally sorted with tree resource totals", async () => {
    source = Array.from({ length: 30 }, (_, i) => processRow({ pid: i + 1, name: `job-${i}`, actionToken: `token-${i}`, jobRoot: true, job: { kind: "build", label: "Build" }, rssBytes: 1000 - i, tree: { count: 3, rssBytes: 100 + i, cpuPercent: i } }));
    const { renderer } = await mountProcesses();
    await press(renderer, "Heavy jobs");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "jobs", sort: "memory", direction: "desc", offset: 0, limit: 25 })));
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(25));
    expect(renderer.root.findAllByType(ProcessItem)[0]!.props.row.pid).toBe(30);
    expect(renderer.root.findAllByType(ProcessItem).every((row) => row.props.byTree)).toBe(true);
    await press(renderer, "Next page");
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(5));
    await search(renderer, "Search processes", "job-29");
    await rendered(() => expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(1));
    expect(rpc.stop).not.toHaveBeenCalled();
  });
  it("drills into CPU and memory across the host and clears a restrictive filter and search", async () => {
    const { renderer } = await mountProcesses();
    await press(renderer, "Filter: Protected");
    await search(renderer, "Search processes", "missing");
    await press(renderer, "Busiest processes");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "all", query: "", sort: "cpu", direction: "desc", offset: 0 })));
    await press(renderer, "Largest memory users");
    await rendered(() => expect(rpc.report).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "memory", direction: "desc" })));
  });
  it("mounts the provided browser panel and Housekeeping only in their pivots", async () => {
    const { renderer } = await mount(<ProcessesTab theme={theme} compact hostId={hostId} say={say} browserPanel={<TextFixture />} />);
    expect(text(renderer.toJSON())).not.toContain("Browser panel fixture");
    expect(text(renderer.toJSON())).not.toContain("Housekeeping fixture");
    await press(renderer, "Browsers");
    expect(text(renderer.toJSON())).toContain("Browser panel fixture");
    expect(renderer.root.findAllByType(ProcessItem)).toHaveLength(0);
    await press(renderer, "Housekeeping");
    expect(text(renderer.toJSON())).toContain("Housekeeping fixture");
    expect(text(renderer.toJSON())).not.toContain("Browser panel fixture");
    expect(rpc.stop).not.toHaveBeenCalled();
  });
  it("keeps alternate pivots usable when the process report fails and explains a missing browser panel", async () => {
    rpc.report.mockRejectedValue(new Error("offline"));
    const { renderer } = await mount(<ProcessesTab theme={theme} compact hostId={hostId} say={say} />);
    await press(renderer, "Browsers");
    expect(text(renderer.toJSON())).toContain("Browser details aren't available here");
    await press(renderer, "Housekeeping");
    expect(text(renderer.toJSON())).toContain("Housekeeping fixture");
  });
  it("explains older daemon limit wording in the Overview hero, including without load data", () => {
    const verdict = { issues: [{ code: "too-many-jobs", severity: "warning", message: "5 jobs; your limit is 4" }], load: { heavyJobs: 5, heavyJobLimit: 4 } } as never;
    expect(heroState(verdict, true).lead).toContain("above the warning threshold of 4");
    expect(heroState(verdict, true).lead).not.toContain("your limit");
    expect(heroState({ ...verdict as object, load: null } as never, true).lead).toContain("This warning never stops jobs");
  });
  it("offers the saved threshold and every valid value without changing other policies", async () => {
    const { renderer } = await mountProcesses();
    expect(text(renderer.toJSON())).not.toContain("at once is the limit");
    expect(text(renderer.toJSON())).toContain("The warning threshold never stops or blocks jobs");
    await press(renderer, "Threshold settings");
    const select = renderer.root.findByType("SettingsSelect" as never);
    expect(select.props.value).toBe("7");
    expect(select.props.options).toHaveLength(32);
    expect(select.props.options[0].value).toBe("1");
    expect(select.props.options[31].value).toBe("32");
    await act(async () => select.props.onValueChange("32"));
    expect(settings.save).toHaveBeenCalledWith({ ...(settings.state.values as object), maxHeavyJobs: 32 }, "saved-revision");
    expect(rpc.stop).not.toHaveBeenCalled();
  });
  it("shows a settings failure without offering to reset policies", async () => {
    settings.state = { status: "invalid", error: "Stored settings need attention", reload: vi.fn() };
    const { renderer } = await mount(<HeavyJobSettings theme={theme} />);
    expect(text(renderer.toJSON())).toContain("Stored settings need attention");
    expect(buttons(renderer, "Reload settings")).toHaveLength(1);
    expect(settings.save).not.toHaveBeenCalled();
  });
});
function TextFixture() { return React.createElement("Text", {}, "Browser panel fixture"); }

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

describe("workspace browser integration", () => {
  it("opens each registered workspace identity without confusing the folder row id", async () => {
    const open = vi.fn();
    const { renderer } = await mount(<WorkspaceRow theme={theme} compact workspace={workspaceUsage({ id: "folder-proof", names: ["Alpha", "Beta"], workspaceIds: ["workspace-a", "workspace-b"] })} checking={false} onWatchBrowser={open} />);
    await press(renderer, "Watch agent browser in Beta");
    expect(open).toHaveBeenCalledExactlyOnceWith("workspace-b"); expect(open).not.toHaveBeenCalledWith("folder-proof");
    expect(buttons(renderer, "Details for Alpha")).toHaveLength(1);
  });
  it("keeps unlinked folders without an invented browser workspace action", async () => {
    const { renderer } = await mount(<WorkspaceRow theme={theme} compact workspace={workspaceUsage({ state: "unlinked" })} checking={false} onWatchBrowser={vi.fn()} />);
    expect(renderer.root.findAll(node => (node.type as unknown) === "Pressable" && String(node.props.accessibilityLabel).startsWith("Watch agent browser"))).toHaveLength(0);
  });
});
