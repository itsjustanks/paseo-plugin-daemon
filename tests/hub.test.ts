import { describe, expect, it } from "vitest";
import { ownerGroup, processGroups, runningIn, type ProcessRow } from "../shared/processes";

/** 0.16.0: where each process runs, at a glance. */

const row = (over: Partial<ProcessRow> & { owner: ProcessRow["owner"] }): ProcessRow => ({ pid: 1, name: "node", rssBytes: 0, cpuPercent: 0, flags: [], ports: [], cwdPath: null, ...over } as ProcessRow);
const owner = (kind: ProcessRow["owner"]["kind"], project: string | null = null, workspace: string | null = null) => ({ kind, label: "x", project, workspace });

describe("project attribution", () => {
  it("names the group: project · workspace, Paseo itself, or not in a workspace", () => {
    expect(ownerGroup(owner("project", "project-hub", "feature-x"))).toBe("project-hub · feature-x");
    expect(ownerGroup(owner("agent", "project-hub", null))).toBe("project-hub");
    expect(ownerGroup(owner("paseo"))).toBe("Paseo itself");
    expect(ownerGroup(owner("plugin"))).toBe("Paseo itself");
    expect(ownerGroup(owner("other"))).toBe("Not in a workspace");
  });

  it("groups keep rows in order; flagged groups first, then heaviest, then by name", () => {
    const rows = [
      row({ pid: 1, rssBytes: 900, owner: owner("other") }),
      row({ pid: 2, rssBytes: 100, owner: owner("project", "hub", "a") }),
      row({ pid: 3, rssBytes: 50, owner: owner("project", "hub", "b"), flags: [{ code: "cpu-runaway", text: "x" }] }),
      row({ pid: 4, rssBytes: 80, owner: owner("project", "hub", "a") }),
      row({ pid: 5, rssBytes: 180, owner: owner("paseo") }),
    ];
    const groups = processGroups(rows);
    expect(groups.map((group) => [group.title, group.rows.map((item) => item.pid), group.rssBytes])).toEqual([
      ["hub · b", [3], 50],
      ["Not in a workspace", [1], 900],
      ["hub · a", [2, 4], 180],
      ["Paseo itself", [5], 180],
    ]);
  });
});

describe("Running here", () => {
  it("a workspace's processes: its folder or inside it, heaviest first; never a sibling folder", () => {
    const rows = [
      row({ pid: 1, rssBytes: 10, cwdPath: "/home/u/hub", owner: owner("project") }),
      row({ pid: 2, rssBytes: 99, cwdPath: "/home/u/hub/apps/web", owner: owner("project") }),
      row({ pid: 3, rssBytes: 500, cwdPath: "/home/u/hubby", owner: owner("project") }),
      row({ pid: 4, rssBytes: 500, cwdPath: null, owner: owner("other") }),
    ];
    expect(runningIn(rows, { path: "/home/u/hub" }).map((item) => item.pid)).toEqual([2, 1]);
    expect(runningIn(rows, { path: undefined })).toEqual([]);
  });
});
