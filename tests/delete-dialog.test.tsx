import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 0.16.0 warning dialog, rendered: it opens on a fresh check, Cancel is the
 * default (focused), Enter never confirms, a big delete needs "I understand"
 * ticked, a double press deletes once, and every opening starts fresh. The
 * Stop sheet in the Workspaces hub follows the same rules.
 */

const host = vi.hoisted(() => ({ Modal: undefined as unknown, calls: [] as Array<{ name: string; input: unknown }>, plan: null as unknown, job: { state: "running", freedBytes: 0, results: [], message: null } }));

vi.mock("@getpaseo/plugin/client/react-native", () => ({ get Modal() { return host.Modal; }, useToast: undefined, copyText: undefined, Icon: () => null }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => async (input: unknown) => {
    host.calls.push({ name: contract.name, input });
    if (contract.name === "daemon-link.disk.preview") return host.plan;
    if (contract.name === "daemon-link.disk.clear") return host.job;
    return {};
  },
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => React.forwardRef((props: Record<string, unknown>, ref) => React.createElement(name, { ...props, ref }, props.children as React.ReactNode));
  return { Text: make("Text"), View: make("View"), Pressable: make("Pressable"), ActivityIndicator: make("ActivityIndicator"), TextInput: make("TextInput"), ScrollView: make("ScrollView"), Clipboard: { setString: () => undefined }, Platform: { OS: "web" } };
});

const { DeleteDialog } = await import("../client/clear");
const { StopSheet } = await import("../client/processes");

const theme = { colors: new Proxy({}, { get: () => "#336699" }) } as never;
const GB = 1024 ** 3;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const Dialog = ({ title, open, children }: { title: string; open: boolean; children: React.ReactNode }) => (open ? React.createElement("Dialog", { title }, children) : null);

const plan = (bytes: number, count: number, refused = 0) => ({
  items: [
    ...Array.from({ length: count }, (_, index) => ({ workspace: "project-hub", where: index === 1 ? `apps/a${index}/.next` : `apps/a${index}/node_modules`, path: `/home/u/hub/apps/a${index}/node_modules`, what: "Installed packages", cost: index === 1 ? "Rebuilt the next time the app builds." : "Comes back.", bytes: Math.round(bytes / count), ok: true, reason: null })),
    ...Array.from({ length: refused }, (_, index) => ({ workspace: "site", where: `dist${index}`, path: `/home/u/site/dist${index}`, what: "Build output", cost: "Rebuilt.", bytes: 10, ok: false, reason: "Something has a file in it open right now." })),
  ],
  bytes, count, checkedAt: Date.now(),
});

const text = (node: ReturnType<ReactTestRenderer["toJSON"]>): string => {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  return (node.children ?? []).map((child) => text(child as never)).join(" ");
};
const pressable = (renderer: ReactTestRenderer, label: string | RegExp) => renderer.root.findAll((node) => (node.type as unknown) === "Pressable" && (typeof label === "string" ? node.props.accessibilityLabel === label : label.test(String(node.props.accessibilityLabel ?? ""))))[0];
const clears = () => host.calls.filter((call) => call.name === "daemon-link.disk.clear");

let focused: string[] = [];
async function open(planValue: unknown, tokens = ["t1", "t2", "t3"], props: Partial<React.ComponentProps<typeof DeleteDialog>> = {}) {
  host.plan = planValue;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DeleteDialog theme={theme} tokens={tokens} open onClose={() => undefined} onStarted={() => undefined} {...props} />, { createNodeMock: (element) => ({ focus: () => { focused.push(String((element.props as { accessibilityLabel?: string }).accessibilityLabel)); } }) });
    await flush(); await flush();
  });
  return renderer;
}

beforeEach(() => { host.calls = []; focused = []; host.Modal = Dialog; });
afterEach(() => { host.Modal = undefined; });

