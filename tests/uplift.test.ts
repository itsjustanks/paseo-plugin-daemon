import { describe, expect, it } from "vitest";
import { ARCHIVED_GRACE_MS, ARCHIVED_WATCH_MS, ArchivedWorkspaces } from "../server/archived";
import { HealthChecker } from "../server/health";
import { EMPTY_HEALTH_MEMORY, askSubjectFor, chipText, evaluateHealth, pillText, workspaceHealth, type HealthInput } from "../shared/health";
import { sshCommand } from "../shared/link";
import { processDetails, type ProcessReport, type ProcessRow } from "../shared/processes";
import { redactLongTokens, redactSecrets } from "../shared/redaction";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";
import { SYNTHETIC_ANTHROPIC_KEY, SYNTHETIC_GITHUB_TOKEN, SYNTHETIC_JWT } from "./synthetic-secrets";

/** 0.15.0: the shared redactor's free-text rules, the copy texts, and archived workspaces' leftovers. */

describe("redactSecrets (everything people see or copy)", () => {
  it("hides bearer and sk- keys, key=/token=/secret=/password= pairs, URLs with credentials, JWTs, long hex and base64", () => {
    const cases = [
      `Authorization: Bearer ${SYNTHETIC_GITHUB_TOKEN}`,
      `failed with ${SYNTHETIC_ANTHROPIC_KEY}`,
      "api_key=abc123secretvalue token=t0k3nValue99 secret=s3cr3tvalue password=hunter2pass",
      "https://alice:pa55word@db.example.com:5432/app",
      `session ${SYNTHETIC_JWT}`,
      "digest 3f786850e387550fdab836ed7e6dc881de23001b8f2a1c4d",
      "blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1234ABCDefgh",
    ];
    for (const text of cases) {
      const out = redactSecrets(text);
      for (const secret of [SYNTHETIC_GITHUB_TOKEN, SYNTHETIC_ANTHROPIC_KEY, "abc123secretvalue", "t0k3nValue99", "s3cr3tvalue", "hunter2pass", "pa55word", SYNTHETIC_JWT, "3f786850e387550fdab836ed7e6dc881de23001b8f2a1c4d", "QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1234ABCDefgh"]) expect(out, text).not.toContain(secret);
    }
  });

  it("keeps prose, paths, ports, PIDs and a commit named as one", () => {
    const keep = [
      "Asked next-server (PID 4402) to stop.",
      "~/code/site/node_modules · 1.2 GB looks safe to clear",
      "Disk check finished: about 3.2 GB looks safe to clear in 2 idle workspaces.",
      "ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 -p 22 me@office",
      "commit 3f786850e387550fdab836ed7e6dc881de23001b",
    ];
    for (const text of keep) expect(redactSecrets(text)).toBe(text);
    expect(redactLongTokens("#3f786850e387550fdab836ed7e6dc881de23001b")).toBe("#3f786850e387550fdab836ed7e6dc881de23001b");
  });
});

describe("copy texts", () => {
  it("Copy SSH command: the same forward, nothing secret", () => {
    expect(sshCommand({ destination: "me@office", sshPort: 2222, remotePort: 5173, localPort: 3000 })).toBe("ssh -N -L 127.0.0.1:3000:127.0.0.1:5173 -p 2222 me@office");
  });
  it("Copy details: name, PID, ports, folder, command", () => {
    const row = { name: "next-server", pid: 4402, ports: [3000, 3001], cwd: "~/code/site", command: "node next dev" } as Pick<ProcessRow, "name" | "pid" | "ports" | "cwd" | "command">;
    expect(processDetails(row)).toBe("next-server (PID 4402) · ports :3000 :3001 · in ~/code/site\nnode next dev");
  });
});

const row = (over: Partial<ProcessRow>): ProcessRow => ({ pid: 1, name: "node", ports: [], cwd: null, stoppable: true, command: "node", ...over } as ProcessRow);
const report = (rows: ProcessRow[]) => async () => ({ processes: rows } as unknown as ProcessReport);

