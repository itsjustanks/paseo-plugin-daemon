import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecoveryDetailsSchema, recoveryActionLabel, recoveryWarning } from "../../shared/recovery";
import { remoteCommand, shellQuote, sshArgs } from "../../server/recovery/commands";
import { fixture } from "./fixtures";
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function profile() { const f = fixture(); fixtures.push(f); return { f, p: f.save() }; }

describe("fixed recovery commands", () => {
  it.each(["-oProxyCommand=evil", "a; reboot", "a$(reboot)", "a`reboot`", "a\nreboot", "ssh://host", "user@host", "host/path"])("rejects hostname injection %s", hostname => {
    expect(RecoveryDetailsSchema.safeParse({ name: "Fixture", hostname, preset: "docker", auth: { kind: "config" } }).success).toBe(false);
  });
  it.each(["container", "unit", "user"] as const)("validates %s again at command construction", field => {
    const { p } = profile(); expect(() => remoteCommand({ ...p, [field]: "-x; reboot" }, "restart")).toThrow();
  });
  it("quotes shell metacharacters literally", () => {
    const literal = "a' ; $(printf injected) `printf wrong` \n end";
    expect(execFileSync("sh", ["-c", `printf '%s' ${shellQuote(literal)}`], { encoding: "utf8" })).toBe(literal);
  });
  it("uses strict non-interactive SSH options and one remote command", () => {
    const { p } = profile(); const path = "/home/fixture/.ssh/key with ' spaces";
    const args = sshArgs({ ...p, port: 2222, user: "paseo", auth: { kind: "identity", path } }, remoteCommand(p, "start"));
    for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=8", "ConnectionAttempts=1", "ControlMaster=no", "ControlPath=none", "ForwardAgent=no", "ClearAllForwardings=yes", "RequestTTY=no", "PermitLocalCommand=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "IdentitiesOnly=yes"]) expect(args).toContain(option);
    expect(args.slice(-3)).toEqual(["--", p.hostname, "'docker' 'start' '--' 'paseo-dev-stack-paseo'"]);
    expect(args[args.indexOf("-i") + 1]).toBe(path); expect(args).toContain("2222");
    const config = sshArgs(p, "true"); for (const option of ["-p", "-l", "-i"]) expect(config).not.toContain(option);
  });
  it("separates worker/container restart, start and reboot; scopes sudo", () => {
    const { p } = profile();
    expect(remoteCommand(p, "container_restart")).toBe("'docker' 'restart' '--' 'paseo-dev-stack-paseo'");
    expect(remoteCommand(p, "restart")).toContain("'--user' 'paseo'");
    expect(remoteCommand(p, "restart")).toContain("/opt/npm-global/bin/paseo");
    expect(remoteCommand(p, "restart")).toContain("command -v paseo");
    expect(remoteCommand({ ...p, sudo: true }, "start")).toMatch(/^'sudo' '-n' '--' 'docker'/);
    expect(remoteCommand({ ...p, sudo: true, user: "root" }, "reboot")).toBe("'systemctl' 'reboot'");
    expect(remoteCommand({ ...p, preset: "systemd" }, "test")).toBe("'systemctl' 'is-active' '--' 'paseo.service'");
    expect(remoteCommand({ ...p, preset: "systemd", sudo: true }, "restart")).toBe("'sudo' '-n' '--' 'systemctl' 'restart' '--' 'paseo.service'");
    expect(() => remoteCommand({ ...p, preset: "systemd" }, "container_restart")).toThrow("Docker");
    for (const action of ["test", "start", "restart", "container_restart", "reboot"] as const) expect(remoteCommand(p, action)).not.toMatch(/compose|recreate|socket/);
    expect(recoveryActionLabel(p, "start")).toBe("Start container"); expect(recoveryActionLabel(p, "restart")).toBe("Restart Paseo worker");
    expect(recoveryActionLabel({ ...p, preset: "systemd" }, "start")).toBe("Start Paseo");
    for (const action of ["start", "restart", "container_restart", "reboot", "remove"] as const) expect(recoveryWarning(p, action, "Fixture helper")).toContain("Fixture helper");
    expect(recoveryWarning(p, "container_restart", "Fixture helper")).toContain("All work inside this container");
  });
});

