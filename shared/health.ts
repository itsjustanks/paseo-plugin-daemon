import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Snapshot } from "./contracts";
import type { ProcessReport } from "./processes";
import { WatchResultSchema, type WatchResult } from "./watch";
import { AUTO_STOP_NOTICE_MINUTES, type GuardState } from "./guard";
import { DiskSpaceSchema } from "./disk";
import type { LinkState, Profile, Tunnel } from "./link";
import { cwdWithinDirectory, filterWorkspaceProcesses, workspacePorts, type WorkspaceProcessLike, type WorkspaceTarget } from "./workspace-filter";

/**
 * Host health is a verdict computed from data the plugin already collects:
 * the monitor snapshot, temporary browser links, and saved SSH forwards. The
 * server evaluates it on the snapshot interval and caches the result; every
 * pill and panel reads that cache instead of probing the host itself.
 *
 * "Unhealthy" means one of:
 *  - the host could not be read at all, or project verification is unavailable
 *  - a dev server port that was serving at a recent check is no longer served
 *  - a temporary browser link is in the error state
 *  - a saved SSH forward is retrying, or is set to auto-connect but not running
 *  - a project process is a zombie
 *  - CPU or memory pressure is critical
 *  - a project process is a top CPU or memory user while the host is under
 *    pressure (the collector's `pressure-driver` impact), which lets a
 *    workspace see that it is the one loading the host rather than a bystander
 *  - the container's memory is near its limit, too many heavy jobs run at
 *    once, or a process has held a full CPU core for minutes (the process
 *    report's runaways)
 *  - a watched service on another machine is slow or down
 *  - (0.13.0) a Paseo plugin isn't answering, memory pressure is rising (the
 *    check loop's reading), or the optional guard just stopped a runaway
 *  - (0.14.0) the disk the workspaces live on is 85% full or more
 * Nothing here contains tokens, URLs, or raw command lines; issues carry only
 * ports, a home-relative cwd, and fixed copy.
 */

/** How long a vanished dev-server port stays reported before it is forgotten. */
export const PORT_GONE_TTL_MS = 10 * 60_000;

