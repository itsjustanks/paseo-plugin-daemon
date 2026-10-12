import { describe, expect, it } from "vitest";
import { DarwinAdapter, parseLsofEndpoints } from "../server/darwin";
import { LinuxAdapter, MAX_FDS_PER_PROCESS, parseProcTcpEndpoints, type LinuxFs } from "../server/linux";
import { provenLoopbackEndpoints } from "../server/tcp-endpoints";
import { localCdpEndpoint } from "../server/browser-cdp";

const header = "sl local_address remote_address st tx_queue rx_queue tr uid timeout inode\n";
const row = (address: string, inode: number, state = "0A") => `0: ${address}:2406 00000000:0000 ${state} 0:0 00:0 0 1000 0 ${inode}\n`;
const v4 = "0100007F";
const v6 = "00000000000000000000000001000000";
function linux(tcp: string, tcp6: string, fds = ["1"], links: Record<string, string> = { "1": "socket:[43]" }) {
  const fs: LinuxFs = {
    readFile: async (path) => { if (path === "/proc/net/tcp") return tcp; if (path === "/proc/net/tcp6") return tcp6; throw new Error("unreadable"); },
    readFileBuffer: async () => { throw new Error("unused"); },
    readdir: async () => fds,
    readlink: async (path) => { const value = links[path.split("/").pop()!]; if (!value) throw new Error("denied"); return value; },
  };
  return new LinuxAdapter({ fs });
}
describe("fresh exact TCP ownership", () => {
  it.each([4, 6] as const)("compares Linux and Darwin literal IPv%s parser fixtures", async (family) => {
    const address = family === 4 ? "127.0.0.1" : "::1";
    const raw = family === 4 ? v4 : v6;
    const mac = parseLsofEndpoints(`p43\nf8\ntIPv${family}\nn${family === 6 ? `[${address}]` : address}:9222\n`);
    const proc = parseProcTcpEndpoints(header + row(raw, 43), family, "LE");
    expect(proc).toEqual(mac);
    expect(provenLoopbackEndpoints(mac, 43)).toEqual([{ address, family, port: 9222 }]);
    const adapter = linux(header + (family === 4 ? row(raw, 43) : ""), header + (family === 6 ? row(raw, 43) : ""));
    expect(await adapter.freshListeningEndpoints(43)).toEqual([{ address, family, port: 9222 }]);
  });
  it("keeps IPv4 and IPv6 ownership separate on the same port", async () => {
    const mac = new DarwinAdapter({ exec: async () => "p43\nf1\ntIPv6\nn[::1]:9222\np99\nf2\ntIPv4\nn127.0.0.1:9222\n" });
    const proc = linux(header + row(v4, 99), header + row(v6, 43));
    const endpoint = [{ address: "::1", family: 6, port: 9222 }];
    expect(await mac.freshListeningEndpoints(43)).toEqual(endpoint);
    expect(await proc.freshListeningEndpoints(43)).toEqual(endpoint);
    expect(localCdpEndpoint("ws://localhost:9222/devtools/browser/test", endpoint[0] as { address: "::1"; family: 6; port: number })).toBe("ws://[::1]:9222/devtools/browser/test");
    expect(() => localCdpEndpoint("ws://127.0.0.1:9222/devtools/browser/test", { address: "::1", family: 6, port: 9222 })).toThrow();
  });
  it.each(["duplicate", "wildcard", "unknown"])("rejects %s competing ownership", async (kind) => {
    const other = kind === "duplicate" ? "127.0.0.1" : kind === "wildcard" ? "*" : "unknown";
    const mac = new DarwinAdapter({ exec: async () => `p43\nf1\ntIPv4\nn127.0.0.1:9222\np99\nf2\n${kind === "wildcard" ? "tIPv6\n" : ""}n${other}:9222\n` });
    expect(await mac.freshListeningEndpoints(43)).toEqual([]);
    if (kind !== "unknown") {
      const proc = linux(header + row(v4, 43) + (kind === "duplicate" ? row(v4, 99) : ""), header + (kind === "wildcard" ? row("0".repeat(32), 99) : ""));
      expect(await proc.freshListeningEndpoints(43)).toEqual([]);
    }
  });
  it("keeps dual-stack owned listeners in stable family order and preserves distinct ports", () => {
    const rows = parseLsofEndpoints("p43\nf1\ntIPv6\nn[::1]:9222\nf2\ntIPv4\nn127.0.0.1:9222\nf3\ntIPv4\nn127.0.0.1:9223\n");
    expect(provenLoopbackEndpoints(rows, 43)).toEqual([
      { address: "127.0.0.1", family: 4, port: 9222 }, { address: "::1", family: 6, port: 9222 }, { address: "127.0.0.1", family: 4, port: 9223 },
    ]);
  });
  it("deduplicates one owned socket and never admits non-loopback or malformed evidence", () => {
    const rows = parseLsofEndpoints("p43\nf1\ntIPv4\nn127.0.0.1:9222\nf2\ntIPv4\nn127.0.0.1:9222\nf3\ntIPv4\nn192.168.1.1:9223\n");
    expect(provenLoopbackEndpoints(rows, 43)).toEqual([{ address: "127.0.0.1", family: 4, port: 9222 }]);
    expect(() => parseLsofEndpoints("p43\nnunknown\n")).toThrow();
    expect(() => parseLsofEndpoints("p43\nn127.0.0.1:65536\n")).toThrow();
    expect(provenLoopbackEndpoints(parseLsofEndpoints("p43\ntIPv6\nn127.0.0.1:9222\n"), 43)).toEqual([]);
    expect(() => parseProcTcpEndpoints(header + row("BAD", 43), 4)).toThrow();
    expect(() => parseProcTcpEndpoints(header + row(v4, 0), 4)).toThrow();
    expect(parseProcTcpEndpoints(header + row(v4, 43, "01"), 4)).toEqual([]);
    expect(parseProcTcpEndpoints(header + row("7F000001", 43), 4, "BE")[0]?.address).toBe("127.0.0.1");
    expect(parseProcTcpEndpoints(header + row("0200007F", 43), 4, "LE")[0]?.address).toBe("other");
  });
  it("fails closed on missing OS evidence, truncated descriptors, or unreadable socket links", async () => {
    await expect(new DarwinAdapter({ exec: async () => { throw new Error("denied"); } }).freshListeningEndpoints(43)).rejects.toThrow();
    await expect(linux(header, header, Array.from({ length: MAX_FDS_PER_PROCESS + 1 }, (_, i) => String(i))).freshListeningEndpoints(43)).rejects.toThrow("truncated");
    await expect(linux(header + row(v4, 43), header, ["1"], {}).freshListeningEndpoints(43)).rejects.toThrow("denied");
    expect(await linux(header + row(v4, 43), header, ["1"], { "1": "/dev/null" }).freshListeningEndpoints(43)).toEqual([]);
  });
});
