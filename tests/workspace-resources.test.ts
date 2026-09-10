import { describe, expect, it } from "vitest";
import { EMPTY_ROLLUP, processIdentity, rollupResources } from "../shared/workspace-resources";

const host = { cpu: { percent: 40, cores: 8 }, memory: { totalBytes: 16e9, usedBytes: 8e9 } };
const row = (pid: number, cpuPercent: number | null | undefined, rssBytes: number | null | undefined, name = `proc-${pid}`) => ({ pid, name, cpuPercent, rssBytes });

describe("rollupResources", () => {
  it("returns the empty rollup for no processes, with every share unknown", () => {
    expect(rollupResources([], host)).toBe(EMPTY_ROLLUP);
    expect(EMPTY_ROLLUP).toMatchObject({ processCount: 0, cpuPercent: null, rssBytes: null, cpuOfHostPercent: null, memoryOfHostPercent: null });
  });
  it("reports a single process against the host in core units and bytes", () => {
    // 160% of one core on 8 cores is 20% of the machine, which is half of its 40% load.
    expect(rollupResources([row(1, 160, 2e9)], host)).toEqual({
      processCount: 1, cpuPercent: 160, cpuSampled: 1, cpuOfHostPercent: 20, cpuOfHostLoadPercent: 50,
      rssBytes: 2e9, memorySampled: 1, memoryOfHostPercent: 12.5, memoryOfHostUsedPercent: 25,
    });
  });
  it("counts a process that appears in both snapshot lists once", () => {
    const service = row(1, 50, 1e9, "next");
    const duplicate = { ...service, cpuPercent: 55 };
    const other = row(2, 10, 5e8);
    const rollup = rollupResources([service, other, duplicate], host);
    expect(rollup.processCount).toBe(2);
    expect(rollup.cpuPercent).toBe(60);
    expect(rollup.rssBytes).toBe(1.5e9);
    // Same PID, different program: two rows.
    expect(rollupResources([row(1, 1, 1, "a"), row(1, 1, 1, "b")], host).processCount).toBe(2);
    expect(processIdentity({ pid: 7, name: "vite" })).toBe("7:vite");
  });
  it("skips missing or unmeasured metrics instead of counting them as zero", () => {
    const sampling = rollupResources([row(1, null, 3e8), row(2, undefined, undefined), row(3, Number.NaN, -1)], host);
    expect(sampling).toMatchObject({ processCount: 3, cpuPercent: null, cpuSampled: 0, cpuOfHostPercent: null, cpuOfHostLoadPercent: null, rssBytes: 3e8, memorySampled: 1, memoryOfHostPercent: 1.9 });
    const measured = rollupResources([row(1, 12.34, null)], host);
    expect(measured).toMatchObject({ cpuPercent: 12.3, cpuSampled: 1, rssBytes: null, memorySampled: 0, memoryOfHostPercent: null, memoryOfHostUsedPercent: null });
  });
  it("gives absolute totals but no shares when the host totals are missing or zero", () => {
    const rows = [row(1, 80, 1e9), row(2, 20, 1e9)];
    const noHost = rollupResources(rows, null);
    expect(noHost).toMatchObject({ cpuPercent: 100, rssBytes: 2e9, cpuOfHostPercent: null, cpuOfHostLoadPercent: null, memoryOfHostPercent: null, memoryOfHostUsedPercent: null });
    const zeroed = rollupResources(rows, { cpu: { percent: null, cores: 0 }, memory: { totalBytes: 0, usedBytes: 0 } });
    expect(zeroed).toMatchObject({ cpuOfHostPercent: null, cpuOfHostLoadPercent: null, memoryOfHostPercent: null, memoryOfHostUsedPercent: null });
    // Cores known but host load still sampling: capacity share only.
    const sampling = rollupResources(rows, { cpu: { percent: null, cores: 4 }, memory: { totalBytes: 4e9, usedBytes: 0 } });
    expect(sampling).toMatchObject({ cpuOfHostPercent: 25, cpuOfHostLoadPercent: null, memoryOfHostPercent: 50, memoryOfHostUsedPercent: null });
  });
  it("clamps shares to 100 when sampling jitter puts the workspace above the host", () => {
    const rollup = rollupResources([row(1, 900, 20e9)], host);
    expect(rollup.cpuOfHostPercent).toBe(100);
    expect(rollup.cpuOfHostLoadPercent).toBe(100);
    expect(rollup.memoryOfHostPercent).toBe(100);
    expect(rollup.memoryOfHostUsedPercent).toBe(100);
  });
});
