import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
export function defineRpc<T>(contract: T) { return contract; }
export function defineSettings<T>(definition: T) { return definition; }
export function settingsRpc(id: string) { return { read: { name: `settings.${id}.read` }, write: { name: `settings.${id}.write` }, reset: { name: `settings.${id}.reset` } }; }
const peer = { id: "7b5dccce-8405-4681-8278-466501de93c0", label: "Development server" };
let forwards: { id: string; peerId: string; remotePort: number; localPort: number }[] = [];
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error"), unverified = params.has("unverified"), tunnelFail = params.has("tunnelfail"), busy = params.has("busy"), mac = params.has("mac");
const projects = [{ id: "website", name: "Website", path: "~/projects/website" }, { id: "api", name: "API service", path: "~/projects/api" }];
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
const processes = Array.from({ length: 64 }, (_, index) => {
  const app = index < 2, agent = index === 2;
  const project = projects[index % 2];
  return { pid: 1000 + index, ppid: 900, name: agent ? "codex" : app ? (index === 0 ? "next-server" : "vite") : "node", command: agent ? "codex" : "node project-task.js", cwd: project.path,
    state: "sleeping", cpuPercent: 30 - index / 3, rssBytes: (65 - index) * 1e6, memoryPercent: 0.5, ageSeconds: index * 60 + 80,
    ports: app ? [3000 + index] : [], impact: "normal", reasons: [],
    service: app ? { kind: "dev-server", label: index === 0 ? "Next.js" : "Vite", confidence: "high", reasons: ["Recognized framework"] } : null,
    project: { ...project, workspace: "Main", kind: agent ? "agent" : app ? "dev-server" : "project-tool", shareable: app, canStop: app },
    actionable: app, actionToken: app ? "synthetic-action" : null, protectedReason: app ? null : agent ? "Manage this agent in its Paseo agent tab." : "Only verified project dev servers can be stopped here.",
  };
});
/** Fixture tunnels: starting for ~1.2 s, then connected (or error with ?tunnelfail). The URL never contains the real provider's domain. */
type FixtureTunnel = { id: string; port: number; state: string; message: string; createdAt: number; expiresAt: number; url: string | null };
let tunnels: FixtureTunnel[] = [];
let installed = !empty;
let tunnelSequence = 0;
let settings: any = { closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 30, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: Number(params.get("minutes") || 120), maxHeavyJobs: 4,
  watchedServices: busy ? [{ id: "omniroute-ai-router", name: "OmniRoute (AI Router)", url: "http://10.0.0.9:20128/api/health/ping", expectedStatus: null }, { id: "status-page", name: "Status page", url: "https://status.example.com/health", expectedStatus: 200 }] : [] };