/** Real local shell + fake Docker/Paseo. Absolute container paths map into the fixture, never the host's runtime. */
function fakeShell() {
  const { f, p } = profile(), bin = join(f.root, "bin"), persistent = join(f.root, "persistent-paseo"), calls = join(f.root, "calls");
  mkdirSync(bin);
  const paseo = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(process.env.FAKE_STATUS||'');process.exit(Number(process.env.FAKE_CLI_EXIT||0));\n`;
  writeFileSync(join(bin, "paseo"), paseo, { mode: 0o700 });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(a)+'\\n');if(a[0]==='inspect'){process.stdout.write((process.env.FAKE_CONTAINER_STATE||'running')+'\\n');process.exit(Number(process.env.FAKE_INSPECT_EXIT||0));}if(a[0]==='exec'){if(a[1]!=='--user'||a[2]!=='paseo'||a[3]!=='--'||a[5]!=='sh'||a[6]!=='-c')process.exit(9);const script=a[7].replaceAll('/opt/npm-global/bin/paseo',process.env.FAKE_PERSISTENT);const r=spawnSync('sh',['-c',script],{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}process.exit(0);\n`, { mode: 0o700 });
  const run = (env: Record<string, string> = {}, action: "test" | "start" | "restart" | "container_restart" = "test") => execFileSync("sh", ["-c", remoteCommand(p, action)], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PERSISTENT: persistent, FAKE_CALLS: calls, ...env } });
  return { run, persistent, paseo, calls };
}
describe("remote status script in a real local shell with fake executables", () => {
  it.each([
    [{ localDaemon: "running", connectedDaemon: "reachable", workerPid: 123 }, "running\n"],
    [{ localDaemon: "stopped", connectedDaemon: "not_probed" }, "worker_stopped\n"],
    [{ localDaemon: "running", connectedDaemon: "unreachable", workerPid: 123 }, "worker_unknown\n"],
    [{ localDaemon: "running", connectedDaemon: "reachable" }, "worker_unknown\n"],
    [{ localDaemon: "stopped", connectedDaemon: "reachable", workerPid: 123 }, "worker_unknown\n"],
    [{ localDaemon: "running", connectedDaemon: "auth_required" }, "worker_unknown\n"],
  ])("requires an actual reachable worker: %j", (status, expected) => {
    const { run } = fakeShell(); expect(run({ FAKE_STATUS: JSON.stringify({ ...status, providers: { secret: "fixture-private-configuration" } }) })).toBe(expected);
  });
  it.each(["not json", "null", "{}", "x".repeat(70_000)])("keeps malformed/oversize JSON unknown (case %#)", raw => {
    const { run } = fakeShell(); expect(run({ FAKE_STATUS: raw })).toBe("worker_unknown\n");
  });
  it.each(["created", "exited"])("emits exact stopped newline for %s", state => {
    const { run, calls } = fakeShell(); expect(run({ FAKE_CONTAINER_STATE: state })).toBe("container_stopped\n"); expect(readFileSync(calls, "utf8")).not.toContain('"exec"');
  });
  it("uses a persistent executable if present, otherwise fallback", () => {
    const { run, persistent, paseo, calls } = fakeShell();
    expect(run({ FAKE_STATUS: JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable", workerPid: 123 }) })).toBe("running\n");
    writeFileSync(persistent, paseo, { mode: 0o700 });
    expect(run({ FAKE_STATUS: JSON.stringify({ localDaemon: "stopped", connectedDaemon: "not_probed" }) })).toBe("worker_stopped\n");
    expect(readFileSync(calls, "utf8")).toContain('["daemon","status","--json","--home",');
  });
  it("returns unknown for a CLI failure and nonzero for a missing container", () => {
    const { run } = fakeShell(); expect(run({ FAKE_CLI_EXIT: "1", FAKE_STATUS: JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable", workerPid: 123 }) })).toBe("worker_unknown\n");
    expect(() => run({ FAKE_INSPECT_EXIT: "1" })).toThrow(); expect(run({ FAKE_CONTAINER_STATE: "restarting" })).toBe("unknown\n");
  });
  it("executes start/restart with only fixed target arguments", () => {
    const { run, calls } = fakeShell(); run({}, "start"); run({}, "container_restart");
    expect(readFileSync(calls, "utf8").trim().split("\n").map(s => JSON.parse(s))).toEqual([["start", "--", "paseo-dev-stack-paseo"], ["restart", "--", "paseo-dev-stack-paseo"]]);
  });
});
