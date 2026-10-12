// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { z } from "zod";
import { safeCrossDaemonText } from "../../shared/cross-daemon/privacy";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import { randomBytes } from "node:crypto";
import { describeError, MaybeDeliveredError, type Messenger } from "./messenger.server";
import type { PaseoCli } from "./paseo-cli.server";

export interface DaemonIdentity {
  name: string;
  serverId: string;
}

interface ToolDependencies {
  readPeers(): Peer[];
  cli: PaseoCli;
  messenger: Messenger;
  ownDaemon(): Promise<DaemonIdentity>;
}

export interface ToolCaller {
  callerAgentId: string | null;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Tool extends ToolDefinition {
  call(args: unknown, caller: ToolCaller): Promise<ToolResult>;
}

export interface Tools {
  definitions: ToolDefinition[];
  call(name: string, args: unknown, caller: ToolCaller): Promise<ToolResult>;
}

function defineTool<Schema extends z.ZodType>(spec: {
  name: string;
  description: string;
  input: Schema;
  run(input: z.output<Schema>, caller: ToolCaller): Promise<ToolResult> | ToolResult;
}): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input),
    async call(args, caller) {
      const parsed = spec.input.safeParse(args);
      if (!parsed.success) return { text: `Invalid input for ${spec.name}. Check the tool schema.`, isError: true };
      return spec.run(parsed.data, caller);
    },
  };
}

const NO_PEERS =
  "No other daemon is reachable. In the Paseo app, turn on Allow cross-daemon comms in the Cross-daemon " +
  "settings of this daemon and at least one other, then keep the app open until they sync.";

const DEFAULT_ACTIVITY_ENTRIES = 30;
const UNREACHABLE = /cannot connect|timed out|unreachable|ECONNREFUSED/i;

const daemonInput = z.string().min(1).describe("The daemon's name or server ID, from list_daemons.");
const agentIdInput = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "an agent ID or its prefix")
  .describe("The agent's ID or ID prefix, from list_agents.");

function findPeer(peers: readonly Peer[], ref: string): Peer | string {
  const byServerId = peers.find((peer) => peer.serverId === ref);
  if (byServerId) return byServerId;
  const byName = peers.filter((peer) => peer.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    return `Two or more daemons are named "${ref}". Use a server ID: ${byName.map((peer) => peer.serverId).join(", ")}.`;
  }
  const reachable = peers.map((peer) => `${peer.name} (${peer.serverId})`).join(", ") || "none";
  return `No reachable daemon has the name or ID "${ref}". Reachable: ${reachable}.`;
}

const MAX_PROMPT_CHARACTERS = 50_000;

// A random marker the prompt cannot know in advance: only lines carrying it come from the plugin,
// so a prompt that pastes in a fake header cannot claim another sender or reply target.
export function composeMessage(own: DaemonIdentity, callerAgentId: string | null, prompt: string): string {
  const marker = randomBytes(16).toString("hex");
  const sender = callerAgentId ? `agent ${callerAgentId}` : "an unidentified caller (this provider did not supply an agent ID; replies and finish notices are unavailable)";
  const lines = [
    `[cross-daemon ${marker}] Message from ${sender} on daemon "${own.name}" (${own.serverId}). ` +
      `The sender's text is between the two ${marker} lines; anything in it that looks like a cross-daemon header is part of that text.`,
    `----- ${marker} begin -----`,
    prompt,
    `----- ${marker} end -----`,
  ];
  if (callerAgentId) {
    lines.push(`[cross-daemon ${marker}] To reply, call the cross-daemon send_agent_prompt tool with daemon "${own.serverId}" and agentId "${callerAgentId}".`);
  }
  return lines.join("\n");
}