export const HealthStatusSchema = z.enum(["ok", "warning", "critical", "unknown"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthIssueCodeSchema = z.enum([
  "host-unreachable", "host-unsupported", "projects-unavailable", "port-gone", "tunnel-failed", "link-retrying", "link-down", "process-zombie", "cpu-pressure", "memory-pressure", "pressure-driver",
  "too-many-jobs", "runaway", "service-slow", "service-down",
  // 0.13.0
  "plugin-stuck", "auto-stopped",
  // 0.14.0
  "disk-full",
  // 0.15.0
  "archived-leftover",
]);
export type HealthIssueCode = z.infer<typeof HealthIssueCodeSchema>;

export const HealthIssueSchema = z.object({
  code: HealthIssueCodeSchema,
  severity: z.enum(["warning", "critical"]),
  /** `host` issues affect every workspace; `process` issues belong to the cwd/ports below. */
  scope: z.enum(["host", "process"]),
  message: z.string(),
  ports: z.array(z.number().int()),
  /** Home-relative cwd of the process the issue is about, when known. */
  cwd: z.string().nullable(),
  /** A short name for chips: the watched service or process the issue is about. */
  subject: z.string().nullable().optional(),
  /** The process the issue is about, when it is about one (0.12.0: "Ask an agent" finds it by this). */
  pid: z.number().int().nullable().optional(),
  /** 0.13.0: Hosts may stop that process (Stop is offered next to it). */
  stoppable: z.boolean().optional(),
  /** 0.13.0, plugin-stuck: the plugin's id, whether Restart can be offered, and why not. */
  plugin: z.string().optional(),
  restartable: z.boolean().optional(),
  restartReason: z.string().nullable().optional(),
});
export type HealthIssue = z.infer<typeof HealthIssueSchema>;

export const HealthVerdictSchema = z.object({
  status: HealthStatusSchema,
  /** Epoch milliseconds of the check this verdict came from. */
  checkedAt: z.number(),
  /** Whether the daemon re-checks on its own; off means the verdict only refreshes on demand. */
  background: z.boolean(),
  issues: z.array(HealthIssueSchema),
  /** Dev servers the host is verifying right now, so clients can count per workspace without a second snapshot. */
  services: z.array(z.object({ name: z.string(), cwd: z.string().nullable(), ports: z.array(z.number().int()), project: z.object({ path: z.string(), workspace: z.string().nullable() }).nullable() })),
  /** Watched services on other machines; absent on daemons before 0.10. */
  watched: z.array(WatchResultSchema).optional(),
  /** The few figures the status dot and popover show; absent on daemons before 0.10. */
  load: z.object({
    memoryUsedBytes: z.number(), memoryLimitBytes: z.number(), memoryBasis: z.enum(["container", "machine"]),
    cpuPercent: z.number().nullable(), heavyJobs: z.number().int(), heavyJobLimit: z.number().int(),
  }).nullable().optional(),
  /** 0.14.0: the fullest disk the workspaces live on (statfs); absent on older daemons. */
  disk: DiskSpaceSchema.nullable().optional(),
});
export type HealthVerdict = z.infer<typeof HealthVerdictSchema>;

/** `refresh` checks now instead of serving the cached verdict (older daemons ignore it). */
export const hostHealth = defineRpc({ name: "daemon-link.health", input: z.object({ refresh: z.boolean().optional() }), output: HealthVerdictSchema });

/** A served dev-server port remembered between checks. */
export interface ServingRecord { cwd: string | null; name: string; seenAt: number }
/** A port that stopped serving; reported until it returns or the TTL passes. */
export interface LostRecord extends ServingRecord { lostAt: number }
export interface HealthMemory { serving: Record<number, ServingRecord>; lost: Record<number, LostRecord> }
export const EMPTY_HEALTH_MEMORY: HealthMemory = { serving: {}, lost: {} };

/** 0.15.0: a process still listening in the folder of a workspace archived in the last day. */
export interface ArchivedLeftover { pid: number; name: string; ports: number[]; cwd: string; stoppable: boolean; workspace: string }

export interface HealthInput {
  now: number;
  /** Null when the host could not be read; `error` then says why, in safe copy. */
  snapshot: Pick<Snapshot, "services" | "processes" | "scope" | "supported" | "cpu" | "memory"> | null;
  snapshotError?: string | null;
  tunnels: readonly Tunnel[];
  connections: readonly LinkState[];
  profiles: readonly Pick<Profile, "id" | "name" | "localPort" | "autoConnect">[];
  background: boolean;
  /** The process report, for runaways and load; null when it couldn't be read. */
  report?: Pick<ProcessReport, "runaways" | "container" | "host" | "memoryBasis" | "memoryBasisBytes" | "heavyJobs"> | null;
  watched?: readonly WatchResult[];
  /** 0.13.0: the check loop's latest reading; absent in tests and on unsupported hosts. */
  guard?: GuardState | null;
  /** 0.15.0: dev servers archived workspaces left running. */
  archived?: readonly ArchivedLeftover[];
}

const host = (code: HealthIssueCode, severity: HealthIssue["severity"], message: string): HealthIssue => ({ code, severity, scope: "host", message, ports: [], cwd: null });
const process_ = (code: HealthIssueCode, severity: HealthIssue["severity"], message: string, ports: number[], cwd: string | null): HealthIssue => ({ code, severity, scope: "process", message, ports, cwd });

export function healthStatus(issues: readonly HealthIssue[], unknown = false): HealthStatus {
  if (unknown) return "unknown";
  if (issues.some((issue) => issue.severity === "critical")) return "critical";
  return issues.length > 0 ? "warning" : "ok";
}

/**
 * Pure evaluation. Returns the verdict plus the memory the next check needs.
 * Port bookkeeping only runs when project verification is ready, so a host
 * whose projects cannot be checked never produces "port gone" noise.
 */
export function evaluateHealth(input: HealthInput, memory: HealthMemory = EMPTY_HEALTH_MEMORY): { verdict: HealthVerdict; memory: HealthMemory } {
  const { now, snapshot } = input;
  const issues: HealthIssue[] = [];
  let next: HealthMemory = memory;
  let services: HealthVerdict["services"] = [];

  if (!snapshot) {
    issues.push(host("host-unreachable", "critical", input.snapshotError || "The host could not be read."));
  } else {
    if (!snapshot.supported) issues.push(host("host-unsupported", "warning", "Monitoring is not supported on this host's platform."));
    if (snapshot.scope?.status === "unavailable") issues.push(host("projects-unavailable", "warning", snapshot.scope.message));
    const runaways = input.report?.runaways ?? [];
    const busy = runaways.find((runaway) => runaway.code === "cpu-busy");
    if (busy) issues.push(host("cpu-pressure", "warning", busy.title));
    else if (snapshot.cpu.pressure === "critical") issues.push(host("cpu-pressure", "warning", "CPU pressure on the host is critical."));
    const near = runaways.find((runaway) => runaway.code === "memory-near-limit");
    if (near) issues.push(host("memory-pressure", near.severity, near.title));
    else if (snapshot.memory.pressure === "critical") issues.push(host("memory-pressure", "warning", "Memory pressure on the host is critical."));
    // 0.13.0: the check loop measures pressure every 10 seconds, even while the app can't reach the daemon.
    const loop = input.guard?.memory;
    if (!near && loop && loop.level !== "normal" && loop.sentence && !issues.some((issue) => issue.code === "memory-pressure")) issues.push(host("memory-pressure", loop.level === "critical" ? "critical" : "warning", loop.sentence));
    for (const runaway of runaways) {
      if (runaway.code === "too-many-jobs") issues.push(host("too-many-jobs", "warning", runaway.title));
      if (runaway.code === "cpu-runaway" || runaway.code === "memory-heavy") issues.push({ ...process_("runaway", runaway.severity, runaway.title, [], runaway.cwd), subject: runawaySubject(runaway.title), pid: runaway.pids[0] ?? null, ...(runaway.stoppable === undefined ? {} : { stoppable: runaway.stoppable }) });
    }
    services = snapshot.services.map((service) => ({ name: service.name, cwd: service.cwd, ports: service.ports, project: service.project ? { path: service.project.path, workspace: service.project.workspace } : null }));
    // A dev server is in both lists; report each process once.
    const seen = new Set<string>();
    for (const process of [...snapshot.services, ...snapshot.processes]) {
      const key = `${process.pid}:${process.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (process.state === "zombie") issues.push({ ...process_("process-zombie", "warning", `${process.name} (PID ${process.pid}) is a zombie process.`, process.ports, process.cwd), pid: process.pid });
      // The collector only awards `pressure-driver` to a top-3 CPU or memory user while the host
      // is under matching pressure, so this is attribution, not a busy host's echo.
      if (process.impact === "pressure-driver") {
        const kind = process.reasons.some((reason) => reason.startsWith("top memory")) ? "memory" : "CPU";
        issues.push({ ...process_("pressure-driver", "warning", `${process.name} (PID ${process.pid}) is a top ${kind} user while the host is under ${kind} pressure.`, process.ports, process.cwd), pid: process.pid });
      }
    }
    if (snapshot.scope?.status !== "unavailable") next = trackPorts(snapshot, memory, now);
  }

  for (const lost of Object.entries(next.lost)) {
    const [port, record] = [Number(lost[0]), lost[1]];
    issues.push(process_("port-gone", "warning", `${record.name} on port ${port} stopped serving.`, [port], record.cwd));
  }
  for (const tunnel of input.tunnels) {
    if (tunnel.state === "error") issues.push(process_("tunnel-failed", "warning", `Browser link for port ${tunnel.port} failed: ${tunnel.message}`, [tunnel.port], null));
  }
  const connections = new Map(input.connections.map((connection) => [connection.id, connection]));
  for (const profile of input.profiles) {
    const connection = connections.get(profile.id);
    if (connection && (connection.state === "retrying" || connection.state === "error")) {
      issues.push(process_("link-retrying", "warning", `SSH forward "${profile.name}" is not connected: ${connection.message}`, [profile.localPort], null));
    } else if (profile.autoConnect && (!connection || connection.state === "stopped")) {
      issues.push(process_("link-down", "warning", `SSH forward "${profile.name}" should auto-connect but is not running.`, [profile.localPort], null));
    }
  }

  for (const plugin of input.guard?.plugins ?? []) {
    const message = plugin.stopping
      ? `${plugin.name} is stuck: it began stopping and never finished, so Paseo can't add, update or reload plugins.`
      : `${plugin.name} isn't answering (${plugin.timeouts} timeout${plugin.timeouts === 1 ? "" : "s"} in ${plugin.windowMinutes} min).`;
    issues.push({ ...host("plugin-stuck", plugin.severity, message), subject: plugin.name, plugin: plugin.id, restartable: plugin.restartable, restartReason: plugin.reason });
  }
  for (const disk of input.guard?.disks ?? []) {
    if (disk.level !== "ok" && disk.sentence) issues.push({ ...host("disk-full", disk.level === "critical" ? "critical" : "warning", disk.sentence), subject: disk.label });
  }
  const auto = input.guard?.autoGuard.last;
  if (auto && now - auto.at < AUTO_STOP_NOTICE_MINUTES * 60_000) issues.push({ ...host("auto-stopped", "warning", auto.message), subject: auto.name, pid: auto.pid });

  for (const left of input.archived ?? []) {
    const ports = left.ports.map((port) => `:${port}`).join(", ");
    issues.push({ ...process_("archived-leftover", "warning", `${left.name} (${ports}) is still running from the archived workspace "${left.workspace}".`, left.ports, left.cwd), subject: left.name, pid: left.pid, stoppable: left.stoppable });
  }
  for (const result of input.watched ?? []) {
    if (result.state === "slow") issues.push({ ...host("service-slow", "warning", result.message), subject: result.name });
    if (result.state === "down") issues.push({ ...host("service-down", "warning", result.message), subject: result.name });
  }
  const report = input.report;
  const load = report ? {
    memoryUsedBytes: report.container?.memoryLimitBytes ? report.container.memoryUsedBytes : report.host.memoryUsedBytes,
    memoryLimitBytes: report.memoryBasisBytes, memoryBasis: report.memoryBasis,
    cpuPercent: report.host.cpuPercent, heavyJobs: report.heavyJobs.count, heavyJobLimit: report.heavyJobs.limit,
  } : null;
  return { verdict: { status: healthStatus(issues), checkedAt: now, background: input.background, issues, services, watched: [...(input.watched ?? [])], load, disk: input.guard?.disks?.[0] ?? null }, memory: next };
}

/** A short name for a runaway: "A test run", "esbuild" (before " is using", or before " (PID"). */
export function runawaySubject(title: string): string | null {
  const cut = [title.indexOf(" (PID"), title.indexOf(" is using"), title.indexOf(" has used")].filter((index) => index > 0);
  return cut.length ? title.slice(0, Math.min(...cut)) : null;
}

/** Remember which dev-server ports are served; move vanished ones to `lost` and expire old entries. */
export function trackPorts(snapshot: Pick<Snapshot, "services" | "processes">, memory: HealthMemory, now: number): HealthMemory {
  const served = new Set<number>();
  for (const process of [...snapshot.services, ...snapshot.processes]) for (const port of process.ports) served.add(port);
  const serving: HealthMemory["serving"] = {};
  for (const service of snapshot.services) for (const port of service.ports) serving[port] = { cwd: service.cwd, name: service.name, seenAt: now };
  const lost: HealthMemory["lost"] = {};
  for (const [key, record] of Object.entries(memory.lost)) {
    const port = Number(key);
    if (!served.has(port) && now - record.lostAt < PORT_GONE_TTL_MS) lost[port] = record;
  }
  for (const [key, record] of Object.entries(memory.serving)) {
    const port = Number(key);
    if (!served.has(port) && !lost[port]) lost[port] = { ...record, lostAt: now };
  }
  return { serving, lost };
}

export interface WorkspaceHealth {
  status: HealthStatus;
  /** Issues that touch this workspace: every host issue plus process issues under its directory or on its ports. */
  issues: HealthIssue[];
  /** Verified dev servers running inside the workspace. */
  services: HealthVerdict["services"];
  ports: number[];
  checkedAt: number;
}

/** Narrow a host verdict to one workspace. Pure; the pill and the panel both use it. */
export function workspaceHealth(verdict: HealthVerdict, target: WorkspaceTarget): WorkspaceHealth {
  const services = filterWorkspaceProcesses(verdict.services as readonly (HealthVerdict["services"][number] & WorkspaceProcessLike)[], target);
  const ports = new Set(workspacePorts(services));
  // A process issue under the workspace directory also claims its ports, so a
  // vanished dev server's failed browser link follows it into the workspace.
  for (const issue of verdict.issues) {
    if (issue.scope === "process" && issue.cwd && cwdWithinDirectory(issue.cwd, target.directory)) for (const port of issue.ports) ports.add(port);
  }
  const issues = verdict.issues.filter((issue) => {
    if (issue.scope === "host") return true;
    if (issue.cwd && cwdWithinDirectory(issue.cwd, target.directory)) return true;
    return issue.ports.some((port) => ports.has(port));
  });
  return { status: healthStatus(issues, verdict.status === "unknown"), issues, services, ports: [...ports].sort((a, b) => a - b), checkedAt: verdict.checkedAt };
}

/**
 * One line for the composer pill, or null when there is nothing worth a chip:
 * no verified dev server in the workspace and no issue touching it.
 */
export function pillText(health: WorkspaceHealth): string | null {
  const critical = health.issues.find((issue) => issue.severity === "critical");
  if (critical) return critical.code === "host-unreachable" ? "Host unreachable" : critical.message;
  // A problem inside the workspace is more actionable than a host-wide one, so it leads the chip.
  const first = health.issues.find((issue) => issue.scope === "process") ?? health.issues[0];
  if (first) {
    const more = health.issues.length > 1 ? ` +${health.issues.length - 1}` : "";
    if (first.code === "port-gone") return `Dev server :${first.ports[0]} stopped${more}`;
    if (first.code === "tunnel-failed") return `Browser link :${first.ports[0]} failed${more}`;
    if (first.code === "link-retrying" || first.code === "link-down") return `SSH forward :${first.ports[0]} down${more}`;
    if (first.code === "process-zombie") return `Zombie process${more}`;
    if (first.code === "pressure-driver") return `Driving host pressure${more}`;
    if (first.code === "runaway") return `Runaway: ${first.subject ?? "process"}${more}`;
    if (first.code === "too-many-jobs") return `Too many heavy jobs${more}`;
    if (first.code === "service-down") return `${first.subject ?? "Watched service"} down${more}`;
    if (first.code === "service-slow") return `${first.subject ?? "Watched service"} slow${more}`;
    if (first.code === "cpu-pressure") return `CPU busy${more}`;
    if (first.code === "memory-pressure") return `Memory nearly full${more}`;
    if (first.code === "projects-unavailable") return `Projects unverified${more}`;
    if (first.code === "plugin-stuck") return `${first.subject ?? "A plugin"} not answering${more}`;
    if (first.code === "auto-stopped") return `Runaway stopped${more}`;
    if (first.code === "disk-full") return `Disk nearly full${more}`;
    if (first.code === "archived-leftover") return `Left running: ${first.subject ?? "dev server"}${more}`;
    return `Host issue${more}`;
  }
  if (health.services.length === 0) return null;
  const ports = health.ports.length > 0 ? ` :${health.ports.slice(0, 3).join(" :")}${health.ports.length > 3 ? "…" : ""}` : "";
  return `${health.services.length} dev server${health.services.length === 1 ? "" : "s"}${ports}`;
}

/**
 * What makes one workspace's chat need attention (0.11.0): its dev server
 * stopped, a link to it failed, or a job in it is driving the host's load.
 * Host-wide trouble (memory, CPU, a watched service, an unreachable host)
 * belongs to the sidebar row's dot, so it never puts a chip in every chat.
 * One exception (0.14.0): a disk 95% full or more. Agents start failing to
 * write files then, in every chat, so every chat gets the chip.
 */
export const CHIP_CODES: ReadonlySet<HealthIssueCode> = new Set<HealthIssueCode>(["port-gone", "tunnel-failed", "link-retrying", "link-down", "pressure-driver", "runaway"]);

/** The issues that earn this workspace a chip, most urgent first. */
export function chipIssues(health: WorkspaceHealth): HealthIssue[] {
  return health.issues
    .filter((issue) => (issue.scope === "process" && CHIP_CODES.has(issue.code)) || (issue.code === "disk-full" && issue.severity === "critical"))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

/** The chip's words, or null when the workspace is calm. Never a count of healthy dev servers. */
/** Issues an agent can be asked about (0.12.0), and how to point at them. */
export function askSubjectFor(issue: HealthIssue, watched: readonly { id: string; name: string }[] = []): { kind: "process"; pid: number } | { kind: "port"; port: number } | { kind: "service"; id: string } | null {
  if ((issue.code === "runaway" || issue.code === "pressure-driver" || issue.code === "archived-leftover") && issue.pid) return { kind: "process", pid: issue.pid };
  if (issue.code === "port-gone" && issue.ports[0] !== undefined) return { kind: "port", port: issue.ports[0] };
  if (issue.code === "service-slow" || issue.code === "service-down") {
    const service = watched.find((item) => item.name === issue.subject);
    return service ? { kind: "service", id: service.id } : null;
  }
  return null;
}

export function chipText(health: WorkspaceHealth): string | null {
  const issues = chipIssues(health);
  const first = issues[0];
  if (!first) return null;
  const more = issues.length > 1 ? ` +${issues.length - 1}` : "";
  const port = first.ports[0] !== undefined ? ` :${first.ports[0]}` : "";
  if (first.code === "port-gone") return `Dev server${port} stopped${more}`;
  if (first.code === "tunnel-failed") return `Browser link${port} failed${more}`;
  if (first.code === "link-retrying" || first.code === "link-down") return `Forward${port} down${more}`;
  if (first.code === "runaway") return `Runaway: ${first.subject ?? "process"}${more}`;
  if (first.code === "disk-full") return `Disk nearly full${more}`;
  return `Driving host load${more}`;
}
