import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";

const host = vi.hoisted(() => ({ selected: "linux", settings: null as any, saves: [] as any[], Modal: undefined as any }));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => host.settings,
  useRpc: () => async () => ({ state: host.selected === "mac" ? "unsupported" : "preview", message: host.selected === "mac" ? "macOS: does nothing here" : "Preview: inspect decisions first", actions: [], lastRuns: { renice: null, reap: null, turbo: null, helpers: null }, machine: null, enabled: true, dryRun: true, checkedAt: 1 }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ get Modal() { return host.Modal; }, Icon: () => null }));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  const component = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return Object.fromEntries(["SettingsCard", "SettingsSection", "SettingsSelect", "SettingsSwitch"].map((name) => [name, component(name)]));
});
vi.mock("react-native", async () => {
  const React = await import("react");
  const component = (name: string) => React.forwardRef((props: any, ref) => React.createElement(name, { ...props, ref }, props.children));
  return { View: component("View"), Text: component("Text"), Pressable: component("Pressable"), ActivityIndicator: component("ActivityIndicator"), ScrollView: component("ScrollView"), Clipboard: {}, Platform: { OS: "web" } };
});
const { HousekeepingControls, HousekeepingSettingsSection, HousekeepingSection } = await import("../client/housekeeping");
const theme = { colors: new Proxy({}, { get: () => "#336699" }) } as never;
const mounted: ReactTestRenderer[] = [], clients: QueryClient[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  host.selected = "linux"; host.saves = [];
  host.settings = { status: "ready", revision: "1", values: structuredClone(HOSTS_SETTINGS_DEFAULTS), saving: false, saveError: null, save: vi.fn(async (values, revision) => { host.saves.push({ values, revision }); return true; }) };
  host.Modal = ({ children, open }: any) => open ? React.createElement("Dialog", {}, children) : null;
});
afterEach(async () => { await act(async () => { mounted.splice(0).forEach((r) => r.unmount()); }); clients.splice(0).forEach((c) => c.clear()); });
async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer; const focused: string[] = [];
  await act(async () => { renderer = create(element, { createNodeMock: (node) => ({ focus: () => focused.push(String((node.props as any).accessibilityLabel)) }) }); await flush(); });
  mounted.push(renderer); return { renderer, focused };
}
function button(r: ReactTestRenderer, label: string) { return r.root.findAll((node) => node.type === "Pressable" as any && node.props.accessibilityLabel === label)[0]!; }
function control(r: ReactTestRenderer, label: string) { return r.root.findAll((node) => node.type === "SettingsSwitch" as any && node.props.label === label)[0]!; }

describe("Housekeeping native controls", () => {
  it("requires explicit live confirmation; Cancel is focused and Enter never saves", async () => {
    const { renderer, focused } = await render(<HousekeepingControls theme={theme} settings={host.settings} supported />);
    await act(async () => { control(renderer, "Preview only").props.onValueChange(false); });
    expect(host.saves).toEqual([]); expect(focused).toContain("Cancel");
    await act(async () => { button(renderer, "Turn on live Housekeeping").props.onPress({ nativeEvent: { key: "Enter" } }); });
    expect(host.saves).toEqual([]);
    await act(async () => { button(renderer, "Cancel").props.onPress(); });
    expect(host.saves).toEqual([]);
    await act(async () => { control(renderer, "Preview only").props.onValueChange(false); });
    await act(async () => { const press = button(renderer, "Turn on live Housekeeping").props.onPress; press({ nativeEvent: {} }); press({ nativeEvent: {} }); await flush(); });
    expect(host.saves).toHaveLength(1); expect(host.saves[0].values.housekeeping.dryRun).toBe(false);
    expect(host.saves[0].values.autoStopRunaways).toBe(false);
  });
  it("switches off and back to preview immediately without live confirmation", async () => {
    const { renderer } = await render(<HousekeepingControls theme={theme} settings={host.settings} supported />);
    await act(async () => { control(renderer, "Housekeeping on").props.onValueChange(false); await flush(); });
    expect(host.saves[0].values.housekeeping.enabled).toBe(false);
    await act(async () => { control(renderer, "Preview only").props.onValueChange(true); await flush(); });
    expect(host.saves[1].values.housekeeping.dryRun).toBe(true);
  });
  it("exposes schedules, ages and priorities in Settings and persists a chosen schedule", async () => {
    const { renderer } = await render(<HousekeepingControls theme={theme} settings={host.settings} supported advanced />);
    const selects = renderer.root.findAll((node) => node.type === "SettingsSelect" as any);
    expect(selects.map((node) => node.props.label)).toEqual([
      "Lower priorities every (minutes)", "Close eligible leftovers every (minutes)", "Trim old caches every (hours)",
      "Browser age to report (hours)", "Orphan query age (hours)", "Keep cache entries for (days)", "Build priority (nice)", "Browser priority (nice)",
    ]);
    await act(async () => { selects[1]!.props.onValueChange("15"); await flush(); });
    expect(host.saves[0].values.housekeeping).toMatchObject({ reapIntervalMinutes: 15, dryRun: true, turboCacheMaxDays: 7 });
  });
  it("keeps separate status caches when Settings changes selected host", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
    const view = (hostId: string) => <QueryClientProvider client={client}><HousekeepingSettingsSection theme={theme} hostId={hostId} /></QueryClientProvider>;
    const { renderer } = await render(view("linux")); await act(async () => { await flush(); });
    expect(control(renderer, "Housekeeping on").props.disabled).toBe(false);
    expect(client.getQueryData(["daemon-link", "linux", "housekeeping"])).toMatchObject({ state: "preview" });
    host.selected = "mac";
    await act(async () => { renderer.update(view("mac")); await flush(); await flush(); });
    expect(control(renderer, "Housekeeping on").props.disabled).toBe(true);
    expect(client.getQueryData(["daemon-link", "mac", "housekeeping"])).toMatchObject({ state: "unsupported" });
  });
  it("keeps process management primary by folding controls and results by default", async () => {
    const client = new QueryClient(); clients.push(client);
    const { renderer } = await render(<QueryClientProvider client={client}><HousekeepingSection theme={theme} hostId="linux" compact={false} /></QueryClientProvider>);
    await act(async () => { await flush(); });
    expect(button(renderer, "Housekeeping").props.accessibilityState.expanded).toBe(false);
    expect(renderer.root.findAll((node) => node.type === "SettingsSwitch" as any)).toHaveLength(0);
    await act(async () => { button(renderer, "Housekeeping").props.onPress(); });
    expect(control(renderer, "Housekeeping on")).toBeDefined();
  });
  it("invalidates an open confirmation when the settings revision changes", async () => {
    const { renderer } = await render(<HousekeepingControls theme={theme} settings={host.settings} supported />);
    await act(async () => { control(renderer, "Preview only").props.onValueChange(false); });
    host.settings = { ...host.settings, revision: "2" };
    await act(async () => { renderer.update(<HousekeepingControls theme={theme} settings={host.settings} supported />); });
    expect(renderer.root.findAll((node) => node.type === "Dialog" as any)).toHaveLength(0);
    expect(host.saves).toEqual([]);
  });
});
