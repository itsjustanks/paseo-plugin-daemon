import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ProjectScope } from "./scope";
import { homedir } from "node:os";
import { createAdapter } from "./adapter";
import type { ActionResult, Snapshot, SnapshotInput } from "../shared/contracts";
import { Collector, unsupportedSnapshot } from "./collector";
import type { Clock, PlatformAdapter } from "./platform";
import { systemClock } from "./platform";
import { ProcessGuard, type KillFn } from "./safety";

/**
 * RPC entry points. Handlers are the only callers of the guard, and they
 * never log tokens, argv, or anything derived from the environment.
 */

export interface MonitorHandlers {
  snapshot(input: SnapshotInput, context?: PluginHandlerContext): Promise<Snapshot>;
  stop(input: { token: string }): Promise<ActionResult>;
  forceStop(input: { token: string }): Promise<ActionResult>;
}

export interface MonitorRuntimeOptions {
  kill?: KillFn;
  scope?: ProjectScope;
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
    new ProcessGuard({ adapter, uid, selfPid, kill: options.kill, alwaysProtected: parentPid > 1 ? [parentPid] : [], clock,
      authorizeProcess: options.scope ? async (pid, descendant) => {
        await options.scope!.refresh(true);
        const sample = await adapter.sampleProcesses(uid);
        const raw = sample.processes.find((p) => p.pid === pid);
        if (!raw) return false;
        const ports = await adapter.listeningPorts([pid]);
        const project = options.scope!.match(raw, ports.ports.get(pid) || []);
        return !!project && (descendant ? project.kind !== "agent" : project.canStop);
      } : undefined,
    });
  const collector = options.collector ?? new Collector({ adapter, policy: guard, uid, home: options.home ?? homedir(), clock, scope: options.scope });

  return {
    async snapshot(input, context) {
      if (context) options.scope?.bind(context.paseo);
      if (options.scope) {
        try { await options.scope.refresh(); } catch { /* Global health is still readable; project rows fail closed. */ }
        collector.invalidate();
      }
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

// Runtime-scoped handler exports registered by index.server.ts.
const monitorHandlers = createMonitorHandlers();
export const handleMonitorSnapshot = monitorHandlers.snapshot;
export const handleMonitorStop = monitorHandlers.stop;
export const handleMonitorForceStop = monitorHandlers.forceStop;
