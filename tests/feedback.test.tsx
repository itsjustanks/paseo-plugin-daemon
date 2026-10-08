import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNTHETIC_ANTHROPIC_KEY } from "./synthetic-secrets";

/**
 * 0.15.0 behaviour, rendered (react-test-renderer): Paseo's toast, clipboard
 * and dialog stand-ins are switched on and off to play each kind of app.
 * Confirm acts once however fast it's pressed, Cancel and dismiss never act,
 * copies are honest about failing, and every word is redacted.
 */

type ToastCall = { text: string; variant?: string };
const host = vi.hoisted(() => ({
  useToast: undefined as undefined | (() => { show(text: string, options?: { variant?: string }): void; error(text: string): void }),
  copyText: undefined as undefined | ((text: string) => Promise<void>),
  Modal: undefined as unknown,
  clipboard: { answer: undefined as unknown, last: "" },
}));

vi.mock("@getpaseo/plugin/client/react-native", () => ({
  get useToast() { return host.useToast; },
  get copyText() { return host.copyText; },
  get Modal() { return host.Modal; },
  Icon: () => null,
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  return {
    Text: make("Text"), View: make("View"), Pressable: make("Pressable"), ActivityIndicator: make("ActivityIndicator"), TextInput: make("TextInput"), ScrollView: make("ScrollView"),
    Clipboard: { setString: (text: string) => { host.clipboard.last = text; return host.clipboard.answer; } },
    Platform: { OS: "web" },
  };
});

const { Confirm, SayProvider, copyToClipboard, useCopy, useSafeToast, useSay } = await import("../client/feedback");
const { ConfirmButton, TokensProvider, useUi } = await import("../client/ui");
const { StopSheet } = await import("../client/processes");

const theme = { colors: new Proxy({}, { get: () => "#336699" }) } as never;
const SECRET = SYNTHETIC_ANTHROPIC_KEY;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const toasts: ToastCall[] = [];
const copied: string[] = [];
let copyFails = false;
const toastApi = { show: (text: string, options?: { variant?: string }) => { toasts.push({ text, variant: options?.variant }); }, error: (text: string) => { toasts.push({ text, variant: "error" }); } };
/** A real hook, as the app's is, so hook order is exercised. */
const useToastStub = () => React.useRef(toastApi).current;
const Dialog = ({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }) => (open ? React.createElement("Dialog", { title, onOpenChange }, children) : null);

function withApp(app: { toast?: boolean; copy?: boolean; modal?: boolean }) {
  host.useToast = app.toast ? useToastStub : undefined;
  host.copyText = app.copy ? async (text: string) => { if (copyFails) throw new Error("denied"); copied.push(text); } : undefined;
  host.Modal = app.modal ? Dialog : undefined;
}

const text = (node: ReturnType<ReactTestRenderer["toJSON"]>): string => {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  return (node.children ?? []).map((child) => text(child as never)).join(" ");
};
const pressable = (renderer: ReactTestRenderer, label: string) => renderer.root.findAll((node) => (node.type as unknown) === "Pressable" && node.props.accessibilityLabel === label)[0];
const dialogs = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => (node.type as unknown) === "Dialog");
async function press(renderer: ReactTestRenderer, label: string, times = 1) {
  const target = pressable(renderer, label);
  if (!target) throw new Error(`No button "${label}" in: ${text(renderer.toJSON())}`);
  await act(async () => { for (let i = 0; i < times; i += 1) target.props.onPress(); await flush(); });
}

beforeEach(() => { toasts.length = 0; copied.length = 0; copyFails = false; host.clipboard = { answer: undefined, last: "" }; });
afterEach(() => { withApp({}); });

function ConfirmHarness({ inPlace, onConfirm, onCancel }: { inPlace?: boolean; onConfirm(): void; onCancel(): void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Pressable accessibilityLabel="ask" onPress={() => setOpen(true)} />
      <Confirm theme={theme} open={open} inPlace={inPlace} title="Restart Activity?" text={`It reloads. token=${SECRET}`} confirmLabel="Restart Activity"
        onConfirm={() => { onConfirm(); setOpen(false); }} onCancel={() => { onCancel(); setOpen(false); }} />
    </>
  );
}
const Pressable = (props: Record<string, unknown>) => React.createElement("Pressable", props);

describe("Confirm", () => {
  for (const app of [{ name: "Paseo's dialog", modal: true }, { name: "an older app (in place)", modal: false }]) {
    it(`${app.name}: confirm acts once on a double press, re-arms on reopening; Cancel and dismiss never act; text redacted`, async () => {
      withApp({ modal: app.modal });
      const confirm = vi.fn(), cancel = vi.fn();
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(<ConfirmHarness onConfirm={confirm} onCancel={cancel} />); });
      expect(text(renderer.toJSON())).not.toContain("Restart Activity");
      await press(renderer, "ask");
      expect(dialogs(renderer).length).toBe(app.modal ? 1 : 0);
      expect(text(renderer.toJSON())).toContain("It reloads.");
      expect(text(renderer.toJSON())).not.toContain(SECRET);
      await press(renderer, "Restart Activity", 2);
      expect(confirm).toHaveBeenCalledTimes(1);
      await press(renderer, "ask");
      await press(renderer, "Cancel: Restart Activity?");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      await press(renderer, "ask");
      await press(renderer, "Restart Activity");
      expect(confirm).toHaveBeenCalledTimes(2);
      if (app.modal) {
        await press(renderer, "ask");
        await act(async () => { dialogs(renderer)[0]!.props.onOpenChange(false); await flush(); });
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledTimes(2);
      }
      await act(async () => { renderer.unmount(); });
    });
  }

  it("in the popover (inPlace) it asks in place even where the app has a dialog", async () => {
    withApp({ modal: true });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ConfirmHarness inPlace onConfirm={() => undefined} onCancel={() => undefined} />); });
    await press(renderer, "ask");
    expect(dialogs(renderer).length).toBe(0);
    expect(text(renderer.toJSON())).toContain("It reloads.");
    await act(async () => { renderer.unmount(); });
  });
});

