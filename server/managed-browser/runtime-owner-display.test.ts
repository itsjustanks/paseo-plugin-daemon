import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "./runtime-owner";
import { PrivateDisplayError, PrivateDisplayCleanupError } from "./virtual-display";

const fake = vi.hoisted(() => ({
  platform: "darwin" as NodeJS.Platform,
  display: vi.fn(),
  reservation: vi.fn(),
  runtime: vi.fn(),
  launch: vi.fn(),
  shutdown: vi.fn(),
  assertAvailable: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => fake.platform,
}));
vi.mock("./virtual-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./virtual-display")>()),
  createPrivateVirtualDisplay: fake.display,
  assertNoRetainedDisplay: fake.reservation,
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
  fake.platform = "darwin";
  vi.stubEnv("HOSTS_BROWSER_XVFB", undefined);
  vi.stubEnv("HOSTS_BROWSER_VIDEO", undefined);
  vi.clearAllMocks();
  fake.assertAvailable.mockReset();
  fake.reservation.mockReset();
  fake.reservation.mockResolvedValue(undefined);
  fake.launch.mockResolvedValue(undefined);
  fake.shutdown.mockResolvedValue(undefined);
  fake.stop.mockResolvedValue(undefined);
  fake.display.mockResolvedValue({
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
});

it("never provisions a display on macOS even when opted in", async () => {
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

it.each([undefined, "1"])("hidden Linux selects image updates before its first launch (video setting %s)", async (video) => {
  fake.platform = "linux";
  vi.stubEnv("HOSTS_BROWSER_VIDEO", video);
  // An inherited desktop is not a managed display; no explicit opt-in means images.
  vi.stubEnv("DISPLAY", ":0");
  const owner = await createRuntimeOwner({ virtualDisplay: false });
  const runtime = await owner.create("linux-workspace");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false, nativeVideo: false });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.launch).toHaveBeenCalledTimes(1);
  await expect(owner.request(runtime, "identity", {})).resolves.toMatchObject({
    displayNotice: "Live video isn't available without a virtual display on this computer.",
  });
  await owner.stop(runtime);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
  expect(fake.stop).not.toHaveBeenCalled();
});

it("a hidden Linux launch failure is returned without retrying or changing its display mode", async () => {
  fake.platform = "linux";
  fake.launch.mockRejectedValue(new Error("fixture launch failed"));
  const owner = await createRuntimeOwner({ nativeVideo: true });
  await expect(owner.create("linux-failure")).rejects.toThrow("fixture launch failed");
  expect(fake.runtime).toHaveBeenCalledTimes(1);
  expect(fake.launch).toHaveBeenCalledTimes(1);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
});

it("explicit Linux headed mode retains the caller's video capability", async () => {
  fake.platform = "linux";
  const owner = await createRuntimeOwner({ headed: true, nativeVideo: true });
  const runtime = await owner.create("headed-workspace");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: true, nativeVideo: true });
  expect(fake.display).not.toHaveBeenCalled();
  await expect(owner.request(runtime, "identity", {})).resolves.not.toHaveProperty("displayNotice");
  await owner.stop(runtime);
});

it("an explicit Linux video opt-out does not report a missing display", async () => {
  fake.platform = "linux";
  const owner = await createRuntimeOwner({ nativeVideo: false });
  const runtime = await owner.create("image-workspace");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ nativeVideo: false });
  await expect(owner.request(runtime, "identity", {})).resolves.not.toHaveProperty("displayNotice");
  await owner.stop(runtime);
});


