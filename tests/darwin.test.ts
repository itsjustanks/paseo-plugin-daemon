import { describe, expect, it } from "vitest";
import {
  DarwinAdapter,
  availableBytesFromVmStat,
  parseLsofCwd,
  parseLsofListen,
  parsePressureLevel,
  parsePsOutput,
  parsePsTime,
  parseSwapUsage,
  parseVmStat,
  type Exec,
} from "../darwin.server";
import * as fx from "./fixtures/darwin";

describe("darwin parsers", () => {
  it("parses ps TIME and ETIME formats", () => {
    expect(parsePsTime("1:23.45")).toBeCloseTo(83.45);
    expect(parsePsTime("12:34.56")).toBeCloseTo(754.56);
    expect(parsePsTime("01:02:03")).toBe(3723);
    expect(parsePsTime("10-02:03:04")).toBe(10 * 86400 + 2 * 3600 + 3 * 60 + 4);
    expect(parsePsTime("bogus")).toBe(0);
  });

  it("parses ps rows including lstart and commands with spaces", () => {
    const rows = parsePsOutput(fx.PS_OUTPUT);
    expect(rows).toHaveLength(4);
    const vite = rows.find((r) => r.pid === 777)!;
    expect(vite).toMatchObject({ ppid: 501, uid: 501, state: "R", rssBytes: 204800 * 1024, lstart: "Thu Sep 4 09:55:00 2026" });
    expect(vite.command).toBe("node /Users/alice/app/node_modules/.bin/vite --port 5173");
    expect(vite.ageSeconds).toBe(300);
    expect(rows.find((r) => r.pid === 778)!.state).toBe("Z");
  });

  it("parses vm_stat and computes conservative available memory", () => {
    const vm = parseVmStat(fx.VM_STAT);
    expect(vm.pageSize).toBe(16384);
    expect(vm.compressed).toBe(80000);
    expect(availableBytesFromVmStat(vm)).toBe((12345 + 100000 + 5000 + 2000) * 16384);
  });

  it("parses swapusage and pressure level", () => {
    expect(parseSwapUsage(fx.SWAPUSAGE)).toEqual({ totalBytes: 2048 * 1024 ** 2, usedBytes: 1234.5 * 1024 ** 2 });
    expect(parsePressureLevel("1\n")).toBe("normal");
    expect(parsePressureLevel("2")).toBe("warn");
    expect(parsePressureLevel("4")).toBe("critical");
    expect(parsePressureLevel("")).toBeNull();
  });

  it("parses lsof field output", () => {
    const ports = parseLsofListen(fx.LSOF_LISTEN);
    expect(ports.get(777)).toEqual([5173]);
    expect(ports.get(900)).toEqual([8080]);
    expect(parseLsofCwd(fx.LSOF_CWD)).toBe("/Users/alice/app");
    expect(parseLsofCwd("")).toBeNull();
  });
});

describe("DarwinAdapter", () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "ps" && args[0] === "-axo" && args[1]?.startsWith("pid=,ppid=,uid=,state")) return fx.PS_OUTPUT;
    if (file === "ps" && args[0] === "-axo") return "1 0 0\n501 1 501\n777 501 501\n778 777 501\n";
    if (file === "ps" && args[0] === "-o") return fx.PS_OUTPUT.split("\n").filter((l) => l.trim().startsWith(`${args[3]} `)).join("\n");
    if (file === "vm_stat") return fx.VM_STAT;
    if (file === "sysctl" && args[1] === "vm.swapusage") return fx.SWAPUSAGE;
    if (file === "sysctl") return "2\n";
    if (file === "lsof" && args[0] === "-nP") return fx.LSOF_LISTEN;
    if (file === "lsof" && args[0] === "-a") return fx.LSOF_CWD;
    throw new Error(`unexpected ${file}`);
  };
  let now = 1000;
  const adapter = new DarwinAdapter({ exec, portCacheMs: 5000, now: () => now });

  it("samples system facts with fixed argv only", async () => {
    const sample = await adapter.sampleSystem();
    expect(sample.pressureSignal).toBe("warn");
    expect(sample.swapUsedBytes).toBe(1234.5 * 1024 ** 2);
    expect(sample.psiCpuSome10).toBeNull();
    for (const call of calls) expect(call.join(" ")).not.toMatch(/[|;&$`]/);
  });

  it("returns same-user processes and resolves cwd only for listeners", async () => {
    calls.length = 0;
    const { processes, warnings } = await adapter.sampleProcesses(501);
    expect(warnings).toEqual([]);
    expect(processes.map((p) => p.pid).sort()).toEqual([501, 777, 778]);
    const vite = processes.find((p) => p.pid === 777)!;
    expect(vite.cwd).toBe("/Users/alice/app");
    expect(vite.argv[0]).toBe("node");
    expect(vite.state).toBe("running");
    expect(processes.find((p) => p.pid === 501)!.cwd).toBeNull();
    expect(processes.find((p) => p.pid === 778)!.state).toBe("zombie");
    const cwdLookups = calls.filter((c) => c[0] === "lsof" && c[1] === "-a");
    expect(cwdLookups).toHaveLength(1);
  });

  it("throttles lsof port scans", async () => {
    calls.length = 0;
    await adapter.listeningPorts([777]);
    await adapter.listeningPorts([777]);
    expect(calls.filter((c) => c[0] === "lsof").length).toBe(0);
    now += 6000;
    await adapter.listeningPorts([777]);
    expect(calls.filter((c) => c[0] === "lsof").length).toBe(1);
  });

  it("degrades with a warning when lsof is missing", async () => {
    const missing: Exec = async (file, args) => {
      if (file === "lsof") throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      return exec(file, args);
    };
    const degraded = new DarwinAdapter({ exec: missing, now: () => now });
    const result = await degraded.listeningPorts([777]);
    expect(result.ports.size).toBe(0);
    expect(result.warnings[0]).toMatch(/lsof/);
  });

  it("reads identity for a single pid", async () => {
    const identity = await adapter.readIdentity(777);
    expect(identity).toMatchObject({ pid: 777, uid: 501, startId: "Thu Sep 4 09:55:00 2026", state: "running" });
    expect(await adapter.readIdentity(-1)).toBeNull();
  });
});
