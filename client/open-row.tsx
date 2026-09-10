import React from "react";
import { Text, View } from "react-native";
import type { Tunnel } from "../shared/link";
import { formatMinutes, tunnelStatus, type TunnelMinutes } from "../shared/tunnel-lease";
import type { useOpenService } from "./open-service";
import { TunnelState } from "./tunnel-row";
import { Button, useTokens } from "./ui";

/**
 * The per-port Open controls under a dev-server card: live link state, one
 * Open press that starts or reuses the browser link, and Extend / Close once
 * one is live. The same component sits in the Hosts surface and the
 * workspace panel so the headline flow is identical in both places.
 */
export function OpenRow({ ports, tunnels, minutes, available, opener, onSetup, installing, onPrivate }: {
  ports: readonly number[];
  tunnels: readonly Tunnel[];
  minutes: TunnelMinutes;
  /** Whether the tunnel helper is installed on this host. */
  available: boolean;
  opener: ReturnType<typeof useOpenService>;
  onSetup?: () => void;
  installing?: boolean;
  /** Offered next to the public link: the private route for the same port. */
  onPrivate?: (port: number) => void;
}) {
  const t = useTokens();
  if (ports.length === 0) return <Text style={t.text.caption}>No listening port yet; Open appears once the server is up.</Text>;
  return (
    <View style={{ gap: t.space.sm, borderTopWidth: 1, borderTopColor: t.color.borderSubtle, paddingTop: t.space.sm }}>
      {ports.map((port) => {
        const tunnel = tunnels.find((item) => item.port === port && item.state !== "stopped");
        const status = tunnel ? tunnelStatus(tunnel, Date.now()) : null;
        const waiting = opener.isWaiting(port);
        const live = status?.phase === "ready" || status?.phase === "starting";
        return (
          <View key={port} style={{ gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm, flexWrap: "wrap" }}>
              <Text style={t.text.bodyStrong}>localhost:{port}</Text>
              <TunnelState tunnel={tunnel} waiting={waiting} />
            </View>
            {status?.phase === "error" ? <Text style={[t.text.caption, { color: t.color.danger }]}>{tunnel!.message}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
              {available ? (
                <Button
                  label={status?.phase === "ready" ? "Open in browser" : waiting || status?.phase === "starting" ? "Opening…" : status?.phase === "error" ? "Retry Open" : "Open in browser"}
                  variant="primary" icon="Globe" loading={waiting || status?.phase === "starting"} disabled={waiting}
                  accessibilityLabel={`Open port ${port} in the browser`} onPress={() => { void opener.openService(port); }}
                />
              ) : (
                <Button label={installing ? "Setting up…" : "Set up browser links"} variant="primary" loading={installing} disabled={installing || !onSetup} accessibilityLabel={`Set up browser links for port ${port}`} onPress={() => onSetup?.()} />
              )}
              {live && tunnel ? <Button label={`Extend ${formatMinutes(minutes)}`} icon="TimerReset" disabled={opener.extending} accessibilityLabel={`Extend browser link for port ${port} by ${formatMinutes(minutes)}`} onPress={() => opener.extendLink(tunnel.id)} /> : null}
              {tunnel && tunnel.state !== "stopped" ? <Button label="Close link" variant="ghost" disabled={opener.closing} accessibilityLabel={`Close browser link for port ${port}`} onPress={() => opener.closeLink(tunnel)} /> : null}
              {onPrivate ? <Button label="Private forward…" icon="Terminal" accessibilityLabel={`Set up a private forward for port ${port}`} onPress={() => onPrivate(port)} /> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
