import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";
import { resolveBrowserRuntimeRoot } from "../../server/managed-browser/runtime-path";
import type { JsonValue } from "../../server/managed-browser/runtime-protocol";
import { RuntimeSupervisor } from "../../server/managed-browser/supervisor";
import type { BrowserState } from "../../shared/managed-browser/browser";

const available = process.platform === "linux" && existsSync("/usr/bin/Xvfb");
const roots: string[] = [];
const saved = { ...process.env };
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Auth directories this test's private TMPDIR holds: one per live owned display. */
function displayDirectories(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("paseo-browser-display-"));
}

/** Xvfb processes whose `-auth` argument lives under this test's private TMPDIR only. */
function ownedXvfbPids(root: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const auth = argv[argv.indexOf("-auth") + 1] ?? "";
      if (argv[0] === "/usr/bin/Xvfb" && auth.startsWith(join(root, "paseo-browser-display-")))
        pids.push(Number(entry));
    } catch {
      /* The process exited while scanning. */
    }
  }
  return pids;
}

const page = `<!doctype html><title>pending</title><script>
const read = () => { document.title = [matchMedia("(hover: hover)").matches, matchMedia("(pointer: fine)").matches].join(","); };
read(); setInterval(read, 50);
</script>`;

async function harness(env: Record<string, string | undefined>, virtualDisplay?: boolean) {
  const root = await mkdtemp(join(tmpdir(), "sbx-"));
  roots.push(root);
  process.env.TMPDIR = root;
  process.env.PASEO_HOME = join(root, "home");
  // Same resolution as browser.smoke: explicit overrides, else the runtime prepared in the original PASEO_HOME.
  const runtimeRoot = resolveBrowserRuntimeRoot(saved.PASEO_HOME ?? join(homedir(), ".paseo"));
  process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY =
    saved.HOSTS_BROWSER_AGENT_BROWSER_BINARY ??
    join(runtimeRoot, "node_modules", ".bin", "agent-browser");
  process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE =
    saved.HOSTS_BROWSER_CHROMIUM_EXECUTABLE ?? join(runtimeRoot, "chromium", "chrome");
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Smoke listener has no port");
  const supervisor = new RuntimeSupervisor({
    owner: await createRuntimeOwner({
      initialUrl: `http://127.0.0.1:${address.port}/`,
      ...(virtualDisplay === undefined ? {} : { virtualDisplay }),
    }),
  });
  // agent-browser keys daemon state by session, so each harness needs its own workspace.
  const workspaceId = `xvfb-smoke-${randomUUID()}`;
  const lease = supervisor.claimBridge("xvfb-smoke");
  const request = async <T>(operation: string, input: unknown): Promise<T> =>
    (await supervisor.dispatch({
      version: 3,
      id: "xvfb-smoke",
      token: "unused-by-direct-fixture",
      bridgeId: "xvfb-smoke",
      epoch: lease.epoch,
      method: "browser.request",
      operation,
      input: input as JsonValue,
    })) as T;
  const attach = () =>
    request<{ viewerToken: string; state: BrowserState }>("attach", { create: true,
      workspaceId,
      viewerLabel: "Smoke",
    });
  const control = async (viewerToken: string) =>
    (
      await request<{ controlToken: string; state: BrowserState }>("acquire-control", {
        viewerToken,
      })
    ).controlToken;
  const guard = (state: BrowserState) => ({
    sessionId: state.sessionId,
    runtimeId: state.runtimeId,
    bridgeEpoch: state.bridgeEpoch,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  });
  const preset = async (viewerToken: string, controlToken: string, presetId: string) => {
    const { state } = await request<{ state: BrowserState }>("status", { viewerToken });
    return request<{ state: BrowserState }>("device", {
      viewerToken,
      controlToken,
      expected: guard(state),
      presetId,
    });
  };
  const title = async (viewerToken: string) =>
    (await request<{ state: BrowserState }>("status", { viewerToken })).state.title;
  const close = async () => {
    await supervisor.stopAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { root, attach, control, guard, preset, title, request, close };
}

describe.skipIf(!available)("private Xvfb hover (Linux)", () => {
  it("stays headless without the opt-in and lets an explicit false override the environment", async () => {
    const unset = await harness({ HOSTS_BROWSER_XVFB: undefined });
    try {
      const viewer = await unset.attach();
      expect(displayDirectories(unset.root)).toEqual([]);
      expect(ownedXvfbPids(unset.root)).toEqual([]);
      await vi.waitFor(async () =>
        expect(await unset.title(viewer.viewerToken)).toBe("false,false"),
      );
    } finally {
      await unset.close();
    }
    const overridden = await harness({ HOSTS_BROWSER_XVFB: "1" }, false);
    try {
      await overridden.attach();
      expect(ownedXvfbPids(overridden.root)).toEqual([]);
    } finally {
      await overridden.close();
    }
  }, 60_000);

  it("opts in to hover after desktop, mobile, desktop and recovers an explicit reconnect after display death", async () => {
    const h = await harness({ HOSTS_BROWSER_XVFB: "1" });
    try {
      const first = await h.attach();
      const control = await h.control(first.viewerToken);
      const [pid] = ownedXvfbPids(h.root);
      expect(ownedXvfbPids(h.root)).toHaveLength(1);
      await vi.waitFor(async () => expect(await h.title(first.viewerToken)).toBe("true,true"));
      const mobile = await h.preset(first.viewerToken, control, "pixel-7");
      await vi.waitFor(async () => expect(await h.title(first.viewerToken)).toBe("false,false"));
      const desktop = await h.preset(first.viewerToken, control, "desktop-chrome");
      await vi.waitFor(async () => expect(await h.title(first.viewerToken)).toBe("true,true"));
      expect(desktop.state.viewportGeneration).toBeGreaterThan(mobile.state.viewportGeneration);

      // Kill only the Xvfb verified above as owned by this test's private TMPDIR.
      expect(ownedXvfbPids(h.root)).toEqual([pid]);
      process.kill(pid as number, "SIGKILL");
      await vi.waitFor(async () => {
        const { state } = await h.request<{ state: BrowserState }>("status", {
          viewerToken: first.viewerToken,
        });
        expect(state.status).toBe("error");
        expect(state.error).toContain("display ended");
      });

      const second = await h.attach();
      expect(second.state.status).toBe("ready");
      expect(second.state.sessionId).not.toBe(first.state.sessionId);
      expect(second.state.runtimeId).not.toBe(first.state.runtimeId);
      const owned = ownedXvfbPids(h.root);
      expect(owned).toHaveLength(1);
      expect(owned[0]).not.toBe(pid);
      await vi.waitFor(async () => expect(await h.title(second.viewerToken)).toBe("true,true"));

      await expect(h.title(first.viewerToken)).rejects.toThrow();
      await expect(
        h.request("input", {
          viewerToken: first.viewerToken,
          controlToken: control,
          expected: h.guard(desktop.state),
          event: { kind: "move", point: { x: 10, y: 10 } },
        }),
      ).rejects.toThrow();
    } finally {
      await h.close();
    }
    expect(ownedXvfbPids(h.root)).toEqual([]);
    expect(displayDirectories(h.root)).toEqual([]);
  }, 90_000);
});
