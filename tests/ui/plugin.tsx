import React, { useCallback } from "react";
import { Text, View } from "react-native";
export function defineRpc<T>(contract: T) { return contract; }
const peer = { id: "7b5dccce-8405-4681-8278-466501de93c0", label: "Development server" };
let forwards: { id: string; peerId: string; remotePort: number; localPort: number }[] = [];
const empty = new URLSearchParams(location.search).has("empty");
const failed = new URLSearchParams(location.search).has("error");
const stub = async (name: string, input: any) => {
  if (name === "daemon-link.status") return { ssh: true, cloudflared: true, profiles: [], connections: [], tunnels: [] };
  if (name === "daemon-link.peers.status") return { relayState: "off", grants: [], peers: empty ? [] : [peer], forwards };
  if (name === "daemon-link.peers.services") {
    if (failed) throw new Error("Peer did not respond. Check that Daemon Link is running on both machines and the relay is reachable.");
    return { services: [{ port: 3000, label: "Next.js", project: "~/projects/my-app" }, { port: 5173, label: "Vite", project: "~/projects/component-library" }, { port: 8000, label: "Uvicorn", project: "~/projects/api" }] };
  }
  if (name === "daemon-link.peers.forward") { forwards = [{ id: "demo-forward", peerId: peer.id, remotePort: input.port, localPort: input.port }]; return { localPort: input.port, url: "https://example.com" }; }
  if (name === "daemon-link.peers.disconnect") { forwards = []; return { ok: true }; }
  if (name === "monitor.snapshot") return {
    timestamp: Date.now(), sampling: "live", platform: "linux", supported: true, warnings: [], uptimeSeconds: 3600,
    cpu: { percent: 12, cores: 8, load1: 0.8, load5: 1.2, load15: 1, psiSome10: 0, pressure: "normal", reasons: [] },
    memory: { totalBytes: 16e9, usedBytes: 5e9, availableBytes: 11e9, swapTotalBytes: 4e9, swapUsedBytes: 0, psiSome10: 0, pressureSignal: "normal", pressure: "normal", reasons: [] },
    services: [], processes: [], totalProcesses: 0, matchedProcesses: 0, truncated: false,
  };
  return { ok: true };
};
export function useRpc(contract: { name: string }) { return useCallback((input: unknown) => stub(contract.name, input), [contract.name]); }
const toast = { show: (message: string) => console.info(message), error: (message: string) => console.info(message) };
export function useToast() { return toast; }
export function Icon({ color }: { color: string }) { return <Text style={{ color }}>◇</Text>; }
export const Modal = Object.assign(({ children, open }: any) => open ? <View>{children}</View> : null, { Content: ({ children }: any) => <View>{children}</View> });
