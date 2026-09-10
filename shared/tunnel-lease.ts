import { z } from "zod";
import type { Tunnel } from "./link";

/**
 * How long a temporary browser link may live.
 *
 * A link is a public HTTPS URL (behind the gate's cookie session and the
 * service lease), so it must always expire on its own. The allowed durations
 * run from a quick 15-minute share to a full 8-hour work day; the daemon's
 * default comes from the Hosts settings. A live link can be renewed without
 * tearing the tunnel down, but never past `TUNNEL_MAX_LIFETIME_MS` after it
 * was created: at that point the URL has been public for a day and a fresh
 * one costs a single press.
 */
export const TUNNEL_MINUTES = [15, 30, 60, 120, 240, 480] as const;
export type TunnelMinutes = (typeof TUNNEL_MINUTES)[number];
export const TUNNEL_MINUTES_DEFAULT: TunnelMinutes = 120;
export const TUNNEL_MAX_LIFETIME_MS = 24 * 60 * 60_000;

export const TunnelMinutesSchema = z.literal(TUNNEL_MINUTES);
export const isTunnelMinutes = (value: number): value is TunnelMinutes => (TUNNEL_MINUTES as readonly number[]).includes(value);
export const TUNNEL_MINUTES_MESSAGE = `Choose a link of ${TUNNEL_MINUTES.map(formatMinutes).join(", ")}.`;

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The expiry a renewal should set, or null when the link has already used
 * its whole lifetime. A renewal that would cross the lifetime cap is clamped
 * to the cap as long as that still buys at least a minute.
 */
export function nextExpiry(now: number, createdAt: number, minutes: TunnelMinutes): number | null {
  const wanted = now + minutes * 60_000;
  const cap = createdAt + TUNNEL_MAX_LIFETIME_MS;
  if (wanted <= cap) return wanted;
  return cap - now >= 60_000 ? cap : null;
}

export type TunnelPhase = "starting" | "ready" | "expired" | "error" | "stopped";

export interface TunnelStatus {
  phase: TunnelPhase;
  /** Milliseconds until expiry; 0 once expired or when the link is not live. */
  remainingMs: number;
}

/** Where a link stands right now; `connected` past its expiry reads as expired until the daemon notices. */
export function tunnelStatus(tunnel: Pick<Tunnel, "state" | "expiresAt">, now: number): TunnelStatus {
  const remainingMs = Math.max(0, tunnel.expiresAt - now);
  if (tunnel.state === "error") return { phase: "error", remainingMs: 0 };
  if (tunnel.state === "stopped") return { phase: "stopped", remainingMs: 0 };
  if (tunnel.state === "connected") return remainingMs > 0 ? { phase: "ready", remainingMs } : { phase: "expired", remainingMs: 0 };
  return { phase: "starting", remainingMs };
}

/** "2 h 10 min left", "12 min left", or "under a minute left"; never a raw millisecond count. */
export function formatRemaining(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute left";
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min left`;
  return minutes % 60 === 0 ? `${hours} h left` : `${hours} h ${minutes % 60} min left`;
}