function ButtonHarness({ onConfirm }: { onConfirm(): void }) {
  const tokens = useUi(theme, false);
  return <TokensProvider value={tokens}><ConfirmButton label="Remove…" confirmLabel="Remove connection" target="Office" title="Remove Office?" text={`The saved connection to me@host is deleted. password=${SECRET}`} onConfirm={onConfirm} /></TokensProvider>;
}

describe("ConfirmButton (stop dev server, revoke, remove pairing, remove SSH connection)", () => {
  for (const modal of [true, false]) {
    it(`${modal ? "dialog" : "older app, inline"}: opens, explains, acts once; Cancel doesn't act`, async () => {
      withApp({ modal });
      const confirm = vi.fn();
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(<ButtonHarness onConfirm={confirm} />); });
      await press(renderer, "Remove… Office");
      expect(dialogs(renderer).length).toBe(modal ? 1 : 0);
      expect(text(renderer.toJSON())).toContain("The saved connection to me@host is deleted.");
      expect(text(renderer.toJSON())).not.toContain(SECRET);
      await press(renderer, "Cancel: Remove connection Office");
      expect(confirm).not.toHaveBeenCalled();
      await press(renderer, "Remove… Office");
      await press(renderer, "Confirm: Remove connection Office", 2);
      expect(confirm).toHaveBeenCalledTimes(1);
      await act(async () => { renderer.unmount(); });
    });
  }
});

describe("StopSheet (single use)", () => {
  it("two quick presses on Stop stop once", async () => {
    withApp({ modal: true });
    host.Modal = Object.assign((props: { title: string; open: boolean; onOpenChange(open: boolean): void; children: React.ReactNode }) => Dialog(props), { Content: ({ children }: { children: React.ReactNode }) => <>{children}</> });
    const confirm = vi.fn();
    const plan = { graceSeconds: 5, targets: [{ ok: true, pid: 4402, name: "tsc", rssBytes: 1e9, cpuPercent: 99, children: [] }] } as never;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<StopSheet theme={theme} plan={plan} busy={false} onCancel={() => undefined} onConfirm={confirm} />); });
    await press(renderer, "Stop it", 2);
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.unmount(); });
  });
});

describe("clipboard", () => {
  it("Paseo's copyText: copied redacted; a rejection is a failure", async () => {
    withApp({ copy: true });
    expect(await copyToClipboard(`curl -H "Authorization: Bearer ${SECRET}"`)).toBe(true);
    expect(copied.at(-1)).not.toContain(SECRET);
    copyFails = true;
    expect(await copyToClipboard("hello")).toBe(false);
  });
  it("react-native's clipboard: undefined (native) copied, false (web, refused) failed", async () => {
    withApp({});
    host.clipboard.answer = undefined;
    expect(await copyToClipboard("x")).toBe(true);
    host.clipboard.answer = false;
    expect(await copyToClipboard("x")).toBe(false);
  });
  it("verbatim only when asked (the pairing code)", async () => {
    withApp({ copy: true });
    await copyToClipboard(`code ${SECRET}`, { verbatim: true });
    expect(copied.at(-1)).toContain(SECRET);
  });
  it("useCopy says Copied, or Couldn't copy", async () => {
    withApp({ toast: true, copy: true });
    let copy!: (text: string, what?: string) => Promise<boolean>;
    const Probe = () => { copy = useCopy(); return null; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { await copy("PID 4402", "Details copied"); });
    copyFails = true;
    await act(async () => { await copy("PID 4402"); });
    expect(toasts.map((toast) => toast.text)).toEqual(["Details copied", "Couldn't copy. Select the text and copy it instead."]);
    expect(toasts.map((toast) => toast.variant)).toEqual(["success", "warning"]);
    await act(async () => { renderer.unmount(); });
  });
});

describe("toasts and their fallback", () => {
  it("useSay: a redacted toast where the app has one, else the message bar (never both)", async () => {
    let state!: ReturnType<typeof useSay>;
    const Probe = () => { state = useSay(); return null; };
    withApp({ toast: true });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { state[1]({ text: `Stop failed: token=${SECRET}`, tone: "danger" }); });
    expect(toasts.at(-1)?.text).toContain("Stop failed");
    expect(toasts.at(-1)?.text).not.toContain(SECRET);
    expect(toasts.at(-1)?.variant).toBe("error");
    expect(state[0]).toBeNull();
    await act(async () => { renderer.unmount(); });
    withApp({});
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { state[1]({ text: `Saved ${SECRET}`, tone: "success" }); });
    expect(state[0]?.text).toContain("Saved");
    expect(state[0]?.text).not.toContain(SECRET);
    await act(async () => { renderer.unmount(); });
  });
  it("useSafeToast without a toast posts to the page's message bar", async () => {
    withApp({});
    const said: unknown[] = [];
    let toast!: ReturnType<typeof useSafeToast>;
    const Probe = () => { toast = useSafeToast(); return null; };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<SayProvider say={(message) => { said.push(message); }}><Probe /></SayProvider>); });
    await act(async () => { toast.error(`Could not stop: Bearer ${SECRET}`); });
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0])).not.toContain(SECRET);
    expect(said[0]).toMatchObject({ tone: "danger" });
    await act(async () => { renderer.unmount(); });
  });
});
