import { beforeEach, describe, expect, it, vi } from "vitest";
import { displayArgvHash, inspectDisplayExecutable, readDisplayProcess, sameDisplayProcess } from "./display-process";
const fake = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn(), readlink: vi.fn(), realpath: vi.fn(), stat: vi.fn(), readdir: vi.fn() }));
vi.mock("node:fs/promises", () => fake);
const elf = Buffer.from([127, 69, 76, 70, 1, 2, 3, 4]);
const procStat = (birth = "111") => { const fields = Array(20).fill("0"); fields[0] = "S"; fields[1] = String(process.pid); fields[19] = birth; return `123 (Xvfb (owned)) ${fields.join(" ")}`; };
beforeEach(() => {
  vi.resetAllMocks();
  fake.realpath.mockImplementation(async (path: string) => path);
  fake.lstat.mockResolvedValue({ uid: 0, mode: 0o755, isSymbolicLink: () => false });
  fake.stat.mockResolvedValue({ dev: 1, ino: 3, size: elf.length, mode: 0o755, isFile: () => true });
  fake.readFile.mockImplementation(async (path: string) => {
    if (path === "/usr/bin/Xvfb") return elf;
    if (path === "/proc/123/stat") return procStat();
    if (path === "/proc/123/status") return "Name:\tXvfb\nUid:\t1000\t1000\t1000\t1000\n";
    if (path === "/proc/123/cmdline") return "/usr/bin/Xvfb\0:23067\0";
    if (path === "/proc/123/task/123/children") return "";
    throw Error("Unexpected fixture read: " + path);
  });
  fake.readlink.mockResolvedValue("/usr/bin/Xvfb"); fake.readdir.mockResolvedValue(["123"]);
});
describe("trusted system display executable", () => {
  it("binds a canonical root-owned ELF to inode/device/hash", async () => { expect(await inspectDisplayExecutable("/usr/bin/Xvfb")).toMatchObject({ path: "/usr/bin/Xvfb", dev: 1, ino: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }); });
  it("missing executable is a distinct prerequisite result with no execution", async () => { fake.realpath.mockRejectedValue(Object.assign(Error(), { code: "ENOENT" })); expect(await inspectDisplayExecutable("/usr/bin/Xvfb")).toBeNull(); expect(fake.readFile).not.toHaveBeenCalled(); });
  it.each(["relative", "writable", "foreign", "setuid", "oversize", "not-elf", "replaced"])("refuses %s executable metadata", async (kind) => {
    if (kind === "writable") fake.lstat.mockResolvedValue({ uid: 0, mode: 0o777, isSymbolicLink: () => false });
    if (kind === "foreign") fake.lstat.mockResolvedValue({ uid: 1000, mode: 0o755, isSymbolicLink: () => false });
    if (kind === "setuid") fake.stat.mockResolvedValue({ dev: 1, ino: 3, size: elf.length, mode: 0o4755, isFile: () => true });
    if (kind === "oversize") fake.stat.mockResolvedValue({ dev: 1, ino: 3, size: 33 * 1024 ** 2, mode: 0o755, isFile: () => true });
    if (kind === "not-elf") fake.readFile.mockResolvedValue(Buffer.alloc(8));
    if (kind === "replaced") fake.stat.mockResolvedValueOnce({ dev: 1, ino: 3, size: elf.length, mode: 0o755, isFile: () => true }).mockResolvedValue({ dev: 1, ino: 4, size: elf.length, mode: 0o755, isFile: () => true });
    await expect(inspectDisplayExecutable(kind === "relative" ? "Xvfb" : "/usr/bin/Xvfb")).rejects.toThrow("Untrusted");
  });
});
describe("exact spawned display process proof", () => {
  it("binds birth/UID/parent/executable/argv around a scoped task census without environment reads", async () => {
    const proof = await readDisplayProcess(123); expect(proof).toMatchObject({ pid: 123, parentPid: process.pid, uid: 1000, startTicks: "111", executable: "/usr/bin/Xvfb", executableDev: 1, executableIno: 3, argvHash: displayArgvHash(["/usr/bin/Xvfb", ":23067"]), children: [] });
    expect(fake.readdir.mock.calls).toEqual([["/proc/123/task"]]); expect(fake.readFile.mock.calls.every(([path]) => String(path).startsWith("/proc/123/") && !String(path).includes("environ"))).toBe(true);
    expect(sameDisplayProcess(proof!, { ...proof!, children: [456] })).toBe(true); expect(sameDisplayProcess(proof!, { ...proof!, startTicks: "222" })).toBe(false);
  });
  it("reads only each exact task children file and deduplicates descendants", async () => {
    const original = fake.readFile.getMockImplementation()!; fake.readdir.mockResolvedValue(["123", "124"]);
    fake.readFile.mockImplementation(async (path: string) => path.endsWith("/children") ? "456 789 456" : original(path));
    expect((await readDisplayProcess(123))!.children).toEqual([456, 789]);
    expect(fake.readFile.mock.calls.some(([path]) => String(path).startsWith("/proc/456/"))).toBe(false);
  });
  it("gone is distinct from unreadable, with no signal0 or process-table scan", async () => {
    fake.readFile.mockRejectedValue(Object.assign(Error(), { code: "ENOENT" })); expect(await readDisplayProcess(123)).toBeNull();
    fake.readFile.mockRejectedValue(Object.assign(Error("permission"), { code: "EACCES" })); await expect(readDisplayProcess(123)).rejects.toThrow("permission");
  });
  it.each([0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid PID %s before reads", async (pid) => { await expect(readDisplayProcess(pid)).rejects.toThrow("PID"); expect(fake.readFile).not.toHaveBeenCalled(); });
  it.each(["birth", "exe", "uid", "argv", "task-bound", "children-bound", "malformed-stat", "mixed-uid", "argv-bound"])("refuses %s change/limit", async (kind) => {
    const original = fake.readFile.getMockImplementation()!; let stats = 0, commands = 0;
    fake.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("/stat") && kind === "birth") return procStat(++stats > 1 ? "222" : "111");
      if (path.endsWith("/stat") && kind === "malformed-stat") return "123 malformed";
      if (path.endsWith("/status") && kind === "mixed-uid") return "Uid:\t1000\t0\t1000\t1000\n";
      if (path.endsWith("/status") && kind === "uid") return "Uid:\t1000\t1000\t1000\t1000\n".replace(/1000/g, ++stats > 1 ? "1001" : "1000");
      if (path.endsWith("/cmdline") && kind === "argv") return ++commands > 1 ? "foreign\0" : "/usr/bin/Xvfb\0:23067\0";
      if (path.endsWith("/cmdline") && kind === "argv-bound") return "x".repeat(8193) + "\0";
      if (path.endsWith("/children") && kind === "children-bound") return "2 3 4 5 6 7 8 9 10";
      return original(path);
    });
    if (kind === "exe") fake.readlink.mockResolvedValueOnce("/usr/bin/Xvfb").mockResolvedValue("/foreign");
    if (kind === "task-bound") fake.readdir.mockResolvedValue(Array.from({ length: 65 }, (_, index) => String(index + 1)));
    await expect(readDisplayProcess(123)).rejects.toThrow();
  });
});


