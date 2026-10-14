import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { browserTabIdSchema } from "../../shared/managed-browser/browser";
import { MAX_AGENT_VIEWPORT as MAX_VIEWPORT, MIN_VIEWPORT } from "../../shared/managed-browser/viewport-limits";
import type { JsonValue } from "./runtime-protocol";
import { resolveSupervisorPaths } from "./supervisor-paths";
import { AgentSupervisorClient } from "./supervisor-client";

const TICKET_ENV = "HOSTS_BROWSER_TICKET";

const pointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(16_384),
  height: z.number().finite().positive().max(16_384),
});

const inputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    point: pointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({ kind: z.literal("move"), point: pointSchema }),
  z.object({
    kind: z.literal("drag"),
    start: pointSchema,
    end: pointSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    kind: z.literal("scroll"),
    point: pointSchema,
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(4_000) }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
]);

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shared Browser supervisor returned an invalid response");
  return value;
}

function textResult(value: JsonValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main(): Promise<void> {
  const ticket = process.env[TICKET_ENV];
  if (!ticket) throw new Error(`${TICKET_ENV} is required`);
  const client = new AgentSupervisorClient({
    ticket,
    paths: resolveSupervisorPaths(paseoHome()),
  });
  await client.open();

  const server = new McpServer({
    name: "paseo-hosts-browser",
    version: "0.22.0",
  }, { instructions: "Use hosts_browser_* for this workspace's Hosts Browser. Humans see and control these same tabs in the Hosts Browser panel. Capture before input and after navigation or handoff. When a page needs the user to sign in, release control if you hold it, read status for the current tab, and direct them to Open this tab in Hosts Browser in its chat card, or the Hosts Browser panel on this host. Ask them to take Control, sign in there, and Return control when finished; never ask for credentials in chat. Human control has priority; wait for release and capture again. Do not use an independent CLI to bypass this lease. These tools do not redirect Paseo's separate desktop browser, the separate Shared Browser plugin or existing external sessions." });

  server.registerTool(
    "hosts_browser_status",
    {
      description: "Read the current shared browser state for this agent's workspace.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(await client.request("status", {})),
  );

  server.registerTool(
    "hosts_browser_capture",
    {
      description:
        "Capture the current shared browser frame and state. Capture before sending input.",
      inputSchema: z.object({
        quality: z.enum(["low", "medium", "high"]).default("medium"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ quality }) => {
      const result = await client.request("capture", { quality });
      const data = asObject(result);
      const frame = data.frame;
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(data.state, null, 2) }];
      if (frame && typeof frame === "object" && !Array.isArray(frame)) {
        const image = frame as Record<string, JsonValue>;
        if (typeof image.dataBase64 === "string" && typeof image.mimeType === "string")
          content.push({
            type: "image",
            data: image.dataBase64,
            mimeType: image.mimeType,
          });
      }
      return { content };
    },
  );

  server.registerTool(
    "hosts_browser_tabs",
    {
      description: "List tabs in this agent's workspace and identify this agent's selected tab.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(await client.request("tabs.list", {})),
  );

  server.registerTool(
    "hosts_browser_tab_open",
    {
      description: "Open and select a new tab in the shared browser profile for this agent only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () => textResult(await client.request("tabs.create", {})),
  );

  server.registerTool(
    "hosts_browser_tab_select",
    {
      description:
        "Select an existing tab for this agent only. Capture its current frame before sending input.",
      inputSchema: z.object({ tabId: browserTabIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ tabId }) => textResult(await client.request("tabs.select", { tabId })),
  );

  server.registerTool(
    "hosts_browser_tab_close",
    {
      description:
        "Close this agent's selected and controlled tab for every viewer. Other tabs remain open.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async () => textResult(await client.request("tabs.close", {})),
  );

  server.registerTool(
    "hosts_browser_acquire_control",
    {
      description:
        "Acquire browser control if no human or other viewer currently holds it. Forced takeover is unavailable.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async () => textResult(await client.request("acquire-control", {})),
  );

  server.registerTool(
    "hosts_browser_release_control",
    {
      description: "Release this agent's browser control lease.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async () => textResult(await client.request("release-control", {})),
  );
  server.registerTool(
    "hosts_browser_navigate",
    {
      description: "Navigate the shared browser using the agent's current observed state.",
      inputSchema: z.object({
        action: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("goto"),
            url: z.string().trim().min(1).max(8_192),
          }),
          z.object({ kind: z.literal("back") }),
          z.object({ kind: z.literal("forward") }),
          z.object({ kind: z.literal("reload") }),
        ]),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ action }) =>
      textResult(
        await client.request("navigate", {
          action: action as unknown as JsonValue,
        }),
      ),
  );

  server.registerTool(
    "hosts_browser_input",
    {
      description:
        "Send one input event using the exact frame returned by the latest capture. Stale frames are rejected.",
      inputSchema: z.object({ event: inputEventSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ event }) =>
      textResult(await client.request("input", { event: event as unknown as JsonValue })),
  );

  server.registerTool(
    "hosts_browser_viewport",
    {
      description: "Resize the shared browser viewport using the agent's current observed state.",
      inputSchema: z.object({
        width: z.number().int().min(MIN_VIEWPORT.width).max(MAX_VIEWPORT.width),
        height: z.number().int().min(MIN_VIEWPORT.height).max(MAX_VIEWPORT.height),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (viewport) =>
      textResult(
        await client.request("viewport", {
          viewport: viewport as unknown as JsonValue,
        }),
      ),
  );

  const transport = new StdioServerTransport();
  process.once("exit", () => client.disconnect());
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
