import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WATCH_HISTORY,
  WATCH_MIN_INTERVAL_MS,
  WATCH_TIMEOUT_MS,
  aiRouterHealthUrl,
  judge,
  watchTarget,
  watchUrlProblem,
  type Probe,
  type Suggestion,
  type WatchedService,
  type WatchResult,
} from "../shared/watch";

export type Fetcher = (url: string, init: { method: string; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; body?: { cancel?: () => Promise<void> } | null }>;

/**
 * Checks the watched URLs: a GET with a short timeout, redirects not
 * followed (a redirect's status is the answer), nothing sent but a
 * user-agent, and the body discarded unread. Keeps a short history per
 * service in memory; results survive between checks, not daemon restarts.
 */
export class WatchChecker {
  private readonly history = new Map<string, WatchResult["history"]>();
  private readonly last = new Map<string, WatchResult>();
  private lastRun = 0;
  private inflight: Promise<WatchResult[]> | null = null;

  constructor(private readonly fetcher: Fetcher = globalThis.fetch as unknown as Fetcher, private readonly now: () => number = Date.now) {}

  /** The latest results, checking first when the last check is older than the minimum interval (or `force`). */
  async check(services: readonly WatchedService[], force = false): Promise<WatchResult[]> {
    const ids = new Set(services.map((service) => service.id));
    for (const id of [...this.history.keys()]) if (!ids.has(id)) { this.history.delete(id); this.last.delete(id); }
    const due = force || this.now() - this.lastRun >= WATCH_MIN_INTERVAL_MS || services.some((service) => !this.last.has(service.id) || this.last.get(service.id)!.target !== watchTarget(service.url));
    if (due && services.length > 0) {
      this.inflight ??= Promise.all(services.map((service) => this.probe(service))).finally(() => { this.inflight = null; this.lastRun = this.now(); });
      await this.inflight;
    }
    return services.map((service) => this.last.get(service.id) ?? unknown(service));
  }

  private async probe(service: WatchedService): Promise<WatchResult> {
    let probe: Probe;
    const started = this.now();
    if (watchUrlProblem(service.url)) probe = { at: started, latencyMs: null, status: null, error: "network" };
    else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WATCH_TIMEOUT_MS);
      try {
        const response = await this.fetcher(service.url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "Paseo Daemon Link health check" } });
        probe = { at: started, latencyMs: Math.max(0, this.now() - started), status: response.status, error: null };
        void response.body?.cancel?.().catch(() => undefined);
      } catch {
        probe = { at: started, latencyMs: null, status: null, error: controller.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    }
    const earlier = this.history.get(service.id) ?? [];
    const verdict = judge(service, probe, earlier);
    const history = [...earlier, { at: probe.at, state: verdict.state, latencyMs: probe.latencyMs }].slice(-WATCH_HISTORY);
    this.history.set(service.id, history);
    const result: WatchResult = {
      id: service.id, name: service.name, target: watchTarget(service.url), state: verdict.state, latencyMs: probe.latencyMs,
      usualMs: verdict.usualMs, status: probe.status, checkedAt: probe.at, message: verdict.message, history,
    };
    this.last.set(service.id, result);
    return result;
  }
}

function unknown(service: WatchedService): WatchResult {
  return { id: service.id, name: service.name, target: watchTarget(service.url), state: "unknown", latencyMs: null, usualMs: null, status: null, checkedAt: null, message: `${service.name} hasn't been checked yet.`, history: [] };
}

/**
 * Suggest watching the AI Router's OmniRoute when that plugin is set up on
 * this daemon. Only its `endpoint` field is read; the API key and every
 * other field in that file are ignored and never leave this function.
 */
export async function suggestions(watched: readonly WatchedService[], paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo")): Promise<Suggestion[]> {
  let endpoint: unknown;
  try {
    const parsed = JSON.parse(await readFile(join(paseoHome, "plugin-settings", "ai-router", "connection.json"), "utf8")) as Record<string, unknown>;
    endpoint = parsed?.endpoint;
  } catch { return []; }
  if (typeof endpoint !== "string") return [];
  const url = aiRouterHealthUrl(endpoint);
  if (!url || watched.some((service) => service.url === url)) return [];
  return [{ name: "OmniRoute (AI Router)", url, source: "ai-router", why: "The AI Router plugin on this daemon sends every request through it." }];
}
