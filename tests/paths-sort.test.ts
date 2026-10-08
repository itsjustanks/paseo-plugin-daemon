import { describe, expect, it } from "vitest";
import { bySafeThenSize, bySize, cleanupAskText } from "../server/disk-scan";
import { order } from "../server/processes";
import { diskReportText, DiskReportSchema } from "../shared/disk";
import { friendlyPath, fullPath, truncateMiddle } from "../shared/paths";
import { processDetails, type ProcessRow } from "../shared/processes";

/** 0.15.0 addendum: one file-reference formatter, and highest-first, stable sort orders. */

const HOME = "/home/alice";

describe("friendlyPath", () => {
  it("home: ~/…, with the full path kept for the opened row", () => {
    expect(friendlyPath("/home/alice/.cache/ms-playwright", { home: HOME })).toMatchObject({ label: "~/.cache/ms-playwright", workspace: null, full: "/home/alice/.cache/ms-playwright" });
    expect(friendlyPath("~/.npm/_cacache", { home: HOME }).full).toBe("/home/alice/.npm/_cacache");
  });
  it("workspace-relative, the most specific root winning; the top is the name alone", () => {
    const roots = [{ name: "project-hub", root: "/home/alice/code/hub" }, { name: "studio", root: "~/code/hub/apps/studio" }];
    expect(friendlyPath("/home/alice/code/hub/packages/ui/node_modules", { home: HOME, roots }).label).toBe("project-hub · packages/ui/node_modules");
    expect(friendlyPath("/home/alice/code/hub/apps/studio/node_modules", { home: HOME, roots })).toMatchObject({ label: "studio · node_modules", workspace: "studio", rel: "node_modules" });
    expect(friendlyPath("/home/alice/code/hub", { home: HOME, roots }).label).toBe("project-hub");
    expect(friendlyPath("/home/alice/code/hubby", { home: HOME, roots }).label).toBe("~/code/hubby");
  });
  it("a worktree under $PASEO_HOME/worktrees no workspace claims", () => {
    expect(friendlyPath("/home/alice/.paseo/worktrees/site/feature-x/apps/web/.next", { home: HOME }).label).toBe("worktree site/feature-x · apps/web/.next");
    expect(friendlyPath("/srv/paseo/worktrees/site/fix", { home: HOME, paseoHome: "/srv/paseo" }).label).toBe("worktree site/fix");
  });
  it("/tmp, macOS's /private/tmp, and the per-user temp folder", () => {
    expect(friendlyPath("/tmp/build-x", { home: HOME }).label).toBe("/tmp/build-x");
    expect(friendlyPath("/private/tmp/pm-review-1", { home: HOME }).label).toBe("/tmp/pm-review-1");
    expect(friendlyPath("/var/folders/p5/abc/T/hosts-x", { home: HOME }).label).toBe("temp · hosts-x");
  });
  it("an unknown root stays as it is", () => {
    expect(friendlyPath("/opt/agent-home/.agent-browser/browsers", { home: HOME })).toMatchObject({ label: "/opt/agent-home/.agent-browser/browsers", workspace: null });
    expect(fullPath("~/x", null)).toBe("~/x");
  });
  it("truncateMiddle keeps both ends", () => {
    expect(truncateMiddle("project-hub · apps/studio/node_modules", 20)).toBe("project-hu…e_modules");
    expect(truncateMiddle("short", 20)).toBe("short");
  });
});

const row = (over: Partial<ProcessRow>): ProcessRow => ({ pid: 1, name: "node", rssBytes: 0, cpuPercent: 0, ageSeconds: 0, flags: [], tree: { count: 1, cpuPercent: 0, rssBytes: 0 }, ...over } as ProcessRow);

