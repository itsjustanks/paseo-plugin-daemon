import { describe, expect, it } from "vitest";
import { classifyCpuPressure, classifyMemoryPressure, classifyProcessImpact, detectService, formatBytes } from "../heuristics.server";

describe("system pressure", () => {
  it("is normal on an idle box", () => {
    const result = classifyCpuPressure({ percent: 12, sustainedPercent: 10, sustainedSeconds: 0, load1: 0.5, cores: 8, psiSome10: 1 });
    expect(result).toEqual({ pressure: "normal", reasons: [] });
  });

  it("escalates to critical on sustained saturation with a reason", () => {
    const result = classifyCpuPressure({ percent: 99, sustainedPercent: 97, sustainedSeconds: 14, load1: 3, cores: 8, psiSome10: null });
    expect(result.pressure).toBe("critical");
    expect(result.reasons).toContain("CPU 97% for 14s");
  });

  it("uses PSI and load per core when available", () => {
    expect(classifyCpuPressure({ percent: 40, sustainedPercent: 40, sustainedSeconds: 0, load1: 9, cores: 8, psiSome10: null }).pressure).toBe("high");
    expect(classifyCpuPressure({ percent: 40, sustainedPercent: 40, sustainedSeconds: 0, load1: 1, cores: 8, psiSome10: 45 }).pressure).toBe("critical");
  });

  it("memory pressure explains available ratio, swap, PSI and kernel signal", () => {
    const gb = 1024 ** 3;
    expect(classifyMemoryPressure({ totalBytes: 32 * gb, availableBytes: 20 * gb, swapTotalBytes: 0, swapUsedBytes: 0, swapGrowthBytes: null, psiSome10: null, pressureSignal: null })).toEqual({ pressure: "normal", reasons: [] });
    const critical = classifyMemoryPressure({ totalBytes: 32 * gb, availableBytes: 1 * gb, swapTotalBytes: 8 * gb, swapUsedBytes: 5 * gb, swapGrowthBytes: 200 * 1024 ** 2, psiSome10: null, pressureSignal: null });
    expect(critical.pressure).toBe("critical");
    expect(critical.reasons).toContain("3% memory available");
    expect(critical.reasons).toContain("swap +200 MB recently");
    expect(classifyMemoryPressure({ totalBytes: 32 * gb, availableBytes: 20 * gb, swapTotalBytes: 0, swapUsedBytes: 0, swapGrowthBytes: null, psiSome10: null, pressureSignal: "critical" }).pressure).toBe("critical");
    expect(classifyMemoryPressure({ totalBytes: 32 * gb, availableBytes: 20 * gb, swapTotalBytes: 0, swapUsedBytes: 0, swapGrowthBytes: null, psiSome10: 8, pressureSignal: null }).pressure).toBe("high");
  });
});

describe("process impact", () => {
  const base = { cpuPercent: 2, cpuSustainedPercent: 2, cpuSustainedSeconds: 0, memoryPercent: 0.5, rssGrowthBytes: null, rssWindowSeconds: 0, cpuRank: 5, memoryRank: 5, systemCpuPressure: "normal" as const, systemMemoryPressure: "normal" as const };

  it("labels idle and normal", () => {
    expect(classifyProcessImpact({ ...base, cpuPercent: 0.2, cpuSustainedPercent: 0.1 }).impact).toBe("idle");
    expect(classifyProcessImpact(base).impact).toBe("normal");
  });

  it("labels high with measured reasons", () => {
    const result = classifyProcessImpact({ ...base, cpuPercent: 96, cpuSustainedPercent: 96, cpuSustainedSeconds: 14 });
    expect(result.impact).toBe("high");
    expect(result.reasons).toEqual(["CPU 96% for 14s"]);
    const mem = classifyProcessImpact({ ...base, memoryPercent: 12 });
    expect(mem.reasons).toEqual(["12% of memory"]);
    const growth = classifyProcessImpact({ ...base, rssGrowthBytes: 180 * 1024 ** 2, rssWindowSeconds: 60 });
    expect(growth.reasons).toEqual(["RSS +180 MB in 60s"]);
  });

  it("only calls a process a pressure driver when the system is under matching pressure", () => {
    const hot = { ...base, cpuPercent: 96, cpuSustainedPercent: 96, cpuSustainedSeconds: 14, cpuRank: 0 };
    expect(classifyProcessImpact(hot).impact).toBe("high");
    const driver = classifyProcessImpact({ ...hot, systemCpuPressure: "critical" });
    expect(driver.impact).toBe("pressure-driver");
    expect(driver.reasons).toContain("top CPU user during CPU pressure");
    // Memory pressure does not make a CPU hog a driver.
    expect(classifyProcessImpact({ ...hot, systemMemoryPressure: "critical" }).impact).toBe("high");
    // A low-rank process under pressure is still just high.
    expect(classifyProcessImpact({ ...hot, cpuRank: 4, systemCpuPressure: "critical" }).impact).toBe("high");
  });
});

describe("service detection", () => {
  it("recognises common dev servers when listening", () => {
    const vite = detectService(["node", "/app/node_modules/.bin/vite", "--port", "5173"], [5173]);
    expect(vite).toMatchObject({ kind: "dev-server", confidence: "high", label: "Vite" });
    expect(vite!.reasons).toContain("listening on :5173");
    expect(detectService(["npm", "run", "dev"], [3000])!.label).toBe("Package script");
    expect(detectService(["pnpm", "dev"], [3000])!.label).toBe("Package script");
    expect(detectService(["python3", "-m", "http.server", "8000"], [8000])!.label).toBe("Python http.server");
    expect(detectService(["uvicorn", "app:app", "--reload"], [8000])!.label).toBe("Uvicorn");
    expect(detectService(["next", "dev"], [3000])!.label).toBe("Next.js");
  });

  it("labels unknown listeners honestly and never calls them dev servers", () => {
    const listener = detectService(["/usr/bin/some-daemon", "--serve"], [9000]);
    expect(listener).toMatchObject({ kind: "listener", label: "Listening Process", confidence: "medium" });
    expect(detectService(["bash"], [])).toBeNull();
  });

  it("reduces confidence for a dev-server pattern with no port yet", () => {
    const booting = detectService(["vite"], []);
    expect(booting).toMatchObject({ kind: "dev-server", confidence: "medium" });
    expect(booting!.reasons).toContain("no listening port yet");
    expect(detectService(["go", "run", "."], [])!.confidence).toBe("low");
  });

  it("does not match npm scripts that are not dev-like", () => {
    expect(detectService(["npm", "run", "test"], [])).toBeNull();
    expect(detectService(["npm", "install"], [])).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(180 * 1024 ** 2)).toBe("180 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});
