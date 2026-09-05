import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceLease } from "../server/lease";
import { createAdapter } from "../server/adapter";
import { FakeAdapter } from "./fake-adapter";
vi.mock("../server/adapter", () => ({ createAdapter: vi.fn() }));

describe("service ownership lease", () => {
  beforeEach(() => vi.resetAllMocks());
  it("rejects unsupported platforms and unowned listeners", async () => {
    vi.mocked(createAdapter).mockReturnValue(null);
    await expect(createServiceLease(3000)).rejects.toThrow("Linux or macOS");
    const adapter = {
      sampleProcesses: vi.fn(async () => ({ processes: [], warnings: [] })),
      listeningPorts: vi.fn(async () => ({ ports: new Map(), warnings: [] })),
    };
    vi.mocked(createAdapter).mockReturnValue(adapter as unknown as FakeAdapter);
    await expect(createServiceLease(3000)).rejects.toThrow("owned by");
  });
  it("pins start identity and user, and rejects a disappeared or reused listener", async () => {
    const uid = process.getuid!();
    const processRow = { pid: 987654, ppid: 987653, uid, comm: "fixture", argv: ["fixture"], state: "sleeping", startId: "start", cpuSeconds: 0, rssBytes: 0, ageSeconds: 1, cwd: null };
    const adapter = {
      sampleProcesses: vi.fn(async () => ({ processes: [processRow], warnings: [] })),
      listeningPorts: vi.fn(async () => ({ ports: new Map([[processRow.pid, [3000]]]), warnings: [] })),
      readIdentity: vi.fn(async () => ({ ...processRow, argvHash: "hash" })),
    };
    vi.mocked(createAdapter).mockReturnValue(adapter as unknown as FakeAdapter);
    const verify = await createServiceLease(3000);
    expect(await verify()).toBe(true);
    adapter.readIdentity.mockResolvedValueOnce({ ...processRow, startId: "reused", argvHash: "hash" });
    expect(await verify()).toBe(false);
    adapter.readIdentity.mockResolvedValueOnce({ ...processRow, uid: uid + 1, argvHash: "hash" });
    expect(await verify()).toBe(false);
    adapter.listeningPorts.mockResolvedValueOnce({ ports: new Map(), warnings: [] });
    expect(await verify()).toBe(false);
    adapter.readIdentity.mockRejectedValueOnce(new Error("read failed"));
    expect(await verify()).toBe(false);
  });
});
