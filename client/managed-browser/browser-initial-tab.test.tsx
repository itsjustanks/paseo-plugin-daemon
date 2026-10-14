import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ calls: [] as { name: string; input: any }[], missing: false, upgrade: false,
  wrong: false, attachGate: null as Promise<void> | null, viewers: new Map<string, any>(), rpc: new Map<string, any>(), sequence: 0 }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable",
  ScrollView: "ScrollView", TextInput: "TextInput", ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} },
  Platform: { OS: "ios" }, useWindowDimensions: () => ({ width: 390, height: 844, scale: 1 }),
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  BackHandler: { addEventListener: () => ({ remove() {} }) }, PanResponder: { create: () => ({ panHandlers: {} }) } }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon", TextInput: "TextInput",
  Modal: Object.assign(() => null, { Content: () => null }) }));
vi.mock("./browser-runtime-upgrade", async () => {
  const { createElement } = await import("react");
  return { BrowserRuntimeUpgradeAction: (props: Record<string, unknown>) => createElement("RuntimeUpgrade", props) };
});
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: (definition: any) => ({ status: "ready", values: definition.schema.parse({}),
    saving: false, revision: "1", save: async () => true, reload() {}, reset() {} }),
  useRpc(contract: any) {
    if (!fixture.rpc.has(contract.name)) fixture.rpc.set(contract.name, async (raw: any) => {
      const input = contract.input.parse(raw); fixture.calls.push({ name: contract.name, input });
      let result;
      if (contract.name.endsWith(".attach")) {
        if (fixture.attachGate) await fixture.attachGate;
        if (fixture.upgrade) throw new Error("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: restart required");
        if (fixture.missing && input.tabId) throw new Error("Browser tab is no longer available");
        const tabId = fixture.wrong ? "unrelated-tab" : input.tabId ?? "open-tab";
        const state = { sessionId: "s".repeat(32), workspaceId: input.workspaceId, status: "ready",
          url: `http://synthetic.invalid/${tabId}`, title: tabId, canGoBack: false, canGoForward: false,
          viewport: { width: 390, height: 744 }, captureScale: 1, navigationGeneration: 0,
          viewportGeneration: 0, devicePresetId: null, userAgent: "Fixture", controller: "none",
          controllerLabel: null, controllerExpiresAt: null, viewerCount: 1, error: null,
          runtimeId: "r".repeat(32), tabId, bridgeEpoch: 1 };
        const viewerToken = String(++fixture.sequence).padStart(32, "v"); fixture.viewers.set(viewerToken,state);
        result = { viewerToken, state };
      } else if (contract.name.endsWith(".tabs.list")) {
        result = { tabs: ["historical-tab", "open-tab"].map(id => ({ id, title: id,
          url: `http://synthetic.invalid/${id}`, viewerCount: 1, controllerLabel: null })) };
      } else if (contract.name.endsWith(".capture")) result = { state: fixture.viewers.get(input.viewerToken), frame: null };
      else if (contract.name.endsWith(".detach")) result = { detached: true };
      else throw new Error(`Unexpected mutation in observation test: ${contract.name}`);
      return contract.output.parse(result);
    });
    return fixture.rpc.get(contract.name);
  },
}));
import { ManagedBrowserPanel } from "./browser";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | null = null; let client: QueryClient;
const props = { theme: { colors: {} }, host: { id: "host", label: "Fixture" },
  workspaceId: "workspace-one", layout: { compact: true, platform: "ios" }, context: "workspace" } as any;
