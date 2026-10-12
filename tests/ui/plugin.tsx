import { headlessFixture, fixtureHosts } from "./headless-fixtures";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
export { TextInput };
export function defineRpc<T>(contract: T) { return contract; }
export function defineSettings<T>(definition: T) { return definition; }
export function settingsRpc(id: string) { return { read: { name: `settings.${id}.read` }, write: { name: `settings.${id}.write` }, reset: { name: `settings.${id}.reset` } }; }
const peer = { id: "7b5dccce-8405-4681-8278-466501de93c0", label: "Development server" };
let forwards: { id: string; peerId: string; remotePort: number; localPort: number }[] = [];
import { createPortal } from "react-dom";
import { HOUSEKEEPING_DEFAULTS } from "../../shared/housekeeping";
import { matchesProcess, processOrder } from "../../shared/processes";
import { DiskReportSchema } from "../../shared/disk";
import { clearItem, workspaceUsage } from "../resource-table-fixtures";
import { composeAskMessage } from "../../shared/ask";
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error"), unverified = params.has("unverified"), tunnelFail = params.has("tunnelfail"), busy = params.has("busy"), mac = params.has("mac");
const longnames = params.has("longnames"), nodisk = params.has("nodisk");
const projects = [{ id: "website", name: longnames ? "Website-with-a-deliberately-long-project-name-for-layout-review" : "Website", path: "~/projects/website" }, { id: "api", name: "API service", path: "~/projects/api" }];
const grant = { id: "00000000-0000-4000-8000-000000000001", label: "My laptop", projectIds: [] as string[] };
const preview = { token: "00000000-0000-4000-8000-000000000002", project: projects[0], head: "a1b2c3d4".repeat(5), commits: 24, bytes: 245760, sha256: "a".repeat(64), expiresAt: Date.now() + 600000 };
let history: any[] = [];
(window as any).__fixtureCalls = [];
/** Every URL a reserved tab was sent to; the real `window.open` is stubbed so headless runs stay deterministic. */
(window as any).__fixturePopups = [] as { opened: number; finished: string | null; closed: boolean }[];
(window as any).open = (url: string) => {
  const record = { opened: Date.now(), finished: null as string | null, closed: false };
  (window as any).__fixturePopups.push(record);
  if (url !== "about:blank") { record.finished = url; return { location: { replace() {} }, close() {}, opener: null }; }
  return { location: { replace(next: string) { record.finished = next; } }, close() { record.closed = true; }, opener: null };
};
const processes: any[] = Array.from({ length: 64 }, (_, index) => {
  const app = index < 2, agent = index === 2;
  const project = projects[index % 2];
  return { pid: 1000 + index, ppid: 900, name: agent ? "codex" : app ? (index === 0 ? "next-server" : "vite") : "node", command: agent ? "codex" : "node project-task.js", cwd: project.path,
    state: "sleeping", cpuPercent: 30 - index / 3, rssBytes: (65 - index) * 1e6, memoryPercent: 0.5, ageSeconds: index * 60 + 80,
    ports: app ? [3000 + index] : [], impact: "normal", reasons: [],
    service: app ? { kind: "dev-server", label: index === 0 ? "Next.js" : "Vite", confidence: "high", reasons: ["Recognized framework"] } : null,
    project: { ...project, workspace: longnames ? "Sandbox with a deliberately long workspace name" : "main", kind: agent ? "agent" : app ? "dev-server" : "project-tool", shareable: app, canStop: app },
    actionable: app, actionToken: app ? `synthetic-action-${1000 + index}` : null, protectedReason: app ? null : agent ? "Manage this agent in its Paseo agent tab." : "Only verified project dev servers can be stopped here.",
  };
});
processes.push({ ...processes[0], pid: 8100, name: "python3", command: "python3 -m http.server 8000", project: null, cwd: "~/scratch/http-demo", cpuPercent: 0, rssBytes: 20e6, ports: [8000], service: { kind: "dev-server", label: "Python HTTP server", confidence: "high", reasons: ["Exact -m http.server command"] }, actionable: true, actionToken: "synthetic-http-server", protectedReason: null });
/** Fixture tunnels: starting for ~1.2 s, then connected (or error with ?tunnelfail). The URL never contains the real provider's domain. */
type FixtureTunnel = { id: string; port: number; state: string; message: string; createdAt: number; expiresAt: number; url: string | null };
let tunnels: FixtureTunnel[] = [];
let installed = !empty;
let tunnelSequence = 0;
let settings: any = { closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 30, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: Number(params.get("minutes") || 120), maxHeavyJobs: 4, autoStopRunaways: false, housekeeping: { ...HOUSEKEEPING_DEFAULTS, enabled: !params.has("hkoff"), dryRun: !params.has("hklive") },
  watchedServices: busy ? [{ id: "omniroute-ai-router", name: "OmniRoute (AI Router)", url: "http://router.example.test/health", expectedStatus: null }, { id: "status-page", name: "Status page", url: "https://status.example.com/health", expectedStatus: 200 }] : [] };
