import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserRuntimeRoot } from "../../server/managed-browser/runtime-path";
import { type JsonValue, RUNTIME_PROTOCOL_VERSION } from "../../server/managed-browser/runtime-protocol";
import {
  type RuntimeInstance,
  type RuntimeOwner,
  RuntimeSupervisor,
  resolveSupervisorPaths,
  startSupervisorServer,
} from "../../server/managed-browser/supervisor";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

interface FakeRuntime extends RuntimeInstance {
  workspaceId: string;
}

class FakeOwner implements RuntimeOwner<FakeRuntime> {
  readonly created: FakeRuntime[] = [];
  readonly stopped: FakeRuntime[] = [];
  readonly requests: string[] = [];
  createGate: Deferred<void> | null = null;
  createStarted: Deferred<void> | null = null;
  requestGate: Deferred<void> | null = null;
  requestStarted: Deferred<void> | null = null;
  stopError: Error | null = null;
  activeRequests = 0;
  maxActiveRequests = 0;

  async create(workspaceId: string): Promise<FakeRuntime> {
    this.createStarted?.resolve();
    if (this.createGate) await this.createGate.promise;
    const runtime = { workspaceId, runtimeId: `runtime-${this.created.length + 1}` };
    this.created.push(runtime);
    return runtime;
  }

  async request(runtime: FakeRuntime, operation: string): Promise<JsonValue> {
    this.requests.push(operation);
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
    this.requestStarted?.resolve();
    try {
      if (this.requestGate) await this.requestGate.promise;
      return { runtimeId: runtime.runtimeId, operation };
    } finally {
      this.activeRequests -= 1;
    }
  }