it.each(["environment", "option"])("opts hidden Linux video into an owned display through %s only", async (choice) => {
  fake.platform = "linux";
  vi.stubEnv("HOSTS_BROWSER_XVFB", choice === "environment" ? "1" : undefined);
  vi.stubEnv("DISPLAY", ":0"); vi.stubEnv("XAUTHORITY", "/unrelated/user/authority");
  const owner = await createRuntimeOwner(choice === "option" ? { virtualDisplay: true } : {});
  const runtime = await owner.create("private-display-workspace");
  expect(fake.display).toHaveBeenCalledOnce();
  expect(fake.display.mock.calls[0]![0].root).toContain("/plugin-data/daemon-link/browser/displays/");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: true, nativeVideo: true,
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" } });
  expect(fake.display.mock.invocationCallOrder[0]).toBeLessThan(fake.runtime.mock.invocationCallOrder[0]!);
  await owner.stop(runtime); expect(fake.stop).toHaveBeenCalledOnce();
});
it.each([{ virtualDisplay: false }, { nativeVideo: false }])("explicit opt-out %j wins over the display environment opt-in", async (options) => {
  fake.platform = "linux"; vi.stubEnv("HOSTS_BROWSER_XVFB", "1");
  const owner = await createRuntimeOwner(options); const runtime = await owner.create("opt-out");
  expect(fake.display).not.toHaveBeenCalled(); expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false, nativeVideo: false }); await owner.stop(runtime);
});
it("video environment off prevents display provisioning", async () => {
  fake.platform = "linux"; vi.stubEnv("HOSTS_BROWSER_XVFB", "1"); vi.stubEnv("HOSTS_BROWSER_VIDEO", "0");
  const owner = await createRuntimeOwner(); const runtime = await owner.create("video-off"); expect(fake.display).not.toHaveBeenCalled(); await owner.stop(runtime);
});
it.each([null, new PrivateDisplayError("Private browser display executable is not trusted or usable")])("missing or confirmed failed display chooses images before a single browser launch (%s)", async (failure) => {
  fake.platform = "linux"; if (failure) fake.display.mockRejectedValue(failure); else fake.display.mockResolvedValue(null);
  const owner = await createRuntimeOwner({ virtualDisplay: true }); const runtime = await owner.create("display-unavailable");
  expect(fake.runtime).toHaveBeenCalledOnce(); expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: false, nativeVideo: false }); expect(fake.launch).toHaveBeenCalledOnce();
  await expect(owner.request(runtime, "identity", {})).resolves.toHaveProperty("displayNotice"); await owner.stop(runtime);
});
it("unknown display cleanup blocks fallback and an existing reservation blocks later replacement even with opt-out", async () => {
  fake.platform = "linux"; fake.display.mockRejectedValue(new PrivateDisplayCleanupError());
  const owner = await createRuntimeOwner({ virtualDisplay: true }); await expect(owner.create("retained")).rejects.toBeInstanceOf(PrivateDisplayCleanupError);
  expect(fake.runtime).not.toHaveBeenCalled(); fake.reservation.mockRejectedValue(new PrivateDisplayCleanupError());
  const optedOut = await createRuntimeOwner({ virtualDisplay: false }); await expect(optedOut.create("retained")).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.runtime).not.toHaveBeenCalled();
});
it("browser launch failure stops the owned display without trying another browser", async () => {
  fake.platform = "linux"; fake.launch.mockRejectedValue(Error("fixture browser failure")); const owner = await createRuntimeOwner({ virtualDisplay: true });
  await expect(owner.create("browser-failed")).rejects.toThrow("fixture browser failure"); expect(fake.runtime).toHaveBeenCalledOnce(); expect(fake.stop).toHaveBeenCalledOnce();
});
it("display shutdown uncertainty is propagated and never converted into a fallback launch", async () => {
  fake.platform = "linux"; fake.stop.mockRejectedValue(new PrivateDisplayCleanupError()); const owner = await createRuntimeOwner({ virtualDisplay: true }); const runtime = await owner.create("cleanup-unknown");
  await expect(owner.stop(runtime)).rejects.toBeInstanceOf(PrivateDisplayCleanupError); expect(fake.runtime).toHaveBeenCalledOnce();
});

it("keeps the display when normal browser shutdown is unconfirmed", async () => {
  fake.platform = "linux"; const owner = await createRuntimeOwner({ virtualDisplay: true }); const runtime = await owner.create("browser-shutdown-unknown");
  fake.shutdown.mockRejectedValue(Error("fixture browser still live")); await expect(owner.stop(runtime)).rejects.toThrow("fixture browser still live"); expect(fake.stop).not.toHaveBeenCalled();
});
it("failed browser launch plus unconfirmed browser cleanup retains display and never retries", async () => {
  fake.platform = "linux"; fake.launch.mockRejectedValue(Error("fixture launch failed")); fake.shutdown.mockRejectedValue(Error("fixture cleanup unknown"));
  const owner = await createRuntimeOwner({ virtualDisplay: true }); await expect(owner.create("launch-cleanup-unknown")).rejects.toThrow("cleanup was not confirmed"); expect(fake.stop).not.toHaveBeenCalled(); expect(fake.runtime).toHaveBeenCalledOnce();
});