it("missing CONFIG_PROC_CHILDREN is unknown when the exact task directory still exists", async () => {
  const original = fake.readFile.getMockImplementation()!;
  fake.readFile.mockImplementation(async (path: string) => {
    if (path === "/proc/123/task/123/children") throw Object.assign(Error("missing children capability"), { code: "ENOENT" });
    return original(path);
  });
  await expect(readDisplayProcess(123)).rejects.toThrow("Display child census is unavailable");
  expect(fake.lstat.mock.calls).toEqual([["/proc/123/task/123"]]);
});

it("a missing children file is skipped only after its exact task directory is confirmed gone", async () => {
  const original = fake.readFile.getMockImplementation()!; fake.readdir.mockResolvedValue(["123", "124"]);
  fake.readFile.mockImplementation(async (path: string) => {
    if (path === "/proc/123/task/124/children") throw Object.assign(Error(), { code: "ENOENT" });
    return original(path);
  });
  fake.lstat.mockImplementation(async (path: string) => {
    expect(path).toBe("/proc/123/task/124"); throw Object.assign(Error(), { code: "ENOENT" });
  });
  expect((await readDisplayProcess(123))!.children).toEqual([]);
  expect(fake.lstat).toHaveBeenCalledOnce();
});

it("an unreadable task directory after missing children remains unknown", async () => {
  const original = fake.readFile.getMockImplementation()!;
  fake.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("/children")) throw Object.assign(Error(), { code: "ENOENT" });
    return original(path);
  });
  fake.lstat.mockRejectedValue(Object.assign(Error("task permission"), { code: "EACCES" }));
  await expect(readDisplayProcess(123)).rejects.toThrow("task permission");
});
