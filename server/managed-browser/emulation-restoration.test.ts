import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentBrowserRuntime, type DeviceEmulation } from "./agent-browser-runtime";
import { type CdpConnection, CdpSession } from "./cdp";

/** Protocol fixture exercises real attachment/configuration methods without a browser process. */
class ConnectionFixture extends EventEmitter {
  isOpen = true;
  nextSession = 0;
  calls: { method: string; params: Record<string, unknown>; sessionId: string | undefined }[] = [];
  intercept?: (method: string, sessionId?: string) => Promise<void>;

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string } = {},
  ): Promise<T> {
    this.calls.push({ method, params, sessionId: options.sessionId });
    await this.intercept?.(method, options.sessionId);
    if (method === "Target.getTargets") {
      return {
        targetInfos: ["a", "b"].map((targetId) => ({
          targetId,
          type: "page",
          url: "about:blank",
          title: targetId,
        })),
      } as T;
    }
    if (method === "Target.attachToTarget") return { sessionId: `new-${++this.nextSession}` } as T;
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [] } as T;
    return {} as T;
  }

  close(): void {
    this.isOpen = false;
  }
}

interface RuntimeControl {
  connection: CdpConnection;
  page: CdpSession | null;
  targetId: string | null;
  viewport: DeviceEmulation;
  emulationAppliedPage: CdpSession | null;
  screencastActive: boolean;
  screencastFrame: unknown;
  attachmentGeneration: number;
  assertVersion(): Promise<void>;
  connectCdp(targetId?: string): Promise<void>;
  requirePage(): Promise<CdpSession>;
  reattachPageForScreencast(previous: CdpSession): Promise<CdpSession>;
  onScreencastFrame(page: CdpSession, event: unknown): void;
}

const pixel: DeviceEmulation = {
  width: 412,
  height: 839,
  deviceScaleFactor: 2.625,
  captureScale: 2,
  mobile: true,
  touch: true,
  screenWidth: 430,
  screenHeight: 900,
  userAgent: "fixture-mobile-agent",
  platform: "Android",
};

function fixture() {
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/tmp/unlaunched-browser",
    executablePath: "/tmp/unlaunched-chromium",
    profilePath: "/tmp/uncreated-profile",
    ipcDirectory: "/tmp/uncreated-ipc",
    session: "emulation-test",
  });
  const connection = new ConnectionFixture();
  const typedConnection = connection as unknown as CdpConnection;
  const previous = new CdpSession(typedConnection, "previous", "a");
  const control = runtime as unknown as RuntimeControl;
  Object.assign(control, {
    connection: typedConnection,
    page: previous,
    targetId: "a",
    viewport: { ...pixel },
    emulationAppliedPage: previous,
  });
  return { runtime, connection, previous, control };
}

