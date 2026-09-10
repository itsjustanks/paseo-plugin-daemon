import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { z } from "zod";
import * as rpc from "../shared/link";
import type { TunnelMinutes } from "../shared/tunnel-lease";
import { prepareExternal } from "./web";

/**
 * The one-press "open this dev server in my browser" flow, shared by the
 * Hosts surface and the workspace panel so both behave identically.
 *
 * A press reserves a browser tab synchronously (popup blockers only allow
 * that inside the click), then either finishes it straight away with a live
 * link's URL, or starts a link and lets the status poll redirect the tab once
 * the daemon reports `connected`. Nothing here ever renders or logs the URL;
 * it goes from the RPC result into the reserved tab and nowhere else.
 */

export type LinkStatus = z.output<typeof rpc.linkStatus.output>;
type Popup = ReturnType<typeof prepareExternal>;

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";

export function useOpenService({ links, minutes }: { links: UseQueryResult<LinkStatus>; minutes: TunnelMinutes }) {
  const toast = useToast();
  const start = useRpc(rpc.tunnelStart), stop = useRpc(rpc.tunnelStop), open = useRpc(rpc.tunnelOpen), extend = useRpc(rpc.tunnelExtend), install = useRpc(rpc.tunnelInstall);
  /** Tabs reserved for ports whose link is still starting. */
  const pending = useRef(new Map<number, Popup>());
  /** Ports whose redirect is in flight, so one poll cannot finish a tab twice. */
  const opening = useRef(new Set<number>());

  useEffect(() => () => { for (const popup of pending.current.values()) popup.close(); pending.current.clear(); }, []);
  useEffect(() => {
    if (links.isError) { for (const popup of pending.current.values()) popup.close(); pending.current.clear(); return; }
    for (const tunnel of links.data?.tunnels || []) {
      const popup = pending.current.get(tunnel.port);
      if (!popup || opening.current.has(tunnel.port)) continue;
      if (tunnel.state === "error") { popup.close(); pending.current.delete(tunnel.port); toast.error(tunnel.message); }
      if (tunnel.state === "connected") {
        opening.current.add(tunnel.port);
        void open({ id: tunnel.id }).then(({ url }) => popup.finish(url)).catch((err) => { popup.close(); toast.error(errorMessage(err)); })
          .finally(() => { pending.current.delete(tunnel.port); opening.current.delete(tunnel.port); });
      }
    }
  }, [links.data, links.isError, open, toast]);

  /** Must be called synchronously from the press handler: it opens the tab before any await. */
  const openService = useCallback(async (port: number) => {
    if (pending.current.has(port)) return;
    let popup: Popup | undefined;
    try {
      popup = prepareExternal();
      const existing = links.data?.tunnels.find((tunnel) => tunnel.port === port && tunnel.state === "connected" && tunnel.expiresAt > Date.now());
      if (existing) { await popup.finish((await open({ id: existing.id })).url); return; }
      pending.current.set(port, popup);
      for (const failed of links.data?.tunnels.filter((tunnel) => tunnel.port === port && tunnel.state === "error") || []) await stop({ id: failed.id });
      await start({ port, minutes }); await links.refetch();
    } catch (err) { popup?.close(); pending.current.delete(port); toast.error(errorMessage(err)); }
  }, [links, minutes, open, start, stop, toast]);

  const extendMutation = useMutation({
    mutationFn: (id: string) => extend({ id, minutes }),
    onSuccess: () => { void links.refetch(); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const stopMutation = useMutation({
    mutationFn: (id: string) => stop({ id }),
    onSuccess: () => { void links.refetch(); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const closeLink = useCallback((tunnel: Pick<rpc.Tunnel, "id" | "port">) => {
    pending.current.get(tunnel.port)?.close(); pending.current.delete(tunnel.port);
    stopMutation.mutate(tunnel.id);
  }, [stopMutation]);

  /** One-time helper install on this host; the status poll flips `cloudflared` to true afterwards. */
  const installMutation = useMutation({
    mutationFn: () => install({}),
    onSuccess: () => { void links.refetch(); toast.show("Browser links are ready", { variant: "success" }); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** True while a tab is reserved for this port and the daemon has not answered yet. */
  const isWaiting = useCallback((port: number) => pending.current.has(port), []);

  return {
    openService, isWaiting,
    extendLink: extendMutation.mutate, extending: extendMutation.isPending,
    closeLink, closing: stopMutation.isPending,
    installLinks: installMutation.mutate, installing: installMutation.isPending,
  };
}
