import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLog } from "../server/action-log";
import { createRuntime, unsupportedProcesses } from "../server/runtime";
import { ProcessReportSchema } from "../shared/processes";
import { HOSTS_SETTINGS_DEFAULTS } from "../shared/settings";

let dir: string | null = null;
const previousHome = process.env.PASEO_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("runtime wiring", () => {
  it("reads this machine's processes through the shared collector, and logs the monitor's stop attempts", async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-link-runtime-"));
    // Pairings, profiles and state live under PASEO_HOME: never the real one in a test.
    process.env.PASEO_HOME = dir;
    const log = new ActionLog(join(dir, "actions.jsonl"), () => {});
    const runtime = createRuntime({ log, readSettings: async () => ({ ...HOSTS_SETTINGS_DEFAULTS, maxHeavyJobs: 6 }) });
    try {
      const report = ProcessReportSchema.parse(await runtime.processes.report({ limit: 5 }));
      expect(report.supported).toBe(true);
      expect(report.heavyJobs.limit).toBe(6);
      expect(report.total).toBeGreaterThan(0);
      // Without a Paseo session nothing is verified, and nothing outside Paseo's tree can be stopped.
      expect(report.projectsVerified).toBe(false);
      const denied = await runtime.monitor.stop({ token: "not-a-token" });
      expect(denied.status).toBe("denied");
      const [entry] = await log.recent(1);
      expect(entry).toMatchObject({ action: "stop", source: "monitor", status: "denied", name: "Dev server" });
      expect(typeof runtime.watch.check).toBe("function");
    } finally {
      runtime.processes.close();
      await Promise.all([runtime.links.close(), runtime.peers.close(), runtime.transfers.close()]);
    }
  });

  it("gives an honest empty report, and refuses actions, where processes can't be read", async () => {
    const processes = unsupportedProcesses();
    const report = ProcessReportSchema.parse(await processes.report());
    expect(report).toMatchObject({ supported: false, platform: "unsupported", processes: [] });
    expect(report.warnings[0]).toMatch(/Linux and macOS/);
    await expect(processes.preview()).rejects.toThrow(/Linux and macOS/);
    await expect(processes.stop()).rejects.toThrow(/Linux and macOS/);
    processes.close();
  });
});