  async stop(runtime: FakeRuntime): Promise<void> {
    this.stopped.push(runtime);
    if (this.stopError) throw this.stopError;
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function replaceRuntime(stagingRoot: string, runtimeRoot: string): Promise<void> {
  const script = new URL("../../scripts/browser/replace-runtime.mjs", import.meta.url).href;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { replaceRuntime } from ${JSON.stringify(script)}; await replaceRuntime(process.argv[1], process.argv[2]);`,
        stagingRoot,
        runtimeRoot,
      ],
      (error) => (error ? reject(error) : resolve()),
    );
    child.unref();
  });
}

function createHarness(maxWorkspaces?: number) {
  const owner = new FakeOwner();
  const supervisor = new RuntimeSupervisor({
    owner,
    now: () => Date.now(),
    heartbeatIntervalMs: 1_000,
    bridgeTimeoutMs: 10_000,
    orphanGraceMs: 120_000,
    ...(maxWorkspaces === undefined ? {} : { maxWorkspaces }),
  });
  return { owner, supervisor };
}

async function openSocket(path: string): Promise<Socket> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function sendRequest(socket: Socket, request: object): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim())));
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify(request)}\n`);
  return response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime replacement", () => {
  it("atomically activates staged assets without moving the live runtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "hosts-browser-runtime-"));
    const root = join(home, "plugin-data", "daemon-link", "browser");
    const runtimeRoot = join(root, "runtime");
    const stagingRoot = join(root, ".runtime-123e4567-e89b-42d3-a456-426614174000");
    try {
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(join(runtimeRoot, "version"), "old");
      await mkdir(stagingRoot);
      await writeFile(join(stagingRoot, "version"), "new");

      await replaceRuntime(stagingRoot, runtimeRoot);

      expect(resolveBrowserRuntimeRoot(home)).toBe(stagingRoot);
      await expect(readFile(join(stagingRoot, "version"), "utf8")).resolves.toBe("new");
      await expect(readFile(join(runtimeRoot, "version"), "utf8")).resolves.toBe("old");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the live runtime selected when staged assets are missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "hosts-browser-runtime-"));
    const root = join(home, "plugin-data", "daemon-link", "browser");
    const runtimeRoot = join(root, "runtime");
    const stagingRoot = join(root, ".runtime-123e4567-e89b-42d3-a456-426614174000");
    try {
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(join(runtimeRoot, "version"), "old");

      await expect(replaceRuntime(stagingRoot, runtimeRoot)).rejects.toThrow();

      expect(resolveBrowserRuntimeRoot(home)).toBe(runtimeRoot);
      await expect(readFile(join(runtimeRoot, "version"), "utf8")).resolves.toBe("old");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
describe("detached runtime supervisor lifecycle", () => {
  it("keeps a workspace runtime alive when its plugin bridge disconnects", async () => {
    vi.useFakeTimers();
    const { owner, supervisor } = createHarness();
    const first = supervisor.claimBridge("bridge-one");
    const runtime = await supervisor.ensureWorkspace("bridge-one", first.epoch, "workspace-one");

    supervisor.bridgeDisconnected("bridge-one", first.epoch);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(owner.stopped).toEqual([]);

    const replacement = supervisor.claimBridge("bridge-two");
    const reattached = await supervisor.ensureWorkspace(
      "bridge-two",
      replacement.epoch,
      "workspace-one",
    );
    expect(reattached.runtimeId).toBe(runtime.runtimeId);
    expect(owner.created).toHaveLength(1);
  });

  it("requires explicit takeover before replacing a live plugin bridge", async () => {
    const { supervisor } = createHarness();
    const first = supervisor.claimBridge("bridge-one");

    expect(() => supervisor.claimBridge("bridge-two")).toThrow("explicit administrative takeover");
    const replacement = supervisor.claimBridge("bridge-two", true);

    await expect(
      supervisor.requestWorkspace("bridge-one", first.epoch, "workspace-one", "status", null),
    ).rejects.toMatchObject({ code: "BRIDGE_FENCED" });
    expect(replacement.epoch).toBeGreaterThan(first.epoch);
  });

  it("stops workspace resources only after the 120 second orphan grace", async () => {
    vi.useFakeTimers();
    const { owner, supervisor } = createHarness();
    const bridge = supervisor.claimBridge("bridge-one");
    await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");

    supervisor.bridgeDisconnected("bridge-one", bridge.epoch);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(owner.stopped.map((runtime) => runtime.runtimeId)).toEqual(["runtime-1"]);
  });

  it("closes only the expected workspace runtime and permits a fresh one", async () => {
    const { owner, supervisor } = createHarness();
    const bridge = supervisor.claimBridge("bridge-one");
    const first = await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");

    await expect(
      supervisor.closeWorkspace("bridge-one", bridge.epoch, "workspace-one", "wrong-runtime"),
    ).rejects.toThrow("Browser runtime was replaced");
    expect(owner.stopped).toEqual([]);

    await supervisor.closeWorkspace("bridge-one", bridge.epoch, "workspace-one", first.runtimeId);
    expect(owner.stopped.map((runtime) => runtime.runtimeId)).toEqual([first.runtimeId]);
    const next = await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");
    expect(next.runtimeId).not.toBe(first.runtimeId);
  });

  it("lets archive fence creation and tear down a runtime created concurrently", async () => {
    vi.useFakeTimers();
    const { owner, supervisor } = createHarness();
    const gate = deferred<void>();
    owner.createGate = gate;
    owner.createStarted = deferred<void>();
    const bridge = supervisor.claimBridge("bridge-one");
    const creation = supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");
    await owner.createStarted.promise;

    const archive = supervisor.archiveWorkspace("bridge-one", bridge.epoch, "workspace-one");
    gate.resolve();

    await expect(creation).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    await expect(archive).resolves.toEqual({ archived: true });
    expect(owner.stopped.map((runtime) => runtime.runtimeId)).toEqual(["runtime-1"]);
    await expect(
      supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one"),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
  });

  it("archives only after an active request drains and rejects its result", async () => {
    const { owner, supervisor } = createHarness();
    const bridge = supervisor.claimBridge("bridge-one");
    await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");
    owner.requestGate = deferred<void>();
    owner.requestStarted = deferred<void>();

    const request = supervisor.requestWorkspace(
      "bridge-one",
      bridge.epoch,
      "workspace-one",
      "mutate",
      null,
    );
    await owner.requestStarted.promise;
    const archive = supervisor.archiveWorkspace("bridge-one", bridge.epoch, "workspace-one");
    expect(owner.stopped).toEqual([]);

    owner.requestGate.resolve();
    await expect(request).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    await expect(archive).resolves.toEqual({ archived: true });
    expect(owner.stopped.map((runtime) => runtime.runtimeId)).toEqual(["runtime-1"]);
  });

  it("drains an old epoch mutation before starting the takeover epoch", async () => {
    const { owner, supervisor } = createHarness();
    const oldBridge = supervisor.claimBridge("bridge-old");
    await supervisor.ensureWorkspace("bridge-old", oldBridge.epoch, "workspace-one");
    owner.requestGate = deferred<void>();
    owner.requestStarted = deferred<void>();

    const oldRequest = supervisor.requestWorkspace(
      "bridge-old",
      oldBridge.epoch,
      "workspace-one",
      "old-mutation",
      null,
    );
    await owner.requestStarted.promise;
    const currentBridge = supervisor.claimBridge("bridge-current", true);
    const currentRequest = supervisor.requestWorkspace(
      "bridge-current",
      currentBridge.epoch,
      "workspace-one",
      "new-mutation",
      null,
    );
    await Promise.resolve();
    expect(owner.requests).toEqual(["old-mutation"]);

    owner.requestGate.resolve();
    await expect(oldRequest).rejects.toMatchObject({ code: "BRIDGE_FENCED" });
    await expect(currentRequest).resolves.toMatchObject({ operation: "new-mutation" });
    expect(owner.requests).toEqual(["old-mutation", "new-mutation"]);
    expect(owner.maxActiveRequests).toBe(1);
  });

  it("enforces a workspace limit independent of runtime-owned sessions", async () => {
    const { owner, supervisor } = createHarness(2);
    const bridge = supervisor.claimBridge("bridge-one");
    await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");
    await supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-two");

    await expect(
      supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-three"),
    ).rejects.toThrow("Runtime supervisor workspace limit (2) reached");
    expect(owner.created.map((runtime) => runtime.workspaceId)).toEqual([
      "workspace-one",
      "workspace-two",
    ]);
  });

  it("bounds socket flooding and processes one request per socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-browser-flood-"));
    const paths = resolveSupervisorPaths(root);
    const owner = new FakeOwner();
    const server = await startSupervisorServer(owner, paths);
    const token = await readFile(paths.token, "utf8");
    const socket = await openSocket(paths.socket);
    try {
      const claim = await sendRequest(socket, {
        id: "claim",
        token,
        version: RUNTIME_PROTOCOL_VERSION,
        method: "bridge.claim",
        bridgeId: "bridge-one",
      });
      if (
        !("result" in claim) ||
        !claim.result ||
        typeof claim.result !== "object" ||
        !("epoch" in claim.result) ||
        typeof claim.result.epoch !== "number"
      )
        throw new Error("Bridge claim did not return an epoch");
      const epoch = claim.result.epoch;
      await sendRequest(socket, {
        id: "ensure",
        token,
        version: RUNTIME_PROTOCOL_VERSION,
        method: "workspace.ensure",
        bridgeId: "bridge-one",
        epoch,
        workspaceId: "workspace-one",
      });

      owner.requestGate = deferred<void>();
      owner.requestStarted = deferred<void>();
      socket.write(
        `${JSON.stringify({
          id: "request-0",
          token,
          version: RUNTIME_PROTOCOL_VERSION,
          method: "workspace.request",
          bridgeId: "bridge-one",
          epoch,
          workspaceId: "workspace-one",
          operation: "mutation-0",
          input: null,
        })}\n`,
      );
      await owner.requestStarted.promise;
      const busy = new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += String(chunk);
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          if (response.id === "request-16") resolve(response);
        });
        socket.once("error", reject);
      });
      for (let index = 1; index <= 16; index += 1) {
        socket.write(
          `${JSON.stringify({
            id: `request-${index}`,
            token,
            version: RUNTIME_PROTOCOL_VERSION,
            method: "workspace.request",
            bridgeId: "bridge-one",
            epoch,
            workspaceId: "workspace-one",
            operation: `mutation-${index}`,
            input: null,
          })}\n`,
        );
      }
      await expect(busy).resolves.toMatchObject({
        ok: false,
        error: { code: "RUNTIME_BUSY" },
      });
      expect(socket.destroyed).toBe(false);
      owner.requestGate.resolve();
      socket.destroy();
      await server.close();
      expect(owner.maxActiveRequests).toBe(1);
    } finally {
      owner.requestGate?.resolve();
      socket.destroy();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes a quiet socket after global backpressure clears", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-browser-global-backpressure-"));
    const paths = resolveSupervisorPaths(root);
    const owner = new FakeOwner();
    const server = await startSupervisorServer(owner, paths);
    const token = await readFile(paths.token, "utf8");
    const sockets = await Promise.all(Array.from({ length: 5 }, () => openSocket(paths.socket)));
    try {
      const claim = await sendRequest(sockets[0]!, {
        id: "claim",
        token,
        version: RUNTIME_PROTOCOL_VERSION,
        method: "bridge.claim",
        bridgeId: "bridge-one",
      });
      if (
        !("result" in claim) ||
        !claim.result ||
        typeof claim.result !== "object" ||
        !("epoch" in claim.result) ||
        typeof claim.result.epoch !== "number"
      )
        throw new Error("Bridge claim did not return an epoch");
      const epoch = claim.result.epoch;
      await sendRequest(sockets[0]!, {
        id: "ensure",
        token,
        version: RUNTIME_PROTOCOL_VERSION,
        method: "workspace.ensure",
        bridgeId: "bridge-one",
        epoch,
        workspaceId: "workspace-one",
      });

      owner.requestGate = deferred<void>();
      owner.requestStarted = deferred<void>();
      const localBusyResponses = sockets.slice(0, 4).map((socket, socketIndex) => {
        const response = new Promise<Record<string, unknown>>((resolve, reject) => {
          socket.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim())));
          socket.once("error", reject);
        });
        for (let requestIndex = 0; requestIndex <= 16; requestIndex += 1) {
          socket.write(
            `${JSON.stringify({
              id: `socket-${socketIndex}-request-${requestIndex}`,
              token,
              version: RUNTIME_PROTOCOL_VERSION,
              method: "workspace.request",
              bridgeId: "bridge-one",
              epoch,
              workspaceId: "workspace-one",
              operation: `mutation-${socketIndex}-${requestIndex}`,
              input: null,
            })}\n`,
          );
        }
        return response;
      });
      await owner.requestStarted.promise;
      const localBusy = await Promise.all(localBusyResponses);
      for (const response of localBusy) {
        expect(response).toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });
      }

      await expect(
        sendRequest(sockets[4]!, {
          id: "global-busy",
          token,
          version: RUNTIME_PROTOCOL_VERSION,
          method: "workspace.request",
          bridgeId: "bridge-one",
          epoch,
          workspaceId: "workspace-one",
          operation: "globally-rejected",
          input: null,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });

      // Normal global capacity stays full, but the current authenticated lease
      // must retain its independently bounded maintenance slot.
      await expect(
        sendRequest(sockets[4]!, {
          id: "heartbeat-during-global-busy",
          token,
          version: RUNTIME_PROTOCOL_VERSION,
          method: "bridge.heartbeat",
          bridgeId: "bridge-one",
          epoch,
        }),
      ).resolves.toMatchObject({ ok: true });
      for (const credentials of [
        { token: "invalid-token", epoch },
        { token, epoch: epoch + 1 },
      ]) {
        await expect(
          sendRequest(sockets[4]!, {
            id: "unqualified-heartbeat",
            ...credentials,
            version: RUNTIME_PROTOCOL_VERSION,
            method: "bridge.heartbeat",
            bridgeId: "bridge-one",
          }),
        ).resolves.toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });
      }

      owner.requestGate.resolve();
      await vi.waitFor(() => expect(owner.requests).toHaveLength(64));
      await vi.waitFor(() => expect(owner.activeRequests).toBe(0));
      for (const credentials of [
        { token: "invalid-token", epoch, code: "AUTHENTICATION_FAILED" },
        { token, epoch: epoch + 1, code: "BRIDGE_FENCED" },
      ]) {
        await expect(
          sendRequest(sockets[4]!, {
            id: "refused-heartbeat",
            token: credentials.token,
            epoch: credentials.epoch,
            version: RUNTIME_PROTOCOL_VERSION,
            method: "bridge.heartbeat",
            bridgeId: "bridge-one",
          }),
        ).resolves.toMatchObject({ ok: false, error: { code: credentials.code } });
      }
      await expect(
        sendRequest(sockets[4]!, {
          id: "heartbeat-after-busy",
          token,
          version: RUNTIME_PROTOCOL_VERSION,
          method: "bridge.heartbeat",
          bridgeId: "bridge-one",
          epoch,
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      owner.requestGate?.resolve();
      for (const socket of sockets) socket.destroy();
      await server.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes endpoint metadata and the startup lock when stopping rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-browser-cleanup-"));
    const paths = resolveSupervisorPaths(root);
    const owner = new FakeOwner();
    const server = await startSupervisorServer(owner, paths);
    const bridge = server.supervisor.claimBridge("bridge-one");
    await server.supervisor.ensureWorkspace("bridge-one", bridge.epoch, "workspace-one");
    owner.stopError = new Error("stop failed");

    await expect(server.close()).rejects.toThrow("Runtime supervisor shutdown failed");
    if (process.platform !== "win32") await expect(access(paths.socket)).rejects.toBeDefined();
    await expect(access(paths.endpoint)).rejects.toBeDefined();
    await expect(access(paths.token)).rejects.toBeDefined();
    await expect(access(paths.lock)).rejects.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });
});