const GB = 1024 ** 3, MB = 1024 ** 2;
/** Fixture processes for the Processes tab: a fleet container (or a Mac with ?mac); ?busy adds a runaway and a crowd of jobs. */
const owner = (kind: string, label: string, project: string | null = null, workspace: string | null = null) => ({ kind, label, project, workspace });
const prow = (pid: number, name: string, extra: any = {}) => ({ pid, ppid: 1, name, command: name, cwd: "~/projects/website", state: "sleeping", cpuPercent: 1, cpuSustained: 1, hotSeconds: 0, rssBytes: 80 * MB, memoryPercent: 1, ageSeconds: 3600, ports: [], job: null, jobRoot: false, tree: { count: 1, cpuPercent: 1, rssBytes: 80 * MB }, owner: owner("other", "Outside Paseo"), flags: [], stoppable: !extra.protectedReason, protectedReason: null, actionToken: extra.protectedReason ? null : `synthetic-action-${pid}`, outsidePaseo: true, ...extra });
const stoppable = { stoppable: true, protectedReason: null };
const website = owner("project", "Website · main", "Website", "main"), api = owner("project", "API service · fix-auth", "API service", "fix-auth");
const fixtureChat = (api = false) => ({ id: api ? "00000000-0000-4000-8000-000000000005" : "00000000-0000-4000-8000-000000000004", title: api ? "Test the API service" : "Build the Website", status: "running", workspaceId: api ? "ws-api-fixture" : "ws-fixture", workspace: api ? "fix-auth" : "main", project: api ? "API service" : "Website", workspacePath: api ? "/home/fixture/projects/api" : "/home/fixture/projects/website", where: api ? "API service · fix-auth" : "Website · main" });
function processRows() {
  const rows = [
    prow(4402, "tsc", { ...stoppable, chat: fixtureChat(), command: "node ~/projects/website/node_modules/.bin/tsc --noEmit", cpuPercent: busy ? 99.4 : 3, cpuSustained: busy ? 98 : 3, hotSeconds: busy ? 260 : 0, rssBytes: (busy ? 2100 : 640) * MB, memoryPercent: busy ? 27 : 8, ageSeconds: busy ? 420 : 40, job: { kind: "typecheck", label: "TypeScript" }, jobRoot: true, owner: website, tree: { count: 1, cpuPercent: busy ? 99.4 : 3, rssBytes: (busy ? 2100 : 640) * MB }, flags: busy ? [{ code: "cpu-runaway", text: "Has used a full CPU core for 4 min" }] : [] }),
    prow(4310, "next", { ...stoppable, chat: fixtureChat(), command: "node ~/projects/website/node_modules/.bin/next dev", cpuPercent: 12, rssBytes: 910 * MB, memoryPercent: 11.6, ports: [3000], job: { kind: "dev-server", label: "Next.js" }, jobRoot: true, owner: website, ageSeconds: 7400, tree: { count: 3, cpuPercent: 14, rssBytes: 1300 * MB } }),
    prow(4520, "vitest", { ...stoppable, chat: fixtureChat(true), command: "node ~/projects/api/node_modules/.bin/vitest run", cwd: "~/projects/api", cpuPercent: busy ? 64 : 0.4, rssBytes: 420 * MB, memoryPercent: 5.3, job: { kind: "test", label: "Vitest" }, jobRoot: busy, owner: api, ageSeconds: 95, tree: { count: 5, cpuPercent: busy ? 230 : 1, rssBytes: 1600 * MB } }),
    prow(4600, "vite", { ...stoppable, chat: fixtureChat(true), command: "node ~/projects/api/node_modules/.bin/vite", cwd: "~/projects/api", cpuPercent: 4, rssBytes: 300 * MB, memoryPercent: 3.8, ports: [5173], job: { kind: "dev-server", label: "Vite" }, jobRoot: true, owner: api, ageSeconds: 5000 }),
    prow(100, "Paseo Daemon", { command: "Paseo Daemon", cwd: "~", cpuPercent: 2.1, rssBytes: 306 * MB, memoryPercent: 3.9, ageSeconds: 83868, owner: owner("paseo", "Paseo daemon"), protectedReason: "Part of Paseo, so it can't be stopped here." }),
    prow(170, "plugin-process", { command: "node …/@getpaseo/server/dist/server/server/plugins/plugin-process.js", cwd: "~", rssBytes: 200 * MB, memoryPercent: 2.5, owner: owner("paseo", "Paseo plugin"), protectedReason: "Part of Paseo, so it can't be stopped here." }),
    prow(4400, "claude", { command: "claude", rssBytes: 380 * MB, memoryPercent: 4.8, owner: owner("agent", "Agent · Website · main", "Website", "main"), protectedReason: "An agent. Stop it from its chat in Paseo." }),
    prow(36, "stream-bridge", { command: "python3 /usr/local/bin/stream-bridge.py", cwd: "/", rssBytes: 10 * MB, memoryPercent: 0.1 }),
  ];
  if (busy) rows.push(prow(4700, "npm", { ...stoppable, command: "npm run build", cwd: "~/projects/website", cpuPercent: 0.5, job: { kind: "build", label: "Build" }, jobRoot: true, owner: owner("paseo-started", "Started from Paseo"), tree: { count: 6, cpuPercent: 180, rssBytes: 1900 * MB } }));
  return rows;
}
let actions: any[] = busy ? [{ at: Date.now() - 600_000, action: "stop", source: "processes", pid: 4211, name: "next", owner: "Website · main", status: "signaled", signaled: 3, message: "" }, { at: Date.now() - 590_000, action: "auto-force-stop", source: "processes", pid: 4211, name: "next", owner: "Website · main", status: "signaled", signaled: 1, message: "" }] : [];
function report(input: any) {
  let rows = processRows();
  rows = rows.filter((row) => matchesProcess(row, input));
  rows.sort(processOrder(input.sort ?? "memory", input.filter === "jobs", input.direction));
  const limitBytes = 7.33 * GB, used = busy ? 6.9 * GB : 3.1 * GB;
  const container = mac ? null : { memoryLimitBytes: limitBytes, memoryUsedBytes: used, memoryPercent: Math.round((used / limitBytes) * 1000) / 10, cpuLimitCores: null, cpuCoresUsed: busy ? 5.4 : 1.2, cpuPercent: busy ? 67 : 15, psiMemorySome10: 0, psiCpuSome10: 0, oomKills: 0, pressure: busy ? "critical" : "normal", reasons: busy ? ["using 94% of this container's 7.3 GB memory limit"] : [] };
  const runaways = busy ? [
    { code: "memory-near-limit", severity: "critical", title: "This container's memory is nearly full: 6.9 GB of its 7.3 GB limit.", pids: [], cwd: null },
    { code: "too-many-jobs", severity: "warning", title: "5 heavy jobs are running, above your warning threshold of 4. Builds, tests and dev servers compete for the same CPU. This warning never stops jobs.", pids: [4402, 4310, 4520, 4600, 4700], cwd: null },
    { code: "cpu-runaway", severity: "warning", title: "tsc (PID 4402) has used a full CPU core for 4 min.", pids: [4402], cwd: "~/projects/website" },
  ] : [];
  return {
    checkedAt: Date.now(), platform: mac ? "darwin" : "linux", supported: true, sampling: false,
    host: { cores: 8, cpuPercent: busy ? 91 : 18, load1: busy ? 9.4 : 1.1, memoryTotalBytes: mac ? 32 * GB : 64 * GB, memoryUsedBytes: mac ? 19 * GB : 21 * GB, cpuPressure: busy ? "high" : "normal", memoryPressure: busy ? "critical" : "normal" },
    container, memoryBasis: container ? "container" : "machine", memoryBasisBytes: container ? limitBytes : 32 * GB,
    heavyJobs: { count: busy ? 5 : 3, limit: settings.maxHeavyJobs, pids: [] }, runaways,
    processes: rows.slice(input.offset || 0, (input.offset || 0) + (input.limit || 25)), total: processRows().length, matched: rows.length,
    paseoBytes: 506 * MB, projectsVerified: !unverified, warnings: [], recentActions: actions.slice(0, 5),
  };
}
const watched = () => busy ? [
  { id: "omniroute-ai-router", name: "OmniRoute (AI Router)", target: "router.example.test/health", state: "slow", latencyMs: 4200, usualMs: 110, status: 200, checkedAt: Date.now(), message: "OmniRoute (AI Router) is slow: 4.2 s, usually 110 ms.", history: [110, 95, 120, 105, 130, 2900, 4200].map((latencyMs, i) => ({ at: i, state: latencyMs > 2000 ? "slow" : "up", latencyMs })) },
  { id: "status-page", name: "Status page", target: "status.example.com/health", state: "up", latencyMs: 180, usualMs: 170, status: 200, checkedAt: Date.now(), message: "Status page answered in 180 ms.", history: [160, 170, 180, 175, 180].map((latencyMs, i) => ({ at: i, state: "up", latencyMs })) },
] : [];
let revision = 1;
const stub = async (name: string, input: any) => {
  (window as any).__fixtureCalls.push({ name, input });
  if (params.has("managed") && name.startsWith("daemon-link.browser.managed.")) {
    const response = await fetch("/__managed-browser/rpc", { method: "POST", headers: { "Content-Type": "application/json", "x-hosts-fixture": "owned-browser-test" }, body: JSON.stringify({ name, input }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const headless = await headlessFixture(name, input); if (headless !== undefined) return headless;
  if (name === "daemon-link.housekeeping.status") {
    const state = mac ? "unsupported" : params.has("hkpassive") ? "passive" : params.has("hkblocked") ? "blocked" : !settings.housekeeping.enabled ? "off" : settings.housekeeping.dryRun ? "preview" : "live";
    return { state, enabled: settings.housekeeping.enabled, dryRun: settings.housekeeping.dryRun, message: state === "unsupported" ? "Housekeeping works on Linux hosts. This daemon runs on macOS, so it does nothing here." : state === "passive" ? "Standalone housekeeper active: Hosts stays passive." : state === "blocked" ? "The process table couldn't be read completely, so nothing was closed." : state === "off" ? "Housekeeping is off." : state === "preview" ? "Preview: logs what it would tidy. Nothing on this host is changed until you confirm live mode." : "Tidying this host. Running, open idle and unknown chats stay protected.", lastRuns: Object.fromEntries(["renice", "reap", "turbo", "helpers"].map((job) => [job, empty ? null : { at: Date.now() - 60000, outcome: settings.housekeeping.dryRun ? "preview" : "done", summary: job === "reap" ? "Kept an open idle chat's browser." : "Checked; see recent results." }])), actions: empty || mac ? [] : [{ at: Date.now() - 60000, job: "reap", outcome: "kept", what: "agent-browser daemon (PID 5001)", why: "Its chat is idle, so it was left alone" }, { at: Date.now() - 60000, job: "renice", outcome: "preview", what: "3 builds and tests", why: "Would lower main-process priority to nice 10" }], machine: mac ? null : { freeBytes: 6 * GB, totalBytes: 8 * GB, basis: "container", load1: 2.45, cores: 8 }, checkedAt: Date.now() };
  }
  if (name === "daemon-link.disk.report") return DiskReportSchema.parse({
    disks: [{ label: "This computer's disk", totalBytes: 100 * GB, usedBytes: 65 * GB, freeBytes: 35 * GB, percent: 65, level: "ok", sentence: null }], scan: { state: empty || nodisk ? "never" : "done", startedAt: null, finishedAt: empty ? null : Date.now() - 60000, done: empty ? 0 : 3, total: 3, partial: false, message: null },
    workspaces: empty || nodisk ? [] : [
      workspaceUsage({ id: "website", workspaceIds: longnames ? ["ws-fixture", "ws-fixture-review", "ws-fixture-long"] : ["ws-fixture"], names: longnames ? ["Sandbox", "Review workspace with a deliberately long name", "Release verification workspace with another long name"] : ["main"], folder: "~/projects/website", path: "/home/fixture/projects/website", totalBytes: 8 * GB, clearableBytes: 0, state: "working", busy: "A chat and dev server are running here.", items: [clearItem({ name: "node_modules", where: "~/projects/website/node_modules", bytes: 3 * GB, blocked: "Workspace is in use" })] }),
      workspaceUsage({ id: "api", names: ["fix-auth"], project: "API service", folder: "~/projects/api", path: "/home/fixture/projects/api", totalBytes: 3 * GB, clearableBytes: 0, state: "working", branch: "fix-auth", busy: "A dev server is running here.", items: [] }),
      workspaceUsage({ id: "docs", names: ["docs"], project: "Documentation", folder: "~/projects/docs", path: "/home/fixture/projects/docs", totalBytes: 2 * GB, clearableBytes: GB, items: [clearItem({ name: "node_modules", what: "Installed packages", where: "~/projects/docs/node_modules", bytes: GB, safe: true, token: "fixture-delete-docs" })] }),
    ], caches: empty ? [] : [
      { id: "packages", title: "Package downloads", totalBytes: 4 * GB, items: [clearItem({ name: "pnpm store", where: "~/.local/share/pnpm/store", bytes: 4 * GB, sharedBytes: 2 * GB, partial: true })] },
      { id: "temporary", title: "Temporary files", totalBytes: 2 * GB, items: [clearItem({ name: "old-build", what: "Temporary", where: "/tmp/old-build", bytes: 2 * GB, askId: "fixture-temp" })] },
    ], clearableBytes: GB, warnings: [],
  });
  if (name === "daemon-link.disk.preview") return { items: [{ workspace: "docs", where: "node_modules", path: "/home/fixture/projects/docs/node_modules", what: "Installed packages", cost: "Run the package install again.", bytes: GB, ok: true, reason: null }], bytes: GB, count: 1, checkedAt: Date.now() };
  if (name === "daemon-link.disk.clear-status") return { state: "idle", freedBytes: 0, results: [], message: null };
  if (name === "daemon-link.disk.clear") throw new Error("Deletion is disabled in this fictional preview.");
  if (name.startsWith("daemon-link.sync.") && failed) throw new Error("Source host is unavailable. Keep both plugins running and retry.");
  if (name === "daemon-link.sync.status") return { projects, grants: empty ? [] : [grant], history };
  if (name === "daemon-link.sync.projects") return { projects: empty ? [] : projects };
  if (name === "daemon-link.sync.preview") return { ...preview, project: projects.find((p) => p.id === input.projectId), expiresAt: Date.now() + 600000 };
  if (name === "daemon-link.sync.share") { grant.projectIds = input.projectIds; return { ok: true }; }
  if (name === "daemon-link.sync.receive") {
    const entry = { id: "00000000-0000-4000-8000-000000000003", peerId: peer.id, projectName: "Website", head: preview.head, startedAt: Date.now(), finishedAt: Date.now(), state: "done", bytes: preview.bytes, directory: "~/.paseo/daemon-link/transfers/received/example/repository", message: "Received into a separate checkout. Add this directory as a Paseo project when you are ready." };
    history = [entry]; return entry;
  }
  if (name === "daemon-link.status") return { ssh: true, cloudflared: installed, profiles: [], connections: [], tunnels: tunnels.map((tunnel) => ({ ...tunnel })) };
  if (name === "daemon-link.tunnel.install") { installed = true; return { ok: true }; }
  if (name === "daemon-link.tunnel.start") {
    const existing = tunnels.find((tunnel) => tunnel.port === input.port && ["starting", "connected"].includes(tunnel.state));
    if (existing) return { ...existing };
    const now = Date.now();
    const tunnel: FixtureTunnel = { id: `00000000-0000-4000-8000-00000000010${tunnelSequence++}`, port: input.port, state: "starting", message: "Starting a temporary link…", createdAt: now, expiresAt: now + input.minutes * 60_000, url: null };
    tunnels = [...tunnels, tunnel];
    setTimeout(() => {
      if (tunnelFail) { tunnel.state = "error"; tunnel.message = "Tunnel could not connect. Check outbound TCP port 7844, or use an SSH connection."; }
      else { tunnel.state = "connected"; tunnel.message = "Ready to open. Access expires automatically."; tunnel.url = "https://fixture-link.example"; }
    }, 1200);
    return { ...tunnel };
  }
  if (name === "daemon-link.tunnel.extend") {
    const tunnel = tunnels.find((item) => item.id === input.id);
    if (!tunnel || !["starting", "connected"].includes(tunnel.state)) throw new Error("This link is no longer live. Open the service again for a fresh link.");
    tunnel.expiresAt = Math.max(tunnel.expiresAt, Date.now() + input.minutes * 60_000);
    return { ...tunnel };
  }
  if (name === "daemon-link.tunnel.open") {
    const tunnel = tunnels.find((item) => item.id === input.id);
    if (!tunnel || tunnel.state !== "connected") throw new Error("This link is not ready. Check its status and retry.");
    return { url: `${tunnel.url}/__daemon_link#fixture-session` };
  }
  if (name === "daemon-link.tunnel.stop") { tunnels = tunnels.filter((item) => item.id !== input.id); return { ok: true }; }
  if (name === "daemon-link.health") {
    const r = report({ limit: 1 });
    const issues = busy ? [
      { code: "memory-pressure", severity: "critical", scope: "host", message: r.runaways[0]!.title, ports: [], cwd: null },
      { code: "too-many-jobs", severity: "warning", scope: "host", message: r.runaways[1]!.title, ports: [], cwd: null },
      { code: "runaway", severity: "warning", scope: "process", message: r.runaways[2]!.title, ports: [], cwd: "~/projects/website", subject: "tsc", pid: 4402 },
      { code: "port-gone", severity: "warning", scope: "process", message: "storybook on port 6006 stopped serving.", ports: [6006], cwd: "~/projects/website" },
      { code: "service-slow", severity: "warning", scope: "host", message: watched()[0]!.message, ports: [], cwd: null, subject: "OmniRoute (AI Router)" },
    ] : [];
    return { status: busy ? "critical" : "ok", checkedAt: Date.now(), background: true, issues, watched: watched(),
      load: { memoryUsedBytes: r.container ? r.container.memoryUsedBytes : r.host.memoryUsedBytes, memoryLimitBytes: r.memoryBasisBytes, memoryBasis: r.memoryBasis, cpuPercent: r.host.cpuPercent, heavyJobs: r.heavyJobs.count, heavyJobLimit: r.heavyJobs.limit },
      services: processes.filter((p) => p.service).map((p) => ({ name: p.name, cwd: p.cwd, ports: p.ports, project: p.project ? { path: p.project.path, workspace: p.project.workspace } : null })) };
  }
  if (name === "daemon-link.processes.report") return report(input);
  if (name === "daemon-link.ask.context") {
    const port = input.subject.kind === "port";
    const text = composeAskMessage(port
      ? { code: "port-gone", problem: "storybook on port 6006 stopped serving.", hostLine: "memory 6.9 GB of 7.3 GB (container limit), CPU 91%, 5 of 4 heavy jobs", devServer: { name: "storybook", port: 6006, cwd: "~/projects/website", stoppedMinutesAgo: 2 }, where: "Website · main", output: { from: "the terminal \"storybook\"", lines: ["info => Starting manager..", "info => Starting preview..", "ERR! Error: Cannot find module './preview.ts'", "ERR!     at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)", "WARN Broken build, fix the error above."] } }
      : { code: "cpu-runaway", problem: "tsc (PID 4402): has used a full CPU core for 4 min.", hostLine: "memory 6.9 GB of 7.3 GB (container limit), CPU 91%, 5 of 4 heavy jobs", where: "Website · main", process: { name: "tsc", pid: 4402, job: "TypeScript", owner: "Website · main", cwd: "~/projects/website", cpuPercent: 99.4, rssBytes: 2100 * MB, memoryPercent: 27, memoryWhere: "this container's limit", ageSeconds: 420, command: "node ~/projects/website/node_modules/.bin/tsc --noEmit", ports: [] } });
    return { title: port ? "storybook on :6006 stopped" : "tsc is stuck at full CPU", text, workspaceId: "ws-fixture", workspaceName: "main", outputFrom: port ? "the terminal \"storybook\"" : null };
  }
  if (name === "daemon-link.terminal.open") return { ok: true, message: "Opened a terminal in ~/projects/website, in main.", workspaceId: "ws-fixture", terminalId: "term-1" };
  if (name === "daemon-link.processes.preview") {
    const targets = [...processRows(), ...processes.filter((row) => row.actionable)].filter((row) => input.tokens.includes(row.actionToken));
    return { graceSeconds: 10, targets: targets.map((row) => ({ pid: row.pid, name: row.name, ok: true, reason: null, rssBytes: row.rssBytes, cpuPercent: row.cpuPercent, outsidePaseo: row.outsidePaseo ?? true, workspaceWarnings: row.project ? [`Inside ${row.project.workspace}, but Paseo didn't start it`] : [], children: row.tree?.count > 1 ? Array.from({ length: row.tree.count - 1 }, (_, i) => ({ pid: row.pid + i + 1, name: i === 0 ? "node" : "esbuild" })) : [] })) };
  }
  if (name === "monitor.stop" || name === "monitor.force-stop") return { ok: true, status: "signaled", message: "Fictional request only. No process was signalled." };

  if (name === "daemon-link.processes.stop") {
    const targets = processRows().filter((row) => row.stoppable && input.tokens.includes(row.actionToken));
    actions = [...targets.map((row) => ({ at: Date.now(), action: "stop", source: "processes", pid: row.pid, name: row.name, owner: row.owner.label, status: "signaled", signaled: 1, message: "" })), ...actions];
    return { escalateAfterSeconds: 10, results: targets.map((row) => ({ pid: row.pid, name: row.name, ok: true, status: "signaled", signaled: 1, message: `Asked ${row.name} to stop. Anything still running in 10 seconds is stopped forcefully.` })) };
  }
  if (name === "daemon-link.processes.log") return { entries: actions };
  if (name === "daemon-link.watch.suggestions") return { suggestions: settings.watchedServices.length || mac ? [] : [{ name: "OmniRoute (AI Router)", url: "http://router.example.test/health", source: "ai-router", why: "The AI Router plugin on this daemon sends every request through it." }] };
  if (name === "settings.hosts.read") return { status: "ready", revision: String(revision), values: settings };
  if (name === "settings.hosts.write") { settings = input.values; revision++; return { status: "saved", revision: String(revision), values: settings }; }
  if (name === "daemon-link.peers.status") return { relayState: "off", grants: [], peers: empty ? [] : [peer], forwards };
  if (name === "daemon-link.peers.services") {
    if (failed) throw new Error("Peer did not respond. Check that Daemon Link is running on both machines and the relay is reachable.");
    return { services: [{ port: 3000, label: "Next.js", project: "Website" }, { port: 5173, label: "Vite", project: "Component library" }] };
  }
  if (name === "daemon-link.peers.forward") { forwards = [{ id: "demo-forward", peerId: peer.id, remotePort: input.port, localPort: input.port }]; return { localPort: input.port, url: "https://example.com" }; }
  if (name === "daemon-link.peers.disconnect") { forwards = []; return { ok: true }; }
  if (name === "monitor.snapshot") {
    const all = empty || unverified ? [] : processes;
    const filtered = all.filter((process) => `${process.name} ${process.project?.name ?? ""} ${process.pid}`.toLowerCase().includes(input.query?.toLowerCase() || ""));
    const ascending = input.direction ? input.direction === "asc" : ["name", "pid"].includes(input.sort);
    const field = input.sort === "memory" ? "rssBytes" : input.sort === "cpu" ? "cpuPercent" : input.sort;
    filtered.sort((a: any, b: any) => (typeof a[field] === "string" ? a[field].localeCompare(b[field]) : a[field] - b[field]) * (ascending ? 1 : -1));
    const offset = input.offset || 0;
    return {
      timestamp: Date.now(), sampling: "live", platform: "linux", supported: true, warnings: [], uptimeSeconds: 3600,
      scope: { status: unverified ? "unavailable" : "ready", projects: empty ? [] : projects, message: unverified ? "Paseo projects could not be verified. Refresh this host; sharing and process controls are paused." : "Verified against this host's Paseo projects and workspaces." }, hiddenProcesses: 48,
      cpu: { percent: 12, cores: 8, load1: 0.8, load5: 1.2, load15: 1, psiSome10: 0, pressure: "normal", reasons: [] },
      memory: { totalBytes: 16e9, usedBytes: 5e9, availableBytes: 11e9, swapTotalBytes: 4e9, swapUsedBytes: 0, psiSome10: 0, pressureSignal: "normal", pressure: "normal", reasons: [] },
      services: all.filter((process) => process.service), processes: filtered.slice(offset, offset + input.limit), totalProcesses: all.length, matchedProcesses: filtered.length, truncated: filtered.length > input.limit,
    };
  }
  return { ok: true };
};
/** A fake Paseo session for "Ask an agent": three chats, one busy in this workspace. ?noagents hides the feature, as on an app without it. */
const fakeAgents = [
  { id: "a1", title: "Fix the checkout flow", status: "running", provider: "claude", model: "opus-5.5", workspaceId: "ws-fixture", updatedAt: "2026-10-06T06:00:00Z", archivedAt: null },
  { id: "a2", title: "Tidy the API tests", status: "idle", provider: "codex", model: "gpt-6.1-sol", workspaceId: "ws-fixture", updatedAt: "2026-10-06T05:00:00Z", archivedAt: null },
  { id: "a3", title: "Release notes", status: "idle", provider: "claude", model: "opus-5.5", workspaceId: "ws-other", updatedAt: "2026-10-06T04:00:00Z", archivedAt: null },
];
const sent: unknown[] = [];
(window as any).__fixtureSent = sent;
const paseo = params.has("noagents") ? null : {
  agents: { list: async () => ({ entries: fakeAgents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }), ref: (id: string) => ({ send: async (text: string, options: unknown) => { sent.push({ id, text, options }); } }) },
  workspaces: { ref: (id: string) => ({ agents: { create: async (input: unknown) => { sent.push({ workspace: id, input }); return { id: "new" }; } } }) },
  terminals: { create: async () => ({ id: "term-1" }) },
};
export function useHosts() { return fixtureHosts; }
export function usePaseo() { return paseo; }
export function useRpc(contract: { name: string }) { return useCallback((input: unknown) => stub(contract.name, input), [contract.name]); }
const toasts: string[] = [];
(window as any).__fixtureToasts = toasts;
const toast = { show: (message: string) => { toasts.push(message); console.info(message); }, error: (message: string) => { toasts.push(`error: ${message}`); console.info(message); } };
export function useToast() { return toast; }
export function Icon({ color, name }: { color: string; name: string }) { return <Text style={{ color }}>{({ ArrowLeft: "←", ArrowRight: "→", RotateCw: "↻", EllipsisVertical: "⋮", MousePointer2: "↖", LogOut: "↗", Crown: "♛", PanelsTopLeft: "+", X: "×", FolderCode: "▣", Network: "⇄", Activity: "⌁", BookOpen: "▤", Laptop: "▱", Globe: "◎", Terminal: ">_", CircleCheck: "✓", Circle: "○", Server: "▥", TimerReset: "↻", ChevronDown: "▾", ChevronRight: "▸" } as Record<string, string>)[name] || "◇"}</Text>; }
/** Like Paseo's own Modal, a sheet above the page (a portal), so later rows never paint over it. */
export const Modal = Object.assign(({ children, open, title }: any) => open ? createPortal(<View style={{ position: "fixed" as any, top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", paddingTop: 48, paddingHorizontal: 12, backgroundColor: "rgba(0,0,0,0.35)", zIndex: 10 }}><View style={{ width: "100%", maxWidth: 560, maxHeight: "90vh" as any, overflow: "auto" as any, backgroundColor: params.has("light") ? "#ffffff" : "#1a2029", borderWidth: 1, borderColor: "#8886", borderRadius: 16, boxShadow: "0 12px 40px rgba(0,0,0,0.35)" as any }}><Text style={{ padding: 16, paddingBottom: 0, fontSize: 17, fontWeight: "700", color: params.has("light") ? "#20252d" : "#eef1f6" }}>{title}</Text>{children}</View></View>, document.body) : null, { Content: ({ children }: any) => <View>{children}</View> });
/** Settings hook: reads the fixture document through the same stub the pill uses, saves synchronously. */
export function useSettings(definition?: any) {
  if (definition?.id === "browser-display-preferences") return { status: "ready", values: { captureQuality: "medium", favoritePresetIds: [] }, revision: "1", saving: false, saveError: null, save: async () => true, reload: async () => {}, reset: async () => true };
  const [state, setState] = useState<any>({ status: "loading", saving: false, saveError: null });
  const load = useCallback(async () => { const result = await stub("settings.hosts.read", {}); setState({ ...result, saving: false, saveError: null }); }, []);
  useEffect(() => { void load(); }, [load]);
  return { ...state, save: async (values: unknown, rev: string) => { await stub("settings.hosts.write", { revision: rev, values }); await load(); return true; }, reset: async () => true, reload: load };
}
/** The fixture workspace is the Website project; its directory matches the `~/projects/website` cwd rows. */
export function useWorkspace(_id: string, selector: (workspace: any) => unknown) {
  return selector({ id: "ws-fixture", directory: "/home/fixture/projects/website", projectRootPath: "/home/fixture/projects/website", name: "Main" });
}
// Fixture colours only: the real SDK supplies its own styles in the app.
const settingsColors = params.has("light") ? { text: "#20252d", muted: "#606b78", accent: "#4f46e5", border: "#d7dbe1" } : { text: "#eef1f6", muted: "#a2adbc", accent: "#a5b4fc", border: "#394352" };
export const SettingsSection = ({ title, info, children }: any) => <View style={{ gap: 8, padding: 12 }}><Text style={{ fontWeight: "600", color: settingsColors.text }}>{title}</Text>{info ? <Text style={{ color: settingsColors.text }}>{info}</Text> : null}{children}</View>;
export const SettingsGroup = SettingsSection;
export const SettingsCard = ({ children }: any) => <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: settingsColors.border }}>{children}</View>;
export const SettingsRow = ({ label, hint, children }: any) => <View style={{ gap: 4 }}><Text style={{ color: settingsColors.text }}>{label}</Text>{hint ? <Text style={{ color: settingsColors.muted }}>{hint}</Text> : null}{children}</View>;
export const SettingsSwitch = ({ label, hint, value, onValueChange, disabled }: any) => <SettingsRow label={label} hint={hint}><Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} disabled={disabled} /></SettingsRow>;
export function SettingsSelect({ label, hint, value, options, onValueChange, disabled }: any) {
  return <SettingsRow label={label} hint={hint}><select aria-label={label} value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)} style={{ minHeight: 36, width: "100%", minWidth: 0, maxWidth: "100%", padding: 6, color: settingsColors.text, background: params.has("light") ? "#ffffff" : "#1a2029", border: `1px solid ${settingsColors.border}`, borderRadius: 6 }}>{options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></SettingsRow>;
}
export const SettingsInput = ({ label, hint, initialValue, onChangeText, placeholder, disabled }: any) => <SettingsRow label={label} hint={hint}><TextInput accessibilityLabel={label} defaultValue={initialValue} placeholder={placeholder} placeholderTextColor={settingsColors.muted} style={{ color: settingsColors.text, borderColor: settingsColors.border }} onChangeText={onChangeText} editable={!disabled} /></SettingsRow>;
export const SettingsAction = ({ label, actionLabel, onPress, disabled }: any) => <SettingsRow label={label}><Pressable accessibilityRole="button" accessibilityLabel={actionLabel} disabled={disabled} onPress={onPress}><Text style={{ color: settingsColors.accent }}>{actionLabel}</Text></Pressable></SettingsRow>;
