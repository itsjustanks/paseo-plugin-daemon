import * as ClientSdk from "@getpaseo/plugin/client";

export interface CrossDaemonHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}

// useHosts is documented in the supplied official reference and SDK 0.10.3.
// Hosts still typechecks against 0.8.0-beta.1; never invent a host list on older apps.
const useHosts = (ClientSdk as unknown as { useHosts?: () => readonly CrossDaemonHostSummary[] }).useHosts;
export function useCrossDaemonHosts(): readonly CrossDaemonHostSummary[] | null {
  return useHosts ? useHosts() : null;
}