describe("archived workspaces' leftovers", () => {
  it("finds processes still listening in the folder after the grace period, for a day, never outside it", async () => {
    let now = 1_000_000;
    const archived = new ArchivedWorkspaces("/home/alice", () => now);
    archived.record({ id: "w1", name: "feature-x", cwd: "/home/alice/.paseo/worktrees/site/feature-x" });
    const rows = [
      row({ pid: 10, name: "next-server", ports: [3000], cwd: "~/.paseo/worktrees/site/feature-x" }),
      row({ pid: 11, name: "vite", ports: [5173], cwd: "~/.paseo/worktrees/site/feature-x/apps/web", stoppable: false }),
      row({ pid: 12, name: "tsc", ports: [], cwd: "~/.paseo/worktrees/site/feature-x" }),
      row({ pid: 13, name: "other", ports: [4000], cwd: "~/.paseo/worktrees/site/feature-xy" }),
    ];
    expect(await archived.leftovers(report(rows))).toEqual([]);
    now += ARCHIVED_GRACE_MS;
    expect(await archived.leftovers(report(rows))).toEqual([
      { pid: 10, name: "next-server", ports: [3000], cwd: "~/.paseo/worktrees/site/feature-x", stoppable: true, workspace: "feature-x" },
      { pid: 11, name: "vite", ports: [5173], cwd: "~/.paseo/worktrees/site/feature-x/apps/web", stoppable: false, workspace: "feature-x" },
    ]);
    now += ARCHIVED_WATCH_MS;
    expect(archived.size).toBe(0);
    expect(await archived.leftovers(report(rows))).toEqual([]);
  });

  it("ignores events without a usable folder (and the home folder), and never throws", () => {
    const archived = new ArchivedWorkspaces("/home/alice");
    for (const event of [{}, { cwd: 42 }, { cwd: "relative" }, { cwd: "/" }, { cwd: "/home/alice" }, { cwd: "/home/alice/" }]) archived.record(event as never);
    expect(archived.size).toBe(0);
  });

  it("each becomes an issue with Stop (when stoppable) and Ask an agent; no chip in every chat", () => {
    const input: HealthInput = { now: 1, snapshot: null, tunnels: [], connections: [], profiles: [], background: true, archived: [{ pid: 10, name: "next-server", ports: [3000], cwd: "~/x", stoppable: true, workspace: "feature-x" }] };
    const { verdict } = evaluateHealth(input, EMPTY_HEALTH_MEMORY);
    const issue = verdict.issues.find((item) => item.code === "archived-leftover")!;
    expect(issue).toMatchObject({ message: 'next-server (:3000) is still running from the archived workspace "feature-x".', pid: 10, stoppable: true, severity: "warning" });
    expect(askSubjectFor(issue)).toEqual({ kind: "process", pid: 10 });
    const health = workspaceHealth(verdict, { directory: "/home/alice/site", projectRootPath: "/home/alice/site", name: "main" });
    expect(chipText(health)).toBeNull();
    expect(pillText({ ...health, issues: [issue] })).toBe("Left running: next-server");
  });

  it("the health check asks only while a workspace is being watched, and a failing report is ignored", async () => {
    const runtime = {
      monitor: { snapshot: async () => { throw new Error("x"); } },
      links: { status: async () => ({ profiles: [], connections: [], tunnels: [] }) },
      processes: { report: async () => { throw new Error("report down"); } },
    };
    let size = 0, asked = 0;
    const archived = { get size() { return size; }, leftovers: async (query: (input: never) => Promise<unknown>) => { asked += 1; await query({} as never); return []; } };
    const checker = new HealthChecker({ runtime: runtime as never, readSettings: async () => HOSTS_SETTINGS_DEFAULTS, archived: archived as never, setTimer: (() => 0) as never, clearTimer: (() => undefined) as never });
    await checker.read(undefined, true);
    expect(asked).toBe(0);
    size = 1;
    const verdict = await checker.read(undefined, true);
    expect(asked).toBe(1);
    expect(verdict.issues.some((issue) => issue.code === "archived-leftover")).toBe(false);
    checker.close();
  });
});

describe("archived workspaces (review fixes)", () => {
  it("a symlinked folder also matches the kernel's real path, resolved after the hook returned", async () => {
    let now = 1_000_000;
    class Linked extends ArchivedWorkspaces { protected override resolve() { return Promise.resolve("/home/alice/real/site"); } }
    const archived = new Linked("/home/alice", () => now);
    archived.record({ id: "w1", name: "site", cwd: "/home/alice/link/site" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += ARCHIVED_GRACE_MS;
    const found = await archived.leftovers(report([row({ pid: 20, name: "next-server", ports: [3000], cwd: "~/real/site" })]));
    expect(found.map((item) => item.pid)).toEqual([20]);
  });

  it("a failing real-path lookup keeps the given folder", async () => {
    let now = 1_000_000;
    class Broken extends ArchivedWorkspaces { protected override resolve(): Promise<string | null> { return Promise.reject(new Error("gone")); } }
    const archived = new Broken("/home/alice", () => now);
    archived.record({ id: "w1", name: "site", cwd: "/home/alice/site" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += ARCHIVED_GRACE_MS;
    expect((await archived.leftovers(report([row({ pid: 21, ports: [4000], cwd: "~/site" })]))).map((item) => item.pid)).toEqual([21]);
  });

  it("reads every page: a listener behind 200 heavier matches is still found", async () => {
    let now = 1_000_000;
    const archived = new ArchivedWorkspaces("/home/alice", () => now);
    archived.record({ id: "w1", name: "site", cwd: "/home/alice/site" });
    now += ARCHIVED_GRACE_MS;
    const heavy = Array.from({ length: 260 }, (_, index) => row({ pid: 1000 + index, ports: [], cwd: "~/site" }));
    const all = [...heavy, row({ pid: 99, name: "vite", ports: [5173], cwd: "~/site/web" })];
    const offsets: number[] = [];
    const paged = async (input: { offset?: number; limit?: number }) => {
      offsets.push(input.offset ?? 0);
      const start = input.offset ?? 0;
      return { processes: all.slice(start, start + (input.limit ?? 25)), matched: all.length } as unknown as ProcessReport;
    };
    const found = await archived.leftovers(paged as never);
    expect(found.map((item) => item.pid)).toEqual([99]);
    expect(offsets).toEqual([0, 200]);
  });
});
