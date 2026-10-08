import type { PaseoApi } from "@getpaseo/client";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { attachmentUrl, matchesQuery, type HostsAttachmentItem } from "../shared/attachments";
import { OUTPUT_LINES, bytesWords, composeAskMessage, durationWords, tailLines, type AskContext, type AskFacts, type AskProcessFacts, type AskSubject } from "../shared/ask";
import type { HealthVerdict } from "../shared/health";
import type { ProcessReport, ProcessRow, ReportInput } from "../shared/processes";
import type { WatchResult } from "../shared/watch";
import { homeRelative, redactText } from "./redaction";
import { containsDirectory } from "./scope";

/**
 * The daemon side of "Ask an agent", the Hosts attachments and "Open a
 * terminal here" (0.12.0). It reads only what the Processes tab and the
 * health check already read, plus the tail of a matching Paseo terminal in
 * the problem's workspace, and every line passes `redactText` before it
 * leaves. It never sends anything to an agent itself: the app shows the
 * person the exact text and sends it only when they press Send.
 */
export interface AskDeps {
  report(input: ReportInput): Promise<ProcessReport>;
  verdict(): Promise<HealthVerdict>;
  /** When a dev server's port stopped serving, while the health check still reports it. */
  lost(port: number): { name: string; cwd: string | null; lostAt: number } | null;
  /** 0.14.0: the message about a worktree folder no workspace uses, by its id in the last disk check. */
  folder?(id: string): Promise<AskContext | null>;
  home?: string;
  now?: () => number;
}

type Workspace = { id: string; name: string; directory: string; project: string; scripts: ReadonlyArray<{ name: string; port: number | null; terminalId: string | null }> };
type Output = { from: string; lines: string[] };

/** How long one terminal read may take before it's skipped. */
const CAPTURE_TIMEOUT_MS = 2500;
/** Terminals read at most per lookup, so a busy workspace can't stall the sheet. */
const CAPTURE_MAX = 6;
/** Lines read to recognise the right terminal; only the last `OUTPUT_LINES` are kept. */
const SCAN_LINES = 400;
/** Dev servers whose output an attachment search reads at most. */
const ATTACH_OUTPUT_MAX = 4;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

