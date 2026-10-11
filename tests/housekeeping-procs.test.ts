import { describe, expect, it } from "vitest";
import { ProcReader, parseEnvTags, parseNice, type HkFs } from "../server/housekeeping-procs";
import { PID_STAT_PARENS } from "./fixtures/linux";
import { A, B, PROFILE } from "./housekeeping-fixture";
import { profileInUse } from "../server/housekeeping-plan";

function stat(nice = 0, start = "5000") {
  const close = PID_STAT_PARENS.lastIndexOf(")"); const fields = PID_STAT_PARENS.slice(close + 2).trim().split(/\s+/);
  fields[16] = String(nice); fields[19] = start;
  return `42 (chrome) ${fields.join(" ")}`;
}
function fixture() {
  let reads = 0;
  const fs: HkFs = {
    readdir: async () => ["42"],
    readFile: async (path) => path === "/proc/uptime" ? "1000 1" : path.endsWith("/status") ? "Uid:\t1000\t1000\t1000\t1000\n" : stat(++reads > 1 ? 15 : 0),
    readFileBuffer: async (path) => Buffer.from(path.endsWith("/environ") ? `PASEO_AGENT_ID=${A}\0SECRET=ignored\0` : `chrome\0--user-data-dir=${PROFILE}\0`),
    readlink: async (path) => path.endsWith("/exe") ? "/usr/bin/chrome" : "/tmp",
  };
  return fs;
}

describe("housekeeping proc reads", () => {
  it("reads nice from the final identity-bound stat and only retains the two allowed environment tags", async () => {
    const reader = new ProcReader(1000, { fs: fixture(), clockTicks: async () => 100 });
    const row = await reader.read(42);
    expect(row).toMatchObject({ pid: 42, uid: 1000, startId: "5000", nice: 15, agentId: A });
    expect(JSON.stringify(row)).not.toContain("SECRET"); expect(parseNice(stat(-5))).toBe(-5); expect(parseNice("bad")).toBeNull();
    expect(parseEnvTags(`PASEO_AGENT_ID=${A}\0PASEO_AGENT_ID=${B}\0`)).toMatchObject({ agentId: null });
    expect(parseEnvTags(`PASEO_AGENT_ID=${A}`)).toMatchObject({ agentId: null });
    expect(parseEnvTags("PASEO_AGENT_ID=bad\0AGENT_BROWSER_DAEMON=1\0")).toEqual({ agentId: null, browserDaemon: true });
  });
  it("refuses PID reuse mid-read, unreadable same-user paths and partial scans", async () => {
    let calls = 0; const fs = fixture(); fs.readFile = async (path) => path.endsWith("status") ? "Uid:\t1000\n" : path.endsWith("uptime") ? "1000 1" : stat(0, ++calls > 1 ? "5001" : "5000");
    const changed = new ProcReader(1000, { fs, clockTicks: async () => 100 }); await expect(changed.read(42)).rejects.toThrow("unreadable");
    const failed = fixture(); failed.readlink = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    expect((await new ProcReader(1000, { fs: failed, clockTicks: async () => 100 }).scan()).complete).toBe(false);
    const cancelled = new AbortController(); cancelled.abort(); expect((await new ProcReader(1000, { fs: fixture(), clockTicks: async () => 100 }).scan(cancelled.signal)).complete).toBe(false);
  });
  it("inaccessible foreign-user paths block profile deletion rather than pretending the profile is unused", async () => {
    const fs = fixture(); const readFile = fs.readFile; fs.readFile = (path) => path.endsWith("status") ? Promise.resolve("Uid:\t1001\n") : readFile(path);
    fs.readlink = async () => { throw new Error("denied"); };
    const table = await new ProcReader(1000, { fs, clockTicks: async () => 100 }).scan();
    expect(table.complete).toBe(true); expect(table.processes[0]?.pathsKnown).toBe(false); expect(profileInUse(table, PROFILE)).toBe(true);
    expect(profileInUse(table, PROFILE, { uid: 1000, privateOwned: true })).toBe(false);
    expect(profileInUse(table, PROFILE, { uid: 1001, privateOwned: true })).toBe(true);
  });
});
