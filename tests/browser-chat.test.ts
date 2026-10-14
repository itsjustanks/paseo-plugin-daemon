import { describe, expect, it } from "vitest";
import { BrowserChatDataSchema, browserStepLabel, browserStepMessage, transformBrowserStep } from "../shared/browser-chat";

const state = { workspaceId: "workspace-a", tabId: "tab-a", title: "Example", url: "https://user:password@example.test/private?token=private#fragment", viewerToken: "never-copy-this", controller: "self" };
const item = (name = "hosts-browser.hosts_browser_capture", output: unknown = { content: [{ type: "text", text: JSON.stringify(state) }, { type: "text", text: "[image]" }] }) => ({ type: "tool_call", name, status: "completed", detail: { type: "unknown", input: { password: "never-copy-input" }, output } });
const data = (value: ReturnType<typeof item>) => transformBrowserStep({ item: value })?.items[0]?.data;
describe("browser chat summaries", () => {
  it.each(["hosts-browser.hosts_browser_capture", "mcp__hosts-browser__hosts_browser_capture"])("recognizes the exact provider namespace %s", (name) => {
    expect(data(item(name))).toEqual({ operation: "capture", status: "completed", captured: true, title: "Example", origin: "https://example.test", workspaceId: "workspace-a", tabId: "tab-a" });
  });
  it.each(["hosts_browser_capture", "mcp__other__hosts_browser_capture", "other.hosts_browser_capture", "hosts-browser.hosts_browser_capture_extra", "mcp__hosts-browser-extra__hosts_browser_capture", "Bash", ""])("leaves unrelated tools native: %s", (name) => expect(data(item(name))).toBeUndefined());
  it("understands Claude's single output wrapper and extracted image placeholder", () => {
    expect(data(item(undefined, { output: `${JSON.stringify(state)}\n[image]` }))).toMatchObject({ title: "Example", tabId: "tab-a" });
    expect(data(item(undefined, { output: state }))).toMatchObject({ title: "Example" });
  });
  it("understands direct state, wrapped state and raw MCP block arrays", () => {
    for (const output of [state, { state }, JSON.stringify({ state }), [{ type: "text", text: JSON.stringify(state) }]]) expect(data(item(undefined, output))).toMatchObject({ title: "Example" });
  });
  it("does not copy authority, tool input, images, URL secrets or arbitrary result fields", () => {
    const json = JSON.stringify(data(item()));
    for (const value of ["never-copy", "password", "private", "fragment", "controller", "[image]"]) expect(json).not.toContain(value);
  });
  it("redacts page title credentials and control characters", () => {
    expect(data(item(undefined, { ...state, title: "Example token=secret-value\npage" }))?.title).toBe("Example token=[redacted] page");
  });
  it.each(["file:///private/folder", "javascript:alert(1)", "data:text/plain,secret", "not a url", "x".repeat(8193)])("omits unsafe or invalid URLs", (url) => {
    expect(data(item(undefined, { ...state, url }))?.origin).toBeUndefined();
  });
  it("bounds text blocks and ignores malformed data and invalid target IDs", () => {
    expect(data(item(undefined, { content: [{ type: "text", text: "{" }, { type: "text", text: "x".repeat(24001) }] }))).toMatchObject({ captured: true });
    expect(data(item(undefined, { ...state, workspaceId: "../other", tabId: "bad/id" }))?.workspaceId).toBeUndefined();
    expect(data(item(undefined, { content: Array.from({ length: 8 }, () => ({ type: "text", text: "bad" })).concat({ type: "text", text: JSON.stringify(state) }) }))?.title).toBeUndefined();
  });
  it.each(["running", "failed", "canceled"])("does not present stale output as a completed result: %s", (status) => {
    const result = data({ ...item(), status });
    expect(result).toMatchObject({ status, captured: false }); expect(result?.title).toBeUndefined();
  });
  it("recognizes MCP failure even when provider says completed", () => {
    const error = { isError: true, content: [{ type: "text", text: JSON.stringify(state) }] };
    for (const output of [error, { output: error }, { output: JSON.stringify(error) }]) {
      expect(data(item(undefined, output))).toMatchObject({ status: "failed", captured: false });
      expect(data(item(undefined, output))?.title).toBeUndefined();
    }
  });
  it.each([
    { status: "error", recoveryState: "available", availability: "unavailable" },
    { status: "ready", recoveryState: "runtime-unavailable", availability: "unavailable" },
    { status: "ready", recoveryState: "browser-restarted", availability: "restarted" },
  ] as const)("shows bounded historical availability for $recoveryState/$status", ({ status, recoveryState, availability }) => {
    const resultState = { ...state, status, recoveryState, error: "private error token=secret-value" };
    for (const output of [{ output: JSON.stringify(resultState) }, { content: [{ type: "text", text: JSON.stringify(resultState) }] }]) {
      const result = data(item("hosts-browser.hosts_browser_status", output))!;
      expect(result).toMatchObject({ status: "completed", availability });
      expect(JSON.stringify(result)).not.toContain("private error");
      expect(JSON.stringify(result)).not.toContain("secret-value");
      expect(browserStepMessage(result)).toBe(availability === "unavailable"
        ? "The browser was unavailable at this step." : "The browser had restarted at this step.");
    }
    const failed = data(item(undefined, { isError: true, state: resultState }))!;
    expect(failed.status).toBe("failed"); expect(failed.availability).toBeUndefined();
  });
  it("leaves non-tool and unknown status items alone", () => {
    expect(data({ ...item(), type: "assistant_message" })).toBeUndefined();
    expect(data({ ...item(), status: "unknown" })).toBeUndefined();
  });
  it("uses historical language and never infers an offline daemon", () => {
    for (const operation of BrowserChatDataSchema.shape.operation.options) {
      const result = { operation, status: "completed" as const, captured: false };
      expect(browserStepLabel(result)).toBeTruthy(); expect(browserStepMessage(result)).toBe("Completed at this step.");
    }
    expect(browserStepMessage({ operation: "capture", status: "completed", captured: true })).toContain("at this step");
    expect(browserStepMessage({ operation: "navigate", status: "failed", captured: false })).toContain("operation failed");
    expect(browserStepMessage({ operation: "navigate", status: "running", captured: false })).toBe("In progress…");
    expect(browserStepMessage({ operation: "navigate", status: "canceled", captured: false })).toBe("Canceled.");
  });
});