export function createAsk(deps: AskDeps) {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;

  /** A home-relative path from a report or verdict, back to an absolute one. */
  const absolute = (cwd: string | null): string | null => {
    if (!cwd) return null;
    if (cwd === "~") return home;
    if (cwd.startsWith("~/")) return join(home, cwd.slice(2));
    return isAbsolute(cwd) ? cwd : null;
  };

  /** The deepest live workspace whose folder holds `directory`. */
  async function workspaceFor(paseo: PaseoApi, directory: string | null): Promise<Workspace | null> {
    if (!directory || typeof paseo?.workspaces?.list !== "function") return null;
    let best: Workspace | null = null;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await paseo.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const entry of result.entries) {
        const root = entry.workspaceDirectory || entry.projectRootPath;
        if (entry.archivingAt || !root || !containsDirectory(root, directory)) continue;
        if (best && best.directory.length >= root.length) continue;
        best = {
          id: entry.id, name: entry.name, directory: root, project: entry.projectDisplayName,
          scripts: (entry.scripts ?? []).map((script) => ({ name: script.scriptName, port: script.port ?? null, terminalId: script.terminalId ?? null })),
        };
      }
      if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
      cursor = result.pageInfo.nextCursor;
    }
    return best;
  }

  /**
   * The tail of the terminal a dev server runs in, when one can be told
   * apart: a workspace service script on that port, or a terminal in its
   * folder whose output names the port or the program. Null otherwise; a
   * guess would put the wrong output in front of an agent.
   */
  async function outputFor(paseo: PaseoApi, workspace: Workspace | null, target: { port: number | null; directory: string | null; name: string }): Promise<Output | null> {
    if (!workspace || typeof paseo?.terminals?.list !== "function" || typeof paseo.terminals.ref !== "function") return null;
    const service = target.port !== null ? workspace.scripts.find((item) => item.port === target.port) ?? null : null;
    // A Paseo service script on that port names its own terminal: no guessing needed.
    if (service?.terminalId) {
      const capture = await withTimeout(paseo.terminals.ref(service.terminalId).capture({ start: -SCAN_LINES, stripAnsi: true }), CAPTURE_TIMEOUT_MS);
      if (capture?.lines?.length) return { from: `the service script "${service.name}"`, lines: redactText(tailLines(capture.lines, OUTPUT_LINES), home) };
    }
    const listed = await withTimeout(paseo.terminals.list({ workspaceId: workspace.id }), CAPTURE_TIMEOUT_MS);
    const terminals = listed?.entries ?? [];
    if (!terminals.length) return null;
    const script = service?.name ?? null;
    const near = (cwd: string) => !!target.directory && (containsDirectory(cwd, target.directory) || containsDirectory(target.directory, cwd));
    const candidates = terminals
      .filter((terminal) => (script && terminal.name === script) || near(terminal.cwd))
      .sort((a, b) => Number(b.name === script) - Number(a.name === script))
      .slice(0, CAPTURE_MAX);
    let best: { score: number; output: Output } | null = null;
    for (const terminal of candidates) {
      const capture = await withTimeout(paseo.terminals.ref(terminal.id).capture({ start: -SCAN_LINES, stripAnsi: true }), CAPTURE_TIMEOUT_MS);
      if (!capture?.lines?.length) continue;
      const text = capture.lines.join("\n");
      const score = (script && terminal.name === script ? 3 : 0)
        + (target.port !== null && new RegExp(`(:|port\\s*)${target.port}\\b`, "i").test(text) ? 2 : 0)
        + (text.toLowerCase().includes(target.name.toLowerCase()) ? 1 : 0);
      if (score > 0 && (!best || score > best.score)) best = { score, output: { from: `the terminal "${terminal.name}"`, lines: redactText(tailLines(capture.lines, OUTPUT_LINES), home) } };
    }
    return best?.output ?? null;
  }

  async function processRow(pid: number): Promise<{ row: ProcessRow; report: ProcessReport } | null> {
    const report = await deps.report({ query: String(pid), limit: 20, sort: "cpu", filter: "all", offset: 0 });
    const row = report.processes.find((item) => item.pid === pid);
    return row ? { row, report } : null;
  }

  function hostLine(report: ProcessReport | null): string | null {
    if (!report?.supported) return null;
    const used = report.container?.memoryLimitBytes ? report.container.memoryUsedBytes : report.host.memoryUsedBytes;
    const parts = [`memory ${bytesWords(used)} of ${bytesWords(report.memoryBasisBytes)}${report.memoryBasis === "container" ? " (container limit)" : ""}`];
    if (report.host.cpuPercent !== null) parts.push(`CPU ${Math.round(report.host.cpuPercent)}%`);
    parts.push(`${report.heavyJobs.count} of ${report.heavyJobs.limit} heavy jobs`);
    return parts.join(", ");
  }

  function processFacts(row: ProcessRow, report: ProcessReport): AskProcessFacts {
    return {
      name: row.name, pid: row.pid, job: row.job?.label ?? null, owner: row.owner.label, cwd: row.cwd,
      cpuPercent: row.cpuPercent, rssBytes: row.rssBytes, memoryPercent: row.memoryPercent,
      memoryWhere: report.memoryBasis === "container" ? "this container's limit" : "this machine's memory",
      ageSeconds: row.ageSeconds, command: redactText([row.command], home)[0] ?? "", ports: row.ports,
    };
  }

  const where = (workspace: Workspace | null) => (workspace ? `${workspace.project} · ${workspace.name}` : null);

  function serviceFacts(service: WatchResult): AskFacts["service"] {
    return { name: service.name, target: service.target, state: service.state, latencyMs: service.latencyMs, usualMs: service.usualMs, status: service.status, history: service.history };
  }

  async function context(subject: AskSubject, paseo: PaseoApi): Promise<AskContext> {
    if (subject.kind === "folder") {
      const found = await deps.folder?.(subject.id);
      if (!found) throw new Error("That folder isn't in the last disk check any more. Check again first.");
      return found;
    }
    if (subject.kind === "service") {
      const service = (await deps.verdict()).watched?.find((item) => item.id === subject.id);
      if (!service) throw new Error("That watched service isn't in Settings any more.");
      const code = service.state === "down" ? "service-down" : service.state === "slow" ? "service-slow" : "service";
      const facts: AskFacts = { code, problem: service.message, hostLine: null, service: serviceFacts(service) };
      return { title: service.state === "up" ? `${service.name} is answering` : `${service.name} is ${service.state}`, text: composeAskMessage(facts), workspaceId: null, workspaceName: null, outputFrom: null };
    }
    if (subject.kind === "port") {
      const verdict = await deps.verdict();
      const issue = verdict.issues.find((item) => item.code === "port-gone" && item.ports.includes(subject.port));
      const lost = deps.lost(subject.port);
      if (!issue && !lost) throw new Error(`Nothing is reported about port ${subject.port} any more. It may be serving again.`);
      const name = lost?.name ?? issue?.subject ?? "The dev server";
      const cwd = lost?.cwd ?? issue?.cwd ?? null;
      const directory = absolute(cwd);
      const workspace = await workspaceFor(paseo, directory).catch(() => null);
      const output = await outputFor(paseo, workspace, { port: subject.port, directory, name }).catch(() => null);
      const report = await deps.report({ limit: 1, sort: "cpu", filter: "all", query: "", offset: 0 }).catch(() => null);
      const facts: AskFacts = {
        code: "port-gone", problem: issue?.message ?? `${name} on port ${subject.port} stopped serving.`, hostLine: hostLine(report),
        devServer: { name, port: subject.port, cwd, stoppedMinutesAgo: lost ? Math.floor((now() - lost.lostAt) / 60_000) : null },
        output, where: where(workspace),
      };
      return { title: `${name} on :${subject.port} stopped`, text: composeAskMessage(facts), workspaceId: workspace?.id ?? null, workspaceName: workspace?.name ?? null, outputFrom: output?.from ?? null };
    }
    const found = await processRow(subject.pid);
    if (!found) throw new Error(`Process ${subject.pid} has already exited.`);
    const { row, report } = found;
    const verdict = await deps.verdict().catch(() => null);
    const flag = row.flags[0] ?? null;
    const driver = verdict?.issues.find((issue) => issue.code === "pressure-driver" && issue.pid === row.pid);
    const code: AskFacts["code"] = flag?.code === "memory-growing" ? "memory-heavy" : flag?.code ?? (driver ? "pressure-driver" : "process");
    const directory = absolute(row.cwd);
    const workspace = await workspaceFor(paseo, directory).catch(() => null);
    const serves = row.ports.length > 0 || row.job?.kind === "dev-server";
    const output = serves ? await outputFor(paseo, workspace, { port: row.ports[0] ?? null, directory, name: row.name }).catch(() => null) : null;
    const problem = flag?.text ? `${row.name} (PID ${row.pid}): ${flag.text.charAt(0).toLowerCase()}${flag.text.slice(1)}.`.replace(/\.\.$/, ".") : driver?.message ?? `${row.name} (PID ${row.pid}) is using ${row.cpuPercent === null ? "an unknown share of" : `${Math.round(row.cpuPercent)}% of a`} CPU core and ${bytesWords(row.rssBytes)} of memory.`;
    const facts: AskFacts = { code, problem, hostLine: hostLine(report), process: processFacts(row, report), output, where: where(workspace) ?? (row.owner.project ? row.owner.label : null) };
    const title = code === "cpu-runaway" ? `${row.name} is stuck at full CPU` : code === "memory-heavy" ? `${row.name} holds a lot of memory` : code === "pressure-driver" ? `${row.name} is loading the host` : `${row.name} (PID ${row.pid})`;
    return { title, text: composeAskMessage(facts), workspaceId: workspace?.id ?? null, workspaceName: workspace?.name ?? null, outputFrom: output?.from ?? null };
  }

  /** The Hosts attach menu: heavy processes, what needs attention, dev servers' output and watched services. */
  async function attachments(query: string, paseo: PaseoApi): Promise<{ items: HostsAttachmentItem[] }> {
    const [report, verdict] = await Promise.all([
      deps.report({ limit: 10, sort: "cpu", filter: "all", query: "", offset: 0 }).catch(() => null),
      deps.verdict().catch(() => null),
    ]);
    type Draft = Omit<HostsAttachmentItem, "text"> & { text: () => Promise<string> };
    const drafts: Draft[] = [];
    if (report?.supported) {
      drafts.push({
        id: "processes", identifier: "processes", title: "Heavy processes now", subtitle: hostLine(report) ?? undefined, url: attachmentUrl("processes"), resourceType: "processes",
        text: async () => [
          `Heavy processes on this host, most CPU first. Host: ${hostLine(report)}.`,
          ...report.processes.map((row) => `- ${row.name} (PID ${row.pid}) · ${row.owner.label} · CPU ${row.cpuPercent === null ? "?" : `${Math.round(row.cpuPercent)}%`} · ${bytesWords(row.rssBytes)} · running ${durationWords(row.ageSeconds)}${row.flags.length ? ` · ${row.flags.map((flag) => flag.text).join("; ")}` : ""}\n  ${redactText([row.command], home)[0]}`),
        ].join("\n"),
      });
    }
    const issues = verdict?.issues.filter((issue) => issue.code !== "projects-unavailable") ?? [];
    if (issues.length) {
      drafts.push({
        id: "attention", identifier: "attention", title: "What needs attention", subtitle: `${issues.length} issue${issues.length === 1 ? "" : "s"}`, url: attachmentUrl("attention"), resourceType: "issues",
        text: async () => ["What Hosts flags on this machine right now:", ...issues.map((issue) => `- ${issue.message}`)].join("\n"),
      });
    }
    const workspaces = new Map<string, Promise<Workspace | null>>();
    const workspaceOf = (directory: string | null) => {
      const key = directory ?? "";
      if (!workspaces.has(key)) workspaces.set(key, workspaceFor(paseo, directory).catch(() => null));
      return workspaces.get(key)!;
    };
    const servers = (verdict?.services ?? []).slice(0, 8);
    for (const server of servers) {
      const port = server.ports[0] ?? null;
      drafts.push({
        id: `server-${port ?? server.name}`, identifier: port !== null ? `:${port}` : server.name, title: `Dev server output: ${server.name}${port !== null ? ` :${port}` : ""}`,
        subtitle: server.cwd ?? undefined, url: attachmentUrl(`servers/${port ?? server.name}`), resourceType: "dev-server-output",
        text: async () => {
          const directory = absolute(server.cwd);
          const output = await outputFor(paseo, await workspaceOf(directory), { port, directory, name: server.name }).catch(() => null);
          return [`Dev server ${server.name}${port !== null ? ` on port ${port}` : ""}${server.cwd ? ` in ${server.cwd}` : ""}.`, output ? `Last ${output.lines.length} lines of its output (from ${output.from}):\n~~~text\n${output.lines.join("\n")}\n~~~` : "Its output wasn't found in this workspace's terminals."].join("\n");
        },
      });
    }
    for (const issue of issues.filter((item) => item.code === "port-gone")) {
      const port = issue.ports[0]!;
      const lost = deps.lost(port);
      drafts.push({
        id: `stopped-${port}`, identifier: `:${port}`, title: `Stopped dev server: ${lost?.name ?? "port"} :${port}`, subtitle: issue.message, url: attachmentUrl(`stopped/${port}`), resourceType: "dev-server-output",
        text: async () => (await context({ kind: "port", port }, paseo)).text,
      });
    }
    for (const service of verdict?.watched ?? []) {
      drafts.push({
        id: `service-${service.id}`, identifier: service.name, title: `Watched service: ${service.name}`, subtitle: service.message, url: attachmentUrl(`services/${service.id}`), resourceType: "watched-service",
        text: async () => {
          const facts = serviceFacts(service)!;
          return [
            `Watched service ${service.name} at ${facts.target}: ${service.message}`,
            `Recent checks, oldest first: ${facts.history.length ? facts.history.map((entry) => (entry.latencyMs !== null ? `${entry.state} ${Math.round(entry.latencyMs)} ms` : entry.state)).join(", ") : "none yet"}.`,
          ].join("\n");
        },
      });
    }
    const chosen = drafts.filter((item) => matchesQuery(item, query));
    let outputs = 0;
    const items: HostsAttachmentItem[] = [];
    for (const draft of chosen) {
      if (draft.resourceType === "dev-server-output" && ++outputs > ATTACH_OUTPUT_MAX) continue;
      const text = await draft.text().catch(() => null);
      if (text) items.push({ ...draft, text });
    }
    return { items };
  }

  /** A Paseo terminal in a process's folder, inside its workspace; never outside one. */
  async function openTerminal(pid: number, paseo: PaseoApi): Promise<{ ok: boolean; message: string; workspaceId: string | null; terminalId: string | null }> {
    const refuse = (message: string, workspaceId: string | null = null) => ({ ok: false, message, workspaceId, terminalId: null });
    if (typeof paseo?.terminals?.create !== "function") return refuse("This version of Paseo can't open terminals for plugins.");
    const found = await processRow(pid);
    if (!found) return refuse(`Process ${pid} has already exited.`);
    const directory = absolute(found.row.cwd);
    const workspace = await workspaceFor(paseo, directory);
    if (!workspace || !directory) return refuse("Its folder isn't inside a Paseo workspace, so Hosts won't open a terminal there.");
    const terminal = await paseo.terminals.create({ workspaceId: workspace.id, cwd: directory, name: `${found.row.name} folder` });
    return { ok: true, message: `Opened a terminal in ${homeRelative(directory, home)}, in ${workspace.name}.`, workspaceId: workspace.id, terminalId: terminal.id };
  }

  return { context, attachments, openTerminal };
}
