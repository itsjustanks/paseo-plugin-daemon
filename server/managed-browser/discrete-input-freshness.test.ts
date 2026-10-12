/** Exercises real capture/input policy with delayed native replies, without starting a daemon. */
import { expect, it } from "vitest";
import type { BrowserInputEvent, BrowserState } from "../../shared/managed-browser/browser";
import type { BrowserFrameAuthority } from "../../shared/managed-browser/browser-video";
import { SessionManager } from "./browser-policy";

/** One owned document and injected elapsed clock make publication boundaries observable. */
async function fixture() {
  let clock = 1_000;
  let monotonicClock = 1_000;
  let ids = 0;
  let document = "1:1";
  let intercept: (operation: string) => void = () => {};
  const calls: string[] = [];
  const manager = new SessionManager({
    now: () => clock,
    monotonicNow: () => monotonicClock,
    validateWorkspace: async () => true,
    issueToken: () => String(++ids).padStart(32, "0"),
    client: {
      connect: async () => ({ epoch: 1 }),
      ensureWorkspace: async (workspaceId) => ({
        workspaceId,
        runtimeId: "r".repeat(32),
        createdAt: 1,
      }),
      archiveWorkspace: async () => {},
      ...{ closeWorkspace: async () => {} },
      disconnect: () => {},
      requestWorkspace: async (_workspace, operation) => {
        calls.push(operation);
        intercept(operation);
        if (operation === "identity") return { userAgent: "Fixture" };
        if (operation === "state") {
          return {
            url: "https://fixture.invalid/",
            title: "Fixture",
            inputGeneration: document,
            canGoBack: false,
            canGoForward: false,
          };
        }
        if (operation === "frame") {
          return {
            dataBase64: "eA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date(clock).toISOString(),
          };
        }
        if (operation === "video.read") {
          return {
            status: "ready",
            streamId: "v".repeat(32),
            inputGeneration: document,
            packets: [
              {
                streamId: "v".repeat(32),
                captureGeneration: 1,
                sequence: 1,
                timestampUs: 1000,
                type: "key",
                codec: "vp8",
                width: 1280,
                height: 800,
                capturedAt: new Date(clock).toISOString(),
                capturedAtMonotonicMs: monotonicClock,
                dataBase64: "AA==",
              },
            ],
          };
        }
        return null;
      },
    },
  });
  await manager.connect();
  const { viewerToken } = await manager.attach("owned", "Fixture");
  const { controlToken } = await manager.acquireControl(viewerToken);
  return {
    manager,
    viewerToken,
    calls,
    advance: (milliseconds: number) => {
      clock += milliseconds;
      monotonicClock += milliseconds;
    },
    advanceWall: (milliseconds: number) => {
      clock += milliseconds;
    },
    advanceMonotonic: (milliseconds: number) => {
      monotonicClock += milliseconds;
    },
    replaceDocument: () => {
      document = "1:2";
    },
    intercept: (callback: (operation: string) => void) => {
      intercept = callback;
    },
    capture: () => manager.capture(viewerToken),
    videoCapture: async () => {
      const reply = await manager.readVideo({
        viewerToken,
        quality: "high",
        streamId: null,
        afterSequence: 0,
        waitMs: 0,
        requestKeyFrame: true,
      });
      return { state: reply.state, frame: reply.packets[0]!.frame };
    },
    send: (
      capture: { state: BrowserState; frame: BrowserFrameAuthority | null },
      event: BrowserInputEvent,
    ) => {
      const state = capture.state;
      return manager.sendInput({
        viewerToken,
        controlToken,
        expected: {
          sessionId: state.sessionId,
          runtimeId: state.runtimeId!,
          bridgeEpoch: state.bridgeEpoch!,
          navigationGeneration: state.navigationGeneration,
          viewportGeneration: state.viewportGeneration,
        },
        target: capture.frame!,
        event,
      });
    },
  };
}

const click: BrowserInputEvent = {
  kind: "click",
  point: { x: 100, y: 100, width: 1280, height: 800 },
  button: "left",
  clickCount: 1,
};

it("refuses a capture whose final metadata replaced the same-URL document", async () => {
  const f = await fixture();
  try {
    let pixelsCaptured = false;
    f.intercept((operation) => {
      if (operation === "frame") pixelsCaptured = true;
      if (operation === "state" && pixelsCaptured) f.replaceDocument();
    });
    await expect(f.capture()).rejects.toThrow("changed during capture");
    expect(f.calls).not.toContain("mouse.down");
  } finally {
    f.manager.disconnect();
  }
});

it("refuses capture authority already expired while final metadata was pending", async () => {
  const f = await fixture();
  try {
    let pixelsCaptured = false;
    f.intercept((operation) => {
      if (operation === "frame") pixelsCaptured = true;
      if (operation === "state" && pixelsCaptured) f.advance(6_000);
    });
    await expect(f.capture()).rejects.toThrow("expired during validation");
  } finally {
    f.manager.disconnect();
  }
});

it("does not extend capture age by the time spent validating metadata", async () => {
  const f = await fixture();
  try {
    let pixelsCaptured = false;
    f.intercept((operation) => {
      if (operation === "frame") pixelsCaptured = true;
      if (operation === "state" && pixelsCaptured) f.advance(4_000);
    });
    const capture = await f.capture();
    f.intercept(() => {});
    f.advance(1_001);
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=expired; ageMs=5001)",
    );
    expect(f.calls).not.toContain("mouse.down");
  } finally {
    f.manager.disconnect();
  }
});

