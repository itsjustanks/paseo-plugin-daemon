import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DarwinAdapter } from "../server/darwin";
import { createMonitorHandlers } from "../server/handlers";
import { ProjectScope } from "../server/scope";

// Explicit opt-in: signals only new orphaned fixtures this test launches.
// Run on macOS with HOSTS_SYNTHETIC_STOP_TEST=1 npx vitest run tests/dev-server-stop-live.test.ts.
const live = process.platform === "darwin" && process.env.HOSTS_SYNTHETIC_STOP_TEST === "1";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("owned macOS listeners through the real Stop guard", () => {
  it.each([
    ["Python http.server", "python3", ["-m", "http.server", "0", "--bind", "127.0.0.1"]],
    ["node listener", process.execPath, ["-e", "require('node:net').createServer().listen(0,'127.0.0.1')"]],
    ["Vite", process.execPath, [join(realpathSync("node_modules"), "vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "0"]],
  ])("previews and stops only its synthetic %s", async (name, program, args) => {
    // A short-lived launcher leaves the child under launchd, as an existing
    // detached server would be. It reports only the PID of the child it owns.
    const launcher = "const{spawn}=require('node:child_process');const p=spawn(process.argv[1],JSON.parse(process.argv[2]),{cwd:process.argv[3],detached:true,stdio:'ignore'});p.on('spawn',()=>{console.log(p.pid);p.unref()});p.on('error',()=>process.exit(1));";
    const pid = Number(execFileSync(process.execPath, ["-e", launcher, program, JSON.stringify(args), tmpdir()], { encoding: "utf8", timeout: 5000 }).trim());
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    const adapter = new DarwinAdapter();
    const birth = (await adapter.readTree()).find((row) => row.pid === pid);
    let original: Awaited<ReturnType<DarwinAdapter["readIdentity"]>> = null;
    try {
      // Read identity from the owned PID before doing anything that can signal it.
      for (let attempt = 0; attempt < 30 && !original; attempt++) {
        original = await adapter.readIdentity(pid).catch(() => null);
        if (!original) await delay(100);
      }
      expect(original).not.toBeNull();
      let ports: number[] = [];
      for (let attempt = 0; attempt < 40 && !ports.length; attempt++) {
        ports = (await adapter.freshListeningEndpoints(pid)).map((entry) => entry.port);
        if (!ports.length) await delay(100);
      }
      expect(ports.length).toBeGreaterThan(0);
      // Limit inventory to our fixture; action identity and ancestry use the
      // real adapter unchanged, including the final identity read before kill.
      const sample = adapter.sampleProcesses.bind(adapter);
      adapter.sampleProcesses = async (uid) => {
        const result = await sample(uid);
        return { ...result, processes: result.processes.filter((row) => row.pid === pid) };
      };
      const scope = new ProjectScope(); // No registry session and no chat.
      const monitor = createMonitorHandlers({ adapter, scope, uid: process.getuid!(), selfPid: process.pid, parentPid: process.ppid });
      const row = (await monitor.snapshot({})).services.find((entry) => entry.pid === pid)!;
      expect(row).toMatchObject({ actionable: true, project: null });
      expect(row.ports).toEqual(ports);
      const plan = await monitor.internals!.manager.preview([row.actionToken!]);
      expect(plan.targets[0]).toMatchObject({ ok: true, outsidePaseo: true, children: [] });
      const result = await monitor.stop({ token: row.actionToken! });
      expect(result).toMatchObject({ ok: true, status: "signaled", pid, signaledCount: 1 });
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!(await adapter.readTree()).some((entry) => entry.pid === pid)) break;
        await delay(100);
      }
      // An unreadable identity is never proof of exit; require the PID to
      // disappear from a successful fresh process-table read.
      expect((await adapter.readTree()).some((entry) => entry.pid === pid)).toBe(false);
      console.log(JSON.stringify({ pid, program: name, ports, ownership: "owned synthetic, outside Paseo", reason: "preview accepted; SIGTERM verified; exited" }));
    } finally {
      // Cleanup may touch only the fixture's exact original incarnation.
      const fresh = (await adapter.readTree()).find((entry) => entry.pid === pid);
      if (fresh && birth && fresh.uid === birth.uid && fresh.startId === birth.startId) process.kill(pid, "SIGTERM");
    }
  }, 30000);
});
