import type { ProcessReport, ProcessRow } from "../shared/processes";
import type { ClearItem, WorkspaceUsage } from "../shared/disk";
export const processRow = (extra: Partial<ProcessRow> = {}): ProcessRow => ({
  pid: 42, ppid: 1, name: "node", command: "node app.js", cwd: "~/app", cwdPath: "/home/example/app", where: "app",
  state: "sleeping", cpuPercent: 1, cpuSustained: 1, hotSeconds: 0, rssBytes: 100, memoryPercent: 1, ageSeconds: 60,
  ports: [], job: null, jobRoot: false, tree: { count: 1, cpuPercent: 1, rssBytes: 100 },
  owner: { kind: "other", label: "Started outside Paseo", project: null, workspace: null }, chat: null,
  outsidePaseo: true, flags: [], stoppable: true, protectedReason: null, actionToken: "token-original", ...extra,
});
export const processReportFixture = (rows: ProcessRow[]): ProcessReport => ({
  checkedAt: 1, platform: "linux", supported: true, sampling: false,
  host: { cores: 4, cpuPercent: 10, load1: 1, memoryTotalBytes: 1000, memoryUsedBytes: 100, cpuPressure: "normal", memoryPressure: "normal" },
  container: null, memoryBasis: "machine", memoryBasisBytes: 1000,
  heavyJobs: { count: 0, limit: 4, pids: [] }, runaways: [], processes: rows, total: rows.length, matched: rows.length,
  paseoBytes: 0, projectsVerified: true, warnings: [], recentActions: [],
});
export const clearItem = (extra: Partial<ClearItem> = {}): ClearItem => ({
  name: "cache", what: "Tool cache", cost: "Rebuilt next time.", where: "~/cache", bytes: 100, sharedBytes: 0, partial: false,
  safe: false, blocked: null, ...extra,
});
export const workspaceUsage = (extra: Partial<WorkspaceUsage> = {}): WorkspaceUsage => ({
  id: "workspace-1", names: ["Alpha"], project: "Website", folder: "~/app", path: "/home/example/app", worktree: false,
  branch: "main", state: "idle", activeAt: null, devServers: [], totalBytes: 100, clearableBytes: 50,
  partial: false, busy: null, items: [], skipped: false, measured: true, ...extra,
});