const GB = 1024 ** 3, MB = 1024 ** 2;
/** Fixture processes for the Processes tab: a fleet container (or a Mac with ?mac); ?busy adds a runaway and a crowd of jobs. */
const owner = (kind: string, label: string, project: string | null = null, workspace: string | null = null) => ({ kind, label, project, workspace });
const prow = (pid: number, name: string, extra: any = {}) => ({ pid, ppid: 1, name, command: name, cwd: "~/projects/website", state: "sleeping", cpuPercent: 1, cpuSustained: 1, hotSeconds: 0, rssBytes: 80 * MB, memoryPercent: 1, ageSeconds: 3600, ports: [], job: null, jobRoot: false, tree: { count: 1, cpuPercent: 1, rssBytes: 80 * MB }, owner: owner("other", "Outside Paseo"), flags: [], stoppable: false, protectedReason: "Started outside Paseo and outside your Paseo projects, so it can only be viewed here.", actionToken: null, ...extra });
const stoppable = { stoppable: true, protectedReason: null, actionToken: "synthetic-action" };
const website = owner("project", "Website · main", "Website", "main"), api = owner("project", "API service · fix-auth", "API service", "fix-auth");
function processRows() {
  const rows = [
    prow(4402, "tsc", { ...stoppable, command: "node ~/projects/website/node_modules/.bin/tsc --noEmit", cpuPercent: busy ? 99.4 : 3, cpuSustained: busy ? 98 : 3, hotSeconds: busy ? 260 : 0, rssBytes: (busy ? 2100 : 640) * MB, memoryPercent: busy ? 27 : 8, ageSeconds: busy ? 420 : 40, job: { kind: "typecheck", label: "TypeScript" }, jobRoot: true, owner: website, tree: { count: 1, cpuPercent: busy ? 99.4 : 3, rssBytes: (busy ? 2100 : 640) * MB }, flags: busy ? [{ code: "cpu-runaway", text: "Has used a full CPU core for 4 min" }] : [] }),
    prow(4310, "next", { ...stoppable, command: "node ~/projects/website/node_modules/.bin/next dev", cpuPercent: 12, rssBytes: 910 * MB, memoryPercent: 11.6, ports: [3000], job: { kind: "dev-server", label: "Next.js" }, jobRoot: true, owner: website, ageSeconds: 7400, tree: { count: 3, cpuPercent: 14, rssBytes: 1300 * MB } }),
    prow(4520, "vitest", { ...stoppable, command: "node ~/projects/api/node_modules/.bin/vitest run", cwd: "~/projects/api", cpuPercent: busy ? 64 : 0.4, rssBytes: 420 * MB, memoryPercent: 5.3, job: { kind: "test", label: "Vitest" }, jobRoot: busy, owner: api, ageSeconds: 95, tree: { count: 5, cpuPercent: busy ? 230 : 1, rssBytes: 1600 * MB } }),
    prow(4600, "vite", { ...stoppable, command: "node ~/projects/api/node_modules/.bin/vite", cwd: "~/projects/api", cpuPercent: 4, rssBytes: 300 * MB, memoryPercent: 3.8, ports: [5173], job: { kind: "dev-server", label: "Vite" }, jobRoot: true, owner: api, ageSeconds: 5000 }),
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
  if (input.filter === "jobs") rows = rows.filter((row) => row.jobRoot);
  if (input.filter === "stoppable") rows = rows.filter((row) => row.stoppable);
  const q = (input.query || "").toLowerCase();
  if (q) rows = rows.filter((row) => `${row.name} ${row.owner.label} ${row.pid}`.toLowerCase().includes(q));
  const key = input.sort === "memory" ? (row: any) => -row.rssBytes : input.sort === "age" ? (row: any) => -row.ageSeconds : input.sort === "name" ? null : (row: any) => -(row.cpuPercent ?? 0);
  rows.sort(key ? (a, b) => key(a) - key(b) : (a, b) => a.name.localeCompare(b.name));
  const limitBytes = 7.33 * GB, used = busy ? 6.9 * GB : 3.1 * GB;
  const container = mac ? null : { memoryLimitBytes: limitBytes, memoryUsedBytes: used, memoryPercent: Math.round((used / limitBytes) * 1000) / 10, cpuLimitCores: null, cpuCoresUsed: busy ? 5.4 : 1.2, cpuPercent: busy ? 67 : 15, psiMemorySome10: 0, psiCpuSome10: 0, oomKills: 0, pressure: busy ? "critical" : "normal", reasons: busy ? ["using 94% of this container's 7.3 GB memory limit"] : [] };
  const runaways = busy ? [
    { code: "memory-near-limit", severity: "critical", title: "This container's memory is nearly full: 6.9 GB of its 7.3 GB limit.", pids: [], cwd: null },
    { code: "too-many-jobs", severity: "warning", title: "5 heavy jobs are running at once; your limit is 4. Builds, tests and dev servers compete for the same CPU.", pids: [4402, 4310, 4520, 4600, 4700], cwd: null },
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
  { id: "omniroute-ai-router", name: "OmniRoute (AI Router)", target: "10.0.0.9:20128/api/health/ping", state: "slow", latencyMs: 4200, usualMs: 110, status: 200, checkedAt: Date.now(), message: "OmniRoute (AI Router) is slow: 4.2 s, usually 110 ms.", history: [110, 95, 120, 105, 130, 2900, 4200].map((latencyMs, i) => ({ at: i, state: latencyMs > 2000 ? "slow" : "up", latencyMs })) },
  { id: "status-page", name: "Status page", target: "status.example.com/health", state: "up", latencyMs: 180, usualMs: 170, status: 200, checkedAt: Date.now(), message: "Status page answered in 180 ms.", history: [160, 170, 180, 175, 180].map((latencyMs, i) => ({ at: i, state: "up", latencyMs })) },
] : [];
let revision = 1;
const stub = async (name: string, input: any) => {
  (window as any).__fixtureCalls.push({ name, input });
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
      { code: "runaway", severity: "warning", scope: "process", message: r.runaways[2]!.title, ports: [], cwd: "~/projects/website", subject: "tsc" },
      { code: "service-slow", severity: "warning", scope: "host", message: watched()[0]!.message, ports: [], cwd: null, subject: "OmniRoute (AI Router)" },
    ] : [];
    return { status: busy ? "critical" : "ok", checkedAt: Date.now(), background: true, issues, watched: watched(),
      load: { memoryUsedBytes: r.container ? r.container.memoryUsedBytes : r.host.memoryUsedBytes, memoryLimitBytes: r.memoryBasisBytes, memoryBasis: r.memoryBasis, cpuPercent: r.host.cpuPercent, heavyJobs: r.heavyJobs.count, heavyJobLimit: r.heavyJobs.limit },
      services: processes.filter((p) => p.service).map((p) => ({ name: p.name, cwd: p.cwd, ports: p.ports, project: { path: p.project.path, workspace: p.project.workspace } })) };
  }
  if (name === "daemon-link.processes.report") return report(input);
  if (name === "daemon-link.processes.preview") return { graceSeconds: 10, targets: processRows().filter((row) => row.stoppable).slice(0, input.tokens.length).map((row) => ({ pid: row.pid, name: row.name, ok: true, reason: null, rssBytes: row.rssBytes, cpuPercent: row.cpuPercent, children: row.tree.count > 1 ? Array.from({ length: row.tree.count - 1 }, (_, i) => ({ pid: row.pid + i + 1, name: i === 0 ? "node" : "esbuild" })) : [] })) };
  if (name === "daemon-link.processes.stop") { actions = [{ at: Date.now(), action: "stop", source: "processes", pid: 4402, name: "tsc", owner: "Website · main", status: "signaled", signaled: 1, message: "" }, ...actions]; return { escalateAfterSeconds: 10, results: [{ pid: 4402, name: "tsc", ok: true, status: "signaled", signaled: 1, message: "Asked tsc to stop. Anything still running in 10 seconds is stopped forcefully." }] }; }
  if (name === "daemon-link.processes.log") return { entries: actions };
  if (name === "daemon-link.watch.suggestions") return { suggestions: settings.watchedServices.length || mac ? [] : [{ name: "OmniRoute (AI Router)", url: "http://10.0.0.9:20128/api/health/ping", source: "ai-router", why: "The AI Router plugin on this daemon sends every request through it." }] };
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
    const filtered = all.filter((process) => `${process.name} ${process.project.name} ${process.pid}`.toLowerCase().includes(input.query?.toLowerCase() || ""));
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
export function useRpc(contract: { name: string }) { return useCallback((input: unknown) => stub(contract.name, input), [contract.name]); }
const toasts: string[] = [];
(window as any).__fixtureToasts = toasts;
const toast = { show: (message: string) => { toasts.push(message); console.info(message); }, error: (message: string) => { toasts.push(`error: ${message}`); console.info(message); } };
export function useToast() { return toast; }
export function Icon({ color, name }: { color: string; name: string }) { return <Text style={{ color }}>{({ FolderCode: "▣", Network: "⇄", Activity: "⌁", BookOpen: "▤", Laptop: "▱", Globe: "◎", Terminal: ">_", CircleCheck: "✓", Circle: "○", Server: "▥", TimerReset: "↻", ChevronDown: "▾", ChevronRight: "▸" } as Record<string, string>)[name] || "◇"}</Text>; }
export const Modal = Object.assign(({ children, open, title }: any) => open ? <View style={{ position: "absolute" as any, top: 80, left: 0, right: 0, alignItems: "center", zIndex: 10 }}><View style={{ width: "100%", maxWidth: 520, backgroundColor: params.has("light") ? "#ffffff" : "#1a2029", borderWidth: 1, borderColor: "#8886", borderRadius: 16, boxShadow: "0 12px 40px rgba(0,0,0,0.35)" as any }}><Text style={{ padding: 16, paddingBottom: 0, fontSize: 17, fontWeight: "700", color: "inherit" as any }}>{title}</Text>{children}</View></View> : null, { Content: ({ children }: any) => <View>{children}</View> });
/** Settings hook: reads the fixture document through the same stub the pill uses, saves synchronously. */
export function useSettings() {
  const [state, setState] = useState<any>({ status: "loading", saving: false, saveError: null });
  const load = useCallback(async () => { const result = await stub("settings.hosts.read", {}); setState({ ...result, saving: false, saveError: null }); }, []);
  useEffect(() => { void load(); }, [load]);
  return { ...state, save: async (values: unknown, rev: string) => { await stub("settings.hosts.write", { revision: rev, values }); await load(); return true; }, reset: async () => true, reload: load };
}
/** The fixture workspace is the Website project; its directory matches the `~/projects/website` cwd rows. */
export function useWorkspace(_id: string, selector: (workspace: any) => unknown) {
  return selector({ id: "ws-fixture", directory: "/home/fixture/projects/website", projectRootPath: "/home/fixture/projects/website", name: "Main" });
}
// Settings UI primitives, enough to render the Hosts settings screen headlessly.
export const SettingsSection = ({ title, info, children }: any) => <View style={{ gap: 8, padding: 12 }}><Text style={{ fontWeight: "600" }}>{title}</Text>{info ? <Text>{info}</Text> : null}{children}</View>;
export const SettingsGroup = SettingsSection;
export const SettingsCard = ({ children }: any) => <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#8884" }}>{children}</View>;
export const SettingsRow = ({ label, hint, children }: any) => <View style={{ gap: 4 }}><Text>{label}</Text>{hint ? <Text>{hint}</Text> : null}{children}</View>;
export const SettingsSwitch = ({ label, hint, value, onValueChange, disabled }: any) => <SettingsRow label={label} hint={hint}><Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} disabled={disabled} /></SettingsRow>;
export function SettingsSelect({ label, hint, value, options, onValueChange, disabled }: any) {
  return <SettingsRow label={label} hint={hint}><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{options.map((option: any) => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={`${label}: ${option.label}`} accessibilityState={{ selected: option.value === value, disabled }} disabled={disabled} onPress={() => onValueChange(option.value)} style={{ padding: 6, borderWidth: 1, borderColor: option.value === value ? "#4f46e5" : "#8884" }}><Text>{option.label}</Text></Pressable>)}</View></SettingsRow>;
}
export const SettingsInput = ({ label, hint, initialValue, onChangeText, placeholder, disabled }: any) => <SettingsRow label={label} hint={hint}><TextInput accessibilityLabel={label} defaultValue={initialValue} placeholder={placeholder} onChangeText={onChangeText} editable={!disabled} /></SettingsRow>;
export const SettingsAction = ({ label, actionLabel, onPress, disabled }: any) => <SettingsRow label={label}><Pressable accessibilityRole="button" accessibilityLabel={actionLabel} disabled={disabled} onPress={onPress}><Text>{actionLabel}</Text></Pressable></SettingsRow>;
