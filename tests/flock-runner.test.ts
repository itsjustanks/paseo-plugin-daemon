import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { runFlock } from "../server/housekeeping-lock";
beforeEach(() => spawn.mockReset());
describe("flock subprocess outcomes", () => {
  it("does not spawn after cancellation", async () => {
    const c = new AbortController(); c.abort(); expect(await runFlock(9, c.signal)).toEqual({ code: null, missing: false }); expect(spawn).not.toHaveBeenCalled();
  });
  it("passes only the held descriptor and preserves busy/success exit codes", async () => {
    for (const code of [0, 75]) {
      const child = new EventEmitter(); spawn.mockReturnValue(child); const c = new AbortController(), result = runFlock(9, c.signal);
      expect(spawn).toHaveBeenLastCalledWith("flock", ["-n", "-E", "75", "3"], expect.objectContaining({ stdio: ["ignore", "ignore", "ignore", 9], signal: c.signal }));
      child.emit("exit", code); expect(await result).toEqual({ code, missing: false });
    }
  });
  it("reports missing flock without granting authority, even if an exit event follows", async () => {
    const child = new EventEmitter(); spawn.mockReturnValue(child); const result = runFlock(9, new AbortController().signal);
    child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })); child.emit("exit", 0);
    expect(await result).toEqual({ code: null, missing: true });
    spawn.mockImplementationOnce(() => { throw new Error("spawn failed"); }); const failed = await runFlock(9, new AbortController().signal); spawn.mockReset(); expect(failed).toEqual({ code: null, missing: false });
  });
});
