/** Actual plugin bridge socket: a held media reply must not delay a later input command. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";
import type { BrowserVideoReadReply } from "../../shared/managed-browser/browser-video";
import { RuntimeProtocolError } from "./runtime-protocol";
import { resolveSupervisorPaths, startSupervisorServer } from "./supervisor";
import { SupervisorClient } from "./supervisor-client";

it("keeps video past unrelated teardown and input past video on the authenticated socket", async () => {
  const home = await mkdtemp(join(tmpdir(), "owned-video-socket-"));
  let release = () => {};
  let started = () => {};
  let block = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retirementGate = Promise.withResolvers<void>();
  const retirementStarted = Promise.withResolvers<void>();
  let blockRetirement = false;
  let retirement: Promise<unknown> | null = null;
  const stateGate = Promise.withResolvers<void>();
  const inputPublished = Promise.withResolvers<void>();
  let blockState = false;
  let jpegQuality: unknown;
  let videoSequence = 0;
  const calls: string[] = [];
  const running = await startSupervisorServer(
    {
      create: async () => ({ runtimeId: "r".repeat(32) }),
      stop: async () => {},
      request: async (_runtime, operation, parameters) => {
        calls.push(operation);
        if (operation === "screencast.stop" && blockRetirement) {
          retirementStarted.resolve();
          await retirementGate.promise;
        }
        if (operation === "identity") return { userAgent: "Owned fixture" };
        if (operation === "frame") {
          jpegQuality = (parameters as { quality?: unknown }).quality;
          return {
            dataBase64: "AA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date().toISOString(),
          };
        }
        if (operation === "mouse.move") inputPublished.resolve();
        if (operation === "state") {
          if (blockState) await stateGate.promise;
          return {
            url: "https://fixture.invalid/",
            title: "Owned",
            inputGeneration: "1:1",
            canGoBack: false,
            canGoForward: false,
          };
        }
        if (operation === "video.read") {
          if (block) {
            started();
            await gate;
          }
          return {
            status: "ready",
            streamId: "s".repeat(32),
            inputGeneration: "1:1",
            packets: [
              {
                streamId: "s".repeat(32),
                captureGeneration: 1,
                sequence: ++videoSequence,
                timestampUs: 1000,
                type: "key",
                codec: "vp8",
                width: 1280,
                height: 800,
                dataBase64: "AA==",
                capturedAt: new Date().toISOString(),
                capturedAtMonotonicMs: performance.now(),
              },
            ],
          };
        }
        return null;
      },
    },
    resolveSupervisorPaths(home),
  );
  const client = new SupervisorClient({
    bridgeId: "owned-video-socket",
    paths: resolveSupervisorPaths(home),
  });
  type MediaReply = {
    state: BrowserState;
    frame?: BrowserFrame | null;
    packets?: BrowserVideoReadReply["packets"];
  };
  let pending: Promise<MediaReply> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await client.connect();
    const attached = await client.requestBrowser<{ viewerToken: string }>("attach", { create: true,
      workspaceId: "owned",
      viewerLabel: "Owned fixture",
    });
    const control = await client.requestBrowser<{ controlToken: string; state: BrowserState }>(
      "acquire-control",
      { viewerToken: attached.viewerToken },
    );
    const input = {
      viewerToken: attached.viewerToken,
      quality: "high",
      streamId: null,
      afterSequence: 0,
      waitMs: 250,
      requestKeyFrame: false,
    };
    const maximum = await client.requestBrowser<MediaReply>("capture", {
      viewerToken: attached.viewerToken,
      quality: "maximum",
    });
    expect(maximum.frame?.mimeType).toBe("image/jpeg");
    expect(jpegQuality).toBe(100);
    const initial = await client.requestBrowser<MediaReply>("video.read", input);
    // Switching panels can retire one workspace while another keeps playing.
    // Its native teardown must not occupy the shared socket's video lane.
    const retiring = await client.requestBrowser<{ viewerToken: string }>("attach", { create: true,
      workspaceId: "retiring",
      viewerLabel: "Retiring fixture",
    });
    blockRetirement = true;
    retirement = client.requestBrowser("detach", { viewerToken: retiring.viewerToken });
    await retirementStarted.promise;
    const independentRead = client.requestBrowser<MediaReply>("video.read", input);
    const progressed = await Promise.race([
      independentRead.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 250);
      }),
    ]);
    retirementGate.resolve();
    await retirement;
    await independentRead;
    expect(progressed).toBe(true);
    blockRetirement = false;
    const frame = initial.packets![0]!.frame;
    const stateReads = calls.filter((call) => call === "state").length;
    block = true;
    blockState = true;
    pending = client.requestBrowser<MediaReply>("video.read", input);
    await arrived;
    expect(calls.filter((call) => call === "state")).toHaveLength(stateReads);
    const mutation = client.requestBrowser("input", {
      viewerToken: attached.viewerToken,
      controlToken: control.controlToken,
      expected: {
        sessionId: initial.state.sessionId,
        navigationGeneration: initial.state.navigationGeneration,
        viewportGeneration: initial.state.viewportGeneration,
      },
      target: {
        frameId: frame.frameId,
        navigationGeneration: frame.navigationGeneration,
        viewportGeneration: frame.viewportGeneration,
      },
      event: { kind: "move", point: { x: 10, y: 20, width: 1280, height: 800 } },
    });
    // Discrete input first reconciles the captured document, so a stalled metadata
    // read must hold back every native primitive rather than let one reach an
    // unobserved page. The pending video read must not be what delays it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).not.toContain("mouse.move");
    expect(calls).not.toContain("input.begin");
    stateGate.resolve();
    const accepted = await Promise.race([
      inputPublished.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    // Published through a pinned channel while the video read is still pending.
    expect(accepted).toBe(true);
    expect(calls.indexOf("input.begin")).toBeGreaterThan(-1);
    expect(calls.indexOf("input.begin")).toBeLessThan(calls.indexOf("mouse.move"));
    await mutation;
    expect(calls).toContain("input.end");
    const finalStateReads = calls.filter((call) => call === "state").length;
    release();
    expect((await pending).packets).toEqual([]);
    expect(calls.filter((call) => call === "state")).toHaveLength(finalStateReads);
  } finally {
    if (timeout) clearTimeout(timeout);
    retirementGate.resolve();
    await retirement?.catch(() => undefined);
    stateGate.resolve();
    release();
    await pending?.catch(() => undefined);
    client.disconnect();
    await running.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("bounds sixteen viewers' media while retaining input, cancel and heartbeat capacity", async () => {
  const home = await mkdtemp(join(tmpdir(), "owned-heartbeat-cap-review-"));
  let release!: () => void;
  let allStarted!: () => void;
  let reads = 0;
  const calls: string[] = [];
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const paths = resolveSupervisorPaths(home);
  const running = await startSupervisorServer(
    {
      create: async () => ({ runtimeId: "r".repeat(32) }),
      stop: async () => {},
      async request(_runtime, operation) {
        calls.push(operation);
        if (operation === "identity") return { userAgent: "Fixture" };
        if (operation === "state")
          return {
            url: "https://fixture.invalid/",
            title: "Fixture",
            inputGeneration: "1:1",
            canGoBack: false,
            canGoForward: false,
          };
        if (operation === "frame")
          return {
            dataBase64: "AA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date().toISOString(),
          };
        if (operation === "video.read") {
          if (++reads === 12) allStarted();
          await barrier;
          return {
            status: "waiting",
            streamId: "s".repeat(32),
            inputGeneration: "1:1",
            packets: [],
          };
        }
        return null;
      },
    },
    paths,
  );
  const client = new SupervisorClient({ bridgeId: "owned-cap-review", paths });
  const pending: Promise<unknown>[] = [];
  try {
    const lease = await client.connect();
    const viewers: string[] = [];
    for (let i = 0; i < 16; i++) {
      const attached = await client.requestBrowser<{ viewerToken: string }>("attach", { create: true,
        workspaceId: "owned",
        viewerLabel: `Fixture ${i}`,
      });
      viewers.push(attached.viewerToken);
    }
    const viewerToken = viewers[0]!;
    const { controlToken } = await client.requestBrowser<{ controlToken: string }>(
      "acquire-control",
      { viewerToken },
    );
    const captured = await client.requestBrowser<{ state: BrowserState; frame: BrowserFrame }>(
      "capture",
      { viewerToken },
    );
    const expected = {
      sessionId: captured.state.sessionId,
      runtimeId: captured.state.runtimeId!,
      bridgeEpoch: captured.state.bridgeEpoch!,
      navigationGeneration: captured.state.navigationGeneration,
      viewportGeneration: captured.state.viewportGeneration,
    };
    const target = {
      frameId: captured.frame.frameId,
      navigationGeneration: captured.frame.navigationGeneration,
      viewportGeneration: captured.frame.viewportGeneration,
    };
    const context = { viewerToken, controlToken, expected };
    const gesture = await client.requestBrowser<{ gestureId: string; nextSequence: number }>(
      "gesture.begin",
      {
        ...context,
        target,
        pointerKind: "mouse",
      },
    );
    for (const viewerToken of viewers)
      pending.push(
        client
          .requestBrowser("video.read", {
            viewerToken,
            quality: "high",
            streamId: null,
            afterSequence: 0,
            waitMs: 250,
            requestKeyFrame: false,
          })
          .catch((error) => error),
      );
    await started;
    const internal = client as unknown as { send(request: unknown): Promise<unknown> };
    await expect(
      internal.send({
        method: "bridge.heartbeat",
        bridgeId: "owned-cap-review",
        epoch: lease.epoch,
      }),
    ).resolves.toMatchObject({ epoch: lease.epoch });
    // JPEG fallback uses the same media cap, so excess readers cannot consume
    // the normal headroom reserved for an ordered press and its cleanup.
    await expect(client.requestBrowser("capture", { viewerToken })).rejects.toMatchObject({
      code: "RUNTIME_BUSY",
    });
    const pressed = await client.requestBrowser<{ nextSequence: number }>("gesture.update", {
      ...context,
      gestureId: gesture.gestureId,
      sequence: gesture.nextSequence,
      target,
      event: {
        kind: "down",
        point: { x: 10, y: 20, width: 1280, height: 800 },
        button: "left",
        clickCount: 1,
      },
    });
    await client.requestBrowser("gesture.end", {
      ...context,
      gestureId: gesture.gestureId,
      sequence: pressed.nextSequence,
      cancel: true,
    });
    expect(calls).toContain("mouse.down");
    expect(calls).toContain("input.end");
    expect(reads).toBe(12);
    release();
    const results = await Promise.all(pending);
    expect(
      results.filter(
        (value) => value instanceof RuntimeProtocolError && value.code === "RUNTIME_BUSY",
      ),
    ).toHaveLength(4);
  } finally {
    release();
    await Promise.allSettled(pending);
    client.disconnect();
    await running.close();
    await rm(home, { recursive: true, force: true });
  }
});
