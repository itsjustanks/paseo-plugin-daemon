import React, { useCallback } from "react";
import { Text, View } from "react-native";
export function defineRpc<T>(contract: T) { return contract; }
const peer = { id: "7b5dccce-8405-4681-8278-466501de93c0", label: "Development server" };
let forwards: { id: string; peerId: string; remotePort: number; localPort: number }[] = [];
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error"), unverified = params.has("unverified");
const projects = [{ id: "website", name: "Website", path: "~/projects/website" }, { id: "api", name: "API service", path: "~/projects/api" }];
const processes = Array.from({ length: 64 }, (_, index) => {
  const app = index < 2, agent = index === 2;
  const project = projects[index % 2];
  return { pid: 1000 + index, ppid: 900, name: agent ? "codex" : app ? "next-server" : "node", command: agent ? "codex" : "node project-task.js", cwd: project.path,
    state: "sleeping", cpuPercent: 30 - index / 3, rssBytes: (65 - index) * 1e6, memoryPercent: 0.5, ageSeconds: index * 60 + 80,
    ports: app ? [3000 + index] : [], impact: "normal", reasons: [],
    service: app ? { kind: "dev-server", label: "Next.js", confidence: "high", reasons: ["Recognized framework"] } : null,
    project: { ...project, workspace: "Main", kind: agent ? "agent" : app ? "dev-server" : "project-tool", shareable: app, canStop: app },
    actionable: app, actionToken: app ? "synthetic-action" : null, protectedReason: app ? null : agent ? "Manage this agent in its Paseo agent tab." : "Only verified project dev servers can be stopped here.",
  };
});
const stub = async (name: string, input: any) => {
  if (name === "daemon-link.status") return { ssh: true, cloudflared: !empty, profiles: [], connections: [], tunnels: [] };
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
const toast = { show: (message: string) => console.info(message), error: (message: string) => console.info(message) };
export function useToast() { return toast; }
export function Icon({ color, name }: { color: string; name: string }) { return <Text style={{ color }}>{({ FolderCode: "▣", Network: "⇄", Activity: "⌁", BookOpen: "▤", Laptop: "▱", Globe: "◎", Terminal: ">_", CircleCheck: "✓", Circle: "○" } as Record<string, string>)[name] || "◇"}</Text>; }
export const Modal = Object.assign(({ children, open }: any) => open ? <View>{children}</View> : null, { Content: ({ children }: any) => <View>{children}</View> });
