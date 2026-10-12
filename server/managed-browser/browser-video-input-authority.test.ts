import { expect, it } from "vitest";
import { SessionManager } from "./browser-policy";

it.each([-1, 0, 40])(
  "keeps late pre-wheel pixels display-only with source skew %sms",
  async (sourceSkew) => {
    let ids = 0;
    let now = Date.parse("2026-10-03T12:00:00Z");
    let monotonicNow = 1_000;
    let blocked: Promise<void> | null = null;
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    let pendingRead: ReturnType<SessionManager["readVideo"]> | null = null;
    const packet = {
      streamId: "v".repeat(32),
      captureGeneration: 1,
      sequence: 1,
      timestampUs: 1000,
      type: "key",
      codec: "vp8",
      width: 1280,
      height: 800,
      capturedAt: new Date(now + sourceSkew).toISOString(),
      capturedAtMonotonicMs: monotonicNow + sourceSkew,
      dataBase64: "AA==",
    };
    const manager = new SessionManager({
      now: () => now,
      monotonicNow: () => monotonicNow,
      validateWorkspace: async () => true,
      issueToken: () => String(++ids).padStart(32, "0"),
      client: {
        connect: async () => ({ epoch: 1 }),
        ensureWorkspace: async (workspaceId) => ({
          workspaceId,
          runtimeId: "r".repeat(32),
          createdAt: now,
        }),
        archiveWorkspace: async () => {},
        closeWorkspace: async () => {},
        disconnect() {},
        requestWorkspace: async (_workspace, operation) => {
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
          if (operation === "video.read") {
            if (blocked) {
              arrived.resolve();
              await blocked;
            }
            return {
              status: "ready",
              streamId: packet.streamId,
              inputGeneration: "1:1",
              packets: [packet],
            };
          }
          return null;
        },
      },
    });
    try {
      await manager.connect();
      const { viewerToken } = await manager.attach("owned", "Fixture");
      const { controlToken } = await manager.acquireControl(viewerToken);
      const videoInput = {
        viewerToken,
        quality: "high" as const,
        streamId: null,
        afterSequence: 0,
        waitMs: 0,
        requestKeyFrame: true,
      };
      const first = await manager.readVideo(videoInput);
      const frame = first.packets[0]!.frame;
      const expected = {
        sessionId: first.state.sessionId,
        runtimeId: first.state.runtimeId!,
        bridgeEpoch: first.state.bridgeEpoch!,
        navigationGeneration: first.state.navigationGeneration,
        viewportGeneration: first.state.viewportGeneration,
      };
      const target = {
        frameId: frame.frameId,
        navigationGeneration: frame.navigationGeneration,
        viewportGeneration: frame.viewportGeneration,
      };
      const begin = await manager.beginGesture({
        viewerToken,
        controlToken,
        pointerKind: "mouse",
        expected,
        target,
      });
      if (!("gestureId" in begin)) throw new Error("Fixture begin was not admitted");
      blocked = release.promise;
      pendingRead = manager.readVideo(videoInput);
      await arrived.promise;
      // Equal and tolerated future timestamps must not bypass input revocation.
      await manager.updateGesture({
        viewerToken,
        controlToken,
        expected,
        gestureId: begin.gestureId,
        sequence: 1,
        event: {
          kind: "scroll",
          point: { x: 20, y: 20, width: 1280, height: 800 },
          deltaX: 0,
          deltaY: 40,
        },
      });
      await manager.endGesture({
        viewerToken,
        controlToken,
        expected,
        gestureId: begin.gestureId,
        sequence: 2,
        cancel: false,
      });
      const reopened = await manager.beginGesture({
        viewerToken,
        controlToken,
        pointerKind: "mouse",
        expected,
        target,
      });
      // The scroll spent this receipt; reopening on it is a known non-admission.
      expect(reopened).toHaveProperty("admission", "stale-frame");
      const strictInput = () =>
        manager.sendInput({
          viewerToken,
          controlToken,
          expected,
          target,
          event: {
            kind: "click" as const,
            point: { x: 20, y: 20, width: 1280, height: 800 },
            button: "left" as const,
            clickCount: 1 as const,
          },
        });
      await expect(strictInput()).rejects.toThrow("frame is stale");
      release.resolve();
      const late = await pendingRead;
      pendingRead = null;
      expect(late.packets[0]!.frame.frameId).toBe(frame.frameId);
      // Late pixels are painted but flagged: the viewer must not try to press on them.
      expect(late.packets[0]!.actionable).toBe(false);
      // Late pixels still paint, but cannot re-authorize discrete agent input.
      await expect(strictInput()).rejects.toThrow("frame is stale");
      expect(calls).not.toContain("mouse.down");

      // A different receipt from the same old source is not the admitted basis.
      packet.sequence += 1;
      packet.timestampUs += 1;
      const otherLate = await manager.readVideo(videoInput);
      const otherLateFrame = otherLate.packets[0]!.frame;
      expect(otherLateFrame.frameId).not.toBe(frame.frameId);
      const refused = await manager.beginGesture({
        viewerToken,
        controlToken,
        pointerKind: "mouse",
        expected,
        target: {
          frameId: otherLateFrame.frameId,
          navigationGeneration: otherLateFrame.navigationGeneration,
          viewportGeneration: otherLateFrame.viewportGeneration,
        },
      });
      expect(refused).toHaveProperty("admission", "stale-frame");
      expect(calls.filter((value) => value === "input.begin")).toHaveLength(1);
      // A later genuine source frame admits input without resetting the video codec.
      now += 100;
      monotonicNow += 100;
      packet.capturedAtMonotonicMs = monotonicNow;
      packet.sequence += 1;
      packet.timestampUs += 100000;
      packet.capturedAt = new Date(now).toISOString();
      const fresh = await manager.readVideo(videoInput);
      const freshFrame = fresh.packets[0]!.frame;
      expect(fresh.packets[0]!.actionable).toBe(true);
      const accepted = await manager.beginGesture({
        viewerToken,
        controlToken,
        pointerKind: "mouse",
        expected,
        target: {
          frameId: freshFrame.frameId,
          navigationGeneration: freshFrame.navigationGeneration,
          viewportGeneration: freshFrame.viewportGeneration,
        },
      });
      expect(accepted).toHaveProperty("gestureId");
      expect(calls.filter((value) => value === "input.begin")).toHaveLength(2);
      expect(calls).not.toContain("video.invalidate");
    } finally {
      release.resolve();
      await pendingRead?.catch(() => undefined);
      await manager.disconnect();
    }
  },
);
