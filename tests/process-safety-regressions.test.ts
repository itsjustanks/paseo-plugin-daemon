import { describe, expect, it, vi } from "vitest";
import { ProcessGuard } from "../server/safety";
import { hashArgv } from "../server/redaction";
import { parseMacAgentIds, parseLinuxAgentId } from "../server/process-tags";
import { LinuxAdapter, MAX_ENVIRON_BYTES, PROC_READ_CONCURRENCY, type LinuxFs } from "../server/linux";
import { DarwinAdapter, PS_FORMAT } from "../server/darwin";
import { FakeAdapter, FakeClock, proc } from "./fake-adapter";

function setup() {
  const adapter = new FakeAdapter();
  adapter.processes = [proc({ pid: 42, argv: ["/bin/sleep", "60"] }), proc({ pid: 43, ppid: 42 }), proc({ pid: 44, ppid: 43 })];
  const kill = vi.fn();
  const authorize = vi.fn(async (_pid: number, _descendant: boolean, _verifiedOnly: boolean) => true);
  const guard = new ProcessGuard({ adapter, uid: 1000, selfPid: 200, alwaysProtected: [100], clock: new FakeClock(), kill, authorizeProcess: authorize });
  const token = guard.mint(adapter.processes[0]!, hashArgv(adapter.processes[0]!.argv));
  return { adapter, kill, authorize, guard, token };
}

