import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * "Ask an agent" (0.12.0): when something on this host breaks (a runaway
 * process, a dev server that stopped, a watched service that is slow or
 * down) Hosts writes a plain message for an agent in that workspace: what is
 * wrong, the figures, the tail of the dev server's output when it can be
 * found, and a suggested next step. The daemon builds the text, so every
 * command and output line passes its redaction first; the person sees the
 * exact text before anything is sent.
 */

export const AskSubjectSchema = z.discriminatedUnion("kind", [
  /** A process on this host, such as a runaway or a dev server. */
  z.object({ kind: z.literal("process"), pid: z.number().int().positive() }),
  /** A dev server that stopped serving this port. */
  z.object({ kind: z.literal("port"), port: z.number().int().min(1).max(65535) }),
  /** A watched service, by its settings id. */
  z.object({ kind: z.literal("service"), id: z.string().min(1).max(64) }),
]);
export type AskSubject = z.infer<typeof AskSubjectSchema>;

export const AskContextSchema = z.object({
  /** Short, for the sheet's title: "tsc is stuck at full CPU". */
  title: z.string(),
  /** The exact message that will be sent. */
  text: z.string(),
  /** The workspace the problem belongs to, when Hosts can tell; agents there are offered first. */
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  /** Where the output in the message came from ("terminal dev"), or null when none was found. */
  outputFrom: z.string().nullable(),
});
export type AskContext = z.infer<typeof AskContextSchema>;

export const askContext = defineRpc({ name: "daemon-link.ask.context", input: z.object({ subject: AskSubjectSchema }), output: AskContextSchema });

export const TerminalOpenResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  workspaceId: z.string().nullable(),
  terminalId: z.string().nullable(),
});
/** Opens a Paseo terminal in a dev server's folder, inside its workspace. */
export const terminalOpen = defineRpc({ name: "daemon-link.terminal.open", input: z.object({ pid: z.number().int().positive() }), output: TerminalOpenResultSchema });

/** How many output lines a message or attachment carries at most. */
export const OUTPUT_LINES = 50;
/** Longer lines are cut, so one minified bundle line can't swamp a message. */
export const OUTPUT_LINE_MAX = 300;

export type AskProcessFacts = {
  name: string;
  pid: number;
  /** "Type check", "Dev server"; null for anything else. */
  job: string | null;
  /** "Website · main", "Started from Paseo". */
  owner: string;
  /** Home-relative. */
  cwd: string | null;
  cpuPercent: number | null;
  rssBytes: number;
  memoryPercent: number;
  /** "this container's limit" or "this machine's memory". */
  memoryWhere: string;
  ageSeconds: number;
  /** Already redacted by the daemon. */
  command: string;
  ports: readonly number[];
};

export type AskServiceFacts = {
  name: string;
  /** Host and path, never the query. */
  target: string;
  state: "up" | "slow" | "down" | "unknown";
  latencyMs: number | null;
  usualMs: number | null;
  status: number | null;
  history: ReadonlyArray<{ state: string; latencyMs: number | null }>;
};

export type AskFacts = {
  /** Which kind of trouble, for the suggested next step. */
  code: "cpu-runaway" | "memory-heavy" | "pressure-driver" | "port-gone" | "service-slow" | "service-down" | "service" | "process";
  /** One plain sentence, outcome first. */
  problem: string;
  /** One line on the host's load, or null when unknown. */
  hostLine: string | null;
  process?: AskProcessFacts | null;
  devServer?: { name: string; port: number; cwd: string | null; stoppedMinutesAgo: number | null } | null;
  service?: AskServiceFacts | null;
  /** Already redacted output lines, oldest first. */
  output?: { from: string; lines: readonly string[] } | null;
  /** Workspace and project, in words. */
  where?: string | null;
};

export function bytesWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

const ms = (value: number) => (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`);

/** What to try first, by kind of trouble. */
export function suggestedStep(facts: Pick<AskFacts, "code" | "process" | "devServer" | "service">): string {
  const name = facts.process?.name ?? facts.devServer?.name ?? facts.service?.name ?? "it";
  switch (facts.code) {
    case "cpu-runaway":
      return `Find out why ${name} is stuck at full CPU: a loop, a watcher on too many files, or a hung build. If it isn't needed, it can be stopped; otherwise restart it with a narrower scope.`;
    case "memory-heavy":
      return `Find out why ${name} holds so much memory: a leak, a large cache or a watcher. Restarting it frees the memory now; find the cause so it doesn't grow back.`;
    case "pressure-driver":
      return `${name} is one of the heaviest users while the host is under pressure. Check whether it needs to run right now, or can run with fewer workers.`;
    case "port-gone":
      return `Read the output above for the error that stopped ${name}, fix the cause, then start the dev server again.`;
    case "service-down":
      return `Check whether ${name} is running and reachable from this host at the address above, and read its logs for the failure.`;
    case "service-slow":
      return `Find out what is slowing ${name} down: its own load, a slow dependency, or the network between here and there.`;
    default:
      return `Check whether ${name} is behaving as expected.`;
  }
}

