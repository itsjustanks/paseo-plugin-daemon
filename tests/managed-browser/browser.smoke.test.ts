import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../server/managed-browser/browser-policy";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";
import { resolveBrowserRuntimeRoot } from "../../server/managed-browser/runtime-path";
import { resolveSupervisorPaths, startSupervisorServer } from "../../server/managed-browser/supervisor";
import { SupervisorClient } from "../../server/managed-browser/supervisor-client";
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";
import { DEFAULT_CAPTURE_QUALITY } from "../../shared/managed-browser/capture-settings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

function target(frame: BrowserFrame) {
  return {
    frameId: frame.frameId,
    navigationGeneration: frame.navigationGeneration,
    viewportGeneration: frame.viewportGeneration,
  };
}

/** The runtime bounds each browser launch (cold start) by a 15 s command timeout. This test
 * performs two real launches, the initial attach and the explicit reopen after close, so a slow
 * runner (Windows CI cold start is ~14 s) legitimately spends ~29 s in launches alone. Budget both
 * launches at their product bound plus the remaining operations; a hung launch still fails first
 * with the runtime's own named timeout error rather than waiting for this budget. */
const BROWSER_LAUNCH_BOUND_MS = 15_000;
const SMOKE_BUDGET_MS = 2 * BROWSER_LAUNCH_BOUND_MS + 15_000;
vi.setConfig({ testTimeout: SMOKE_BUDGET_MS });