/** Slow browser work must not stop authenticated bridge maintenance on the same socket. */
it("retains global command headroom while bounded media reads are saturated", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosts-browser-media-global-"));
  const paths = resolveSupervisorPaths(root);
  const owner = new FakeOwner();
  const held = deferred<void>();
  const allStarted = deferred<void>();
  const request = owner.request.bind(owner);
  let videoReads = 0;
  owner.request = async (runtime, operation) => {
    if (operation === "video.read") {
      if (++videoReads === 48) allStarted.resolve();
      await held.promise;
    }
    return request(runtime, operation);
  };
  const server = await startSupervisorServer(owner, paths);
  const sockets = await Promise.all(Array.from({ length: 5 }, () => openSocket(paths.socket)));
  try {
    const token = (await readFile(paths.token, "utf8")).trim();
    const claimed = await sendRequest(sockets[0]!, {
      id: "claim",
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "bridge.claim",
      bridgeId: "bridge-one",
    });
    const epoch = (claimed.result as { epoch: number }).epoch;
    await sendRequest(sockets[0]!, {
      id: "ensure",
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "workspace.ensure",
      bridgeId: "bridge-one",
      epoch,
      workspaceId: "owned",
    });
    const base = {
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "workspace.request",
      bridgeId: "bridge-one",
      epoch,
      workspaceId: "owned",
    };
    const media = {
      operation: "video.read",
      input: {
        quality: "high",
        streamId: null,
        afterSequence: 0,
        waitMs: 500,
        requestKeyFrame: false,
      },
    };
    const busyReplies = sockets.slice(0, 4).map((socket, socketIndex) => {
      for (let index = 0; index < 12; index++) {
        socket.write(
          `${JSON.stringify({ ...base, ...media, id: `media-${socketIndex}-${index}` })}\n`,
        );
      }
      return sendRequest(socket, { ...base, ...media, id: `excess-${socketIndex}` });
    });
    await allStarted.promise;
    for (const reply of await Promise.all(busyReplies)) {
      expect(reply).toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });
    }
    await expect(
      sendRequest(sockets[4]!, {
        ...base,
        ...media,
        id: "global-excess-video",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });
    await expect(
      sendRequest(sockets[4]!, {
        ...base,
        id: "global-excess-jpeg",
        operation: "frame",
        input: {},
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "RUNTIME_BUSY" } });
    await expect(
      sendRequest(sockets[4]!, {
        ...base,
        id: "ordered-cleanup",
        operation: "input.end",
        input: { gestureId: "owned" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(owner.requests).toEqual(["input.end"]);
    expect(videoReads).toBe(48);
  } finally {
    held.resolve();
    for (const socket of sockets) socket.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("renews the bridge heartbeat while a page operation is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosts-browser-heartbeat-socket-"));
  const paths = resolveSupervisorPaths(root);
  const owner = new FakeOwner();
  const server = await startSupervisorServer(owner, paths);
  const socket = await openSocket(paths.socket);
  try {
    const token = (await readFile(paths.token, "utf8")).trim();
    const claimed = await sendRequest(socket, {
      id: "claim",
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "bridge.claim",
      bridgeId: "bridge-one",
    });
    const epoch = (claimed.result as { epoch: number }).epoch;
    await sendRequest(socket, {
      id: "ensure",
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "workspace.ensure",
      bridgeId: "bridge-one",
      epoch,
      workspaceId: "workspace-one",
    });
    owner.requestGate = deferred<void>();
    owner.requestStarted = deferred<void>();
    socket.write(
      `${JSON.stringify({
        id: "held-page",
        token,
        version: RUNTIME_PROTOCOL_VERSION,
        method: "workspace.request",
        bridgeId: "bridge-one",
        epoch,
        workspaceId: "workspace-one",
        operation: "frame",
        input: null,
      })}\n`,
    );
    await owner.requestStarted.promise;
    const heartbeat = sendRequest(socket, {
      id: "live-heartbeat",
      token,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "bridge.heartbeat",
      bridgeId: "bridge-one",
      epoch,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timely = await Promise.race([
        heartbeat,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
      expect(timely).toMatchObject({ id: "live-heartbeat", ok: true });
      expect(owner.activeRequests).toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    owner.requestGate?.resolve();
    socket.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
