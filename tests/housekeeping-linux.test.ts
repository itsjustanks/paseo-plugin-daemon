import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { takeLock } from "../server/housekeeping-lock";
import { ProcReader } from "../server/housekeeping-procs";
import { Housekeeper } from "../server/housekeeping";
import { profileInUse } from "../server/housekeeping-plan";
import { HOUSEKEEPING_DEFAULTS } from "../shared/housekeeping";
import { NO_RUNS } from "../server/housekeeping-log";

// No real housekeeping effects on macOS. Linux exercises only a disposable child and private fixture files.
describe.runIf(process.platform === "linux")("housekeeping disposable Linux integration", () => {
  it("checks a real full proc snapshot under the private-profile same-UID boundary", async () => {
    const uid = process.getuid!(), reader = new ProcReader(uid), table = await reader.scan();
    const privatePath = "/tmp/agent-browser-chrome-00000000-0000-4000-8000-000000000099";
    // Root init and foreign processes alone never block a private owned profile.
    const own = { ...table, processes: table.processes.filter((p) => p.uid === uid) };
    expect(profileInUse(table, privatePath, { uid, privateOwned: true })).toBe(profileInUse(own, privatePath));
  });
  it("holds the real flock across a pass, then releases it; renices only its own child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hosts-hk-linux-")), uid = process.getuid!(), signal = new AbortController().signal;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "bin/tsc"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const reader = new ProcReader(uid), before = await reader.read(child.pid!); expect(before).not.toBeNull();
      const path = join(dir, "lock"), held = await takeLock(path, uid, signal); expect(held.outcome.kind).toBe("held");
      expect((await takeLock(path, uid, signal)).outcome.kind).toBe("busy"); await held.release();
      const again = await takeLock(path, uid, signal); expect(again.outcome.kind).toBe("held"); await again.release();
      await mkdir(join(dir, "helpers")); for (const name of ["gate.sh", "heavy-run.sh"]) await writeFile(join(dir, "helpers", name), "existing");
      const touched: number[] = [];
      const hk = new Housekeeper({ platform: "linux", uid, selfPid: process.pid, readSettings: async () => ({ ...HOUSEKEEPING_DEFAULTS, dryRun: false }),
        procs: { read: (pid) => reader.read(pid), scan: async () => ({ complete: true, processes: [(await reader.read(child.pid!))!] }) }, owners: { lookup: async () => new Map() }, lock: (s) => takeLock(path, uid, s),
        log: { append: async () => {}, recent: async () => [], runs: async () => ({ ...NO_RUNS }), saveRuns: async () => {} }, workspaces: async () => [], places: { home: join(dir, "home"), paseoHome: join(dir, "paseo"), stateDir: join(dir, "state"), tmpRoots: [] }, helpersDir: join(dir, "helpers"),
        removeProfile: async () => { throw new Error("unexpected profile"); }, kill: () => { throw new Error("unexpected signal"); }, renice: (pid, nice) => { expect(pid).toBe(child.pid); touched.push(pid); setPriority(pid, nice); },
      });
      await hk.tick(); await hk.close(); expect(touched).toEqual([child.pid]); expect(getPriority(child.pid!)).toBeGreaterThanOrEqual(10);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exit; }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
