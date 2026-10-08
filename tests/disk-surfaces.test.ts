import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskReportSchema, PANEL_CLEARABLE_BYTES, diskReportText, diskSpace, workspaceDiskView, type DiskReport, type DiskSpace, type WorkspaceUsage } from "../shared/disk";
import { chipIssues, chipText, workspaceHealth, type HealthVerdict } from "../shared/health";
import { resolveTab } from "../shared/tabs";

/**
 * 0.14.0: disk in the places Hosts already uses (the workspace panel, the
 * sidebar popover, the chip, the Command Center, /disk, the attachments and
 * the process ask). They read the last check; nothing but Refresh, "Check
 * disk space" and /disk starts one.
 */

const GB = 1024 ** 3, MB = 1024 ** 2;
const root = join(__dirname, "..");
const source = (file: string) => readFileSync(join(root, file), "utf8");

const disk = (percent: number): DiskSpace => diskSpace("This computer's disk", { bsize: 1, blocks: 100 * GB, bfree: (100 - percent) * GB, bavail: (100 - percent) * GB });

function usage(over: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
  return {
    id: "ws:/home/alice/app", names: ["main"], project: "Website", folder: "~/app", worktree: false, branch: "main", state: "idle", activeAt: null, devServers: [],
    totalBytes: 3 * GB, clearableBytes: 1.2 * GB, partial: false, busy: null, skipped: false, measured: true, workspaceIds: ["ws-app"],
    items: [
      { safe: true, name: "node_modules", what: "Installed packages", cost: "Comes back on the next install.", where: "node_modules", bytes: 1 * GB, sharedBytes: 0, partial: false, blocked: null },
      { safe: true, name: ".next", what: "Next.js build files", cost: "Rebuilt.", where: ".next", bytes: 0.2 * GB, sharedBytes: 0, partial: false, blocked: null },
    ],
    ...over,
  };
}

function report(workspaces: WorkspaceUsage[], percent = 60, over: Partial<DiskReport> = {}): DiskReport {
  return DiskReportSchema.parse({
    disks: [disk(percent)],
    scan: { state: "done", startedAt: 0, finishedAt: 60_000, done: workspaces.length, total: workspaces.length, partial: false, message: null },
    workspaces,
    caches: [{ id: "npm", title: "npm", totalBytes: 2 * GB, items: [{ safe: false, name: "npm cache", what: "npm downloads", cost: "Downloaded again when needed.", where: "~/.npm/_cacache", bytes: 2 * GB, sharedBytes: 0, partial: false, blocked: null }] }],
    clearableBytes: workspaces.reduce((sum, item) => sum + item.clearableBytes, 0),
    warnings: [],
    ...over,
  });
}

describe("workspace panel: disk from the last check", () => {
  it("speaks up at 500 MB safe to clear, with the ask for this workspace", () => {
    const view = workspaceDiskView(report([usage()]), "ws-app", disk(60));
    expect(view).toMatchObject({ mode: "attention", askId: "ws:/home/alice/app" });
    expect(view.line).toBe("This workspace uses 3 GB; 1.2 GB of it looks safe to clear. The disk is 60% full (40 GB left).");
  });

  it("speaks up when the disk is 85% full, even with little to clear here", () => {
    const view = workspaceDiskView(report([usage({ clearableBytes: 10 * MB })], 88), "ws-app", disk(88));
    expect(view.mode).toBe("attention");
    expect(view.line).toContain("The disk is 88% full");
    expect(view.askId).toBe("ws:/home/alice/app");
  });

  it("is one quiet line below both thresholds", () => {
    const view = workspaceDiskView(report([usage({ clearableBytes: PANEL_CLEARABLE_BYTES - 1 })]), "ws-app", disk(84));
    expect(view).toMatchObject({ mode: "quiet", line: "Disk: this workspace uses 3 GB · the disk is 84% full" });
  });

  it("offers no ask while the workspace is busy, and says not checked when the check never reached it", () => {
    expect(workspaceDiskView(report([usage({ busy: "An agent is working here." })]), "ws-app", disk(60)).askId).toBeNull();
    const unchecked = workspaceDiskView(report([usage({ measured: false, clearableBytes: 0 })]), "ws-app", disk(60));
    expect(unchecked).toMatchObject({ mode: "quiet", askId: null, line: "Disk: not checked yet · the disk is 60% full" });
    // Another workspace's row is never this one's.
    expect(workspaceDiskView(report([usage()]), "ws-other", disk(60))).toMatchObject({ mode: "quiet", usage: null, askId: null });
    expect(workspaceDiskView(undefined, "ws-app", disk(90))).toMatchObject({ mode: "attention", usage: null, askId: null });
  });

  it("never starts a check: the panel, popover and chip only read", () => {
    for (const file of ["client/workspace-panel.tsx", "client/quick.tsx", "client/pill.tsx", "shared/pills.ts"]) {
      expect(source(file), file).not.toMatch(/scan:\s*true|scan\.mutate/);
    }
    expect(source("client/workspace-panel.tsx")).not.toMatch(/useDiskReport/); // its 4-second poll while a check runs is the Workspaces tab's
  });

  it("review fix: no check starts by itself, and the report is polled only while Workspaces shows", () => {
    const daemon = source("client/daemon.tsx");
    expect(daemon).toMatch(/useDiskReport\(props\.host\.id, tab === "workspaces"\)/);
    expect(daemon).not.toMatch(/neverChecked|useEffect\([^)]*scan\.mutate/);
    expect([...daemon.matchAll(/disk\.scan\.mutate\(\)/g)].length).toBe(2); // Refresh on Workspaces, and "Check disk space"
    expect(source("client/workspaces.tsx")).toMatch(/label="Check disk space" icon="ScanSearch" primary/);
  });
});