/** Fences can't be closed early by the output itself. */
const fenceSafe = (line: string) => line.replace(/~~~/g, "~ ~ ~");

/**
 * The message, in plain words. Every value in `facts` is already redacted;
 * nothing here adds paths, environment or tokens.
 */
export function composeAskMessage(facts: AskFacts): string {
  const lines: string[] = [];
  lines.push("Hosts found a problem on this machine and is asking for your help.");
  lines.push("");
  lines.push(`What's wrong: ${facts.problem}`);
  lines.push("");
  lines.push("Snapshot:");
  const p = facts.process;
  if (p) {
    lines.push(`- Process: ${p.name} (PID ${p.pid})${p.job ? `, ${p.job.toLowerCase()}` : ""}${p.owner ? `, ${p.owner}` : ""}`);
    if (p.cwd) lines.push(`- Folder: ${p.cwd}`);
    lines.push(`- CPU: ${p.cpuPercent === null ? "still measuring" : `${Math.round(p.cpuPercent)}% of one core`}`);
    lines.push(`- Memory: ${bytesWords(p.rssBytes)} (${p.memoryPercent.toFixed(1)}% of ${p.memoryWhere})`);
    lines.push(`- Running for: ${durationWords(p.ageSeconds)}`);
    if (p.ports.length) lines.push(`- Listening on: ${p.ports.map((port) => `:${port}`).join(" ")}`);
    lines.push(`- Command: ${p.command}`);
  }
  const d = facts.devServer;
  if (d) {
    lines.push(`- Dev server: ${d.name} on port ${d.port}, no longer answering${d.stoppedMinutesAgo !== null ? ` (noticed ${d.stoppedMinutesAgo < 1 ? "just now" : `${d.stoppedMinutesAgo} min ago`})` : ""}`);
    if (d.cwd) lines.push(`- Folder: ${d.cwd}`);
  }
  const s = facts.service;
  if (s) {
    lines.push(`- Watched service: ${s.name} at ${s.target}`);
    lines.push(`- Last answer: ${s.state}${s.latencyMs !== null ? ` in ${ms(s.latencyMs)}` : ""}${s.status !== null ? `, HTTP ${s.status}` : ""}${s.usualMs !== null ? ` (usually ${ms(s.usualMs)})` : ""}`);
    if (s.history.length) lines.push(`- Recent checks, oldest first: ${s.history.slice(-10).map((entry) => (entry.latencyMs !== null ? `${entry.state} ${ms(entry.latencyMs)}` : entry.state)).join(", ")}`);
  }
  if (facts.where) lines.push(`- Workspace: ${facts.where}`);
  if (facts.hostLine) lines.push(`- Host: ${facts.hostLine}`);
  if (facts.output && facts.output.lines.length) {
    lines.push("");
    lines.push(`Last ${facts.output.lines.length} lines of its output (from ${facts.output.from}):`);
    lines.push("~~~text");
    for (const line of facts.output.lines) lines.push(fenceSafe(line));
    lines.push("~~~");
  } else if (facts.code === "port-gone" || facts.devServer || (p && p.ports.length)) {
    lines.push("");
    lines.push("Its output wasn't found in this workspace's terminals.");
  }
  lines.push("");
  lines.push(`Suggested next step: ${suggestedStep(facts)}`);
  lines.push("");
  lines.push("Please look into it and tell me what you find. Ask me before stopping, restarting or deleting anything.");
  return lines.join("\n");
}

/** Last `count` non-empty-tail lines, each cut to `OUTPUT_LINE_MAX`, with control characters removed. */
export function tailLines(lines: readonly string[], count = OUTPUT_LINES): string[] {
  const clean = lines.map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+$/, ""));
  while (clean.length && clean[clean.length - 1] === "") clean.pop();
  return clean.slice(-count).map((line) => (line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX - 1)}…` : line));
}
