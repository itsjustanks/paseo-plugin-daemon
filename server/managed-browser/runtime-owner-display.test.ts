import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "./runtime-owner";
import { RuntimeLostError } from "./runtime-protocol";
import { PrivateDisplayError } from "./virtual-display";

const fake = vi.hoisted(() => ({
  display: vi.fn(),
  runtime: vi.fn(),
  launch: vi.fn(),
  shutdown: vi.fn(),
  assertAvailable: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./virtual-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./virtual-display")>()),
  createPrivateVirtualDisplay: fake.display,
}));
vi.mock("./runtime-path", () => ({
  resolveBrowserRuntimeRoot: () => "/tmp/owned-runtime-fixture",
}));
vi.mock("./agent-browser-runtime", () => ({
  AgentBrowserRuntime: class {
    launch = fake.launch;
    shutdown = fake.shutdown;
    identity = async () => ({ userAgent: "Fixture" });
    constructor(options: unknown) {
      fake.runtime(options);
    }
  },
}));
afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.stubEnv("HOSTS_BROWSER_XVFB", undefined);
  vi.clearAllMocks();
  fake.assertAvailable.mockReset();
  fake.launch.mockResolvedValue(undefined);
  fake.shutdown.mockResolvedValue(undefined);
  fake.stop.mockResolvedValue(undefined);
  fake.display.mockResolvedValue({
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
});

it("keeps display provisioning disabled and selects only the managed video capability", async () => {
  vi.stubEnv("HOSTS_BROWSER_XVFB", "1");
  vi.stubEnv("HOSTS_BROWSER_VIDEO", "1");
  const owner = await createRuntimeOwner({ nativeVideo: true, virtualDisplay: true, runtimeRoot: "/tmp/immutable-owned-runtime" });
  const runtime = await owner.create("workspace-fixture");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false, nativeVideo: true,
    binaryPath: "/tmp/immutable-owned-runtime/node_modules/.bin/agent-browser",
    executablePath: "/tmp/immutable-owned-runtime/chromium/chrome", initialUrl: "about:blank" });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  await owner.stop(runtime);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
});

it.each([undefined, "0", "1"])("managed video defaults on with host override %s", async (value) => {
  vi.stubEnv("HOSTS_BROWSER_VIDEO", value);
  const owner = await createRuntimeOwner({ runtimeRoot: "/tmp/immutable-owned-runtime" });
  const runtime = await owner.create("video-workspace-fixture");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ nativeVideo: value !== "0" });
  await owner.stop(runtime);
});
it("explicit video false overrides the host default without provisioning a display", async () => {
  vi.stubEnv("HOSTS_BROWSER_VIDEO", "1");
  const owner = await createRuntimeOwner({ nativeVideo: false, runtimeRoot: "/tmp/immutable-owned-runtime" });
  const runtime = await owner.create("video-workspace-fixture");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ nativeVideo: false });
  expect(fake.display).not.toHaveBeenCalled(); await owner.stop(runtime);
});
