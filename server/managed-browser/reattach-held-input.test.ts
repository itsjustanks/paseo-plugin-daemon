import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
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
  mobile: true,
  touch: true,
  screenWidth: 430,
  screenHeight: 900,
  userAgent: "fixture-mobile-agent",
  platform: "Android",
};

const generation = (runtime: AgentBrowserRuntime) => {
  const { attachmentGeneration, documentGeneration } = runtime as unknown as {
    attachmentGeneration: number;
    documentGeneration: number;
  };
  return `${attachmentGeneration}:${documentGeneration}`;
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

it("never releases input held on an older attachment onto a later one during screencast retry", async () => {
  const { runtime, connection, control } = fixture();
  await runtime.beginLiveInput("old-channel", generation(runtime));
  await runtime.mouseDown(10, 20, "left", 1, "old-channel");
  // Real reconnect + target publication; only transport setup is replaced.
  const reconnected = new ConnectionFixture();
  control.assertVersion = async () => {};
  control.connectCdp = async () => {
    control.connection = reconnected as unknown as CdpConnection;
    await runtime.selectTarget("b");
  };
  await runtime.reconnect();
  expect(connection.isOpen).toBe(false);
  await control.reattachPageForScreencast(control.page!);
  expect(reconnected.calls.filter((call) => call.params.type === "mouseReleased")).toEqual([]);
  await runtime.endLiveInput("old-channel");
});

it("still releases held input on its own attachment before reattach detaches it", async () => {
  const { runtime, connection, control, previous } = fixture();
  await runtime.beginLiveInput("channel", generation(runtime));
  await runtime.mouseDown(10, 20, "left", 1, "channel");
  await control.reattachPageForScreencast(previous);
  const order = connection.calls.map((call) => call.params.type ?? call.method);
  expect(order.indexOf("mouseReleased")).toBeGreaterThan(-1);
  expect(order.indexOf("mouseReleased")).toBeLessThan(order.indexOf("Target.detachFromTarget"));
  expect(connection.calls.find((call) => call.params.type === "mouseReleased")).toMatchObject({
    sessionId: "previous",
    params: { x: 10, y: 20 },
  });
});

it("does not retarget ungestured held input from a replaced attachment onto its replacement", async () => {
  const { runtime, connection, control } = fixture();
  await runtime.mouseDown(10, 20, "left", 1);
  const reconnected = new ConnectionFixture();
  control.assertVersion = async () => {};
  control.connectCdp = async () => {
    control.connection = reconnected as unknown as CdpConnection;
    await runtime.selectTarget("b");
  };
  await runtime.reconnect();
  expect(connection.isOpen).toBe(false);
  await control.reattachPageForScreencast(control.page!);
  expect(reconnected.calls.filter((call) => call.params.type === "mouseReleased")).toEqual([]);
});
