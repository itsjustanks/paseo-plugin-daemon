import { describe, expect, it } from "vitest";
import { processStateWords, serviceInventory, serviceTableRows } from "../shared/service-inventory";
import { processRow, workspaceUsage } from "./resource-table-fixtures";

const service = (extra = {}) => ({ pid: 42, name: "python3", cwd: "~/projects/site", state: "sleeping", ports: [8000], cpuPercent: 0, rssBytes: 100, classification: { label: "Python HTTP server" }, ...extra });
describe("live service inventory", () => {
  it("describes sleep as waiting for requests without promising health", () => {
    expect(processStateWords("sleeping", [8000])).toBe("Listening · waiting for requests");
    expect(processStateWords("sleeping")).toBe("Waiting for work");
    expect(processStateWords("running", [3000])).toBe("Listening · active");
    expect(processStateWords("disk-wait")).toBe("Waiting for disk or I/O");
    expect(processStateWords("stopped")).toBe("Paused");
    expect(processStateWords("zombie")).toBe("Exited · awaiting cleanup");
    expect(processStateWords("unknown")).toBe("Activity unknown");
  });
  it("shows running services and truthful unknown attribution without a disk report", () => {
    const [row] = serviceInventory([service()], []);
    expect(row.workspace).toBe("No workspace identified");
    expect(row.ownership).toContain("Owner unknown");
    expect(row.service.ports).toEqual([8000]);
    const [known] = serviceInventory([service({ project: { name: "Website", workspace: "Sandbox" } })], []);
    expect(known.workspace).toBe("Sandbox");
    expect(known.ownership).toContain("no chat identified");
  });
  it("uses exact process identity for chat tags and refuses ambiguous folder associations", () => {
    const row = processRow({ name: "python3", chat: { id: "chat", title: "Build Website", status: "idle", workspaceId: "ws", workspace: "Sandbox", project: "Website", workspacePath: "/home/fixture/projects/site", where: "Website · Sandbox" } });
    expect(serviceInventory([service()], [row])[0].ownership).toBe("Tagged by chat Build Website");
    expect(serviceInventory([service({ name: "new-process" })], [row])[0].chatId).toBeUndefined();
    const disk = workspaceUsage({ folder: "~/projects/site", path: "/home/fixture/projects/site", names: ["Sandbox", "review"] });
    expect(serviceInventory([service()], [], [disk])[0].workspace).toBe("Sandbox, review");
    expect(serviceInventory([service()], [], [disk, { ...disk, id: "duplicate" }])[0].workspace).toBe("No workspace identified");
  });
  it("sorts resources highest first, leaves unknown CPU last, and searches across ownership and ports", () => {
    const rows = serviceInventory([service(), service({ pid: 43, name: "vite", rssBytes: 1000, cpuPercent: null }), service({ pid: 44, name: "next", cpuPercent: 70, rssBytes: 500 })], []);
    expect(serviceTableRows(rows, "", { id: "memory", direction: "desc" }).map((row) => row.service.pid)).toEqual([43, 44, 42]);
    expect(serviceTableRows(rows, "", { id: "cpu", direction: "desc" }).map((row) => row.service.pid)).toEqual([44, 42, 43]);
    expect(serviceTableRows(rows, "8000", { id: "memory", direction: "desc" })).toHaveLength(3);
    expect(serviceTableRows(rows, "Owner unknown", { id: "workspace", direction: "asc" })).toHaveLength(3);
    expect(serviceTableRows(rows, "missing", { id: "project", direction: "asc" })).toEqual([]);
  });
});

it("filters only existing Stop eligibility and workspace association facts", () => {
  const rows = serviceInventory([service({ actionable: true, actionToken: "fixture-token" }), service({ pid: 43, actionable: true, actionToken: null }), service({ pid: 44, actionable: false, actionToken: "fixture-token", project: { name: "Website", workspace: "Sandbox" } })], []);
  const sort = { id: "memory", direction: "desc" } as const;
  expect(serviceTableRows(rows, "", sort, "can-stop").map((row) => row.service.pid)).toEqual([42]);
  expect(serviceTableRows(rows, "", sort, "no-workspace").map((row) => row.service.pid)).toEqual([42, 43]);
  expect(serviceTableRows(rows, "Sandbox", sort, "no-workspace")).toEqual([]);
  expect(rows[2].service).toMatchObject({ actionable: false });
});