describe("Delete dialog", () => {
  it("opens on a fresh check and says exactly what goes, by workspace, with what won't and why", async () => {
    const renderer = await open(plan(3 * GB, 3, 1), ["t1", "t2", "t3", "t4"]);
    expect(host.calls[0]).toEqual({ name: "daemon-link.disk.preview", input: { tokens: ["t1", "t2", "t3", "t4"] } });
    const words = text(renderer.toJSON());
    expect(renderer.root.findAll((node) => (node.type as unknown) === "Dialog")[0]!.props.title).toBe("Delete 3 folders (3 GB)?");
    expect(words).toContain("This permanently deletes these folders. They can't be restored from Paseo.");
    expect(words).toContain("How they come back:");
    // One line per kind, from that kind's own words; refused folders aren't listed.
    expect(words).toContain("node_modules: Comes back.");
    expect(words).toContain(".next: Rebuilt the next time the app builds.");
    expect(words).not.toContain("dist0: Rebuilt.");
    expect(words).not.toContain("They come back the next time you install or build");
    expect(words).toContain("project-hub");
    expect(words).toContain("apps/a0/node_modules · 1 GB · Installed packages");
    expect(words).toContain("Won't be deleted");
    expect(words).toContain("site · dist0: Something has a file in it open right now.");
    expect(words).toContain("Checked just now");
    expect(pressable(renderer, "Delete 3 GB")).toBeDefined();
    await act(async () => { renderer.unmount(); });
  });

  it("Cancel is the default: it takes the focus, and the delete button never does", async () => {
    const renderer = await open(plan(3 * GB, 3));
    expect(focused).toEqual(["Cancel: Delete folders?"]);
    expect(focused.some((label) => /Delete 3 GB/.test(label))).toBe(false);
    await act(async () => { renderer.unmount(); });
  });

  it("Enter (or Return) on the delete button does nothing; a click deletes, once, only what passed the check", async () => {
    const started = vi.fn(), closed = vi.fn();
    const renderer = await open(plan(3 * GB, 3, 1), ["t1", "t2", "t3", "t4"], { onStarted: started, onClose: closed });
    const button = pressable(renderer, "Delete 3 GB")!;
    await act(async () => { button.props.onPress({ nativeEvent: { key: "Enter", type: "keydown" } }); button.props.onPress({ nativeEvent: { key: "Return", type: "keyup" } }); await flush(); });
    expect(clears()).toHaveLength(0);
    await act(async () => { button.props.onPress({ nativeEvent: { type: "click" } }); button.props.onPress({ nativeEvent: { type: "click" } }); await flush(); await flush(); });
    expect(clears()).toEqual([{ name: "daemon-link.disk.clear", input: { tokens: ["t1", "t2", "t3"] } }]);
    expect(started).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });

  for (const [name, bigPlan] of [["over 10 GB", plan(11 * GB, 2)], ["over 20 folders", plan(GB, 21)]] as const) {
    it(`a big delete (${name}) needs "I understand" ticked before the button enables`, async () => {
      const renderer = await open(bigPlan, Array.from({ length: bigPlan.count }, (_, index) => `t${index}`));
      const label = `Delete ${name === "over 10 GB" ? "11 GB" : "1 GB"}`;
      expect(pressable(renderer, label)!.props.accessibilityState.disabled).toBe(true);
      expect(pressable(renderer, label)!.props.onPress).toBeUndefined();
      await act(async () => { pressable(renderer, "I understand these will be deleted")!.props.onPress(); await flush(); });
      expect(pressable(renderer, label)!.props.accessibilityState.disabled).toBe(false);
      await act(async () => { pressable(renderer, label)!.props.onPress({ nativeEvent: { type: "click" } }); await flush(); await flush(); });
      expect(clears()).toHaveLength(1);
      await act(async () => { renderer.unmount(); });
    });
  }

  it("Cancel deletes nothing; reopening checks again and forgets the tick", async () => {
    const closed = vi.fn();
    const renderer = await open(plan(11 * GB, 2), ["t1", "t2"], { onClose: closed });
    await act(async () => { pressable(renderer, "I understand these will be deleted")!.props.onPress(); await flush(); });
    await act(async () => { pressable(renderer, /^Cancel:/)!.props.onPress(); await flush(); });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(clears()).toHaveLength(0);
    await act(async () => { renderer.update(<DeleteDialog theme={theme} tokens={["t1", "t2"]} open={false} onClose={closed} onStarted={() => undefined} />); await flush(); });
    await act(async () => { renderer.update(<DeleteDialog theme={theme} tokens={["t1", "t2"]} open onClose={closed} onStarted={() => undefined} />); await flush(); await flush(); });
    expect(host.calls.filter((call) => call.name === "daemon-link.disk.preview")).toHaveLength(2);
    expect(pressable(renderer, "I understand these will be deleted")!.props.accessibilityState.checked).toBe(false);
    expect(pressable(renderer, "Delete 11 GB")!.props.accessibilityState.disabled).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it("without Paseo's dialog it shows the same warning in place", async () => {
    host.Modal = undefined;
    const renderer = await open(plan(3 * GB, 3));
    const words = text(renderer.toJSON());
    expect(words).toContain("Delete 3 folders (3 GB)?");
    expect(words).toContain("This permanently deletes these folders. They can't be restored from Paseo.");
    expect(pressable(renderer, "Delete 3 GB")).toBeDefined();
    await act(async () => { renderer.unmount(); });
  });

  it("nothing passed the check: no delete button, only Close, with each reason", async () => {
    const renderer = await open(plan(0, 0, 2), ["t1", "t2"]);
    expect(text(renderer.toJSON())).toContain("Why not");
    expect(pressable(renderer, /^Delete /)).toBeUndefined();
    await act(async () => { renderer.unmount(); });
  });
});

describe("Stop sheet in the Workspaces hub, styled the same way", () => {
  it("warns in red, Cancel takes the focus, Enter doesn't stop, a double press stops once", async () => {
    const confirm = vi.fn();
    const stopPlan = { graceSeconds: 5, targets: [{ ok: true, pid: 4402, name: "next-server", rssBytes: GB, cpuPercent: 9, children: [] }] } as never;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<StopSheet theme={theme} plan={stopPlan} busy={false} onCancel={() => undefined} onConfirm={confirm} />, { createNodeMock: (element) => ({ focus: () => { focused.push(String((element.props as { accessibilityLabel?: string }).accessibilityLabel)); } }) }); });
    expect(text(renderer.toJSON())).toContain("This stops this process. Anything not saved in it may be lost.");
    expect(focused).toEqual(["Cancel"]);
    const stop = pressable(renderer, "Stop it")!;
    await act(async () => { stop.props.onPress({ nativeEvent: { key: "Enter" } }); await flush(); });
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => { stop.props.onPress({ nativeEvent: { type: "click" } }); stop.props.onPress({ nativeEvent: { type: "click" } }); await flush(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });
});
