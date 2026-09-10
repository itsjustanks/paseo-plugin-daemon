import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Tunnel } from "../shared/link";
import { formatMinutes, formatRemaining, tunnelStatus, type TunnelMinutes, type TunnelPhase } from "../shared/tunnel-lease";
import { Button, Card, Facts, StatusPill, useTokens, type Tone } from "./ui";

/**
 * Live state of one temporary browser link, shared by the dev-server cards
 * and the link lists. Ticks once a minute so "12 min left" stays honest
 * between polls. Never shows the URL: a link is a credential.
 */

const PHASE_TONE: Record<TunnelPhase, Tone> = { starting: "accent", ready: "ok", expired: "warning", error: "danger", stopped: "neutral" };
const PHASE_LABEL: Record<TunnelPhase, string> = { starting: "Starting link", ready: "Link ready", expired: "Link expired", error: "Link failed", stopped: "Link closed" };

/** Epoch milliseconds, refreshed every minute so remaining-time copy moves on its own. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function TunnelState({ tunnel, waiting }: { tunnel: Tunnel | undefined; waiting: boolean }) {
  const now = useMinuteClock();
  if (!tunnel) return waiting ? <StatusPill tone="accent" label="Starting link" /> : <StatusPill tone="neutral" label="No link yet" />;
  const status = tunnelStatus(tunnel, now);
  return <StatusPill tone={PHASE_TONE[status.phase]} label={status.phase === "ready" ? `Link ready · ${formatRemaining(status.remainingMs)}` : PHASE_LABEL[status.phase]} />;
}

/** One link: port, state, expiry, the one-line daemon message, and Extend / Close. */
export function TunnelCard({ tunnel, minutes, onExtend, onClose, busy }: { tunnel: Tunnel; minutes: TunnelMinutes; onExtend(id: string): void; onClose(tunnel: Tunnel): void; busy: boolean }) {
  const t = useTokens();
  const now = useMinuteClock();
  const status = tunnelStatus(tunnel, now);
  const live = status.phase === "starting" || status.phase === "ready";
  return (
    <Card tone={status.phase === "error" ? "danger" : status.phase === "expired" ? "warning" : undefined}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>Browser link · port {tunnel.port}</Text>
        <TunnelState tunnel={tunnel} waiting={false} />
      </View>
      <Facts items={[
        live ? { value: `expires ${new Date(tunnel.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` } : null,
        live ? { value: formatRemaining(status.remainingMs) } : null,
        { value: `started ${new Date(tunnel.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` },
      ]} />
      <Text style={t.text.caption}>{tunnel.message}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {live ? <Button label={`Extend by ${formatMinutes(minutes)}`} icon="TimerReset" disabled={busy} accessibilityLabel={`Extend browser link for port ${tunnel.port} by ${formatMinutes(minutes)}`} onPress={() => onExtend(tunnel.id)} /> : null}
        <Button label="Close browser link" disabled={busy} accessibilityLabel={`Close browser link for port ${tunnel.port}`} onPress={() => onClose(tunnel)} />
      </View>
    </Card>
  );
}
