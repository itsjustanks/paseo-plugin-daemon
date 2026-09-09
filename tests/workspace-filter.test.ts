import { describe, expect, it } from "vitest";
import { cwdWithinDirectory, filterWorkspaceProcesses, workspacePorts } from "../shared/workspace-filter";

const row = (cwd: string | null, ports: number[] = [], project: { path: string; workspace: string | null } | null = null) => ({ cwd, ports, project, pid: ports[0] ?? 0 });

describe("cwdWithinDirectory", () => {
  it("matches home-relative cwds against an absolute workspace directory", () => {
    expect(cwdWithinDirectory("~/app/web", "/home/alice/app/web")).toBe(true);
    expect(cwdWithinDirectory("~/app/web/src", "/home/alice/app/web")).toBe(true);
    expect(cwdWithinDirectory("~/app/web", "/Users/alice/app/web")).toBe(true);
    expect(cwdWithinDirectory("~/app", "/home/alice/app/web")).toBe(false);
    expect(cwdWithinDirectory("~/app-web", "/home/alice/app/web")).toBe(false);
    expect(cwdWithinDirectory("~/other/app/web", "/home/alice/app/web")).toBe(false);
  });
  it("matches absolute cwds by segment prefix and rejects lookalikes and empties", () => {
    expect(cwdWithinDirectory("/srv/app/web/node_modules", "/srv/app/web")).toBe(true);
    expect(cwdWithinDirectory("/srv/app/web", "/srv/app/web/")).toBe(true);
    expect(cwdWithinDirectory("/srv/app/website", "/srv/app/web")).toBe(false);
    expect(cwdWithinDirectory("/srv/app", "/srv/app/web")).toBe(false);
    expect(cwdWithinDirectory(null, "/srv/app/web")).toBe(false);
    expect(cwdWithinDirectory("~/app", "")).toBe(false);
    expect(cwdWithinDirectory("~", "/home/alice")).toBe(false);
  });
});

describe("filterWorkspaceProcesses", () => {
  const target = { directory: "/home/alice/app/.worktrees/feature", projectRootPath: "/home/alice/app", name: "feature" };
  it("keeps processes inside the workspace directory and drops the rest of the project", () => {
    const inside = row("~/app/.worktrees/feature", [3000]);
    const nested = row("~/app/.worktrees/feature/packages/api", [4000]);
    const sibling = row("~/app/.worktrees/other", [3001]);
    const root = row("~/app", [5173]);
    expect(filterWorkspaceProcesses([inside, nested, sibling, root], target)).toEqual([inside, nested]);
  });
  it("accepts the daemon's own workspace attribution when cwd is unreadable", () => {
    const attributed = row(null, [3000], { path: "~/app", workspace: "feature" });
    const otherWorkspace = row(null, [3001], { path: "~/app", workspace: "other" });
    const otherProject = row(null, [3002], { path: "~/elsewhere", workspace: "feature" });
    expect(filterWorkspaceProcesses([attributed, otherWorkspace, otherProject], target)).toEqual([attributed]);
  });
  it("pulls in listeners that share a workspace port, and explicit forwarded ports", () => {
    const app = row("~/app/.worktrees/feature", [3000]);
    const proxy = row("~/elsewhere", [3000, 8080]);
    const unrelated = row("~/elsewhere", [9000]);
    const forwarded = row(null, [7000]);
    expect(filterWorkspaceProcesses([app, proxy, unrelated, forwarded], target)).toEqual([app, proxy]);
    expect(filterWorkspaceProcesses([app, proxy, unrelated, forwarded], target, [7000])).toEqual([app, proxy, forwarded]);
    expect(filterWorkspaceProcesses([unrelated], target)).toEqual([]);
  });
  it("lists distinct ports in ascending order", () => {
    expect(workspacePorts([row(null, [8080, 3000]), row(null, [3000]), row(null, [])])).toEqual([3000, 8080]);
  });
});
