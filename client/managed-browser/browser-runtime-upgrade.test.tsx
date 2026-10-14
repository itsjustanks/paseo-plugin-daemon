import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ calls: [] as any[], fail: false, unknown: false, notSent: false, expired: false, expires: 0, focused: null as string | null, focusCalls: [] as string[] }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const { createElement, useEffect, useState } = await import("react");
  return { Modal: Object.assign(({ open, children }: any) => {
    // Installed desktop Modal commits its portal after its visibility effect.
    const [shown, setShown] = useState(open);
    useEffect(() => { setShown(open); }, [open]);
    useEffect(() => {
      if (shown && fixture.focused !== "Cancel") {
        fixture.focused = "Close";
        fixture.focusCalls.push("Close");
      }
    }, [shown]);
    return shown ? createElement("View", null, createElement("Pressable", { accessibilityLabel: "Close" }), children) : null;
  }, { Content: ({ children }: any) => children }) };
});
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async (input: any) => {
  fixture.calls.push(input);
  if (fixture.fail) throw Error("SECRET raw stderr argv");
  if (input.action === "preview") return { status: "confirmation-required", message: "impact", approvalToken: "a".repeat(64), expiresAt: fixture.expires, activeBrowserProcesses: 3 };
  if (input.action === "cancel") return { status: "cancelled", message: "Cancelled" };
  if (fixture.unknown) return { status: "unknown", message: "Recheck the restart" };
  if (fixture.notSent) return { status: "not-sent", message: "No signal was sent. Inspect again." };
  if (fixture.expired) return { status: "blocked", message: "Restart approval expired. Inspect again." };
  return { status: "complete", message: "Verified; profiles retained" };
} }));
import { BrowserRuntimeUpgradeAction } from "./browser-runtime-upgrade";
import { isBrowserRuntimeUpgradeRequired } from "../../shared/managed-browser/browser-runtime-upgrade";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | null = null;
const verified = vi.fn();
async function render() {
  await act(async () => {
    tree = create(<BrowserRuntimeUpgradeAction theme={{ colors: {} } as any} hostLabel="Fixture host" onVerified={verified} />, {
      createNodeMock: node => {
        const { accessibilityLabel } = node.props as { accessibilityLabel: string };
        return { focus() { fixture.focused = accessibilityLabel; fixture.focusCalls.push(accessibilityLabel); } };
      },
    });
  });
}
async function press(label: string) { await act(async () => { tree!.root.findAllByType("Pressable" as any).find(node => node.props.accessibilityLabel === label)!.props.onPress(); }); }
const labels = () => tree!.root.findAllByType("Pressable" as any).map(node => node.props.accessibilityLabel);
beforeEach(() => { fixture.calls = []; fixture.fail = false; fixture.unknown = false; fixture.notSent = false; fixture.expired = false; fixture.expires = Date.now() + 60000; fixture.focused = null; fixture.focusCalls = []; verified.mockClear(); });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = null; });
it("mount does not inspect or signal; explicit preview shows Cancel first and ALL-session copy", async () => {
  await render(); expect(fixture.calls).toEqual([]);
  await press("Restart Hosts browser runtime"); expect(fixture.calls).toEqual([{ action: "preview" }]);
  expect(labels().slice(-2)).toEqual(["Cancel", "Close all managed sessions and restart"]);
  const text = JSON.stringify(tree!.toJSON()); expect(text).toContain("ALL Hosts managed"); expect(text).toContain("Fixture host");
  expect(text).toContain("may be forced to stop"); expect(text).toContain("most recent unsaved changes can be lost"); expect(text).toContain("Saved site profiles are kept");
  expect(text).not.toContain("a".repeat(64)); expect(text).not.toContain("3 active");
});
it("default Cancel sends only cancellation; no automatic confirm after preview", async () => {
  await render(); await press("Restart Hosts browser runtime"); await press("Cancel");
  expect(fixture.calls.map(call => call.action)).toEqual(["preview", "cancel"]); expect(verified).not.toHaveBeenCalled();
});
it("confirmation carries explicit ALL-session approval; success only notifies parent", async () => {
  await render(); await press("Restart Hosts browser runtime"); await press("Close all managed sessions and restart");
  expect(fixture.calls[1]).toEqual({ action: "confirm", approvalToken: "a".repeat(64), closeAllManagedSessions: true });
  expect(verified).toHaveBeenCalledTimes(1); expect(labels()).not.toContain("Restart Hosts browser runtime");
});
it("uncertain result offers explicit read-only recheck rather than another confirm", async () => {
  await render(); await press("Restart Hosts browser runtime"); fixture.unknown = true;
  await press("Close all managed sessions and restart"); expect(labels()).toEqual(["Recheck browser runtime restart"]);
  fixture.unknown = false; await press("Recheck browser runtime restart");
  expect(fixture.calls.map(call => call.action)).toEqual(["preview", "confirm", "recheck"]);
});
it("RPC failure never displays raw errors or retains a confirm control", async () => {
  await render(); fixture.fail = true; await press("Restart Hosts browser runtime");
  expect(JSON.stringify(tree!.toJSON())).not.toContain("SECRET"); expect(labels()).toEqual(["Recheck browser runtime restart"]);
});
it.each([-86400000, 86400000])("client/server clock skew %sms never suppresses an explicit confirmation", async skew => {
  await render(); fixture.expires = Date.now() + skew; await press("Restart Hosts browser runtime"); await press("Close all managed sessions and restart");
  expect(fixture.calls.map(call => call.action)).toEqual(["preview", "confirm"]); expect(verified).toHaveBeenCalledTimes(1);
});
it("server remains authoritative for actual expiry; UI never retries automatically", async () => {
  await render(); fixture.expires = Date.now() + 86400000; await press("Restart Hosts browser runtime"); fixture.expired = true;
  await press("Close all managed sessions and restart"); expect(fixture.calls.map(call => call.action)).toEqual(["preview", "confirm"]);
  expect(verified).not.toHaveBeenCalled(); expect(labels()).toEqual(["Restart Hosts browser runtime"]);
});
it("not-sent offers a fresh explicit preview rather than an automatic retry or reboot", async () => {
  await render(); await press("Restart Hosts browser runtime"); fixture.notSent = true;
  await press("Close all managed sessions and restart"); expect(labels()).toEqual(["Restart Hosts browser runtime"]);
  expect(fixture.calls.map(call => call.action)).toEqual(["preview", "confirm"]); expect(verified).not.toHaveBeenCalled();
  fixture.notSent = false; await press("Restart Hosts browser runtime");
  expect(fixture.calls.map(call => call.action)).toEqual(["preview", "confirm", "preview"]);
});
it("only the fixed legacy block marker selects this maintenance UI", () => {
  expect(isBrowserRuntimeUpgradeRequired(Error("HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: restart required"))).toBe(true);
  for (const value of [Error("secret unrelated failure"), "prefix HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: text", null, { message: "HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: spoof" }]) expect(isBrowserRuntimeUpgradeRequired(value)).toBe(false);
});
it("recognises the observed official RPC error wrapper with bounded matching", () => {
  const wrapped = "Request failed: HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: ... requestType=plugin.rpc.invoke.request code=handler_error";
  expect(isBrowserRuntimeUpgradeRequired(new Error(wrapped))).toBe(true);
  expect(isBrowserRuntimeUpgradeRequired(wrapped)).toBe(true);
  for (const text of [wrapped.replace("plugin.rpc.invoke.request", "agent.create.request"), wrapped.replace("handler_error", "unrelated_error"),
    wrapped.replace("Request failed: ", "Unrelated prefix: "), wrapped.replace(": ...", ": " + "x".repeat(4096)),
    "HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED: " + "x".repeat(4096)]) expect(isBrowserRuntimeUpgradeRequired(new Error(text))).toBe(false);
});

it("focuses Cancel on delayed portal mount and keeps the ref stable across renders", async () => {
  await render(); await press("Restart Hosts browser runtime");
  expect(fixture.focused).toBe("Cancel");
  expect(fixture.focusCalls).toEqual(["Cancel"]);
  await act(async () => tree!.update(<BrowserRuntimeUpgradeAction theme={{ colors: {} } as any}
    hostLabel="Updated fixture label" onVerified={verified} />));
  expect(fixture.focusCalls).toEqual(["Cancel"]);
  expect(fixture.calls.map(call => call.action)).toEqual(["preview"]);
});
