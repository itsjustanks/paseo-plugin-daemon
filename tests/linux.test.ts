import { describe, expect, it } from "vitest";
import {
  LinuxAdapter,
  parseCmdline,
  parseLoadavg,
  parseMeminfo,
  parsePressure,
  parseProcNetTcp,
  parseProcPidStat,
  parseProcStat,
  parseProcStatus,
  parseSocketInode,
  parseUptime,
  type LinuxFs,
} from "../linux.server";
import * as fx from "./fixtures/linux";

describe("linux parsers", () => {
  it("parses aggregate cpu counters", () => {
    const cpu = parseProcStat(fx.PROC_STAT);
    expect(cpu.busy).toBe(7399079 + 79538 + 3639026 + 0 + 38540 + 1104790);
    expect(cpu.total).toBe(cpu.busy + 139527888 + 391456);
  });

  it("parses loadavg, uptime, and PSI", () => {
    expect(parseLoadavg(fx.LOADAVG)).toEqual({ load1: 2.04, load5: 1.03, load15: 1.35 });
    expect(parseUptime(fx.UPTIME)).toBe(190635);
    expect(parsePressure(fx.PRESSURE_CPU)).toBe(3.68);
    expect(parsePressure("garbage")).toBeNull();
  });

  it("parses meminfo with and without MemAvailable", () => {
    const mem = parseMeminfo(fx.MEMINFO);
    expect(mem.totalBytes).toBe(32864204 * 1024);
    expect(mem.availableBytes).toBe(22870792 * 1024);
    expect(mem.swapTotalBytes - mem.swapFreeBytes).toBe((24820704 - 24804736) * 1024);
    const old = parseMeminfo(fx.MEMINFO_OLD_KERNEL);
    expect(old.availableBytes).toBe((100000 + 200000 + 30000 + 50000) * 1024);
  });

  it("parses /proc/<pid>/stat when comm contains spaces or parentheses", () => {
    const daemon = parseProcPidStat(fx.PID_STAT_DAEMON);
    expect(daemon).toMatchObject({ pid: 1458488, comm: "Paseo Daemon", state: "S", ppid: 1458477, utimeTicks: 96763, stimeTicks: 79197, startTicks: 15076589, rssPages: 123969 });
    const weird = parseProcPidStat(fx.PID_STAT_PARENS);
    expect(weird).toMatchObject({ pid: 42, comm: "weird (name)", state: "R", ppid: 1, utimeTicks: 300, stimeTicks: 100, startTicks: 5000, rssPages: 25 });
  });

  it("parses status uid and VmRSS", () => {
    expect(parseProcStatus(fx.PID_STATUS_DAEMON)).toEqual({ uid: 1000, rssBytes: 496616 * 1024 });
    expect(parseProcStatus(fx.PID_STATUS_ROOT).uid).toBe(0);
  });

  it("splits cmdline on NUL and drops the trailing empty entry", () => {
    expect(parseCmdline(fx.CMDLINE_NODE)).toEqual(["node", "/home/u/app/server.js", "--token", "abc123"]);
    expect(parseCmdline(Buffer.alloc(0))).toEqual([]);
  });

  it("extracts only LISTEN sockets from /proc/net/tcp{,6}", () => {
    const v4 = parseProcNetTcp(fx.NET_TCP);
    expect(v4).toEqual([
      { inode: 8233008, port: 0xa3c3, uid: 1000 },
      { inode: 2871, port: 53, uid: 990 },
      { inode: 10082, port: 22, uid: 0 },
    ]);
    const v6 = parseProcNetTcp(fx.NET_TCP6);
    expect(v6.map((s) => s.port)).toEqual([0x12f2, 3000]);
    expect(parseSocketInode("socket:[555]")).toBe(555);
    expect(parseSocketInode("/dev/null")).toBeNull();
  });
});

