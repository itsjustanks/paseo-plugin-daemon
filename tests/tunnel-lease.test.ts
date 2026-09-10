import { describe, expect, it } from "vitest";
import { tunnelExtend, tunnelStart } from "../shared/link";
import { TUNNEL_MAX_LIFETIME_MS, TUNNEL_MINUTES, TUNNEL_MINUTES_DEFAULT, TUNNEL_MINUTES_MESSAGE, formatMinutes, formatRemaining, isTunnelMinutes, nextExpiry, tunnelStatus } from "../shared/tunnel-lease";

const MINUTE = 60_000;

describe("tunnel lease durations", () => {
  it("offers 15 minutes to 8 hours, defaults to 2 hours, and caps a link's life at 24 hours", () => {
    expect([...TUNNEL_MINUTES]).toEqual([15, 30, 60, 120, 240, 480]);
    expect(TUNNEL_MINUTES_DEFAULT).toBe(120);
    expect(TUNNEL_MAX_LIFETIME_MS).toBe(24 * 60 * MINUTE);
    expect(isTunnelMinutes(480)).toBe(true);
    expect(isTunnelMinutes(45)).toBe(false);
    expect(TUNNEL_MINUTES_MESSAGE).toBe("Choose a link of 15 min, 30 min, 1 h, 2 h, 4 h, 8 h.");
    expect(formatMinutes(90)).toBe("1 h 30 min");
  });
  it("is what the RPC contracts accept", () => {
    expect(tunnelStart.input.parse({ port: 3000 })).toEqual({ port: 3000, minutes: 120 });
    expect(tunnelStart.input.safeParse({ port: 3000, minutes: 45 }).success).toBe(false);
    expect(tunnelStart.input.safeParse({ port: 3000, minutes: 480 }).success).toBe(true);
    expect(tunnelExtend.input.parse({ id: "00000000-0000-4000-8000-000000000001" })).toEqual({ id: "00000000-0000-4000-8000-000000000001", minutes: 120 });
    expect(tunnelExtend.input.safeParse({ id: "00000000-0000-4000-8000-000000000001", minutes: 1440 }).success).toBe(false);
  });
  it("renews from now, clamps to the lifetime cap, and refuses once the cap is spent", () => {
    const createdAt = 1_000_000;
    expect(nextExpiry(createdAt + 10 * MINUTE, createdAt, 60)).toBe(createdAt + 70 * MINUTE);
    // 23 hours in, an 8-hour renewal only reaches the cap.
    expect(nextExpiry(createdAt + 23 * 60 * MINUTE, createdAt, 480)).toBe(createdAt + TUNNEL_MAX_LIFETIME_MS);
    // Less than a minute of cap left is not worth a renewal.
    expect(nextExpiry(createdAt + TUNNEL_MAX_LIFETIME_MS - 30_000, createdAt, 15)).toBeNull();
    expect(nextExpiry(createdAt + TUNNEL_MAX_LIFETIME_MS + 1, createdAt, 15)).toBeNull();
  });
});

describe("tunnelStatus and formatRemaining", () => {
  const now = 5_000_000;
  it("maps daemon state plus expiry onto what the row should say", () => {
    expect(tunnelStatus({ state: "starting", expiresAt: now + 10 * MINUTE }, now)).toEqual({ phase: "starting", remainingMs: 10 * MINUTE });
    expect(tunnelStatus({ state: "connected", expiresAt: now + 10 * MINUTE }, now)).toEqual({ phase: "ready", remainingMs: 10 * MINUTE });
    // The daemon's expiry timer may lag a poll; the row already reads as expired.
    expect(tunnelStatus({ state: "connected", expiresAt: now - 1 }, now)).toEqual({ phase: "expired", remainingMs: 0 });
    expect(tunnelStatus({ state: "error", expiresAt: now + MINUTE }, now)).toEqual({ phase: "error", remainingMs: 0 });
    expect(tunnelStatus({ state: "stopped", expiresAt: now + MINUTE }, now)).toEqual({ phase: "stopped", remainingMs: 0 });
    expect(tunnelStatus({ state: "retrying", expiresAt: now + MINUTE }, now).phase).toBe("starting");
  });
  it("formats remaining time in hours and minutes only", () => {
    expect(formatRemaining(20_000)).toBe("under a minute left");
    expect(formatRemaining(12 * MINUTE + 5_000)).toBe("12 min left");
    expect(formatRemaining(120 * MINUTE)).toBe("2 h left");
    expect(formatRemaining(130 * MINUTE)).toBe("2 h 10 min left");
    expect(formatRemaining(-5)).toBe("under a minute left");
  });
});
