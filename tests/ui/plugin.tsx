import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
export function defineRpc<T>(contract: T) { return contract; }
export function defineSettings<T>(definition: T) { return definition; }
export function settingsRpc(id: string) { return { read: { name: `settings.${id}.read` }, write: { name: `settings.${id}.write` }, reset: { name: `settings.${id}.reset` } }; }
const peer = { id: "7b5dccce-8405-4681-8278-466501de93c0", label: "Development server" };
let forwards: { id: string; peerId: string; remotePort: number; localPort: number }[] = [];
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error"), unverified = params.has("unverified"), tunnelFail = params.has("tunnelfail");
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
let settings = { closeTunnelsOnArchive: true, panelScope: "workspace", snapshotIntervalSeconds: 20, backgroundHealthChecks: true, showComposerPill: true, tunnelMinutes: Number(params.get("minutes") || 120) };
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
  if (name === "daemon-link.health") return { status: "ok", checkedAt: Date.now(), background: true, issues: [], services: processes.filter((p) => p.service).map((p) => ({ name: p.name, cwd: p.cwd, ports: p.ports, project: { path: p.project.path, workspace: p.project.workspace } })) };
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
export const Modal = Object.assign(({ children, open }: any) => open ? <View>{children}</View> : null, { Content: ({ children }: any) => <View>{children}</View> });
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