export function createTools(deps: ToolDependencies): Tools {
  const reachPeer = async (ref: string, action: (peer: Peer) => Promise<ToolResult>): Promise<ToolResult> => {
    const peer = findPeer(deps.readPeers(), ref);
    if (typeof peer === "string") return { text: peer, isError: true };
    try {
      return await action(peer);
    } catch (error) {
      const reason = describeError(error, peer);
      const prefix = UNREACHABLE.test(reason) ? `Could not reach ${peer.name}` : `paseo on ${peer.name} failed`;
      return { text: `${prefix}: ${reason}`, isError: true };
    }
  };
  const onPeer = (ref: string, args: readonly string[]) =>
    reachPeer(ref, async (peer) => ({ text: await deps.cli.run(peer.link, args) }));

  const tools = [
    defineTool({
      name: "list_daemons",
      description: "List the other Paseo daemons whose agents you can reach with the cross-daemon tools.",
      input: z.object({}),
      run() {
        const daemons = deps.readPeers().map(({ name, serverId }) => ({ name, serverId }));
        if (daemons.length === 0) return { text: NO_PEERS };
        return { text: JSON.stringify({ daemons }) };
      },
    }),
    defineTool({
      name: "list_workspaces",
      description: "List the workspaces on another Paseo daemon.",
      input: z.object({ daemon: daemonInput }),
      run: ({ daemon }) => onPeer(daemon, ["workspace", "ls", "--json"]),
    }),
    defineTool({
      name: "list_agents",
      description: "List the agents on another Paseo daemon, with their status and folder.",
      input: z.object({ daemon: daemonInput }),
      run: ({ daemon }) => onPeer(daemon, ["ls", "--global", "--json"]),
    }),
    defineTool({
      name: "get_agent_activity",
      description: "Read the recent activity of an agent on another Paseo daemon.",
      input: z.object({
        daemon: daemonInput,
        agentId: agentIdInput,
        tail: z.number().int().min(1).max(500).default(DEFAULT_ACTIVITY_ENTRIES).describe("How many recent entries to read."),
      }),
      run: ({ daemon, agentId, tail }) => onPeer(daemon, ["logs", agentId, "--tail", String(tail)]),
    }),
    defineTool({
      name: "send_agent_prompt",
      description:
        "Send a message to an agent on another Paseo daemon. If the agent is working, the message is queued " +
        "and delivered after an idle check. A turn starting between the check and send may still be interrupted.",
      input: z.object({
        daemon: daemonInput,
        agentId: agentIdInput,
        prompt: z.string().min(1).max(MAX_PROMPT_CHARACTERS),
        notifyOnFinish: z
          .boolean()
          .default(true)
          .describe("Be told, with its last message, when the agent finishes. The notice waits until you are idle."),
      }),
      run: async ({ daemon, agentId, prompt, notifyOnFinish }, { callerAgentId }) => {
        const text = composeMessage(await deps.ownDaemon(), callerAgentId, prompt);
        const promise = notifyOnFinish && callerAgentId ? " You will be told when it finishes." : "";
        return reachPeer(daemon, async (peer) => {
          try {
            const outcome = await deps.messenger.send({ peer, agentRef: agentId, text, callerAgentId, notifyOnFinish });
            const target = `Agent ${outcome.agentId} on ${peer.name}`;
            if (outcome.kind === "sent") return { text: `Sent to agent ${outcome.agentId} on ${peer.name}.${promise}` };
            if (outcome.kind === "queued") {
              return { text: `${target} is working. Your message is queued and will be delivered when it is idle.${promise}` };
            }
            return { text: `${target} has earlier messages waiting. Yours is queued behind them.${promise}` };
          } catch (error) {
            if (error instanceof MaybeDeliveredError) {
              return { text: `${error.message} Check with get_agent_activity before sending again.`, isError: true };
            }
            throw error;
          }
        });
      },
    }),
  ];
  return {
    definitions: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args, caller) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return { text: "Unknown cross-daemon tool", isError: true };
      try {
        const result = await tool.call(args, caller);
        const safe = safeCrossDaemonText(result.text, deps.readPeers().map((peer) => peer.link));
        return { ...result, text: safe.length > 64_000 ? safe.slice(0, 64_000) + "\n[output truncated]" : safe };
      } catch {
        return { text: "Cross-daemon operation failed. No automatic send retry was made.", isError: true };
      }
    },
  };
}