describe("Processes: highest first, flagged pinned, stable", () => {
  const rows = [
    row({ pid: 5, name: "zeta", rssBytes: 100, cpuPercent: 90 }),
    row({ pid: 4, name: "alpha", rssBytes: 100, cpuPercent: 10 }),
    row({ pid: 3, name: "big", rssBytes: 900, cpuPercent: 1 }),
    row({ pid: 2, name: "runaway", rssBytes: 10, cpuPercent: 99, flags: [{ code: "cpu-runaway", text: "x" }] }),
    row({ pid: 6, name: "alpha", rssBytes: 100, cpuPercent: 10 }),
  ];
  it("memory (the default): flagged first, then by memory, ties by name then PID", () => {
    expect([...rows].sort(order("memory", false)).map((item) => item.pid)).toEqual([2, 3, 5, 4, 6]);
  });
  it("CPU: flagged first, then by CPU", () => {
    expect([...rows].sort(order("cpu", false)).map((item) => item.pid)).toEqual([2, 5, 4, 6, 3]);
  });
  it("the same rows in any starting order sort the same", () => {
    expect([...rows].reverse().sort(order("memory", false)).map((item) => item.pid)).toEqual([2, 3, 5, 4, 6]);
  });
});

describe("Workspaces, caches and agent lists: biggest first, stable", () => {
  const item = (where: string, bytes: number, safe = true) => ({ where, name: where.split("/").pop()!, bytes, safe });
  it("items: safe first, then size, ties by where", () => {
    const items = [item("b/node_modules", 10, false), item("a/.next", 50), item("c/coverage", 50), item("d/dist", 70)];
    expect([...items].sort(bySafeThenSize).map((entry) => entry.where)).toEqual(["d/dist", "a/.next", "c/coverage", "b/node_modules"]);
    expect([...items].sort(bySize).map((entry) => entry.where)).toEqual(["d/dist", "a/.next", "c/coverage", "b/node_modules"]);
  });
  it("the cleanup message lists biggest first, friendly name first and the path after", () => {
    const text = cleanupAskText({ kind: "workspaces", title: "site", checkedAt: null, items: [
      { label: "site · apps/web/.next", where: "~/code/site/apps/web/.next", bytes: 10, what: "Next.js build files", cost: "Rebuilt.", partial: false },
      { label: "site · node_modules", where: "~/code/site/node_modules", bytes: 900, what: "Installed packages", cost: "Comes back.", partial: false },
    ] });
    const lines = text.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("  Path:"));
    expect(lines).toEqual(["- site · node_modules · 900 bytes · Installed packages. Comes back.", "  Path: ~/code/site/node_modules", "- site · apps/web/.next · 10 bytes · Next.js build files. Rebuilt.", "  Path: ~/code/site/apps/web/.next"]);
  });
  it("the Disk report lists workspaces and caches biggest first", () => {
    const usage = (names: string[], total: number) => ({ id: names[0] ?? "x", names, project: null, folder: `~/${names[0]}`, worktree: false, branch: null, state: "idle", activeAt: null, devServers: [], totalBytes: total, clearableBytes: 0, partial: false, busy: null, items: [], skipped: false, measured: true });
    const report = DiskReportSchema.parse({
      disks: [], scan: { state: "done", startedAt: 0, finishedAt: 0, done: 2, total: 2, partial: false, message: null },
      workspaces: [usage(["small"], 1024), usage(["bravo"], 4096), usage(["alpha"], 4096)],
      caches: [{ id: "a", title: "A", totalBytes: 10, items: [] }, { id: "b", title: "B", totalBytes: 99, items: [] }],
      clearableBytes: 0, warnings: [],
    });
    const lines = diskReportText(report, 0).split("\n").filter((line) => line.startsWith("- "));
    expect(lines.map((line) => line.split(" ")[1])).toEqual(["alpha", "bravo", "small", "B:", "A:"]);
  });
});

describe("Copy details", () => {
  it("leads with the friendly folder and adds the full one", () => {
    expect(processDetails({ name: "vite", pid: 9, ports: [5173], cwd: "~/code/site/apps/web", where: "site · apps/web", cwdPath: "/home/alice/code/site/apps/web", command: "node vite" })).toBe("vite (PID 9) · ports :5173 · in site · apps/web\nfolder /home/alice/code/site/apps/web\nnode vite");
  });
});
