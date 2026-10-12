// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./private-json.server";
import type { ToolDefinition } from "./tools.server";

const PROXY_FILE = "tool-proxy.cjs";

// The MCP server an agent's provider launches. It lists its tools itself and forwards each call to the
// plugin over a local socket, so the tools' logic, and the message queue, live in the long-running
// plugin process. The daemon evaluates plugin code in memory, so this function is written out as a
// standalone script and must not reference anything outside itself.
function toolProxyMain(settings: { socketPath: string; tools: unknown[] }): void {
  const net: typeof import("node:net") = require("node:net");
  const readline: typeof import("node:readline") = require("node:readline");
  const callerAgentId = process.env.PASEO_AGENT_ID ?? null;
  // Above a send's worst case: three CLI calls of up to 90 s each, plus waiting for another send.
  const pluginTimeoutMs = 360_000;

  const askPlugin = (request: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let reply = "";
      const socket = net.createConnection(settings.socketPath);
      socket.setEncoding("utf8");
      socket.setTimeout(pluginTimeoutMs, () => {
        socket.destroy();
        resolve({ error: `The cross-daemon plugin did not answer within ${pluginTimeoutMs / 1000} s. A message may still be delivered; check before sending again.` });
      });
      socket.on("data", (chunk: string) => {
        reply += chunk;
      });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(reply));
        } catch {
          resolve({ error: "Unreadable cross-daemon reply; details withheld" });
        }
      });
      socket.on("error", (error: Error) => resolve({ error: "The cross-daemon plugin is unavailable. A send may have been delivered; check activity before resending." }));
      socket.end(JSON.stringify(request));
    });

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  readline.createInterface({ input: process.stdin }).on("line", async (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    if (!isRecord(parsed)) {
      fail(null, -32600, "Invalid request");
      return;
    }
    const message = parsed;
    const params = isRecord(message.params) ? message.params : {};
    if (message.id === undefined) return;
    const reply = (result: object) => send({ jsonrpc: "2.0", id: message.id, result });

    if (message.method === "initialize") {
      reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hosts-cross-daemon", version: "1" },
      });
    } else if (message.method === "ping") {
      reply({});
    } else if (message.method === "tools/list") {
      reply({ tools: settings.tools });
    } else if (message.method === "tools/call") {
      const answer = await askPlugin({
        type: "call",
        name: params.name,
        arguments: params.arguments ?? {},
        callerAgentId,
      });
      const text = typeof answer.text === "string" ? answer.text : String(answer.error ?? "No reply");
      reply({ content: [{ type: "text", text }], isError: answer.isError === true || answer.error !== undefined });
    } else {
      fail(message.id, -32601, "Method not found");
    }
  });
}

// Agents keep the path in their saved config, so it stays the same across plugin updates; the
// content is refreshed at every plugin start.
export function installToolProxy(stateDir: string, settings: { socketPath: string; tools: readonly ToolDefinition[] }): string {
  const proxyPath = join(stateDir, PROXY_FILE);
  const source = `(${toolProxyMain.toString()})(${JSON.stringify(settings)});\n`;
  if (existsSync(proxyPath) && readFileSync(proxyPath, "utf8") === source) return proxyPath;
  ensurePrivateDirectory(stateDir);
  const staging = `${proxyPath}.${process.pid}.tmp`;
  writeFileSync(staging, source, { mode: 0o600, flag: "wx" });
  renameSync(staging, proxyPath);
  return proxyPath;
}
