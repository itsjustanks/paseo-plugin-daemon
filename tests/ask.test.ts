import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { createAsk } from "../server/ask";
import { redactText } from "../server/redaction";
import { AskContextSchema, OUTPUT_LINES, composeAskMessage, suggestedStep, tailLines, type AskFacts } from "../shared/ask";
import { HostsAttachmentItemSchema, matchesQuery } from "../shared/attachments";
import { askSubjectFor, type HealthIssue, type HealthVerdict } from "../shared/health";
import type { ProcessReport, ProcessRow } from "../shared/processes";
import { SYNTHETIC_ANTHROPIC_KEY, SYNTHETIC_GITHUB_TOKEN, SYNTHETIC_JWT, SYNTHETIC_PASSWORD } from "./synthetic-secrets";

const HOME = "/home/alice";
const GB = 1024 ** 3, MB = 1024 ** 2;

function row(over: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid: 4402, ppid: 401, name: "tsc", command: "node ~/app/node_modules/.bin/tsc --watch", cwd: "~/app", state: "running",
    cpuPercent: 99, cpuSustained: 99, hotSeconds: 240, rssBytes: 2.1 * GB, memoryPercent: 28.8, ageSeconds: 420, ports: [],
    job: { kind: "typecheck", label: "Type check" }, jobRoot: true, tree: { count: 1, cpuPercent: 99, rssBytes: 2.1 * GB },
    owner: { kind: "workspace", label: "Website · main", project: "Website", workspace: "main" },
    flags: [{ code: "cpu-runaway", text: "Has used a full CPU core for 4 min" }], stoppable: true, protectedReason: null, actionToken: "t",
    ...over,
  } as ProcessRow;
}

function report(rows: ProcessRow[]): ProcessReport {
  return {
    checkedAt: 1, platform: "linux", supported: true, sampling: false,
    host: { cores: 8, cpuPercent: 91, load1: 7, memoryTotalBytes: 64 * GB, memoryUsedBytes: 20 * GB, cpuPressure: "high", memoryPressure: "normal" },
    container: { memoryLimitBytes: 7.3 * GB, memoryUsedBytes: 6.9 * GB, memoryPercent: 94, cpuLimitCores: 8, cpuCoresUsed: 5.4, oomKills: 0 },
    memoryBasis: "container", memoryBasisBytes: 7.3 * GB, heavyJobs: { count: 5, limit: 4, pids: [] },
    runaways: [], processes: rows, total: rows.length, matched: rows.length, paseoBytes: 500 * MB, projectsVerified: true, warnings: [], recentActions: [],
  } as unknown as ProcessReport;
}

const issue = (over: Partial<HealthIssue>): HealthIssue => ({ code: "port-gone", severity: "warning", scope: "process", message: "next on port 3000 stopped serving.", ports: [3000], cwd: "~/app", ...over });

function verdict(over: Partial<HealthVerdict> = {}): HealthVerdict {
  return {
    status: "warning", checkedAt: 1, background: true, issues: [issue({})], services: [{ name: "vite", cwd: "~/api", ports: [5173], project: null }],
    watched: [{ id: "omniroute", name: "OmniRoute", target: "10.0.0.9:20128/api/health/ping", state: "down", latencyMs: null, usualMs: 110, status: null, checkedAt: 1, message: "OmniRoute is not answering.", history: [{ at: 1, state: "up", latencyMs: 120 }, { at: 2, state: "down", latencyMs: null }] }],
    load: null,
    ...over,
  } as HealthVerdict;
}

