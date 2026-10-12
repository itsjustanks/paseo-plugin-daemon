/** Exercise real target attachment/reconnect methods without native sockets or profiles. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { CdpConnection, type CdpSession } from "./cdp";

class ConnectionFixture extends EventEmitter {
  isOpen = true;
  nextSession = 0;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  constructor(readonly targetIds: string[]) {
    super();
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Target.getTargets")
      return {
        targetInfos: this.targetIds.map((targetId) => ({
          targetId,
          type: "page",
          url: "about:blank",
          title: targetId,
        })),
      } as T;
    if (method === "Target.attachToTarget")
      return { sessionId: `fixture-${++this.nextSession}` } as T;
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [] } as T;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } } as T;
    return {} as T;
  }

  close(): void {
    this.isOpen = false;
    this.emit("disconnect");
  }
}

interface RuntimeControl {
  invoke(args: string[]): Promise<unknown>;
  assertVersion(): Promise<void>;
  connectCdp(targetId?: string | null): Promise<void>;
  reattachPageForScreencast(previous: CdpSession): Promise<CdpSession>;
  connection: CdpConnection;
  targetId: string | null;
  page: CdpSession | null;
}

/** Stub only binary discovery and CDP transport, preserving runtime selection policy. */
function fixture(targetLists: string[][]) {
  const connections = targetLists.map((ids) => new ConnectionFixture(ids));
  let next = 0;
  vi.spyOn(CdpConnection, "connect").mockImplementation(async () => {
    const connection = connections[next++];
    if (!connection) throw new Error("Unexpected reconnect");
    return connection as unknown as CdpConnection;
  });
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "target-retention-test",
  });
  const control = runtime as unknown as RuntimeControl;
  control.invoke = vi.fn(async () => ({ cdpUrl: "ws://127.0.0.1:1/fixture" }));
  control.assertVersion = async () => {};
  return { runtime, control, connections };
}

afterEach(() => vi.restoreAllMocks());
describe("exact selected target retention", () => {
  it("permits initial selection when no page has ever been selected", async () => {
    const { control } = fixture([["first", "second"]]);
    await control.connectCdp();
    expect(control.targetId).toBe("first");
  });

  it("retains the selected surviving page across disconnect instead of adopting the first tab", async () => {
    const { runtime, control, connections } = fixture([
      ["other", "original"],
      ["other", "original"],
    ]);
    await control.connectCdp("original");
    connections[0]!.close();
    expect(control.page).toBeNull();
    expect(control.targetId).toBe("original");
    await runtime.reconnect();
    expect(control.page?.targetId).toBe("original");
    expect(
      connections[1]!.calls
        .filter((call) => call.method === "Target.activateTarget")
        .map((call) => call.params.targetId),
    ).toEqual(["original"]);
    expect(control.invoke).toHaveBeenCalledWith([
      "--session",
      "target-retention-test",
      "--json",
      "get",
      "cdp-url",
    ]);
    expect(
      connections
        .flatMap((connection) => connection.calls)
        .some((call) => call.method === "Page.navigate"),
    ).toBe(false);
  });

  it("refuses a missing selected page on every reconnect without adopting another tab", async () => {
    const { runtime, control, connections } = fixture([["original"], ["other"], ["other"]]);
    await control.connectCdp("original");
    connections[0]!.close();
    await expect(runtime.reconnect()).rejects.toThrow(
      "selected browser page is no longer available",
    );
    await expect(runtime.reconnect()).rejects.toThrow(
      "selected browser page is no longer available",
    );
    expect(control.targetId).toBe("original");
    expect(control.page).toBeNull();
    expect(
      connections
        .slice(1)
        .flatMap((connection) => connection.calls)
        .some(
          (call) =>
            call.method === "Target.attachToTarget" || call.method === "Target.activateTarget",
        ),
    ).toBe(false);
  });

  it("requires an explicit initial target rather than replacing a missing launch target", async () => {
    const { runtime, control, connections } = fixture([["other"], ["other"]]);
    await expect(control.connectCdp("missing")).rejects.toThrow(
      "selected browser page is no longer available",
    );
    expect(control.targetId).toBe("missing");
    await expect(runtime.reconnect()).rejects.toThrow(
      "selected browser page is no longer available",
    );
    expect(control.page).toBeNull();
    expect(
      connections
        .flatMap((connection) => connection.calls)
        .some((call) => call.method === "Target.activateTarget"),
    ).toBe(false);
  });

  it("retains a newly explicitly selected page across later disconnects", async () => {
    const { runtime, control, connections } = fixture([
      ["first", "chosen"],
      ["first", "chosen"],
    ]);
    await control.connectCdp();
    await runtime.selectTarget("chosen");
    connections[0]!.close();
    await runtime.reconnect();
    expect(control.page?.targetId).toBe("chosen");
  });

  it("refuses screencast reattachment when its exact former page disappeared", async () => {
    const { control, connections } = fixture([["original", "other"]]);
    await control.connectCdp("original");
    const previous = control.page!;
    connections[0]!.targetIds.splice(0, 1);
    const before = connections[0]!.calls.length;
    await expect(control.reattachPageForScreencast(previous)).rejects.toThrow(
      "selected browser page is no longer available",
    );
    expect(control.page).toBe(previous);
    expect(control.targetId).toBe("original");
    expect(
      connections[0]!.calls
        .slice(before)
        .some(
          (call) =>
            call.method === "Target.activateTarget" || call.method === "Target.attachToTarget",
        ),
    ).toBe(false);
  });
});