async function render(extra: any, update = false) {
  await act(async () => {
    const element = <QueryClientProvider client={client}><ManagedBrowserPanel {...props} {...extra} /></QueryClientProvider>;
    if (update) tree!.update(element); else tree = create(element);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  for (let i=0;i<4;i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
function noMutations() {
  expect(fixture.calls.some(c => /control\.acquire|tabs\.create|\.reopen|\.navigate|viewport\.resize/.test(c.name))).toBe(false);
  expect(fixture.calls.filter(c => c.name.endsWith(".attach")).every(c => c.input.create === false)).toBe(true);
}
beforeEach(() => { fixture.calls=[]; fixture.missing=false; fixture.upgrade=false; fixture.wrong=false; fixture.attachGate=null; fixture.viewers.clear();
  fixture.rpc.clear(); fixture.sequence=0; client=new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(async () => { if(tree) await act(async () => {tree!.unmount();}); tree=null; client.clear(); });
it("preserves a validated initial tab through mount resets and observes it without creating or acquiring", async () => {
  await render({ initialTabId: "historical-tab", createIfMissing: true });
  const attaches=fixture.calls.filter(c => c.name.endsWith(".attach")); expect(attaches).toHaveLength(1);
  expect(attaches[0]!.input).toMatchObject({ tabId: "historical-tab", workspaceId: "workspace-one", create: false });
  expect(fixture.calls.some(c => c.name.endsWith(".capture"))).toBe(true); noMutations();
});
it("missing historical tab stays unavailable until an explicit return to existing tabs", async () => {
  fixture.missing=true; await render({ initialTabId: "historical-tab", createIfMissing: true });
  expect(JSON.stringify(tree!.toJSON())).toContain("Browser tab unavailable");
  expect(fixture.calls.some(c => c.name.endsWith(".capture"))).toBe(false); noMutations();
  await act(async () => { tree!.root.findByProps({ accessibilityLabel: "Show open tabs" }).props.onPress(); });
  await render({ initialTabId: "historical-tab", createIfMissing: true }, true);
  const attaches=fixture.calls.filter(c => c.name.endsWith(".attach")); expect(attaches).toHaveLength(2);
  expect(attaches[1]!.input).toMatchObject({ workspaceId: "workspace-one", create: false });
  expect(attaches[1]!.input).not.toHaveProperty("tabId"); noMutations();
});
it("invalid tab IDs perform no RPC before the explicit return action", async () => {
  await render({ initialTabId: "../invalid", createIfMissing: true });
  expect(JSON.stringify(tree!.toJSON())).toContain("Browser tab unavailable"); expect(fixture.calls).toEqual([]);
});
it("a caller changing workspace in place cannot leak the previous initial tab selection", async () => {
  await render({ initialTabId: "historical-tab" });
  await render({ initialTabId: "historical-tab", workspaceId: "workspace-two" }, true);
  const other=fixture.calls.filter(c => c.name.endsWith(".attach") && c.input.workspaceId==="workspace-two");
  expect(other.length).toBeGreaterThan(0); expect(other.every(c => c.input.tabId===undefined)).toBe(true); noMutations();
});
it("a mismatched attach reply is detached and never authorizes unrelated frames", async () => {
  fixture.wrong=true; await render({ initialTabId: "historical-tab" });
  expect(JSON.stringify(tree!.toJSON())).toContain("Browser tab unavailable");
  expect(fixture.calls.some(c => c.name.endsWith(".detach"))).toBe(true);
  expect(fixture.calls.some(c => c.name.endsWith(".capture"))).toBe(false); noMutations();
});
it("shows runtime maintenance before historical-tab refusal and retries only that tab without creation", async () => {
  fixture.upgrade = true;
  await render({ initialTabId: "historical-tab", createIfMissing: true });
  expect(JSON.stringify(tree!.toJSON())).toContain("Browser runtime restart required");
  expect(JSON.stringify(tree!.toJSON())).not.toContain("Browser tab unavailable");
  const upgrade = tree!.root.findByType("RuntimeUpgrade" as never);
  expect(upgrade.props.hostLabel).toBe("Fixture");
  noMutations();
  fixture.upgrade = false; fixture.missing = true;
  await act(async () => { upgrade.props.onVerified(); });
  await render({ initialTabId: "historical-tab", createIfMissing: true }, true);
  const attaches = fixture.calls.filter(c => c.name.endsWith(".attach"));
  expect(attaches).toHaveLength(2);
  expect(attaches.every(c => c.input.tabId === "historical-tab")).toBe(true);
  expect(JSON.stringify(tree!.toJSON())).toContain("Browser tab unavailable");
  noMutations();
});
it("consumes an explicit create permit before the blocked attach and never replays it after restart", async () => {
  fixture.upgrade = true;
  await render({ createIfMissing: true });
  const upgrade = tree!.root.findByType("RuntimeUpgrade" as never);
  fixture.upgrade = false;
  await act(async () => { upgrade.props.onVerified(); });
  await render({ createIfMissing: true }, true);
  const attaches = fixture.calls.filter(c => c.name.endsWith(".attach"));
  expect(attaches.map(c => c.input.create)).toEqual([true, false]);
  expect(fixture.calls.some(c => /control\.acquire|tabs\.create|\.reopen|\.navigate/.test(c.name))).toBe(false);
});

it("retains historical maintenance across a pending and same-error attachment refetch", async () => {
  fixture.upgrade = true; await render({ initialTabId: "historical-tab", createIfMissing: true });
  const original = tree!.root.findByType("RuntimeUpgrade" as never);
  const query = client.getQueryCache().findAll({ queryKey: ["hosts-browser", "attach"] })[0]!;
  expect(query.isActive()).toBe(true);
  let release!: () => void; fixture.attachGate = new Promise<void>(resolve => { release = resolve; });
  let pending!: Promise<unknown>;
  await act(async () => { pending = query.fetch().catch(() => undefined); });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(query.state.error).toBeNull(); expect(query.state.status).toBe("pending");
  expect(tree!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(JSON.stringify(tree!.toJSON())).not.toContain("Browser tab unavailable");
  await act(async () => { release(); await pending; });
  await render({ initialTabId: "historical-tab", createIfMissing: true }, true);
  expect(tree!.root.findByType("RuntimeUpgrade" as never)).toBe(original);
  expect(fixture.calls.filter(c => c.name.endsWith(".attach")).every(c => c.input.tabId === "historical-tab")).toBe(true);
  noMutations();
});
it.each(["host", "workspace"])("resets historical maintenance when the %s scope changes in place", async changed => {
  fixture.upgrade = true; await render({ initialTabId: "historical-tab", createIfMissing: true });
  expect(tree!.root.findAllByType("RuntimeUpgrade" as never)).toHaveLength(1);
  fixture.upgrade = false;
  const other = changed === "host" ? { host: { id: "other-host", label: "Other" } } : { workspaceId: "other-workspace" };
  await render({ initialTabId: "historical-tab", createIfMissing: true, ...other }, true);
  expect(tree!.root.findAllByType("RuntimeUpgrade" as never)).toHaveLength(0);
  await render({ initialTabId: "historical-tab", createIfMissing: true }, true);
  expect(tree!.root.findAllByType("RuntimeUpgrade" as never)).toHaveLength(0);
  noMutations();
});