describe("chip: the disk only at 95%", () => {
  const target = { directory: "/home/alice/app", projectRootPath: "/home/alice/app", name: "main" };
  const verdict = (severity: "warning" | "critical"): HealthVerdict => ({ status: severity, checkedAt: 1, background: true, services: [], issues: [{ code: "disk-full", severity, scope: "host", message: "The disk is full.", ports: [], cwd: null }] });
  it("shows Disk nearly full when critical, nothing when it's a warning", () => {
    expect(chipText(workspaceHealth(verdict("critical"), target))).toBe("Disk nearly full");
    expect(chipIssues(workspaceHealth(verdict("critical"), target))[0]?.severity).toBe("critical");
    expect(chipText(workspaceHealth(verdict("warning"), target))).toBeNull();
  });
});

describe("Disk report attachment text", () => {
  it("lists workspaces by size with what looks safe, then the caches; says it deleted nothing", () => {
    const text = diskReportText(report([usage(), usage({ id: "ws:/home/alice/api", names: ["api"], folder: "~/api", totalBytes: 1 * GB, clearableBytes: 0, items: [], workspaceIds: ["ws-api"] })]), 120_000);
    expect(text).toContain("Hosts deleted nothing");
    expect(text).toContain("Disk: 40 GB free of 100 GB (60% used).");
    expect(text).toContain("- main (~/app): 3 GB, 1.2 GB looks safe to clear");
    expect(text).toContain("  - node_modules: 1 GB (Installed packages)");
    expect(text).toContain("- api (~/api): 1 GB");
    expect(text).toContain("- npm: 2 GB");
    expect(text).toMatch(/never source, \.git or \.env files/);
  });
  it("says when nothing has been checked yet", () => {
    const text = diskReportText(report([], 60, { scan: { state: "never", startedAt: null, finishedAt: null, done: 0, total: 0, partial: false, message: null }, caches: [] }));
    expect(text).toContain("Workspaces haven't been checked yet");
    expect(text).not.toContain("Workspaces by size");
  });
});

describe("Command Center, /disk and the cleanup link", () => {
  it("registers Check disk space, Clean up disk space and /disk [clean]", () => {
    const client = source("index.client.tsx");
    expect(client).toMatch(/title: "Check disk space"/);
    expect(client).toMatch(/title: "Clean up disk space"/);
    expect(client).toMatch(/name: "disk"[\s\S]*argumentHint: "\[clean\]"/);
    expect(client).toMatch(/name: "check-host"/); // kept separate: quick, and never the heavy folder check
  });
  it("the cleanup link lands on Workspaces with the ask", () => {
    expect(resolveTab("workspaces", "cleanup")).toEqual({ tab: "workspaces", fold: "cleanup" });
    expect(resolveTab("cleanup")).toEqual({ tab: "workspaces", fold: "cleanup" });
    expect(resolveTab("overview", "cleanup")).toEqual({ tab: "overview", fold: null });
  });
});
