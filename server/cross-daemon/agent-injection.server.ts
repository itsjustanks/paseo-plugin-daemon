// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

// Paseo compiles plugins against the SDK only, so the config type comes from there, not @getpaseo/protocol.
type AgentSessionConfig = PluginBeforeRequests["agent.create"]["config"];

const TOOL_SERVER_NAME = "hosts-cross-daemon";
// Paseo refuses to create an agent with MCP servers or tool approvals on providers without them.
const PROVIDERS_WITH_MCP_TOOLS = new Set(["claude", "codex", "opencode"]);
// OpenCode turns off its auto-accept whenever a tool policy is present.
const PROVIDERS_TO_PREAPPROVE = new Set(["claude", "codex"]);

// Only the documented providers[id].extends field is inspected. Never copy provider env or commands.
export function resolveToolProvider(provider: string, providers?: unknown): string | null {
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (PROVIDERS_WITH_MCP_TOOLS.has(provider)) return provider;
    if (seen.has(provider) || !providers || typeof providers !== "object" || !Object.hasOwn(providers, provider)) return null;
    seen.add(provider);
    const entry: unknown = Reflect.get(providers, provider);
    const base: unknown = entry && typeof entry === "object" ? Reflect.get(entry, "extends") : undefined;
    if (typeof base !== "string" || !base) return null;
    provider = base;
  }
  return null;
}

export function withCrossDaemonTools(
  config: AgentSessionConfig,
  launch: { command: string; proxyPath: string },
  toolNames: readonly string[],
  rootProvider: string | null = resolveToolProvider(config.provider),
): AgentSessionConfig {
  if (!rootProvider || !PROVIDERS_WITH_MCP_TOOLS.has(rootProvider)) return config;
  // Never replace another MCP server that happens to use our identifier.
  if (config.mcpServers?.[TOOL_SERVER_NAME]) return config;
  const withServer: AgentSessionConfig = {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      [TOOL_SERVER_NAME]: {
        type: "stdio",
        command: launch.command,
        args: [launch.proxyPath],
        // Paseo's desktop daemon runs under Electron, whose binary runs a script only in Node mode.
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
  if (!PROVIDERS_TO_PREAPPROVE.has(rootProvider)) return withServer;
  const preapproved = config.toolPolicy?.preapproved ?? [];
  const isGranted = (tool: string) => preapproved.some((grant) => grant.server === TOOL_SERVER_NAME && grant.tool === tool);
  const grants = toolNames.filter((tool) => !isGranted(tool)).map((tool) => ({ kind: "mcp" as const, server: TOOL_SERVER_NAME, tool }));
  return { ...withServer, toolPolicy: { ...config.toolPolicy, preapproved: [...preapproved, ...grants] } };
}
