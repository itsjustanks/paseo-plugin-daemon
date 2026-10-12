import { setTimeout, clearTimeout } from "./node-timers";
import { EventEmitter } from "node:events";

export class CdpUnavailableError extends Error {
  override readonly name = "CdpUnavailableError";
}

export class CdpUnknownOutcomeError extends Error {
  override readonly name = "CdpUnknownOutcomeError";
}

export interface CdpEvent<T = unknown> {
  method: string;
  params: T;
  sessionId?: string;
}

interface PendingCommand {
  readonly method: string;
  readonly mutation: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  sessionId?: string;
}

interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface CdpConnectionOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  webSocket?: WebSocketConstructor;
}

export class CdpConnection extends EventEmitter {
  private readonly socket: WebSocketLike;
  private readonly commandTimeoutMs: number;
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: WebSocketLike, commandTimeoutMs: number) {
    super();
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    socket.onmessage = (event) => void this.receive(event.data);
    socket.onclose = (event) =>
      this.disconnect(event.reason || `WebSocket closed (${event.code ?? 0})`);
    socket.onerror = () => this.disconnect("CDP WebSocket failed");
  }

  static connect(url: string, options: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new CdpUnavailableError("CDP endpoint must use ws or wss");
    }
    const WebSocketImpl =
      options.webSocket ??
      (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WebSocketImpl) throw new CdpUnavailableError("This runtime does not provide WebSocket");
    const socket = new WebSocketImpl(parsed.href);
    socket.binaryType = "arraybuffer";
    const timeoutMs = options.connectTimeoutMs ?? 10_000;
    const { promise, resolve, reject } = Promise.withResolvers<CdpConnection>();
    const timer = setTimeout(() => {
      socket.close();
      reject(new CdpUnavailableError(`CDP connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(new CdpConnection(socket, options.commandTimeoutMs ?? 15_000));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new CdpUnavailableError("Could not connect to CDP endpoint"));
    };
    return promise;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: {
      sessionId?: string;
      mutation?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    if (!this.isOpen) throw new CdpUnavailableError("CDP connection is closed");
    const id = this.nextId++;
    const mutation = options.mutation ?? false;
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const message: Record<string, unknown> = { id, method, params };
    if (options.sessionId) message.sessionId = options.sessionId;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(
        mutation
          ? new CdpUnknownOutcomeError(`${method} timed out; mutation outcome is unknown`)
          : new CdpUnavailableError(`${method} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    this.pending.set(id, {
      method,
      mutation,
      timer,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      reject(
        mutation
          ? new CdpUnknownOutcomeError(`${method} send failed; mutation outcome is unknown`)
          : error,
      );
    }
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "client shutdown");
    this.rejectPending("CDP connection closed");
  }

  private async receive(data: string | ArrayBuffer | Blob): Promise<void> {
    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : await data.text();
      const message = JSON.parse(text) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `CDP ${pending.method} failed${message.error.code === undefined ? "" : ` (${message.error.code})`}: ${message.error.message ?? "unknown error"}`,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        const event: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
        };
        if (message.sessionId) event.sessionId = message.sessionId;
        this.emit("event", event);
        this.emit(message.method, event.params, event.sessionId);
      }
    } catch (error) {
      this.disconnect(
        `Invalid CDP message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private disconnect(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(message);
    this.emit("disconnect", new CdpUnavailableError(message));
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.mutation
          ? new CdpUnknownOutcomeError(`${pending.method} interrupted; mutation outcome is unknown`)
          : new CdpUnavailableError(message),
      );
    }
    this.pending.clear();
  }
}

export class CdpSession extends EventEmitter {
  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {
    super();
    connection.on("event", this.forwardEvent);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { mutation?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.connection.send<T>(method, params, {
      ...options,
      sessionId: this.sessionId,
    });
  }

  detach(): Promise<void> {
    this.connection.off("event", this.forwardEvent);
    return this.connection.send(
      "Target.detachFromTarget",
      { sessionId: this.sessionId },
      { mutation: true },
    );
  }

  private readonly forwardEvent = (event: CdpEvent): void => {
    if (event.sessionId !== this.sessionId) return;
    this.emit("event", event);
    this.emit(event.method, event.params);
  };
}

export interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

export async function listPageTargets(connection: CdpConnection): Promise<CdpTarget[]> {
  const result = await connection.send<{ targetInfos: CdpTarget[] }>("Target.getTargets");
  return result.targetInfos.filter((target) => target.type === "page");
}

export async function attachToTarget(
  connection: CdpConnection,
  targetId: string,
): Promise<CdpSession> {
  const result = await connection.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
    { mutation: true },
  );
  return new CdpSession(connection, result.sessionId, targetId);
}
