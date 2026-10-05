import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Watched services: health URLs on *other* machines. A daemon in a container
 * can't see its host's processes, so an outage elsewhere (OmniRoute's own
 * server pegging its CPU, say) only shows up as a slow or failing URL. The
 * daemon checks each one on the health-check schedule and keeps a short
 * history, so "slow" means slow compared with how it usually answers.
 *
 * URLs must not carry secrets: no user:password@, and no query keys that look
 * like credentials. Only http and https.
 */

export const WATCH_TIMEOUT_MS = 5000;
/** Checks are never more frequent than this, whatever the health interval. */
export const WATCH_MIN_INTERVAL_MS = 30_000;
export const WATCH_HISTORY = 30;
/** Slower than this is slow, however it usually answers. */
export const SLOW_ABSOLUTE_MS = 2000;
/** Or this many times slower than usual (and at least SLOW_RELATIVE_FLOOR_MS). */
export const SLOW_FACTOR = 5;
export const SLOW_RELATIVE_FLOOR_MS = 500;

const SECRET_QUERY = /^(key|api[-_]?key|token|access[-_]?token|auth|authorization|secret|password|passwd|pwd|sig|signature|session|cookie|credential)s?$/i;

/** Plain words on what is wrong with a URL, or null when it may be watched. */
export function watchUrlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return "Enter the service's health URL.";
  if (text.length > 500) return "That URL is too long.";
  let url: URL;
  try { url = new URL(text); } catch { return "That isn't a full URL. Start it with http:// or https://."; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http:// and https:// URLs can be watched.";
  if (url.username || url.password) return "Remove the user name and password from the URL. Watched URLs must not contain secrets.";
  for (const key of url.searchParams.keys()) if (SECRET_QUERY.test(key)) return `Remove "${key}" from the URL. Watched URLs must not contain secrets.`;
  if (!url.hostname) return "The URL needs a host name.";
  return null;
}

/** Host and path only, for display: never the query or fragment. */
export function watchTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch { return "invalid URL"; }
}

export const WatchedServiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(60),
  url: z.string().refine((value) => watchUrlProblem(value) === null, { message: "Use an http(s) URL without secrets." }),
  /** When set, only this status counts as up; otherwise any 2xx or 3xx. */
  expectedStatus: z.number().int().min(100).max(599).nullable().default(null),
});
export type WatchedService = z.infer<typeof WatchedServiceSchema>;

export const WatchStateSchema = z.enum(["up", "slow", "down", "unknown"]);
export type WatchState = z.infer<typeof WatchStateSchema>;

export const WatchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Host and path, never the query. */
  target: z.string(),
  state: WatchStateSchema,
  latencyMs: z.number().min(0).nullable(),
  /** Median of recent good answers; null until there are three. */
  usualMs: z.number().min(0).nullable(),
  status: z.number().int().nullable(),
  checkedAt: z.number().nullable(),
  /** One plain sentence, such as "OmniRoute is slow: 4.2 s, usually 0.1 s". */
  message: z.string(),
  history: z.array(z.object({ at: z.number(), state: WatchStateSchema, latencyMs: z.number().nullable() })),
});
export type WatchResult = z.infer<typeof WatchResultSchema>;

export interface Probe { at: number; latencyMs: number | null; status: number | null; error: "timeout" | "network" | null }

export function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function median(values: number[]): number | null {
  if (values.length < 3) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Up, slow or down for one probe, judged against the earlier history (good
 * answers only). Pure: the server feeds it probes, tests feed it numbers.
 */
export function judge(service: Pick<WatchedService, "name" | "expectedStatus">, probe: Probe, earlier: WatchResult["history"]): { state: WatchState; usualMs: number | null; message: string } {
  const usualMs = median(earlier.filter((entry) => entry.state === "up" && entry.latencyMs !== null).map((entry) => entry.latencyMs!));
  const usual = usualMs === null ? "" : `, usually ${seconds(usualMs)}`;
  if (probe.error === "timeout") return { state: "down", usualMs, message: `${service.name} is down: no answer within ${seconds(WATCH_TIMEOUT_MS)}${usual}.` };
  if (probe.error || probe.status === null || probe.latencyMs === null) return { state: "down", usualMs, message: `${service.name} is down: it can't be reached.` };
  const good = service.expectedStatus !== null ? probe.status === service.expectedStatus : probe.status >= 200 && probe.status < 400;
  if (!good) return { state: "down", usualMs, message: `${service.name} is down: it answered ${probe.status}${service.expectedStatus !== null ? ` instead of ${service.expectedStatus}` : ""}.` };
  const slow = probe.latencyMs >= SLOW_ABSOLUTE_MS || (usualMs !== null && probe.latencyMs >= Math.max(SLOW_RELATIVE_FLOOR_MS, usualMs * SLOW_FACTOR));
  if (slow) return { state: "slow", usualMs, message: `${service.name} is slow: ${seconds(probe.latencyMs)}${usual}.` };
  return { state: "up", usualMs, message: `${service.name} answered in ${seconds(probe.latencyMs)}.` };
}

/** The AI Router's OmniRoute health URL from its endpoint ("http://h:20128/v1" → "http://h:20128/api/health/ping"). */
export function aiRouterHealthUrl(endpoint: string): string | null {
  const base = endpoint.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  if (!base) return null;
  const url = `${base}/api/health/ping`;
  return watchUrlProblem(url) === null ? url : null;
}

/** A short, stable id from a name: "OmniRoute (AI Router)" → "omniroute-ai-router". */
export function watchId(name: string, taken: readonly string[]): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "service";
  let id = stem, n = 2;
  while (taken.includes(id)) id = `${stem}-${n++}`;
  return id;
}

export const SuggestionSchema = z.object({ name: z.string(), url: z.string(), source: z.enum(["ai-router"]), why: z.string() });
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const watchSuggestions = defineRpc({
  name: "daemon-link.watch.suggestions",
  input: z.object({}),
  output: z.object({ suggestions: z.array(SuggestionSchema) }),
});
