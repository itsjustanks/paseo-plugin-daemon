import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock("../../server/managed-browser/browser", async (original) => ({
  ...await original<typeof import("../../server/managed-browser/browser")>(),
  issueAgentTicket: boundary.issue,
}));
vi.mock("../../server/managed-browser/runtime-path", () => ({
  resolveBrowserRuntimeAssets: () => ({ node: "/owned/node", mcp: "/owned/mcp.cjs" }),
}));
import { contributeManagedBrowser } from "../../server/managed-browser/register";

function creation() {
  const hooks = new Map<string, any>();
  contributeManagedBrowser({ registerSettings() {}, handle() {}, on() {},
    before(name: string, hook: any) { hooks.set(name, hook); } } as any);
  const request = { config: { provider: "codex", mcpServers: { existing: { command: "retained" } },
    toolPolicy: { preapproved: ["existing grant"] } }, env: { RETAIN: "yes" } };
  const controller = new AbortController();
  const invoke = () => hooks.get("agent.create")({ request }, { signal: controller.signal });
  return { request, controller, invoke };
}
beforeEach(() => { vi.useFakeTimers(); boundary.issue.mockReset(); });
afterEach(() => vi.useRealTimers());

it("a rejected browser ticket does not break normal agent creation or alter existing grants", async () => {
  boundary.issue.mockRejectedValue(new Error("Private supervisor unavailable"));
  const fixture = creation();
  expect(await fixture.invoke()).toBe(fixture.request);
  expect(vi.getTimerCount()).toBe(0);
});

it("a stalled supervisor has a bounded creation deadline and late completion cannot inject MCP authority", async () => {
  let finish!: () => void;
  boundary.issue.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const fixture = creation();
  const result = fixture.invoke();
  await vi.advanceTimersByTimeAsync(2_001);
  expect(await result).toBe(fixture.request);
  finish(); await Promise.resolve();
  expect(fixture.request.config.mcpServers).toEqual({ existing: { command: "retained" } });
  expect(vi.getTimerCount()).toBe(0);
});

it("cancellation while ticket issuance is pending promptly returns the untouched creation request", async () => {
  let finish!: () => void;
  boundary.issue.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const fixture = creation();
  const result = fixture.invoke();
  fixture.controller.abort();
  expect(await result).toBe(fixture.request);
  finish(); await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it("an already cancelled creation never issues a browser ticket", async () => {
  const fixture = creation(); fixture.controller.abort();
  expect(await fixture.invoke()).toBe(fixture.request);
  expect(boundary.issue).not.toHaveBeenCalled();
});
