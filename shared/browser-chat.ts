import { z } from "zod";
import { redactSecrets } from "./redaction";
import { browserTabIdSchema } from "./managed-browser/browser";

export const BROWSER_CHAT_KIND = "hosts-browser-step";
export const BROWSER_CHAT_VERSION = 1;
const operationSchema = z.enum(["status", "capture", "tabs", "tab_open", "tab_select", "tab_close", "acquire_control", "release_control", "navigate", "input", "viewport"]);
const idSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserChatDataSchema = z.object({
  operation: operationSchema,
  status: z.enum(["running", "completed", "failed", "canceled"]),
  availability: z.enum(["unavailable", "restarted"]).optional(),
  title: z.string().max(160).optional(),
  origin: z.string().max(256).optional(),
  workspaceId: idSchema.optional(),
  tabId: browserTabIdSchema.optional(),
  captured: z.boolean(),
});
export type BrowserChatData = z.output<typeof BrowserChatDataSchema>;
type ToolItem = { type: string; name?: string; status?: string; detail?: unknown };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Match only our configured MCP server. Similar names and arbitrary shell output stay native. */
function operation(name: string | undefined): BrowserChatData["operation"] | null {
  const suffix = name?.startsWith("mcp__hosts-browser__hosts_browser_")
    ? name.slice("mcp__hosts-browser__hosts_browser_".length)
    : name?.startsWith("hosts-browser.hosts_browser_")
      ? name.slice("hosts-browser.hosts_browser_".length) : null;
  const parsed = operationSchema.safeParse(suffix);
  return parsed.success ? parsed.data : null;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  if (value.length > 24_000) return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

function outputEnvelope(output: unknown): Record<string, unknown> | null {
  const outer = parseObject(output);
  // Claude wraps the coerced MCP text once. Its native image extraction leaves a trailing [image].
  const wrapped = outer?.output;
  return wrapped === undefined ? outer : parseObject(typeof wrapped === "string"
    ? wrapped.replace(/(?:\s*\[image\])+\s*$/, "") : wrapped);
}

/** Bounded MCP text blocks only; do not traverse arbitrary tool output or copy tokens/images. */
function outputState(output: unknown): Record<string, unknown> | null {
  const envelope = outputEnvelope(output);
  const blocks = Array.isArray(output) ? output : envelope?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks.slice(0, 8)) {
      const content = record(block);
      if (content?.type !== "text") continue;
      const parsed = parseObject(content.text);
      const state = record(parsed?.state) ?? parsed;
      if (state && idSchema.safeParse(state.workspaceId).success) return state;
    }
    return null;
  }
  return record(envelope?.state) ?? envelope;
}

function displayOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Paths, credentials, queries and fragments are not needed for the chat summary.
    return url.origin.length <= 256 ? redactSecrets(url.origin) : undefined;
  } catch { return undefined; }
}

export function transformBrowserStep({ item }: { item: ToolItem; phase?: string }) {
  if (item.type !== "tool_call") return undefined;
  const op = operation(item.name);
  const status = BrowserChatDataSchema.shape.status.safeParse(item.status);
  if (!op || !status.success) return undefined;
  const detail = record(item.detail);
  const output = detail?.type === "unknown" ? detail.output : null;
  const failed = parseObject(output)?.isError === true || outputEnvelope(output)?.isError === true;
  const state = status.data === "completed" && !failed ? outputState(output) : null;
  const workspaceId = idSchema.safeParse(state?.workspaceId);
  const tabId = browserTabIdSchema.safeParse(state?.tabId);
  const title = typeof state?.title === "string"
    ? redactSecrets(state.title.slice(0, 1_024)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160).trim() : "";
  const availability = state?.status === "error" || state?.recoveryState === "runtime-unavailable"
    ? "unavailable" : state?.recoveryState === "browser-restarted" ? "restarted" : undefined;
  const data: BrowserChatData = {
    operation: op, status: failed ? "failed" : status.data,
    captured: op === "capture" && status.data === "completed" && !failed,
    ...(availability ? { availability } : {}),
    ...(title ? { title } : {}),
    ...(displayOrigin(state?.url) ? { origin: displayOrigin(state?.url) } : {}),
    ...(workspaceId.success ? { workspaceId: workspaceId.data } : {}),
    ...(tabId.success ? { tabId: tabId.data } : {}),
  };
  return { items: [{ type: "plugin" as const, kind: BROWSER_CHAT_KIND, version: BROWSER_CHAT_VERSION, data }] };
}

const labels: Record<BrowserChatData["operation"], string> = {
  status: "Hosts Browser · Status", capture: "Hosts Browser · Capture", tabs: "Hosts Browser · Tabs", tab_open: "Hosts Browser · Open tab",
  tab_select: "Hosts Browser · Select tab", tab_close: "Hosts Browser · Close tab", acquire_control: "Hosts Browser · Take control",
  release_control: "Hosts Browser · Return control", navigate: "Hosts Browser · Navigation", input: "Hosts Browser · Input", viewport: "Hosts Browser · Size",
};
export function browserStepLabel(data: BrowserChatData): string { return labels[data.operation]; }
export function browserStepMessage(data: BrowserChatData): string {
  if (data.status === "running") return "In progress…";
  if (data.status === "failed") return "This operation failed. Open Hosts Browser to check the current session.";
  if (data.status === "canceled") return "Canceled.";
  if (data.availability === "unavailable") return "The browser was unavailable at this step.";
  if (data.availability === "restarted") return "The browser had restarted at this step.";
  if (data.captured) return "Capture completed at this step. Open Hosts Browser for the live view.";
  return "Completed at this step.";
}
