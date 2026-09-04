import { homedir } from "node:os";
import { createAdapter } from "./adapter.server";
import type { ActionResult, Snapshot, SnapshotInput } from "./contracts.shared";
import { Collector, unsupportedSnapshot } from "./collector.server";
import type { Clock, PlatformAdapter } from "./platform.server";
import { systemClock } from "./platform.server";
import { ProcessGuard } from "./safety.server";

/**
 * RPC entry points. Handlers are the only callers of the guard, and they
 * never log tokens, argv, or anything derived from the environment.
 */

export interface MonitorHandlers {
  snapshot(input: SnapshotInput): Promise<Snapshot>;
  stop(input: { token: string }): Promise<ActionResult>;
  forceStop(input: { token: string }): Promise<ActionResult>;
}

export interface MonitorRuntimeOptions {
  adapter?: PlatformAdapter | null;
  uid?: number;
  home?: string;
  selfPid?: number;
  parentPid?: number;
  clock?: Clock;
  guard?: ProcessGuard;
  collector?: Collector;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

export function createMonitorHandlers(options: MonitorRuntimeOptions = {}): MonitorHandlers {
  const adapter = options.adapter === undefined ? createAdapter() : options.adapter;
  const clock = options.clock ?? systemClock;
  if (!adapter) {
    const unsupported = (): ActionResult => ({ ok: false, status: "denied", message: "Monitor does not support this platform.", pid: null, signaledCount: 0 });
    return {
      snapshot: async () => unsupportedSnapshot(clock.now()),
      stop: async () => unsupported(),
      forceStop: async () => unsupported(),
    };
  }
  const uid = options.uid ?? currentUid();
  const selfPid = options.selfPid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;
  const guard =
    options.guard ??
    new ProcessGuard({ adapter, uid, selfPid, alwaysProtected: parentPid > 1 ? [parentPid] : [], clock });
  const collector = options.collector ?? new Collector({ adapter, policy: guard, uid, home: options.home ?? homedir(), clock });

  return {
    async snapshot(input) {
      if (uid < 0) return { ...unsupportedSnapshot(clock.now()), warnings: ["Monitor cannot determine the current user."] };
      try {
        return await collector.snapshot(input);
      } catch (error) {
        // Never surface raw error text that could include paths or argv.
        console.error("monitor: snapshot failed", error instanceof Error ? error.name : "unknown");
        throw new Error("Monitor could not read system state.");
      }
    },
    async stop(input) {
      if (uid < 0) return { ok: false, status: "denied", message: "Monitor cannot determine the current user.", pid: null, signaledCount: 0 };
      return guard.stop(input.token);
    },
    async forceStop(input) {
      if (uid < 0) return { ok: false, status: "denied", message: "Monitor cannot determine the current user.", pid: null, signaledCount: 0 };
      return guard.forceStop(input.token);
    },
  };
}
