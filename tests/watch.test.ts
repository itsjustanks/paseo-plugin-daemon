import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WatchChecker, suggestions, type Fetcher } from "../server/watch";
import { WATCH_MIN_INTERVAL_MS, aiRouterHealthUrl, judge, watchId, watchTarget, watchUrlProblem, type WatchedService } from "../shared/watch";

const service = (over: Partial<WatchedService> = {}): WatchedService => ({ id: "omniroute", name: "OmniRoute", url: "http://10.0.0.9:20128/api/health/ping", expectedStatus: null, ...over });
const up = (latencyMs: number, at = 0) => ({ at, state: "up" as const, latencyMs });

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

describe("watched service URLs", () => {
  it("allow plain http(s) health URLs and refuse anything that carries a secret", () => {
    expect(watchUrlProblem("http://10.0.0.9:20128/api/health/ping")).toBeNull();
    expect(watchUrlProblem("https://status.example.com/health?verbose=1")).toBeNull();
    expect(watchUrlProblem("")).toMatch(/Enter/);
    expect(watchUrlProblem("example.com/health")).toMatch(/full URL/);
    expect(watchUrlProblem("ftp://example.com")).toMatch(/Only http/);
    expect(watchUrlProblem("https://admin:hunter2@example.com/health")).toMatch(/user name and password/);
    expect(watchUrlProblem("https://example.com/health?token=abc")).toMatch(/Remove "token"/);
    expect(watchUrlProblem("https://example.com/health?API_KEY=abc")).toMatch(/Remove "API_KEY"/);
    expect(watchUrlProblem(`https://example.com/${"a".repeat(600)}`)).toMatch(/too long/);
    expect(watchTarget("https://example.com:8443/health?verbose=1#x")).toBe("example.com:8443/health");
    expect(watchId("OmniRoute (AI Router)", ["omniroute-ai-router"])).toBe("omniroute-ai-router-2");
  });

  it("derive OmniRoute's health URL from the AI Router endpoint, with or without /v1", () => {
    expect(aiRouterHealthUrl("http://10.0.0.9:20128")).toBe("http://10.0.0.9:20128/api/health/ping");
    expect(aiRouterHealthUrl("https://router.example.com/v1/")).toBe("https://router.example.com/api/health/ping");
    expect(aiRouterHealthUrl("https://user:pw@router.example.com/v1")).toBeNull();
    expect(aiRouterHealthUrl("")).toBeNull();
  });
});

describe("up, slow or down", () => {
  it("is slow compared with how it usually answers, and says so in plain words", () => {
    const history = [up(100), up(120), up(90), up(110)];
    expect(judge(service(), { at: 1, latencyMs: 4200, status: 200, error: null }, history)).toEqual({ state: "slow", usualMs: 105, message: "OmniRoute is slow: 4.2 s, usually 105 ms." });
    expect(judge(service(), { at: 1, latencyMs: 600, status: 200, error: null }, history).state).toBe("slow");
    expect(judge(service(), { at: 1, latencyMs: 300, status: 200, error: null }, history)).toMatchObject({ state: "up", message: "OmniRoute answered in 300 ms." });
    // Without a history only the absolute bar applies.
    expect(judge(service(), { at: 1, latencyMs: 1500, status: 200, error: null }, []).state).toBe("up");
    expect(judge(service(), { at: 1, latencyMs: 2500, status: 200, error: null }, []).state).toBe("slow");
  });

  it("is down on a timeout, a network error or the wrong status", () => {
    expect(judge(service(), { at: 1, latencyMs: null, status: null, error: "timeout" }, [up(100), up(100), up(100)]).message).toBe("OmniRoute is down: no answer within 5.0 s, usually 100 ms.");
    expect(judge(service(), { at: 1, latencyMs: null, status: null, error: "network" }, []).message).toBe("OmniRoute is down: it can't be reached.");
    expect(judge(service(), { at: 1, latencyMs: 50, status: 502, error: null }, []).message).toBe("OmniRoute is down: it answered 502.");
    expect(judge(service({ expectedStatus: 204 }), { at: 1, latencyMs: 50, status: 200, error: null }, []).message).toBe("OmniRoute is down: it answered 200 instead of 204.");
    expect(judge(service(), { at: 1, latencyMs: 50, status: 301, error: null }, []).state).toBe("up");
  });
});

describe("WatchChecker", () => {
  it("checks with a GET, no redirects and only a user-agent, keeps a history, and throttles", async () => {
    let now = 0;
    const calls: Array<{ url: string; init: Parameters<Fetcher>[1] }> = [];
    const latencies = [100, 110, 90, 4200];
    const fetcher: Fetcher = async (url, init) => { calls.push({ url, init }); now += latencies[calls.length - 1] ?? 100; return { status: 200, body: null }; };
    const checker = new WatchChecker(fetcher, () => now);
    const services = [service()];
    let results = await checker.check(services);
    expect(calls[0]).toMatchObject({ url: services[0]!.url, init: { method: "GET", redirect: "manual", headers: { "user-agent": "Paseo Daemon Link health check" } } });
    expect(Object.keys(calls[0]!.init.headers)).toEqual(["user-agent"]);
    expect(results[0]).toMatchObject({ state: "up", latencyMs: 100, target: "10.0.0.9:20128/api/health/ping" });
    // Within the minimum interval: the cached answer, no new request.
    await checker.check(services);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) { now += WATCH_MIN_INTERVAL_MS; results = await checker.check(services); }
    expect(calls).toHaveLength(4);
    expect(results[0]).toMatchObject({ state: "slow", usualMs: 100, message: "OmniRoute is slow: 4.2 s, usually 100 ms." });
    expect(results[0]!.history).toHaveLength(4);
    // A forced check skips the throttle; a removed service is forgotten.
    await checker.check(services, true);
    expect(calls).toHaveLength(5);
    expect(await checker.check([])).toEqual([]);
  });

  it("turns a thrown fetch into down, and reports unchecked services as unknown", async () => {
    const checker = new WatchChecker(async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }, () => 0);
    const [result] = await checker.check([service()]);
    expect(result).toMatchObject({ state: "down", message: "OmniRoute is down: it can't be reached." });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });
});

describe("AI Router suggestion", () => {
  it("reads only the endpoint from the AI Router's connection file and never returns its key", async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-link-watch-"));
    expect(await suggestions([], dir)).toEqual([]);
    await mkdir(join(dir, "plugin-settings", "ai-router"), { recursive: true });
    await writeFile(join(dir, "plugin-settings", "ai-router", "connection.json"), JSON.stringify({ router: "omniroute", endpoint: "http://10.0.0.9:20128/v1", apiKey: ["sk", "synthetic", "secret", "value"].join("-"), token: "synthetic-token" }));
    const found = await suggestions([], dir);
    expect(found).toEqual([{ name: "OmniRoute (AI Router)", url: "http://10.0.0.9:20128/api/health/ping", source: "ai-router", why: expect.any(String) }]);
    expect(JSON.stringify(found)).not.toMatch(/sk-synthetic|synthetic-token/);
    expect(await suggestions([service()], dir)).toEqual([]);
    await writeFile(join(dir, "plugin-settings", "ai-router", "connection.json"), "{not json");
    expect(await suggestions([], dir)).toEqual([]);
  });
});