it("shares and persists a production agent-browser runtime across supervisor clients", async () => {
  const preparedHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const runtimeRoot = resolveBrowserRuntimeRoot(preparedHome);
  const binaryPath =
    process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY ??
    join(
      runtimeRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
    );
  const executablePath =
    process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE ??
    join(runtimeRoot, "chromium", process.platform === "win32" ? "chrome.exe" : "chrome");
  await Promise.all([
    access(binaryPath).catch(() => {
      throw new Error(`Browser smoke agent-browser binary is not accessible: ${binaryPath}`);
    }),
    access(executablePath).catch(() => {
      throw new Error(`Browser smoke Chromium executable is not accessible: ${executablePath}`);
    }),
  ]);

  let typedValue = "";
  let clicked = 0;
  let retainedCookie = "";
  let lastUserAgent = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    lastUserAgent = request.headers["user-agent"] ?? "";
    if (url.pathname === "/typed") {
      typedValue = url.searchParams.get("value") ?? "";
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/clicked") {
      clicked += 1;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/set-cookie") {
      response.setHeader(
        "Set-Cookie",
        "hosts-browser-profile=retained; Path=/; Max-Age=3600; SameSite=Lax",
      );
    }
    if (url.pathname === "/read-cookie") retainedCookie = request.headers.cookie ?? "";
    if (url.pathname === "/after-navigation") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><html><body style='background:#123456'>New page</body></html>");
      return;
    }
    const page = `<!doctype html>
      <html><head><title>Shared Browser Smoke</title><style>
        input{position:absolute;left:40px;top:30px;width:220px;height:32px}
        button{position:absolute;left:300px;top:30px;width:140px;height:36px}
        .cursor-case{position:absolute;left:40px;width:400px;height:30px;font:20px/30px monospace;cursor:auto}
        #plain{top:100px} #locked{top:150px;user-select:none}
        #arrow{top:200px;cursor:default} #editor{top:250px}
        #vertical{top:300px;width:30px;height:140px;writing-mode:vertical-rl}
        #link{position:absolute;left:500px;top:100px}
        #shadow{position:absolute;left:500px;top:150px}
      </style></head><body>
        <input aria-label="Shared value" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
        <button onclick="fetch('/clicked')">Record click</button>
        <div id="plain" class="cursor-case">Selectable text</div>
        <div id="locked" class="cursor-case">Non-selectable</div>
        <div id="arrow" class="cursor-case">Explicit arrow</div>
        <div id="editor" class="cursor-case" contenteditable="true"></div>
        <div id="vertical" class="cursor-case">Vertical text</div>
        <a id="link" href="#anchor">Link</a>
        <div id="shadow"></div>
        <script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML = '<span style="cursor:auto;font:20px/30px monospace">Shadow text</span>';</script>
      </body></html>`;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.searchParams.has("delayed")) {
      response.flushHeaders();
      // Real network delay is intentional: fake timers would also stall Chromium's response.
      setTimeout(() => response.end(page), 100);
      return;
    }
    // Stream recovery after fallback needs sustained paint events, which a static
    // page never produces. The cookie page animates so recovery is observable.
    response.end(
      url.pathname === "/set-cookie"
        ? `${page}<style>@keyframes pulse{50%{opacity:.5}}</style><div style="width:8px;height:8px;background:#0a0;animation:pulse .1s infinite"></div>`
        : page,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Smoke listener did not expose a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const paseoHome = await mkdtemp(join(tmpdir(), "hosts-browser-smoke-"));
  roots.push(paseoHome);
  const previousPaseoHome = process.env.PASEO_HOME;
  const previousAgentBrowserBinary = process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY;
  const previousChromiumExecutable = process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE;
  process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY = binaryPath;
  process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE = executablePath;
  process.env.PASEO_HOME = paseoHome;

  const paths = resolveSupervisorPaths(paseoHome);
  const running = await startSupervisorServer(
    await createRuntimeOwner({
      initialUrl: `${origin}/`,
      // agent-browser 0.37.1's private desktop does not start on Windows Server CI.
      headed: process.platform === "win32",
    }),
    paths,
  );
  const createManager = async (bridgeId: string) => {
    const manager = new SessionManager({
      client: new SupervisorClient({ bridgeId, paths }),
      validateWorkspace: async (workspaceId) => workspaceId === "workspace-smoke",
    });
    await manager.connect();
    return manager;
  };

  let manager = await createManager("smoke-bridge-one");
  try {
    const first = await manager.attach("workspace-smoke", "Desktop client");
    expect(first.state.url).toBe(`${origin}/`);
    const second = await manager.attach("workspace-smoke", "Mobile client");
    expect(second.state.sessionId).toBe(first.state.sessionId);
    expect(second.state.viewerCount).toBe(2);
    console.log("browser-smoke: attached");

    const firstControl = await manager.acquireControl(first.viewerToken, false);
    const navigated = await manager.navigate({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstControl.state),
      action: { kind: "goto", url: `${origin}/?delayed=1` },
    });
    expect(navigated.state.url).toBe(`${origin}/?delayed=1`);
    // URL actions acknowledge native navigation; this fixture separately waits
    // for its delayed DOM before exercising the remote input elements below.
    await vi.waitFor(
      async () => {
        const current = await manager.status(first.viewerToken);
        expect(current.state.title).toBe("Shared Browser Smoke");
      },
      { timeout: 5_000 },
    );
    console.log("browser-smoke: navigated");

    let firstCapture = await manager.capture(first.viewerToken, "medium", null);
    expect(firstCapture.frame?.byteLength).toBeLessThanOrEqual(800_000);
    const secondCapture = await manager.capture(second.viewerToken, "medium", null);
    expect(secondCapture.state.sessionId).toBe(firstCapture.state.sessionId);
    expect(secondCapture.state.controller).toBe("other");

    // Exercise actual glyph geometry through the same guarded human RPC path.
    const { runtimeId, bridgeEpoch } = firstCapture.state;
    if (typeof runtimeId !== "string" || typeof bridgeEpoch !== "number") {
      throw new Error("Native cursor fixture requires current runtime identity");
    }
    const cursorContext = {
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: {
        ...expected(firstCapture.state),
        runtimeId,
        bridgeEpoch,
      },
    };
    const channel = await manager.beginGesture({
      ...cursorContext,
      target: target(firstCapture.frame!),
      pointerKind: "mouse",
    });
    if (!("gestureId" in channel) || typeof channel.nextSequence !== "number") {
      throw new Error("Fresh cursor fixture was not admitted");
    }
    let sequence = channel.nextSequence;
    for (const [x, y, cursor] of [
      [45, 115, "text"],
      [390, 115, "default"],
      [45, 165, "default"],
      [45, 215, "default"],
      [390, 265, "text"],
      [55, 305, "vertical-text"],
      [505, 108, "pointer"],
      [505, 165, "text"],
      [150, 46, "text"],
    ] as const) {
      const update = await manager.updateGesture({
        ...cursorContext,
        gestureId: channel.gestureId,
        sequence,
        event: { kind: "move", point: { x, y, width: 1280, height: 800 } },
      });
      expect(update.cursor, `Cursor at ${x},${y}`).toBe(cursor);
      sequence = update.nextSequence;
    }
    await manager.endGesture({
      ...cursorContext,
      gestureId: channel.gestureId,
      sequence,
      cancel: false,
    });
    firstCapture = await manager.capture(first.viewerToken, "medium", null);

    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(firstCapture.state),
      target: target(firstCapture.frame!),
      event: {
        kind: "click",
        point: { x: 75, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    const focused = await manager.capture(first.viewerToken, "medium", null);
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(focused.state),
      target: target(focused.frame!),
      event: { kind: "type", text: "same live page" },
    });
    await vi.waitFor(() => expect(typedValue).toBe("same live page"));

    const buttonFrame = await manager.capture(first.viewerToken, "medium", null);
    await manager.sendInput({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(buttonFrame.state),
      target: target(buttonFrame.frame!),
      event: {
        kind: "click",
        point: { x: 185, y: 23, width: 640, height: 400 },
        button: "left",
        clickCount: 1,
      },
    });
    await vi.waitFor(() => expect(clicked).toBe(1));

    // Two consecutive human presses on the JPEG path, each from its own freshly
    // decoded receipt. An acknowledged press spends the receipt it used.
    const humanPress = async (frame: BrowserFrame, state: BrowserState) => {
      const context = {
        viewerToken: first.viewerToken,
        controlToken: firstControl.controlToken,
        expected: {
          ...expected(state),
          runtimeId: state.runtimeId!,
          bridgeEpoch: state.bridgeEpoch!,
        },
      };
      const begun = await manager.beginGesture({
        ...context,
        target: target(frame),
        pointerKind: "mouse",
      });
      if (!("gestureId" in begun) || typeof begun.nextSequence !== "number") return false;
      const point = { x: 370, y: 46, width: 1280, height: 800 };
      const down = await manager.updateGesture({
        ...context,
        gestureId: begun.gestureId,
        sequence: begun.nextSequence,
        target: target(frame),
        event: { kind: "down", point, button: "left", clickCount: 1 },
      });
      const up = await manager.updateGesture({
        ...context,
        gestureId: begun.gestureId,
        sequence: down.nextSequence,
        event: { kind: "up", point, button: "left", clickCount: 1 },
      });
      await manager.endGesture({
        ...context,
        gestureId: begun.gestureId,
        sequence: up.nextSequence,
        cancel: false,
      });
      return true;
    };
    const pressFrameOne = await manager.capture(first.viewerToken, "medium", null);
    expect(await humanPress(pressFrameOne.frame!, pressFrameOne.state)).toBe(true);
    await vi.waitFor(() => expect(clicked).toBe(2));
    expect(await humanPress(pressFrameOne.frame!, pressFrameOne.state)).toBe(false);
    expect(clicked).toBe(2);
    const pressFrameTwo = await manager.capture(first.viewerToken, "medium", null);
    expect(pressFrameTwo.frame?.frameId).not.toBe(pressFrameOne.frame?.frameId);
    expect(await humanPress(pressFrameTwo.frame!, pressFrameTwo.state)).toBe(true);
    await vi.waitFor(() => expect(clicked).toBe(3));
    console.log("browser-smoke: input");

    const afterNavigation = await manager.navigate({
      viewerToken: first.viewerToken,
      controlToken: firstControl.controlToken,
      expected: expected(buttonFrame.state),
      action: { kind: "goto", url: `${origin}/after-navigation` },
    });
    const postNavigationFrame = await manager.capture(first.viewerToken, "medium", null);
    expect(postNavigationFrame.frame?.dataBase64).not.toBe(buttonFrame.frame?.dataBase64);
    await expect(
      manager.sendInput({
        viewerToken: first.viewerToken,
        controlToken: firstControl.controlToken,
        expected: expected(afterNavigation.state),
        target: target(buttonFrame.frame!),
        event: {
          kind: "click",
          point: { x: 185, y: 23, width: 640, height: 400 },
          button: "left",
          clickCount: 1,
        },
      }),
    ).rejects.toThrow("stale");
    console.log("browser-smoke: stale-frame");

    await manager.releaseControl(first.viewerToken, firstControl.controlToken);
    await expect(manager.detach(first.viewerToken)).resolves.toEqual({ detached: true });
    await expect(manager.detach(second.viewerToken)).resolves.toEqual({ detached: true });
    const resumed = await manager.attach("workspace-smoke", "Reattached client");
    const secondControl = await manager.acquireControl(resumed.viewerToken, false);
    const emulated = await manager.applyDevicePreset({
      viewerToken: resumed.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(secondControl.state),
      presetId: "pixel-7",
    });
    expect(emulated.state.viewport).toEqual({ width: 412, height: 839 });
    expect(emulated.state.userAgent).toContain("Pixel 7");
    await manager.navigate({
      viewerToken: resumed.viewerToken,
      controlToken: secondControl.controlToken,
      expected: expected(emulated.state),
      action: { kind: "goto", url: `${origin}/set-cookie` },
    });
    await vi.waitFor(() => expect(lastUserAgent).toContain("Pixel 7"));
    await vi.waitFor(
      async () => {
        // Only the default quality requests the shared CDP stream. Other viewer
        // qualities intentionally use screenshots without restarting that stream.
        // Leaving fallback needs a 1.5s dwell plus sustained paint events.
        const resumedCapture = await manager.capture(
          resumed.viewerToken,
          DEFAULT_CAPTURE_QUALITY,
          null,
        );
        expect(resumedCapture.frame?.transport).toBe("cdp-screencast");
      },
      { timeout: 10_000, interval: 250 },
    );
    console.log("browser-smoke: emulated");

    manager.disconnect();
    manager = await createManager("smoke-bridge-two");
    const restored = await manager.attach("workspace-smoke", "Reconnected client");
    expect(restored.state.url).toBe(`${origin}/set-cookie`);
    expect(restored.state.viewport).toEqual({ width: 1280, height: 800 });
    const restoredControl = await manager.acquireControl(restored.viewerToken, false);
    await manager.navigate({
      viewerToken: restored.viewerToken,
      controlToken: restoredControl.controlToken,
      expected: expected(restoredControl.state),
      action: { kind: "goto", url: `${origin}/read-cookie` },
    });
    await vi.waitFor(() => expect(retainedCookie).toContain("hosts-browser-profile=retained"));
    console.log("browser-smoke: restored");

    const originalPageUrl = (await manager.status(restored.viewerToken)).state.url;
    const extraTab = await manager.createTab(restored.viewerToken);
    const extraViewer = await manager.attach(
      "workspace-smoke",
      "Second page viewer",
      extraTab.tabId,
    );
    const extraControl = await manager.acquireControl(extraViewer.viewerToken, false);
    retainedCookie = "";
    await manager.navigate({
      viewerToken: extraViewer.viewerToken,
      controlToken: extraControl.controlToken,
      expected: expected(extraControl.state),
      action: { kind: "goto", url: `${origin}/read-cookie` },
    });
    await vi.waitFor(() => expect(retainedCookie).toContain("hosts-browser-profile=retained"));
    const extraFrame = await manager.capture(extraViewer.viewerToken, "medium", null);
    const originalFrame = await manager.capture(restored.viewerToken, "medium", null);
    expect(extraFrame.frame?.byteLength).toBeGreaterThan(0);
    expect(originalFrame.frame?.byteLength).toBeGreaterThan(0);
    expect(extraFrame.state.sessionId).not.toBe(originalFrame.state.sessionId);
    expect((await manager.status(restored.viewerToken)).state.url).toBe(originalPageUrl);
    expect((await manager.status(restored.viewerToken)).state.controller).toBe("self");
    const extraPreset = await manager.applyDevicePreset({
      viewerToken: extraViewer.viewerToken,
      controlToken: extraControl.controlToken,
      expected: expected((await manager.status(extraViewer.viewerToken)).state),
      presetId: "pixel-7",
    });
    expect(extraPreset.state.viewport).toEqual({ width: 412, height: 839 });
    await manager.closeTab({
      viewerToken: restored.viewerToken,
      controlToken: restoredControl.controlToken,
      tabId: restored.state.tabId!,
    });
    await expect(manager.status(restored.viewerToken)).rejects.toThrow("Browser tab is closed");
    expect((await manager.status(extraViewer.viewerToken)).state.url).toBe(`${origin}/read-cookie`);
    expect((await manager.capture(extraViewer.viewerToken, "medium", null)).frame?.width).toBe(412);
    console.log("browser-smoke: independent-tabs");

    await manager.closeBrowser({
      viewerToken: extraViewer.viewerToken,
      controlToken: extraControl.controlToken,
      sessionId: extraViewer.state.sessionId,
      runtimeId: extraViewer.state.runtimeId!,
    });
    await expect(manager.capture(extraViewer.viewerToken, "medium", null)).rejects.toThrow(
      "Browser is closed",
    );
    await expect(manager.attach("workspace-smoke", "Background viewer")).rejects.toThrow(
      "Browser is closed",
    );
    await manager.reopenBrowser("workspace-smoke");
    const reopened = await manager.attach("workspace-smoke", "Explicitly reopened client");
    expect(reopened.state.runtimeId).not.toBe(restored.state.runtimeId);
    const reopenedControl = await manager.acquireControl(reopened.viewerToken, false);
    retainedCookie = "";
    await manager.navigate({
      viewerToken: reopened.viewerToken,
      controlToken: reopenedControl.controlToken,
      expected: expected(reopenedControl.state),
      action: { kind: "goto", url: `${origin}/read-cookie` },
    });
    await vi.waitFor(() => expect(retainedCookie).toContain("hosts-browser-profile=retained"));
    console.log("browser-smoke: closed-and-reopened");

    await manager.archiveWorkspace("workspace-smoke");
    await expect(manager.capture(reopened.viewerToken, "medium", null)).rejects.toThrow(
      "invalid or expired",
    );
    console.log("browser-smoke: archived");
  } finally {
    manager.disconnect();
    await running.close();
    if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousPaseoHome;
    if (previousAgentBrowserBinary === undefined)
      delete process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY;
    else process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY = previousAgentBrowserBinary;
    if (previousChromiumExecutable === undefined)
      delete process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE;
    else process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE = previousChromiumExecutable;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
