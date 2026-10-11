import { describe, expect, it } from "vitest";
import { matchesProcess, processActionKey, processOrder, ReportInputSchema } from "../shared/processes";
import { cacheTableRows, itemTableRows, workspaceTableRows } from "../shared/disk-tables";
import { nextResourceSort } from "../shared/resource-table";
import { clearItem, processRow, workspaceUsage } from "./resource-table-fixtures";

describe("resource order and filters", () => {
  const rows = [
    processRow({ pid: 1, name: "alpha", rssBytes: 900, cpuPercent: 10 }),
    processRow({ pid: 2, name: "beta", rssBytes: 100, cpuPercent: 10 }),
    processRow({ pid: 3, name: "alpha", rssBytes: 100, cpuPercent: 10 }),
    processRow({ pid: 4, name: "alert", rssBytes: 1, cpuPercent: null, flags: [{ code: "memory-growing", text: "Growing" }] }),
  ];
  it("does not pin flagged rows; keeps unknown CPU last in either direction and resolves ties consistently", () => {
    expect([...rows].sort(processOrder("memory", false)).map((r) => r.pid)).toEqual([1, 3, 2, 4]);
    expect([...rows].sort(processOrder("memory", false, "asc")).map((r) => r.pid)).toEqual([4, 3, 2, 1]);
    for (const direction of ["asc", "desc"] as const) {
      expect([...rows].reverse().sort(processOrder("cpu", false, direction)).map((r) => r.pid)).toEqual([1, 3, 2, 4]);
    }
    expect([...rows].sort(processOrder("name", false, "desc")).map((r) => r.pid)).toEqual([2, 1, 3, 4]);
    expect([...rows].sort(processOrder("age", false, "asc")).map((r) => r.pid)).toEqual([4, 1, 3, 2]);
  });
  it("sorts heavy-job roots by the complete tree, rather than its parent process", () => {
    const jobs = [processRow({ pid: 1, rssBytes: 900, tree: { count: 1, rssBytes: 900, cpuPercent: 10 } }), processRow({ pid: 2, rssBytes: 1, tree: { count: 6, rssBytes: 1000, cpuPercent: 90 } })];
    expect(jobs.sort(processOrder("memory", true)).map((r) => r.pid)).toEqual([2, 1]);
    expect(jobs.sort(processOrder("cpu", true, "asc")).map((r) => r.pid)).toEqual([1, 2]);
  });
  it("searches all attribution and command fields; filters chat, protection and attention independently", () => {
    const row = processRow({ owner: { kind: "project", label: "Label", project: "Website", workspace: "Feature" } });
    for (const query of ["42", "APP.JS", "/home/example", "Website", "Feature", "~/app"]) expect(matchesProcess(row, { query })).toBe(true);
    expect(matchesProcess(row, { filter: "no-chat" })).toBe(true);
    expect(matchesProcess(row, { filter: "known-chat" })).toBe(false);
    expect(matchesProcess(row, { filter: "stoppable" })).toBe(true);
    expect(matchesProcess(row, { filter: "protected" })).toBe(false);
    expect(matchesProcess(rows[3]!, { filter: "attention" })).toBe(true);
    expect(matchesProcess(row, { query: "absent" })).toBe(false);
  });
  it("starts numeric sorts descending and names ascending, then toggles", () => {
    expect(nextResourceSort({ id: "memory", direction: "desc" }, "memory")).toEqual({ id: "memory", direction: "asc" });
    expect(nextResourceSort({ id: "memory", direction: "asc" }, "cpu")).toEqual({ id: "cpu", direction: "desc" });
    expect(nextResourceSort({ id: "memory", direction: "desc" }, "name")).toEqual({ id: "name", direction: "asc" });
    expect(processActionKey(processRow())).not.toBe(processActionKey(processRow({ actionToken: "reused-pid-token" })));
  });
  it("keeps bounded inputs and validates sort direction and filters", () => {
    expect(ReportInputSchema.parse({ filter: "protected", direction: "asc" })).toMatchObject({ sort: "memory", limit: 25, offset: 0 });
    expect(ReportInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(ReportInputSchema.safeParse({ query: "x".repeat(121) }).success).toBe(false);
  });
});

describe("disk tables use the last report without changing its source", () => {
  const workspaces = [workspaceUsage(), workspaceUsage({ id: "b", names: ["Beta"], totalBytes: 500, clearableBytes: 10, state: "working", branch: "fix-auth", folder: "~/beta", path: "/home/example/beta" }), workspaceUsage({ id: "unknown", names: ["Unknown"], measured: false, totalBytes: 0 })];
  it("sorts by total, reclaimable, running and name; unknown sizes stay last", () => {
    const before = structuredClone(workspaces);
    expect(workspaceTableRows(workspaces, [], "", "all", { id: "disk", direction: "desc" }).map((r) => r.workspace.id)).toEqual(["b", "workspace-1", "unknown"]);
    expect(workspaceTableRows(workspaces, [], "", "all", { id: "disk", direction: "asc" }).map((r) => r.workspace.id)).toEqual(["workspace-1", "b", "unknown"]);
    expect(workspaceTableRows(workspaces, [], "", "all", { id: "reclaimable", direction: "desc" })[0]?.workspace.id).toBe("workspace-1");
    expect(workspaceTableRows(workspaces, [processRow({ cwdPath: "/home/example/beta" })], "", "all", { id: "running", direction: "desc" })[0]?.workspace.id).toBe("b");
    expect(workspaceTableRows(workspaces, [], "", "all", { id: "name", direction: "desc" })[0]?.workspace.id).toBe("unknown");
    expect(workspaces).toEqual(before);
  });
  it("searches workspace/project/branch/path and filters status before paging", () => {
    const sort = { id: "disk", direction: "desc" } as const;
    expect(workspaceTableRows(workspaces, [], "fix-auth", "working", sort).map((r) => r.workspace.id)).toEqual(["b"]);
    expect(workspaceTableRows(workspaces, [], "/home/example", "idle", sort).map((r) => r.workspace.id)).toEqual(["workspace-1", "unknown"]);
    expect(workspaceTableRows(workspaces, [], "absent", "all", sort)).toEqual([]);
  });
  it("flattens cache groups by size; searches paths/types and filters group without mutating source", () => {
    const groups = [{ id: "small", title: "Small caches", totalBytes: 900, items: [clearItem({ where: "~/z", bytes: 900 })] }, { id: "large", title: "Large caches", totalBytes: 1000, items: [clearItem({ name: "browser", where: "~/browser", bytes: 100 }), clearItem({ name: "temp", where: "/tmp/temp", bytes: 900, what: "Temporary" })] }];
    const before = structuredClone(groups), sort = { id: "size", direction: "desc" } as const;
    expect(cacheTableRows(groups, "", "all", sort).map((r) => r.item.where)).toEqual(["/tmp/temp", "~/z", "~/browser"]);
    expect(cacheTableRows(groups, "browser", "large", sort)).toHaveLength(1);
    expect(cacheTableRows(groups, "", "type:Temporary", sort).map((r) => r.item.name)).toEqual(["temp"]);
    expect(cacheTableRows(groups, "missing", "all", sort)).toEqual([]);
    expect(groups).toEqual(before);
    const items = groups[1]!.items;
    expect(itemTableRows(items, "", { id: "name", direction: "asc" }).map((r) => r.name)).toEqual(["browser", "temp"]);
    expect(itemTableRows(items, "", { id: "size", direction: "asc" }).map((r) => r.bytes)).toEqual([100, 900]);
    expect(itemTableRows(items, "/tmp", sort).map((r) => r.name)).toEqual(["temp"]);
  });
});
