import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Snapshot, SnapshotInput } from "../shared/contracts";
import { EMPTY_HEALTH_MEMORY, evaluateHealth, type HealthInput, type HealthMemory, type HealthVerdict } from "../shared/health";
import type { LinkState, Profile, Tunnel } from "../shared/link";
import type { ProcessReport, ReportInput } from "../shared/processes";
import type { WatchedService, WatchResult } from "../shared/watch";
import type { GuardState } from "../shared/guard";
import { HOSTS_SETTINGS_DEFAULTS, SNAPSHOT_INTERVAL_DEFAULT, type HostsSettings } from "../shared/settings";

/** The slice of the runtime the checker needs; tests hand in a fake. */
export interface HealthRuntime {
  monitor: { snapshot(input: SnapshotInput, context?: PluginHandlerContext): Promise<Snapshot> };
  links: { status(): Promise<{ profiles: Profile[]; connections: LinkState[]; tunnels: Tunnel[] }> };
  /** Absent in older fakes; the verdict then has no runaways or load. */
  processes?: { report(input: ReportInput): Promise<ProcessReport> };
  watch?: { check(services: readonly WatchedService[], force?: boolean): Promise<WatchResult[]> };
}

export interface HealthCheckerOptions {
  runtime: HealthRuntime;
  readSettings: () => Promise<HostsSettings>;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Called with every fresh verdict (the summary file for other plugins). */
  onVerdict?: (verdict: HealthVerdict) => void;
  /** 0.13.0: the check loop's latest reading (no I/O). */
  guard?: () => GuardState;
}

/**
 * Evaluates host health on the snapshot interval and caches the verdict so
 * every composer pill and panel reads one result instead of probing the host.
 *
 * Background ticks wait for the first client request: the project scope only
 * learns its Paseo session from a handler context, and checking before that
 * would report "projects unverified" on every host at startup. A check never
 * throws; an unreadable host becomes a critical verdict instead.
 */
export class HealthChecker {
  private verdict: HealthVerdict | null = null;
  private memory: HealthMemory = EMPTY_HEALTH_MEMORY;
  private inflight: Promise<HealthVerdict> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private context: PluginHandlerContext | null = null;
  private closed = false;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly options: HealthCheckerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** The cached verdict, or null before the first check. */
  current(): HealthVerdict | null { return this.verdict; }

  /** When and where a dev server's port stopped serving, while it is still reported (0.12.0, for "Ask an agent"). */
  lost(port: number): { name: string; cwd: string | null; lostAt: number } | null {
    const record = this.memory.lost[port];
    return record ? { name: record.name, cwd: record.cwd, lostAt: record.lostAt } : null;
  }

  /**
   * Serve the cache when it is younger than the interval, otherwise check now.
   * The first call with a context also arms the background timer.
   */
  async read(context?: PluginHandlerContext, refresh = false): Promise<HealthVerdict> {
    if (context) this.context = context;
    const settings = await this.settings();
    if (this.context && !this.timer && !this.closed) this.schedule(settings);
    const fresh = !refresh && this.verdict && this.now() - this.verdict.checkedAt < settings.snapshotIntervalSeconds * 1000;
    return fresh ? this.verdict! : this.check(settings, refresh);
  }

  /** Run one check now, coalescing concurrent callers onto the same pass. */
  check(settings?: HostsSettings, force = false): Promise<HealthVerdict> {
    this.inflight ??= this.run(settings, force).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(given?: HostsSettings, force = false): Promise<HealthVerdict> {
    const settings = given ?? await this.settings();
    const context = this.context ?? undefined;
    const input: HealthInput = { now: this.now(), snapshot: null, tunnels: [], connections: [], profiles: [], background: settings.backgroundHealthChecks };
    try { input.snapshot = await this.options.runtime.monitor.snapshot({ query: "", sort: "pid", limit: 200 }, context); }
    catch (error) { input.snapshotError = error instanceof Error ? error.message : "The host could not be read."; }
    try {
      const status = await this.options.runtime.links.status();
      input.tunnels = status.tunnels; input.connections = status.connections;
      input.profiles = status.profiles.map(({ id, name, localPort, autoConnect }) => ({ id, name, localPort, autoConnect }));
    } catch { /* Links unavailable: the verdict just has no link issues this round. */ }
    const { processes, watch } = this.options.runtime;
    const [report, watched] = await Promise.all([
      processes ? processes.report({ limit: 1 }).catch(() => null) : Promise.resolve(null),
      watch ? watch.check(settings.watchedServices ?? [], force).catch(() => []) : Promise.resolve([]),
    ]);
    input.report = report;
    input.watched = watched;
    try { input.guard = this.options.guard?.() ?? null; } catch { input.guard = null; }
    const result = evaluateHealth(input, this.memory);
    this.memory = result.memory;
    this.verdict = result.verdict;
    try { this.options.onVerdict?.(result.verdict); } catch { /* A listener never breaks a check. */ }
    return result.verdict;
  }

  private async settings(): Promise<HostsSettings> {
    try { return await this.options.readSettings(); }
    catch { return { ...HOSTS_SETTINGS_DEFAULTS, closeTunnelsOnArchive: false, snapshotIntervalSeconds: SNAPSHOT_INTERVAL_DEFAULT }; }
  }

  private schedule(settings: HostsSettings) {
    if (this.closed) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void (async () => {
        const current = await this.settings();
        // Re-read each tick so toggling the switch takes effect without a reload.
        if (current.backgroundHealthChecks) await this.check(current).catch(() => {});
        this.schedule(current);
      })();
    }, settings.snapshotIntervalSeconds * 1000);
  }

  close() {
    this.closed = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }
}
