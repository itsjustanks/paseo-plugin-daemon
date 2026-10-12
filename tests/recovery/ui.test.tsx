import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { classifySsh } from "../../server/recovery/ssh";
import { outcome } from "./fixtures";
import type { RecoveryProfile } from "../../shared/recovery";
const rpc = vi.hoisted(() => ({ handlers: new Map<string, ReturnType<typeof vi.fn>>(), profiles: [] as RecoveryProfile[], focus: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: { name: string }) => rpc.handlers.get(contract.name) }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null, Modal: undefined }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const make = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  return { Text: make("Text"), View: make("View"), Pressable: make("Pressable"), TextInput: make("TextInput"), ActivityIndicator: make("ActivityIndicator"), Linking: { openURL: vi.fn(async () => undefined) }, Clipboard: { setString: vi.fn() } };
});
const { RecoverySection, RecoveryConfirmation } = await import("../../client/recovery");
const fixtureProfile: RecoveryProfile = { id: "10000000-0000-4000-8000-000000000001", revision: 1, name: "Fixture target", hostname: "fixture.example.test", user: "", port: null, auth: { kind: "config" }, preset: "docker", container: "paseo-dev-stack-paseo", unit: "paseo.service", sudo: false };
const props = { host: { id: "fixture-helper", label: "Fixture helper" }, theme: { colors: new Proxy({}, { get: () => "#336699" }) }, layout: { compact: true, platform: "web" } } as unknown as PluginSurfaceProps;
let renderer: ReactTestRenderer;
const handler = (suffix: string) => rpc.handlers.get(`hosts.recovery.${suffix}`)!;
const press = (label: string) => renderer.root.findAll(n => (n.type as unknown) === "Pressable" && n.props.accessibilityLabel === label)[0];
const input = (label: string) => renderer.root.findAll(n => (n.type as unknown) === "TextInput" && n.props.accessibilityLabel === label)[0];
async function click(label: string) { await act(async () => { const button = press(label); expect(button, label).toBeTruthy(); if (!button.props.disabled) button.props.onPress(); }); }
async function mount() { await act(async () => { renderer = create(<RecoverySection {...props} />, { createNodeMock: element => element.type === "Pressable" ? { focus: rpc.focus } : null }); }); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rpc.focus.mockClear(); rpc.profiles = [fixtureProfile]; rpc.handlers.clear();
  rpc.handlers.set("hosts.recovery.list", vi.fn(async () => ({ profiles: rpc.profiles, checks: {} })));
  rpc.handlers.set("hosts.recovery.save", vi.fn(async (value: { details: object }) => { rpc.profiles = [{ ...fixtureProfile, ...value.details }]; return rpc.profiles[0]; }));
  rpc.handlers.set("hosts.recovery.test", vi.fn(async () => ({ code: "unreachable", state: "unknown", checkedAt: 1, message: "Target SSH offline." })));
  rpc.handlers.set("hosts.recovery.preview", vi.fn(async (value: { action: string }) => ({ token: "10000000-0000-4000-8000-000000000002", profile: fixtureProfile, action: value.action, expiresAt: Date.now() + 60_000 })));
  rpc.handlers.set("hosts.recovery.confirm", vi.fn(async () => ({ code: "sent", state: "unknown", checkedAt: 1, message: "Request sent. Check separately." })));
  rpc.handlers.set("hosts.recovery.cancel", vi.fn(async () => ({ ok: true })));
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
describe("recovery native UI contracts", () => {
  it("shows runner/helper guidance and never autoconnects", async () => {
    await mount(); const view = JSON.stringify(renderer.toJSON()); expect(view).toContain("Fixture helper"); expect(view).toContain("host picker"); expect(view).toContain("offline Hosts panel");
    expect(handler("list")).toHaveBeenCalledOnce(); for (const name of ["test", "preview", "confirm"]) expect(handler(name)).not.toHaveBeenCalled();
    await click("Test SSH + status"); expect(handler("test")).toHaveBeenCalledOnce(); expect(JSON.stringify(renderer.toJSON())).toContain("Target SSH offline.");
  });
  it("offers separately confirmed truthful container actions with Cancel focused/default", async () => {
    await mount(); await click("Manage Fixture target"); expect(press("Start container")).toBeTruthy(); expect(press("Restart Paseo worker")).toBeTruthy();
    await click("Restart existing container"); expect(handler("confirm")).not.toHaveBeenCalled(); expect(rpc.focus).toHaveBeenCalled();
    const view = JSON.stringify(renderer.toJSON()); expect(view).toContain("All work inside this container"); expect(view).toContain("Fixture helper"); expect(view).toContain("Fixture target");
    await click("Cancel"); expect(handler("cancel")).toHaveBeenCalledOnce(); expect(handler("confirm")).not.toHaveBeenCalled();
  });
  it("focuses Cancel when a newly opened busy confirmation becomes enabled", async () => {
    const cancelled = vi.fn(), confirmed = vi.fn();
    let disabled = true;
    // Like the DOM, the fake native node cannot focus while disabled. A mere focus call is not proof.
    const focus = vi.fn(() => { if (disabled) throw new Error("Cannot focus disabled Cancel"); });
    const preview = { token: "10000000-0000-4000-8000-000000000002", profile: fixtureProfile, action: "restart" as const, expiresAt: Date.now() + 60000 };
    await act(async () => { renderer = create(<RecoveryConfirmation {...props} preview={preview} busy onCancel={cancelled} onConfirm={confirmed} />, { createNodeMock: element => element.type === "Pressable" && (element.props as { accessibilityLabel?: string }).accessibilityLabel === "Cancel" ? { focus } : null }); });
    expect(focus).not.toHaveBeenCalled(); expect(press("Cancel").props.disabled).toBe(true);
    disabled = false;
    await act(async () => { renderer.update(<RecoveryConfirmation {...props} preview={preview} busy={false} onCancel={cancelled} onConfirm={confirmed} />); });
    expect(focus).toHaveBeenCalledOnce(); expect(press("Cancel").props.disabled).toBe(false);
    await click("Cancel"); expect(cancelled).toHaveBeenCalledOnce(); expect(confirmed).not.toHaveBeenCalled();
  });
  it("requires exact target name before reboot; duplicate confirm presses act once", async () => {
    await mount(); await click("Manage Fixture target"); await click("Reboot host");
    const rebootButtons = renderer.root.findAll(n => (n.type as unknown) === "Pressable" && n.props.accessibilityLabel === "Reboot host");
    expect(rebootButtons.at(-1)!.props.disabled).toBe(true); expect(JSON.stringify(renderer.toJSON())).toContain("All work on the target host");
    await act(async () => input("Type Fixture target to confirm reboot").props.onChangeText("Fixture target"));
    const confirm = renderer.root.findAll(n => (n.type as unknown) === "Pressable" && n.props.accessibilityLabel === "Reboot host").at(-1)!;
    await act(async () => { confirm.props.onPress(); confirm.props.onPress(); });
    expect(handler("confirm")).toHaveBeenCalledOnce(); expect(handler("confirm")).toHaveBeenCalledWith({ token: "10000000-0000-4000-8000-000000000002", targetName: "Fixture target" });
  });
  it("saves offline without asking for passwords or key contents", async () => {
    rpc.profiles = []; await mount(); await click("Add connection");
    await act(async () => { input("Connection name").props.onChangeText("New fixture"); input("Target hostname or SSH alias").props.onChangeText("offline.example.test"); });
    await click("Save connection"); expect(handler("save")).toHaveBeenCalledOnce(); expect(handler("test")).not.toHaveBeenCalled();
    expect(handler("save").mock.calls[0][0]).toMatchObject({ schemaVersion: 1, expectedRevision: 0, details: { hostname: "offline.example.test", auth: { kind: "config" } } });
    expect(JSON.stringify(renderer.toJSON())).toContain("target was not contacted");
  });
  it("cancels a pending preview on unmount and suppresses raw RPC errors", async () => {
    await mount(); await click("Manage Fixture target"); await click("Restart Paseo worker");
    await act(async () => renderer.unmount()); expect(handler("cancel")).toHaveBeenCalledOnce();
    handler("list").mockRejectedValueOnce(new Error("fixture-sensitive-value")); await mount();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("fixture-sensitive-value"); expect(JSON.stringify(renderer.toJSON())).toContain("online helper");
  });
  it.each(["worker_stopped", "worker_unknown"])("shows truthful running-container guidance for %s", async marker => {
    handler("test").mockResolvedValueOnce(classifySsh(outcome({ stdout: marker + "\n" }), false, 1));
    await mount(); await click("Test SSH + status");
    const view = JSON.stringify(renderer.toJSON());
    expect(view).toContain(marker === "worker_stopped" ? "container is still running" : "container is running");
    expect(view).toContain("Restart existing container"); expect(view).not.toContain("existing Paseo container is stopped");
    if (marker === "worker_stopped") expect(view).toContain("Start container cannot restart a worker");
    expect(handler("confirm")).not.toHaveBeenCalled();
  });
  it("keeps Docker-only restart off the systemd action list", async () => {
    rpc.profiles = [{ ...fixtureProfile, preset: "systemd" }]; await mount(); await click("Manage Fixture target"); expect(press("Start Paseo")).toBeTruthy(); expect(press("Restart existing container")).toBeUndefined();
  });
});
