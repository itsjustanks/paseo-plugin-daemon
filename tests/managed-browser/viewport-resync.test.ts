import { describe, expect, it } from "vitest";
import { AgentBrowserRuntime, jpegDimensions } from "../../server/managed-browser/agent-browser-runtime";

function jpeg(width: number, height: number): string {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
  const comment = Buffer.from([0xff, 0xfe, 0, 4, 0x41, 0x42]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    comment,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]).toString("base64");
}

function fakeRuntime(
  heights: number[],
  viewport = { width: 1280, height: 800 },
  captureScale = 1,
  dpr = 1,
) {
  const calls: string[] = [];
  const page = {
    async send(
      method: string,
    ): Promise<{ data?: string; cssVisualViewport?: { pageX: number; pageY: number } }> {
      calls.push(method);
      if (method === "Page.captureScreenshot") {
        const height = heights.shift() ?? 800;
        return { data: jpeg(viewport.width * captureScale, height) };
      }
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 3, pageY: 20 } };
      return {};
    },
  };
  const runtime = new AgentBrowserRuntime({
    binaryPath: "/bin/true",
    executablePath: "/bin/true",
    profilePath: "/tmp/p",
    ipcDirectory: "/tmp/i",
    session: "fake",
  });
  const connection = { isOpen: true };
  Object.assign(runtime, {
    page,
    emulationAppliedPage: page,
    connection,
    viewport: { ...viewport, deviceScaleFactor: dpr, captureScale, mobile: false, touch: false },
  });
  const control = runtime as unknown as { requirePage: () => Promise<typeof page> };
  Object.assign(page, { connection });
  control.requirePage = async () => page;
  return { runtime, calls, page };
}

describe("jpegDimensions", () => {
  it("reads the frame size past other segments", () => {
    expect(jpegDimensions(jpeg(1280, 633))).toEqual({ width: 1280, height: 633 });
  });
  it("returns null for non-JPEG data", () => {
    expect(jpegDimensions(Buffer.from("not a jpeg").toString("base64"))).toBeNull();
  });
});

describe("fallback frame viewport resync", () => {
  it("returns the first capture untouched when dimensions agree", async () => {
    const { runtime, calls } = fakeRuntime([800]);
    expect((await runtime.frame(1_000_000, 65, 1)).height).toBe(800);
    expect(calls).not.toContain("Emulation.setDeviceMetricsOverride");
  });

  it("re-applies emulation and recaptures once when the JPEG height drifts", async () => {
    const { runtime, calls } = fakeRuntime([633, 800]);
    const frame = await runtime.frame(1_000_000, 65, 1);
    expect(frame).toMatchObject({ width: 1280, height: 800 });
    expect(calls.filter((call) => call === "Emulation.setDeviceMetricsOverride")).toHaveLength(1);
    expect(calls.filter((call) => call === "Page.captureScreenshot")).toHaveLength(2);
  });

  it("fails instead of reporting stale metadata when the resync does not help", async () => {
    const { runtime, calls } = fakeRuntime([633, 577, 800]);
    await expect(runtime.frame(1_000_000, 65, 1)).rejects.toThrow("1280x577 JPEG");
    expect(calls.filter((call) => call === "Page.captureScreenshot")).toHaveLength(2);
  });
});

it("recovers to captureScale pixels independently of mobile DPR", async () => {
  const { runtime, calls } = fakeRuntime([600, 1600], { width: 1280, height: 800 }, 2, 3);
  expect(await runtime.frame(1000000, 65, 1)).toMatchObject({ width: 2560, height: 1600 });
  expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(2);
});

it("rejects malformed JPEG without using it to trigger viewport recovery", async () => {
  const { runtime, calls, page } = fakeRuntime([800]);
  const original = page.send;
  page.send = async (method: string) =>
    method === "Page.captureScreenshot"
      ? { data: Buffer.from("not a jpeg").toString("base64") }
      : original(method);
  await expect(runtime.frame(1000000, 65, 1)).rejects.toThrow("malformed JPEG");
  expect(calls).not.toContain("Emulation.setDeviceMetricsOverride");
});

it("drops viewport recovery after a mutation supersedes capture", async () => {
  const { runtime, calls, page } = fakeRuntime([633, 800]);
  const original = page.send;
  page.send = async (method: string) => {
    const result = await original(method);
    if (method === "Emulation.setDeviceMetricsOverride") {
      (runtime as unknown as { invalidateScreencastFrame(): void }).invalidateScreencastFrame();
    }
    return result;
  };
  await expect(runtime.frame(1000000, 65, 1)).rejects.toThrow("invalidated");
  expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(1);
});

it("captures the requested viewer quality instead of reusing a different-quality stream", async () => {
  const { runtime, calls, page } = fakeRuntime([800]);
  Object.assign(runtime, {
    screencastFrame: {
      dataBase64: jpeg(1280, 800),
      byteLength: Buffer.byteLength(jpeg(1280, 800), "base64"),
      width: 1280,
      height: 800,
      transport: "cdp-screencast",
      capturedAt: new Date().toISOString(),
    },
  });
  let requestedQuality: unknown;
  const send = page.send;
  page.send = async (method: string, ...args: unknown[]) => {
    if (method === "Page.captureScreenshot") {
      requestedQuality = (args[0] as { quality: number }).quality;
    }
    return send(method);
  };
  expect((await runtime.frame(1_000_000, 40, 0)).transport).toBe("screenshot");
  expect(requestedQuality).toBe(40);
  expect(calls.filter((method) => method === "Page.captureScreenshot")).toHaveLength(1);
});
