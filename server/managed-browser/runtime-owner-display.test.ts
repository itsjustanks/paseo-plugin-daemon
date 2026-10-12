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

it("ignores display/video environment opt-ins and keeps browser ownership private", async () => {
  vi.stubEnv("HOSTS_BROWSER_XVFB", "1");
  vi.stubEnv("HOSTS_BROWSER_VIDEO", "1");
  const owner = await createRuntimeOwner({ nativeVideo: true, virtualDisplay: true, runtimeRoot: "/tmp/immutable-owned-runtime" });
  const runtime = await owner.create("workspace-fixture");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false, nativeVideo: false,
    binaryPath: "/tmp/immutable-owned-runtime/node_modules/.bin/agent-browser",
    executablePath: "/tmp/immutable-owned-runtime/chromium/chrome", initialUrl: "about:blank" });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  await owner.stop(runtime);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
});