for (const delayedOperation of ["mouse.move", "mouse.down"]) {
  it(`finishes one admitted click after an eight-second ${delayedOperation} reply`, async () => {
    const f = await fixture();
    try {
      const capture = await f.capture();
      f.intercept((operation) => {
        if (operation === delayedOperation) f.advance(8_000);
      });
      await expect(f.send(capture, click)).resolves.toHaveProperty("state");
      expect(f.calls.filter((operation) => operation === "mouse.down")).toHaveLength(1);
      expect(f.calls.filter((operation) => operation === "mouse.up")).toHaveLength(1);
    } finally {
      f.manager.disconnect();
    }
  });
}

it("still refuses an expired frame before publishing input", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.advance(5_000);
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=expired; ageMs=5000)",
    );
    expect(
      f.calls.filter((operation) => /^(?:mouse\.|key\.|text\.|input\.)/.test(operation)),
    ).toEqual([]);
  } finally {
    f.manager.disconnect();
  }
});

it("refuses a document replacement after down while releasing the original press once", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.intercept((operation) => {
      if (operation === "mouse.down") {
        f.advance(8_000);
        f.replaceDocument();
      }
    });
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admitted-input; reason=context-changed)",
    );
    expect(f.calls.filter((operation) => operation === "mouse.down")).toHaveLength(1);
    expect(f.calls.filter((operation) => operation === "mouse.up")).toHaveLength(1);
    expect(f.calls.filter((operation) => operation === "input.end")).toHaveLength(1);
  } finally {
    f.manager.disconnect();
  }
});

it("refuses bridge replacement during movement before any button press", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.intercept((operation) => {
      if (operation === "mouse.move") f.manager.setBridgeEpoch(2);
    });
    await expect(f.send(capture, click)).rejects.toThrow("stale");
    expect(f.calls).not.toContain("mouse.down");
  } finally {
    f.manager.disconnect();
  }
});

it("does not extend a control lease while a discrete action is awaiting native work", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.intercept((operation) => {
      if (operation === "mouse.move") f.advance(30_000);
    });
    await expect(f.send(capture, click)).rejects.toThrow("control lease");
    expect(f.calls).not.toContain("mouse.down");
  } finally {
    f.manager.disconnect();
  }
});

it("revokes the admitted observation when a published press loses its acknowledgement", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.intercept((operation) => {
      if (operation === "mouse.down") throw new Error("Mutation outcome is unknown");
    });
    await expect(f.send(capture, click)).rejects.toThrow("outcome is unknown");
    f.intercept(() => {});
    const operationsBeforeReplay = f.calls.length;
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=missing-or-revoked)",
    );
    expect(f.calls.slice(operationsBeforeReplay)).toEqual([]);
    expect(f.calls.filter((operation) => operation === "mouse.down")).toHaveLength(1);
  } finally {
    f.manager.disconnect();
  }
});

/** Admission diagnostics must describe the same clock and receipt the policy refuses. */
for (const skew of [-8_000, 8_000]) {
  it(`expires video authority at five monotonic seconds despite wall skew ${skew}`, async () => {
    const f = await fixture();
    try {
      const capture = await f.videoCapture();
      f.advanceWall(skew);
      f.advanceMonotonic(5_000);
      await expect(f.send(capture, click)).rejects.toThrow(
        "Browser frame is stale (stage=admission; reason=expired; ageMs=5000)",
      );
      expect(
        f.calls.filter((operation) => /^(?:mouse\.|key\.|text\.|input\.)/.test(operation)),
      ).toEqual([]);
    } finally {
      f.manager.disconnect();
    }
  });
}

it("admits video authority before monotonic expiry despite a forward wall-clock jump", async () => {
  const f = await fixture();
  try {
    const capture = await f.videoCapture();
    f.advanceWall(8_000);
    f.advanceMonotonic(4_999);
    await expect(f.send(capture, click)).resolves.toHaveProperty("state");
    expect(f.calls.filter((operation) => operation === "mouse.down")).toHaveLength(1);
    expect(f.calls.filter((operation) => operation === "mouse.up")).toHaveLength(1);
  } finally {
    f.manager.disconnect();
  }
});

it("reports a known generation mismatch with age without publishing native input", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.advance(25);
    const changed = {
      ...capture,
      frame: { ...capture.frame!, navigationGeneration: capture.frame!.navigationGeneration + 1 },
    };
    await expect(f.send(changed, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=context-changed; ageMs=25)",
    );
    expect(
      f.calls.filter((operation) => /^(?:mouse\.|key\.|text\.|input\.)/.test(operation)),
    ).toEqual([]);
  } finally {
    f.manager.disconnect();
  }
});

it("preserves expiry evidence before pruning and reports the retired receipt without age", async () => {
  const f = await fixture();
  try {
    const capture = await f.capture();
    f.advance(5_000);
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=expired; ageMs=5000)",
    );
    await expect(f.send(capture, click)).rejects.toThrow(
      "Browser frame is stale (stage=admission; reason=missing-or-revoked)",
    );
    expect(
      f.calls.filter((operation) => /^(?:mouse\.|key\.|text\.|input\.)/.test(operation)),
    ).toEqual([]);
  } finally {
    f.manager.disconnect();
  }
});
