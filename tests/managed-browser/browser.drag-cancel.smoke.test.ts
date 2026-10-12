import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../server/managed-browser/browser-policy";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";
import { resolveBrowserRuntimeRoot } from "../../server/managed-browser/runtime-path";
import { resolveSupervisorPaths, startSupervisorServer } from "../../server/managed-browser/supervisor";
import { SupervisorClient } from "../../server/managed-browser/supervisor-client";
import type { BrowserFrame, BrowserGestureEvent, BrowserState } from "../../shared/managed-browser/browser";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const target = (frame: BrowserFrame) => ({
  frameId: frame.frameId,
  navigationGeneration: frame.navigationGeneration,
  viewportGeneration: frame.viewportGeneration,
});

/**
 * Real Chromium: a held left-button drag is cancelled by control takeover. The page must
 * receive its mouseup at the last pointer position (not the page origin), and late events from
 * the cancelled channel must publish nothing. Page-side effects of the release (click, drop,
 * handlers) are deliberately not asserted either way.
 */
it("releases a cancelled held drag at its last pointer position and drops late channel input", async () => {
  // Same resolution as browser.smoke: explicit overrides, else the prepared runtime in PASEO_HOME.
  const preparedHome = process.env.PASEO_HOME;
  // The prepared runtime is consulted only for an executable without an override.
  let runtimeRoot: string | null = null;
  const preparedRuntime = () => {
    if (!preparedHome) throw new Error("Set an isolated, prepared PASEO_HOME");
    runtimeRoot ??= resolveBrowserRuntimeRoot(preparedHome);
    return runtimeRoot;
  };
  const binaryPath =
    process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY ??
    join(
      preparedRuntime(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
    );
  const executablePath =
    process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE ??
    join(preparedRuntime(), "chromium", process.platform === "win32" ? "chrome.exe" : "chrome");
  await Promise.all([access(binaryPath), access(executablePath)]);
  const previousBinary = process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY;
  const previousExecutable = process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE;
  process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY = binaryPath;
  process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE = executablePath;

  const pageEvents: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/log") {
      const { searchParams: q } = url;
      pageEvents.push(`${q.get("e")}@${q.get("x")},${q.get("y")}`);
      response.writeHead(204).end();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Drag Cancel</title></head>
      <body style="margin:0"><div style="position:absolute;left:100px;top:100px;width:200px;height:200px;background:#ccc"></div>
      <script>
        const log = (e) => navigator.sendBeacon('/log?e=' + e.type + '&x=' + e.clientX + '&y=' + e.clientY);
        for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, log, true);
      </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const paseoHome = await mkdtemp(join(tmpdir(), "hosts-browser-drag-"));
  roots.push(paseoHome);
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = paseoHome;
  const paths = resolveSupervisorPaths(paseoHome);
  const running = await startSupervisorServer(
    await createRuntimeOwner({ initialUrl: `${origin}/`, headed: process.platform === "win32" }),
    paths,
  );
  const manager = new SessionManager({
    client: new SupervisorClient({ bridgeId: "drag-cancel-bridge", paths }),
    validateWorkspace: async (workspaceId) => workspaceId === "workspace-drag",
  });
  try {
    await manager.connect();
    const human = await manager.attach("workspace-drag", "Human");
    await vi.waitFor(
      async () => expect((await manager.status(human.viewerToken)).state.title).toBe("Drag Cancel"),
      { timeout: 10_000 },
    );
    const control = await manager.acquireControl(human.viewerToken, false);
    const capture = await manager.capture(human.viewerToken, "medium", null);
    const state: BrowserState = capture.state;
    const context = {
      viewerToken: human.viewerToken,
      controlToken: control.controlToken,
      expected: {
        sessionId: state.sessionId,
        navigationGeneration: state.navigationGeneration,
        viewportGeneration: state.viewportGeneration,
        runtimeId: state.runtimeId as string,
        bridgeEpoch: state.bridgeEpoch as number,
      },
    };
    const point = (x: number, y: number) => ({
      x,
      y,
      width: state.viewport.width,
      height: state.viewport.height,
    });
    const channel = await manager.beginGesture({
      ...context,
      target: target(capture.frame!),
      pointerKind: "mouse",
    });
    if (!("gestureId" in channel)) throw new Error("Gesture not admitted");
    const { gestureId } = channel;
    let sequence = channel.nextSequence as number;
    const send = async (event: BrowserGestureEvent, withTarget = false) => {
      const result = await manager.updateGesture({
        ...context,
        gestureId,
        sequence,
        event,
        ...(withTarget ? { target: target(capture.frame!) } : {}),
      });
      sequence = result.nextSequence;
    };
    await send({ kind: "down", button: "left", clickCount: 1, point: point(150, 150) }, true);
    await send({ kind: "move", point: point(700, 500) });
    await vi.waitFor(() => expect(pageEvents).toContain("mousedown@150,150"));
    expect(pageEvents.some((event) => event.startsWith("mouseup"))).toBe(false);

    // Another viewer taking control cancels the held channel.
    const other = await manager.attach("workspace-drag", "Other");
    await manager.acquireControl(other.viewerToken, true);
    await vi.waitFor(
      () =>
        expect(pageEvents.filter((event) => event.startsWith("mouseup"))).toEqual([
          "mouseup@700,500",
        ]),
      { timeout: 5_000 },
    );
    expect(pageEvents).not.toContain("mouseup@0,0");

    // The cancelled channel cannot publish late input.
    const before = pageEvents.length;
    await expect(
      manager.updateGesture({
        ...context,
        gestureId,
        sequence,
        event: { kind: "up", button: "left", clickCount: 1, point: point(10, 10) },
      }),
    ).rejects.toThrow();
    // Absence check: a real page round trip window is the only way to observe a non-event.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pageEvents.length).toBe(before);
    console.log(`drag-cancel page events: ${pageEvents.join(" ")}`);
  } finally {
    manager.disconnect();
    await running.close();
    if (previousBinary === undefined) delete process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY;
    else process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY = previousBinary;
    if (previousExecutable === undefined)
      delete process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE;
    else process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE = previousExecutable;
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