/** A fake Paseo session: one workspace at ~/app with a dev terminal, and whatever terminals the test adds. */
function fakePaseo(terminals: Array<{ id: string; name: string; cwd: string; lines: string[] }>, options: { scripts?: Array<{ scriptName: string; port: number; terminalId: string }>; canCreate?: boolean } = {}) {
  const created: unknown[] = [];
  const paseo = {
    workspaces: {
      list: async () => ({
        entries: [
          { id: "ws-app", name: "main", workspaceDirectory: `${HOME}/app`, projectRootPath: `${HOME}/app`, projectDisplayName: "Website", archivingAt: null, scripts: options.scripts ?? [] },
          { id: "ws-other", name: "other", workspaceDirectory: `${HOME}/other`, projectRootPath: `${HOME}/other`, projectDisplayName: "Other", archivingAt: null, scripts: [] },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    terminals: {
      list: async ({ workspaceId }: { workspaceId: string }) => ({ entries: workspaceId === "ws-app" ? terminals.map(({ id, name, cwd }) => ({ id, name, cwd, workspaceId })) : [] }),
      ref: (id: string) => ({ capture: async ({ start }: { start: number }) => ({ terminalId: id, lines: (terminals.find((item) => item.id === id)?.lines ?? []).slice(start), totalLines: 0 }) }),
      ...(options.canCreate === false ? {} : { create: async (input: unknown) => { created.push(input); return { id: "term-new" }; } }),
    },
  } as unknown as PaseoApi;
  return { paseo, created };
}

const deps = (rows: ProcessRow[], current = verdict()) => ({
  report: async (input: { query?: string }) => report(rows.filter((item) => !input.query || String(item.pid) === input.query)),
  verdict: async () => current,
  lost: (port: number) => (port === 3000 ? { name: "next", cwd: "~/app", lostAt: 0 } : null),
  home: HOME,
  now: () => 5 * 60_000,
});

const devLog = (extra: string[] = []) => ["> website@1.0.0 dev", "> next dev", "  ▲ Next.js 15.0.0", "  - Local:        http://localhost:3000", ...Array.from({ length: 80 }, (_, i) => `compiled page ${i}`), ...extra];

describe("composeAskMessage", () => {
  const facts: AskFacts = {
    code: "cpu-runaway", problem: "tsc (PID 4402) has used a full CPU core for 4 min.", hostLine: "memory 6.9 GB of 7.3 GB (container limit), CPU 91%, 5 of 4 heavy jobs",
    process: { name: "tsc", pid: 4402, job: "Type check", owner: "Website · main", cwd: "~/app", cpuPercent: 99, rssBytes: 2.1 * GB, memoryPercent: 28.8, memoryWhere: "this container's limit", ageSeconds: 420, command: "node tsc --watch", ports: [] },
    where: "Website · main",
  };

  it("says what's wrong, the figures, a next step, and asks before anything drastic", () => {
    const text = composeAskMessage(facts);
    expect(text).toContain("What's wrong: tsc (PID 4402) has used a full CPU core for 4 min.");
    expect(text).toContain("- CPU: 99% of one core");
    expect(text).toContain("- Memory: 2.1 GB (28.8% of this container's limit)");
    expect(text).toContain("- Running for: 7m 0s");
    expect(text).toContain("- Command: node tsc --watch");
    expect(text).toContain(`Suggested next step: ${suggestedStep(facts)}`);
    expect(text).toContain("Ask me before stopping, restarting or deleting anything.");
    expect(text).not.toContain("output wasn't found");
  });

  it("fences output so it can't close the block early, and says when there is none", () => {
    const withOutput = composeAskMessage({ ...facts, code: "port-gone", process: null, devServer: { name: "next", port: 3000, cwd: "~/app", stoppedMinutesAgo: 3 }, output: { from: "the terminal \"dev\"", lines: ["Error: boom", "~~~ sneaky"] } });
    expect(withOutput).toContain("Last 2 lines of its output (from the terminal \"dev\"):\n~~~text\nError: boom\n~ ~ ~ sneaky\n~~~");
    expect(withOutput).toContain("noticed 3 min ago");
    expect(composeAskMessage({ ...facts, code: "port-gone", process: null, devServer: { name: "next", port: 3000, cwd: null, stoppedMinutesAgo: null } })).toContain("Its output wasn't found in this workspace's terminals.");
  });

  it("has a next step for every kind of trouble", () => {
    for (const code of ["cpu-runaway", "memory-heavy", "pressure-driver", "port-gone", "service-slow", "service-down", "service", "process"] as const) {
      expect(suggestedStep({ code, service: { name: "OmniRoute", target: "x", state: "down", latencyMs: null, usualMs: null, status: null, history: [] } }).length).toBeGreaterThan(20);
    }
  });

  it("tailLines keeps the last 50, strips colour codes and cuts long lines", () => {
    const lines = tailLines([...Array.from({ length: 70 }, (_, i) => `\u001b[32mline ${i}\u001b[0m`), "x".repeat(500), "", "  "]);
    expect(lines).toHaveLength(OUTPUT_LINES);
    expect(lines[0]).toBe("line 21");
    expect(lines.at(-1)!.length).toBe(300);
  });
});

describe("redactText (terminal output)", () => {
  it("removes secrets from output lines and collapses home", () => {
    const lines = redactText([
      `export API_KEY=${SYNTHETIC_ANTHROPIC_KEY}`,
      `Authorization: Bearer ${SYNTHETIC_JWT}`,
      `connecting to postgres://app:${SYNTHETIC_PASSWORD}@db:5432/app`,
      `cloning with ${SYNTHETIC_GITHUB_TOKEN} into ${HOME}/app`,
      `run --token ${SYNTHETIC_PASSWORD} --port 3000`,
      "GET /callback?code=abc&access_token=xyz 200",
      "ready on http://localhost:3000",
    ], HOME);
    const joined = lines.join("\n");
    for (const secret of [SYNTHETIC_ANTHROPIC_KEY, SYNTHETIC_JWT, SYNTHETIC_PASSWORD, SYNTHETIC_GITHUB_TOKEN, "xyz"]) expect(joined).not.toContain(secret);
    expect(joined).toContain("into ~/app");
    expect(lines.at(-1)).toBe("ready on http://localhost:3000");
  });
});

describe("server ask: context", () => {
  it("a runaway: figures, its workspace, a redacted command, no output for a non-server", async () => {
    const ask = createAsk(deps([row({ command: `node tsc --token ${SYNTHETIC_PASSWORD}` })]));
    const { paseo } = fakePaseo([]);
    const context = AskContextSchema.parse(await ask.context({ kind: "process", pid: 4402 }, paseo));
    expect(context).toMatchObject({ title: "tsc is stuck at full CPU", workspaceId: "ws-app", workspaceName: "main", outputFrom: null });
    expect(context.text).toContain("What's wrong: tsc (PID 4402): has used a full CPU core for 4 min.");
    expect(context.text).toContain("- Host: memory 6.9 GB of 7.3 GB (container limit), CPU 91%, 5 of 4 heavy jobs");
    expect(context.text).not.toContain(SYNTHETIC_PASSWORD);
    expect(context.text).not.toContain("output wasn't found");
  });

  it("a stopped dev server: finds the terminal that names its port and sends only the redacted tail", async () => {
    const ask = createAsk(deps([]));
    const { paseo } = fakePaseo([
      { id: "t-shell", name: "shell", cwd: `${HOME}/app`, lines: ["ls", "README.md"] },
      { id: "t-dev", name: "dev", cwd: `${HOME}/app`, lines: devLog([`Error: connect ECONNREFUSED (DATABASE_URL=postgres://u:${SYNTHETIC_PASSWORD}@db)`, "npm ERR! code 1"]) },
    ]);
    const context = await ask.context({ kind: "port", port: 3000 }, paseo);
    expect(context).toMatchObject({ title: "next on :3000 stopped", workspaceId: "ws-app", outputFrom: "the terminal \"dev\"" });
    expect(context.text).toContain("noticed 5 min ago");
    expect(context.text).toContain("npm ERR! code 1");
    expect(context.text).not.toContain(SYNTHETIC_PASSWORD);
    expect(context.text.split("\n").filter((line) => line.startsWith("compiled page")).length).toBe(OUTPUT_LINES - 2);
  });

  it("prefers a service script's own terminal, and never guesses from an unrelated one", async () => {
    const ask = createAsk(deps([]));
    const scripted = fakePaseo([{ id: "t-web", name: "web", cwd: `${HOME}/app`, lines: ["boot", "crashed"] }], { scripts: [{ scriptName: "web", port: 3000, terminalId: "t-web" }] });
    expect((await ask.context({ kind: "port", port: 3000 }, scripted.paseo)).outputFrom).toBe("the service script \"web\"");
    const unrelated = fakePaseo([{ id: "t-shell", name: "shell", cwd: `${HOME}/app`, lines: ["git status", "nothing to commit"] }]);
    const context = await ask.context({ kind: "port", port: 3000 }, unrelated.paseo);
    expect(context.outputFrom).toBeNull();
    expect(context.text).toContain("Its output wasn't found");
  });

  it("a watched service: its checks, no workspace, and plain errors for what's gone", async () => {
    const ask = createAsk(deps([]));
    const { paseo } = fakePaseo([]);
    const context = await ask.context({ kind: "service", id: "omniroute" }, paseo);
    expect(context).toMatchObject({ title: "OmniRoute is down", workspaceId: null });
    expect(context.text).toContain("- Recent checks, oldest first: up 120 ms, down");
    await expect(ask.context({ kind: "service", id: "gone" }, paseo)).rejects.toThrow(/isn't in Settings/);
    await expect(ask.context({ kind: "process", pid: 9 }, paseo)).rejects.toThrow(/already exited/);
    await expect(ask.context({ kind: "port", port: 9999 }, paseo)).rejects.toThrow(/serving again/);
  });

  it("issues point at the right subject", () => {
    expect(askSubjectFor(issue({ code: "runaway", pid: 4402, ports: [] }))).toEqual({ kind: "process", pid: 4402 });
    expect(askSubjectFor(issue({}))).toEqual({ kind: "port", port: 3000 });
    expect(askSubjectFor(issue({ code: "service-down", scope: "host", subject: "OmniRoute", ports: [] }), [{ id: "omniroute", name: "OmniRoute" }])).toEqual({ kind: "service", id: "omniroute" });
    expect(askSubjectFor(issue({ code: "memory-pressure", scope: "host", ports: [] }))).toBeNull();
    expect(askSubjectFor(issue({ code: "runaway", pid: null, ports: [] }))).toBeNull();
  });
});

describe("server ask: attachments and terminals", () => {
  it("lists heavy processes, attention, dev servers, stopped servers and watched services; each item is valid and searchable", async () => {
    const ask = createAsk(deps([row()]));
    const { paseo } = fakePaseo([{ id: "t-dev", name: "dev", cwd: `${HOME}/app`, lines: devLog(["Error: boom"]) }]);
    const { items } = await ask.attachments("", paseo);
    expect(items.map((item) => item.id)).toEqual(["processes", "attention", "server-5173", "stopped-3000", "service-omniroute"]);
    for (const item of items) HostsAttachmentItemSchema.parse(item);
    expect(items[0]!.text).toContain("tsc (PID 4402) · Website · main · CPU 99%");
    expect(items.find((item) => item.id === "stopped-3000")!.text).toContain("Error: boom");
    expect((await ask.attachments("omni", paseo)).items.map((item) => item.id)).toEqual(["service-omniroute"]);
    expect(matchesQuery({ title: "Heavy processes now", resourceType: "processes", identifier: "processes" }, "heavy proc")).toBe(true);
  });

  it("opens a terminal only inside a workspace, and says why not otherwise", async () => {
    const ask = createAsk(deps([row(), row({ pid: 77, cwd: "/tmp/scratch" })]));
    const { paseo, created } = fakePaseo([]);
    expect(await ask.openTerminal(4402, paseo)).toMatchObject({ ok: true, workspaceId: "ws-app", terminalId: "term-new", message: "Opened a terminal in ~/app, in main." });
    expect(created).toEqual([{ workspaceId: "ws-app", cwd: `${HOME}/app`, name: "tsc folder" }]);
    expect(await ask.openTerminal(77, paseo)).toMatchObject({ ok: false, message: expect.stringMatching(/isn't inside a Paseo workspace/) });
    expect(await ask.openTerminal(5, paseo)).toMatchObject({ ok: false, message: expect.stringMatching(/already exited/) });
    expect(await ask.openTerminal(4402, fakePaseo([], { canCreate: false }).paseo)).toMatchObject({ ok: false, message: expect.stringMatching(/can't open terminals/) });
  });
});
