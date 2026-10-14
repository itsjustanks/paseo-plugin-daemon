import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followBrowserPresence, type BrowserPresencePort } from "../client/browser-presence";
vi.mock("@getpaseo/plugin", () => ({ defineRpc: (value: unknown) => value }));
type Page = Awaited<ReturnType<BrowserPresencePort["list"]>>;
const page = (ids = ["a"], workspaceId = "workspace-a"): Page => ({ entries: ids.map((id) => ({ agent: { id, workspaceId } })), pageInfo: { hasMore: false, nextCursor: null } });
const pending = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
function setup() {
  let observer!: Parameters<NonNullable<Page["subscription"]>["subscribe"]>[0];
  const subscription = { subscribe: vi.fn((next: typeof observer) => { observer = next; return unsubscribe; }), release: vi.fn(async () => {}) };
  const unsubscribe = vi.fn();
  const remove = vi.fn();
  const port = { list: vi.fn<BrowserPresencePort["list"]>().mockResolvedValue({ ...page(), subscription }), read: vi.fn<BrowserPresencePort["read"]>().mockResolvedValue({ workspaceIds: ["workspace-a"] }), add: vi.fn<BrowserPresencePort["add"]>().mockReturnValue(remove) };
  stop = followBrowserPresence(port);
  return { port, subscription, unsubscribe, remove, observer: () => observer };
}
describe("workspace browser composer presence", () => {
  it("shares one read across chats and removes only its pills on teardown", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    x.observer().snapshot(page(["a", "b"])); await vi.advanceTimersByTimeAsync(0);
    expect(x.port.add.mock.calls.map(([a]) => a.id)).toEqual(["a", "b"]);
    stop!(); stop!(); expect(x.remove).toHaveBeenCalledTimes(2); expect(x.subscription.release).toHaveBeenCalledOnce();
    expect(x.unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not show a shortcut for a closed browser", async () => {
    const x = setup(); x.port.read.mockResolvedValue({ workspaceIds: [] }); await vi.advanceTimersByTimeAsync(0);
    expect(x.port.add).not.toHaveBeenCalled();
  });
  it("reconciles agent removal, workspace movement and an absent workspace", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    x.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "a", workspaceId: "other" } } });
    expect(x.remove).toHaveBeenCalledOnce();
    x.observer().update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "a" } } });
    x.observer().update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
    await vi.advanceTimersByTimeAsync(5000); expect(x.port.add).toHaveBeenCalledOnce();
  });
  it("times out a presence read without accumulating retries or publishing a late result", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    const p = pending<{ workspaceIds: string[] }>(); x.port.read.mockReturnValue(p.promise);
    await vi.advanceTimersByTimeAsync(20_000); expect(x.port.read).toHaveBeenCalledTimes(2); expect(x.remove).toHaveBeenCalledOnce();
    p.resolve({ workspaceIds: ["workspace-a"] }); await vi.advanceTimersByTimeAsync(0); expect(x.port.add).toHaveBeenCalledOnce();
    x.port.read.mockResolvedValue({ workspaceIds: ["workspace-a"] }); await vi.advanceTimersByTimeAsync(5000); expect(x.port.add).toHaveBeenCalledTimes(2);
  });
  it("clears stale pills on read failure and retries after settlement", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0); x.port.read.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(5000); expect(x.remove).toHaveBeenCalledOnce();
    x.port.read.mockResolvedValue({ workspaceIds: ["workspace-a"] }); await vi.advanceTimersByTimeAsync(5000); expect(x.port.add).toHaveBeenCalledTimes(2);
  });
  it("releases a late directory result after cleanup", async () => {
    const x = setup(); stop!(); await vi.advanceTimersByTimeAsync(0);
    expect(x.subscription.release).toHaveBeenCalledOnce(); expect(x.port.add).not.toHaveBeenCalled();
  });
  it("ignores callbacks from a disconnected observation", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0); const old = x.observer(); old.error();
    old.snapshot(page(["stale"])); old.update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "stale", workspaceId: "workspace-a" } } });
    await vi.advanceTimersByTimeAsync(0); expect(x.port.add.mock.calls.map(([a]) => a.id)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(5000); expect(x.port.list).toHaveBeenCalledTimes(2);
  });
  it("does not republish presence from a directory that disconnected mid-read", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    const p = pending<{ workspaceIds: string[] }>(); x.port.read.mockReturnValue(p.promise);
    await vi.advanceTimersByTimeAsync(5000); x.observer().error();
    p.resolve({ workspaceIds: ["workspace-a"] }); await vi.advanceTimersByTimeAsync(0);
    expect(x.port.add).toHaveBeenCalledOnce(); expect(x.remove).toHaveBeenCalledOnce();
  });
  it("replays live updates over paged snapshots", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    const p = pending<Page>(); x.port.list.mockReturnValue(p.promise);
    x.observer().snapshot({ ...page(["a"]), pageInfo: { hasMore: true, nextCursor: "next" } });
    x.observer().update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
    p.resolve(page(["b"])); await vi.advanceTimersByTimeAsync(0);
    expect(x.port.add.mock.calls.map(([a]) => a.id)).toEqual(["a", "b"]); expect(x.remove).toHaveBeenCalledOnce();
  });
  it("refuses repeated pagination cursors and does not publish a partial directory", async () => {
    const x = setup(); await vi.advanceTimersByTimeAsync(0);
    const repeated = { ...page(["b"]), pageInfo: { hasMore: true, nextCursor: "same" } };
    x.port.list.mockResolvedValue(repeated); x.observer().snapshot(repeated); await vi.advanceTimersByTimeAsync(0);
    expect(x.port.list).toHaveBeenCalledTimes(2); expect(x.port.add).toHaveBeenCalledOnce();
  });
  it("aborts a timed-out directory request, retaining one underlying request until settled", async () => {
    let signal!: AbortSignal; const p = pending<Page>();
    const port: BrowserPresencePort = { list: vi.fn((options) => { signal = options.signal; return p.promise; }), read: vi.fn(), add: vi.fn() };
    stop = followBrowserPresence(port); await vi.advanceTimersByTimeAsync(20_000);
    expect(signal.aborted).toBe(true); expect(port.list).toHaveBeenCalledOnce();
    const release = vi.fn(async () => {}); p.resolve({ ...page(), subscription: { subscribe: vi.fn(), release } });
    await vi.advanceTimersByTimeAsync(0); expect(release).toHaveBeenCalledOnce(); expect(port.read).not.toHaveBeenCalled();
  });
});