describe("fresh signal safety", () => {
  it.each([false, true])("refuses PID reuse or executable substitution during an awaited tree read (reuse=%s)", async (reuse) => {
    const { adapter, guard, kill, token } = setup();
    const original = adapter.readTree.bind(adapter);
    adapter.readTree = async () => {
      const tree = await original();
      adapter.processes[0] = { ...adapter.processes[0]!, executable: "/opt/postgresql/bin/postgres", comm: "worker", ...(reuse ? { startId: "new-pid-incarnation" } : {}) };
      return tree;
    };
    expect((await guard.stop(token)).ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(["executable", "argv"])("leaves a child and its subtree alone when its %s changes after planning", async (field) => {
    const { adapter, guard, kill, token } = setup();
    kill.mockImplementation((pid) => {
      if (pid === 42) {
        if (field === "executable") adapter.processes[1]!.executable = "/opt/postgresql/bin/postgres";
        else adapter.processes[1]!.argv = ["node", "/opt/@getpaseo/server/plugin-process.js"];
      }
    });
    expect((await guard.stop(token)).signaledCount).toBe(1);
    expect(kill.mock.calls).toEqual([[42, "SIGTERM"]]);
  });

  it("does not force a child that execs during asynchronous authorization", async () => {
    const { adapter, guard, kill, authorize, token } = setup();
    const stopped = await guard.stopTree(token);
    expect(stopped.children).toHaveLength(2);
    kill.mockClear();
    authorize.mockImplementation(async (pid) => {
      if (pid === 43) adapter.processes[1]!.executable = "/opt/postgresql/bin/postgres";
      return true;
    });
    expect(await guard.forceSurvivors(stopped.children)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("rechecks after asynchronous policy and has an identity read immediately before every signal", async () => {
    const { adapter, guard, kill, authorize, token } = setup();
    const events: string[] = [];
    const original = adapter.readIdentity.bind(adapter);
    adapter.readIdentity = async (pid) => { const value = await original(pid); events.push(`identity:${pid}`); return value; };
    authorize.mockImplementation(async (pid) => { await Promise.resolve(); events.push(`policy:${pid}`); return true; });
    kill.mockImplementation((pid) => { expect(events.at(-1)).toBe(`identity:${pid}`); events.push(`signal:${pid}`); });
    expect((await guard.stop(token)).signaledCount).toBe(3);
    expect((await guard.forceStop(token)).signaledCount).toBe(3);
    expect(kill).toHaveBeenCalledTimes(6);
  });

  it.each(["/opt/postgresql/bin/postgres", "/usr/local/bin/redis-server", "/usr/local/bin/sshd"])("protects a renamed %s and its worker descendants", async (executable) => {
    const { adapter, guard, kill, token } = setup();
    adapter.processes[0]!.executable = executable;
    adapter.processes[0]!.comm = "worker";
    const worker = adapter.processes[1]!;
    expect((await guard.stop(guard.mint(worker, hashArgv(worker.argv)))).ok).toBe(false);
    expect((await guard.stop(token)).ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("tags are labels, not argv claims", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("ignores argv tags, malformed prefix matches and environment lookalikes", () => {
    const args = `42 echo PASEO_AGENT_ID=${id}\n43 /bin/sleep 60\n44 /bin/sleep 60\n45 /bin/sleep 60\n46 echo  repeated   spaces`;
    const env = `42 echo PASEO_AGENT_ID=${id} PATH=/bin\n43 /bin/sleep 600 PASEO_AGENT_ID=${id}\n44 /bin/sleep 60 X_PASEO_AGENT_ID=${id}\n45 /bin/sleep 60 PASEO_AGENT_ID=${id}\n46 echo repeated spaces PASEO_AGENT_ID=${id}`;
    expect([...parseMacAgentIds(args, env)]).toEqual([[45, id]]);
    expect(parseLinuxAgentId(`argv=PASEO_AGENT_ID=${id}\0`)).toBeNull();
  });
  it("never attributes a tag past 64 KB", () => {
    expect(parseMacAgentIds("42 sleep", `42 sleep LONG=${"a".repeat(MAX_ENVIRON_BYTES)} PASEO_AGENT_ID=${id}`).size).toBe(0);
  });
});

describe("bounded Linux environment sampling", () => {
  it("caps reads at 64 KB, uses at most 16 workers and returns by its sample deadline", async () => {
    let active = 0, peak = 0;
    const limits: Array<number | undefined> = [];
    const fs: LinuxFs = {
      readdir: async () => Array.from({ length: 100 }, (_, i) => String(i + 10)),
      readlink: async () => "/usr/local/bin/node",
      readFile: async (path) => path.endsWith("status") ? "Uid: 1000\n" : path.endsWith("stat") ? `${path.split("/")[2]} (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123 0 1` : "1000 0",
      readFileBuffer: async (path, limit) => {
        if (!path.endsWith("environ")) return Buffer.from("node\0");
        limits.push(limit); active++; peak = Math.max(peak, active);
        // Deliberately never answers, like an unreadable/stalled procfs entry.
        return new Promise<Buffer>(() => {});
      },
    };
    const start = performance.now();
    const result = await new LinuxAdapter({ fs, clockTicks: 100, sampleMs: 30 }).sampleProcesses(1000);
    expect(result.warnings.join(" ")).toContain("deadline exceeded");
    expect(performance.now() - start).toBeLessThan(1000);
    expect(peak).toBe(PROC_READ_CONCURRENCY);
    expect(limits).toEqual(Array(PROC_READ_CONCURRENCY).fill(MAX_ENVIRON_BYTES));
  });
});


describe("macOS executable identity", () => {
  it("uses the OS comm path rather than a renamed argv", async () => {
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === "ps" && args.includes("comm=")) return "/opt/postgresql/bin/postgres\n";
      if (file === "ps" && args.includes(PS_FORMAT)) return "42 1 1000 S 100 0:00 0:01 Sat Oct 10 12:00:00 2026 worker";
      return "";
    });
    const identity = await new DarwinAdapter({ exec }).readIdentity(42);
    expect(identity).toMatchObject({ executable: "/opt/postgresql/bin/postgres", argv: ["worker"] });
  });
  it("resolves short comm names through lsof, never argv", async () => {
    const exec = async (file: string, args: readonly string[]) => {
      if (file === "ps" && args.includes("comm=")) return "postgres\n";
      if (file === "ps" && args.includes(PS_FORMAT)) return "42 1 1000 S 100 0:00 0:01 Sat Oct 10 12:00:00 2026 worker";
      if (file === "lsof" && args.includes("txt")) return "p42\nn/opt/postgresql/bin/postgres\nn/usr/lib/dyld";
      return "";
    };
    expect(await new DarwinAdapter({ exec }).readIdentity(42)).toMatchObject({ executable: "/opt/postgresql/bin/postgres", argv: ["worker"] });
  });
  it("bounds an entire Mac sample when ps stalls", async () => {
    const result = await new DarwinAdapter({ sampleMs: 30, exec: async () => new Promise<string>(() => {}) }).sampleProcesses(1000);
    expect(result).toMatchObject({ processes: [], warnings: [expect.stringContaining("deadline exceeded")] });
  });
});


describe("macOS exec race", () => {
  it.each(["comm", "lsof"])("refuses exec into sshd during the macOS cwd lookup (%s)", async (source) => {
    let executable = "/bin/sleep", armed = false;
    const exec = async (file: string, args: readonly string[]) => {
      if (file === "ps" && args.includes("comm=")) return source === "comm" ? executable : "worker";
      if (file === "ps" && args.includes(PS_FORMAT)) return "42 1 1000 S 100 0:00 0:01 Sat Oct 10 12:00:00 2026 /bin/sleep 60";
      if (file === "lsof" && args.includes("txt")) return `p42\nn${executable}`;
      if (file === "lsof" && args.includes("cwd")) { if (armed) executable = "/usr/sbin/sshd"; return "p42\nn/tmp"; }
      return "";
    };
    const adapter = new DarwinAdapter({ exec });
    const initial = (await adapter.readIdentity(42))!;
    expect(initial.executable).toBe("/bin/sleep");
    const kill = vi.fn();
    const guard = new ProcessGuard({ adapter, uid: 1000, selfPid: 200, kill });
    const token = guard.mint(initial, initial.argvHash);
    armed = true;
    expect((await guard.stop(token)).ok).toBe(false);
    expect(executable).toBe("/usr/sbin/sshd");
    expect(kill).not.toHaveBeenCalled();
    executable = "/bin/sleep";
    await expect(adapter.readIdentity(42)).rejects.toThrow("process identity changed during read");
  });
});