function fakeFs(files: Record<string, string | Buffer>, dirs: Record<string, string[]>, links: Record<string, string>): LinuxFs {
  const missing = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  return {
    async readFile(path) {
      const value = files[path];
      if (value === undefined) throw missing(path);
      return typeof value === "string" ? value : value.toString("utf8");
    },
    async readFileBuffer(path) {
      const value = files[path];
      if (value === undefined) throw missing(path);
      return typeof value === "string" ? Buffer.from(value) : value;
    },
    async readdir(path) {
      const value = dirs[path];
      if (!value) throw missing(path);
      return value;
    },
    async readlink(path) {
      const value = links[path];
      if (!value) throw missing(path);
      return value;
    },
  };
}

describe("LinuxAdapter", () => {
  const fs = fakeFs(
    {
      "/proc/stat": fx.PROC_STAT,
      "/proc/loadavg": fx.LOADAVG,
      "/proc/meminfo": fx.MEMINFO,
      "/proc/pressure/cpu": fx.PRESSURE_CPU,
      "/proc/uptime": fx.UPTIME,
      "/proc/net/tcp": fx.NET_TCP,
      "/proc/net/tcp6": fx.NET_TCP6,
      "/proc/1458488/stat": fx.PID_STAT_DAEMON,
      "/proc/1458488/status": fx.PID_STATUS_DAEMON,
      "/proc/1458488/cmdline": Buffer.from("paseo\0daemon\0"),
      "/proc/9/stat": "9 (sshd) S 1 9 9 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 100 0 5 0",
      "/proc/9/status": fx.PID_STATUS_ROOT,
      "/proc/9/cmdline": Buffer.from("sshd\0"),
    },
    {
      "/proc": ["1458488", "9", "self", "cpuinfo"],
      "/proc/1458488/fd": ["0", "1", "2", "7"],
    },
    {
      "/proc/1458488/cwd": "/home/paseo",
      "/proc/1458488/fd/7": "socket:[8233008]",
      "/proc/1458488/fd/1": "/dev/null",
    },
  );
  const adapter = new LinuxAdapter({ fs, clockTicks: 100, pageSize: 4096 });

  it("samples the system from procfs", async () => {
    const sample = await adapter.sampleSystem();
    expect(sample.psiCpuSome10).toBe(3.68);
    expect(sample.psiMemorySome10).toBeNull();
    expect(sample.memoryTotalBytes).toBe(32864204 * 1024);
    expect(sample.uptimeSeconds).toBe(190635);
    expect(sample.load1).toBe(2.04);
  });

  it("returns only same-user processes with derived fields", async () => {
    const { processes } = await adapter.sampleProcesses(1000);
    expect(processes.map((p) => p.pid)).toEqual([1458488]);
    const [daemon] = processes;
    expect(daemon!.comm).toBe("Paseo Daemon");
    expect(daemon!.argv).toEqual(["paseo", "daemon"]);
    expect(daemon!.cpuSeconds).toBeCloseTo((96763 + 79197) / 100, 5);
    expect(daemon!.startId).toBe("15076589");
    expect(daemon!.rssBytes).toBe(496616 * 1024);
    expect(daemon!.ageSeconds).toBeCloseTo(190635 - 15076589 / 100, 3);
    expect(daemon!.cwd).toBe("/home/paseo");
  });

  it("maps listening socket inodes to pids and ports", async () => {
    const result = await adapter.listeningPorts([1458488]);
    expect(result.ports.get(1458488)).toEqual([0xa3c3]);
    expect(result.warnings).toEqual([]);
  });

  it("reads identity and returns null for missing pids", async () => {
    const identity = await adapter.readIdentity(1458488);
    expect(identity).toMatchObject({ pid: 1458488, ppid: 1458477, uid: 1000, startId: "15076589", state: "sleeping" });
    expect(identity!.argvHash).toHaveLength(64);
    expect(await adapter.readIdentity(424242)).toBeNull();
  });

  it("reads the whole tree including other users", async () => {
    const tree = await adapter.readTree();
    expect(tree).toEqual(expect.arrayContaining([{ pid: 1458488, ppid: 1458477, uid: 1000 }, { pid: 9, ppid: 1, uid: 0 }]));
  });
});