function assertDeviceRestored(connection: ConnectionFixture, sessionId: string) {
  const calls = connection.calls.filter((call) => call.sessionId === sessionId);
  expect(
    calls.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params,
  ).toEqual({
    width: 412,
    height: 839,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenWidth: 430,
    screenHeight: 900,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  expect(
    calls.find((call) => call.method === "Emulation.setTouchEmulationEnabled")?.params,
  ).toEqual({ enabled: true, maxTouchPoints: 5 });
  // Target-scoped: lets a page behind another tab acknowledge input without being raised.
  expect(
    calls.find((call) => call.method === "Emulation.setFocusEmulationEnabled")?.params,
  ).toEqual({ enabled: true });
  expect(calls.find((call) => call.method === "Emulation.setUserAgentOverride")?.params).toEqual({
    userAgent: "fixture-mobile-agent",
    platform: "Android",
  });
}

describe("session-owned device emulation restoration", () => {
  it("restores full retained settings before publishing a newly selected target", async () => {
    const { runtime, connection, control } = fixture();
    const publications: (CdpSession | null)[] = [];
    connection.intercept = async (method) => {
      if (method.startsWith("Emulation.")) publications.push(control.page);
    };
    await runtime.selectTarget("b");
    expect(publications).toEqual([null, null, null, null]);
    expect(control.page?.targetId).toBe("b");
    expect(control.emulationAppliedPage).toBe(control.page);
    expect(control.viewport.captureScale).toBe(2);
    assertDeviceRestored(connection, control.page!.sessionId);
  });

  it("reconnect restores the device on the replacement transport rather than the old connection", async () => {
    const { runtime, connection, control } = fixture();
    const replacement = new ConnectionFixture();
    control.assertVersion = async () => {};
    control.connectCdp = async () => {
      control.connection = replacement as unknown as CdpConnection;
      await runtime.selectTarget("a");
    };
    await runtime.reconnect();
    expect(connection.isOpen).toBe(false);
    expect(control.page?.connection).toBe(control.connection);
    assertDeviceRestored(replacement, control.page!.sessionId);
  });

  it("screencast retry detaches the old controller before applying replacement metrics", async () => {
    const { connection, control, previous } = fixture();
    const restored = await control.reattachPageForScreencast(previous);
    const detach = connection.calls.findIndex((call) => call.method === "Target.detachFromTarget");
    const metrics = connection.calls.findIndex(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(detach).toBeGreaterThanOrEqual(0);
    expect(metrics).toBeGreaterThan(detach);
    expect(control.page).toBe(restored);
    assertDeviceRestored(connection, restored.sessionId);
  });

  it("refuses frame admission after partial restoration fails", async () => {
    const { runtime, connection, control } = fixture();
    connection.intercept = async (method) => {
      if (method === "Emulation.setTouchEmulationEnabled")
        throw new Error("touch restore rejected");
    };
    await expect(runtime.selectTarget("b")).rejects.toThrow("touch restore rejected");
    expect(control.page).toBeNull();
    expect(control.emulationAppliedPage).toBeNull();
    expect(
      connection.calls.some(
        (call) => call.method === "Target.detachFromTarget" && call.params.sessionId === "new-1",
      ),
    ).toBe(true);
    control.assertVersion = async () => {
      throw new Error("transport unavailable");
    };
    await expect(runtime.frame(1024, 95, 0)).rejects.toThrow("transport unavailable");
    expect(
      connection.calls.some(
        (call) =>
          call.method === "Page.captureScreenshot" || call.method === "Page.startScreencast",
      ),
    ).toBe(false);
  });

  it("rejects a disconnect while restoring rather than publishing the detached session", async () => {
    const { runtime, connection, control } = fixture();
    connection.intercept = async (method) => {
      if (method === "Emulation.setUserAgentOverride") connection.close();
    };
    await expect(runtime.selectTarget("b")).rejects.toThrow("attachment changed");
    expect(control.page).toBeNull();
    expect(control.emulationAppliedPage).toBeNull();
  });

  it("repairs the winning attachment after a stale restoring controller is detached", async () => {
    const { runtime, connection, control } = fixture();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    connection.intercept = async (method, sessionId) => {
      if (method === "Emulation.setUserAgentOverride" && sessionId === "new-1") {
        reached.resolve();
        await gate.promise;
      }
    };
    const older = runtime.selectTarget("a");
    await reached.promise;
    await runtime.selectTarget("b");
    const winner = control.page;
    expect(control.emulationAppliedPage).toBe(winner);
    gate.resolve();
    await expect(older).rejects.toThrow("attachment changed");
    expect(control.page).toBe(winner);
    expect(control.emulationAppliedPage).toBeNull();
    control.screencastActive = true;
    control.onScreencastFrame(winner!, { data: "ignored", metadata: {}, sessionId: 4 });
    expect(control.screencastFrame).toBeNull();
    expect(await control.requirePage()).toBe(winner);
    expect(control.emulationAppliedPage).toBe(winner);
    assertDeviceRestored(connection, winner!.sessionId);
  });

  it("refuses retry publication if detaching the prior emulation controller fails", async () => {
    const { connection, control, previous } = fixture();
    connection.intercept = async (method) => {
      if (method === "Target.detachFromTarget") throw new Error("detach outcome unknown");
    };
    await expect(control.reattachPageForScreencast(previous)).rejects.toThrow(
      "detach outcome unknown",
    );
    expect(control.page).toBeNull();
    expect(control.emulationAppliedPage).toBeNull();
    expect(
      connection.calls.some(
        (call) => call.method.startsWith("Emulation.") || call.method === "Page.startScreencast",
      ),
    ).toBe(false);
  });

  it("invalidates winner readiness after detaching a superseded retry controller", async () => {
    const { runtime, connection, control, previous } = fixture();
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let first = true;
    connection.intercept = async (method) => {
      if (method === "Target.attachToTarget" && first) {
        first = false;
        reached.resolve();
        await gate.promise;
      }
    };
    const retry = control.reattachPageForScreencast(previous);
    await reached.promise;
    await runtime.selectTarget("b");
    const winner = control.page;
    gate.resolve();
    expect(await retry).toBe(winner);
    expect(control.page).toBe(winner);
    expect(control.emulationAppliedPage).toBeNull();
    expect(await control.requirePage()).toBe(winner);
    expect(control.emulationAppliedPage).toBe(winner);
  });
});
