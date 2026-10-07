import { describe, expect, it } from "vitest";
import { parseCgroupPath, parseCpuMax, parseLimit, parsePsi, readCgroup, workingSet } from "../server/cgroup";
import { classifyContainerMemory } from "../server/heuristics";

const GB = 1024 ** 3;
/** A filesystem holding exactly these files; anything else is ENOENT. */
const fs = (files: Record<string, string>) => ({
  readFile: async (path: string) => {
    if (path in files) return files[path]!;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
});

describe("cgroup limits", () => {
  it("parses the files a Docker container exposes", () => {
    expect(parseCgroupPath("0::/\n")).toBe("/");
    expect(parseCgroupPath("12:memory:/docker/abc\n0::/system.slice/docker-abc.scope\n")).toBe("/system.slice/docker-abc.scope");
    expect(parseCgroupPath("12:memory:/docker/abc\n")).toBeNull();
    expect(parseLimit("7872708608\n")).toBe(7872708608);
    expect(parseLimit("max\n")).toBeNull();
    expect(parseLimit("9223372036854771712")).toBeNull();
    expect(parseCpuMax("max 100000")).toBeNull();
    expect(parseCpuMax("200000 100000")).toBe(2);
    expect(parsePsi("some avg10=12.50 avg60=0.00 avg300=0.00 total=130\nfull avg10=0.00")).toBe(12.5);
    expect(workingSet(2482847744, 1376440320)).toBe(1106407424);
    expect(workingSet(100, 500)).toBe(0);
  });

  it("reads a namespaced v2 container (the fleet: 7.3 GB limit on a 64 GB host, no CPU limit)", async () => {
    const sample = await readCgroup(64 * GB, fs({
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.current": "2482847744\n",
      "/sys/fs/cgroup/memory.max": "7872708608\n",
      "/sys/fs/cgroup/memory.stat": "anon 1024200704\nfile 1376530432\ninactive_file 1376440320\nactive_file 90112\n",
      "/sys/fs/cgroup/cpu.max": "max 100000\n",
      "/sys/fs/cgroup/cpu.stat": "usage_usec 3229858957\nuser_usec 2329037401\n",
      "/sys/fs/cgroup/memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=130\n",
      "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    }));
    expect(sample).toEqual({ memoryLimitBytes: 7872708608, memoryUsageBytes: 2482847744, memoryWorkingSetBytes: 1106407424, cpuLimitCores: null, cpuUsageUsec: 3229858957, psiMemorySome10: 0, psiMemoryFull10: null, psiCpuSome10: null, oomKills: 0, version: 2 });
  });

  it("treats a limit at or above the host's memory as no limit, falls back to v1, and is null without cgroups", async () => {
    const unlimited = await readCgroup(8 * GB, fs({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.current": "100", "/sys/fs/cgroup/memory.max": String(16 * GB) }));
    expect(unlimited?.memoryLimitBytes).toBeNull();
    const v1 = await readCgroup(64 * GB, fs({
      "/proc/self/cgroup": "12:memory:/docker/abc\n",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(3 * GB),
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(4 * GB),
      "/sys/fs/cgroup/memory/memory.stat": `total_inactive_file ${GB}\n`,
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    }));
    expect(v1).toMatchObject({ version: 1, memoryLimitBytes: 4 * GB, memoryWorkingSetBytes: 2 * GB, cpuLimitCores: 1.5 });
    expect(await readCgroup(64 * GB, fs({}))).toBeNull();
    expect(await readCgroup(64 * GB, fs({ "/proc/self/cgroup": "0::/\n" }))).toBeNull();
  });

  it("judges pressure against the limit, in plain words", () => {
    expect(classifyContainerMemory({ limitBytes: 8 * GB, workingSetBytes: 4 * GB, psiSome10: 0, newOomKills: 0 })).toEqual({ pressure: "normal", reasons: [] });
    expect(classifyContainerMemory({ limitBytes: 8 * GB, workingSetBytes: 6.6 * GB, psiSome10: 0, newOomKills: 0 })).toEqual({ pressure: "high", reasons: ["using 83% of this container's 8.0 GB memory limit"] });
    expect(classifyContainerMemory({ limitBytes: 8 * GB, workingSetBytes: 7.5 * GB, psiSome10: null, newOomKills: null }).pressure).toBe("critical");
    expect(classifyContainerMemory({ limitBytes: null, workingSetBytes: 7.5 * GB, psiSome10: 30, newOomKills: null })).toMatchObject({ pressure: "critical", reasons: ["processes waited on memory 30% of the last 10 seconds"] });
    expect(classifyContainerMemory({ limitBytes: 8 * GB, workingSetBytes: GB, psiSome10: 0, newOomKills: 1 })).toEqual({ pressure: "critical", reasons: ["the kernel stopped a process for running out of memory"] });
  });
});
