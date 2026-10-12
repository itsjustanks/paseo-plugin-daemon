import { setInterval, clearInterval } from "./node-timers";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import {
  type AgentBrowserOperation,
  type BridgeLease,
  isRuntimeResponse,
  type JsonValue,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeDescriptor,
  RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeResult,
} from "./runtime-protocol";
import { resolveSupervisorPaths, type SupervisorPaths } from "./supervisor-paths";

interface PendingRequest {
  resolve(value: RuntimeResult): void;
  reject(error: Error): void;
}

interface EndpointFile {
  version: number;
  socket: string;
}
type ClientRuntimeRequest<Request extends RuntimeRequest = RuntimeRequest> =
  Request extends RuntimeRequest ? Omit<Request, "id" | "token" | "version"> : never;

export interface SupervisorClientOptions {
  bridgeId: string;
  paths?: SupervisorPaths;
  takeover?: boolean;
}

export class SupervisorClient {
  private readonly bridgeId: string;
  private readonly paths: SupervisorPaths;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: Socket | null = null;
  private token = "";
  private epoch = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  private receiveBuffer = "";
  private readonly takeover: boolean;
  private reconnecting: Promise<BridgeLease> | null = null;
  private lease: BridgeLease | null = null;
  private closed = false;

  constructor(options: SupervisorClientOptions) {
    this.bridgeId = options.bridgeId;
    this.paths = options.paths ?? resolveSupervisorPaths();
    this.takeover = options.takeover === true;
  }

  async connect(): Promise<BridgeLease> {
    if (this.socket && !this.socket.destroyed && this.lease) return this.lease;
    if (!this.reconnecting) {
      this.closed = false;
      this.reconnecting = this.connectOnce();
    }
    try {
      return await this.reconnecting;
    } catch (error) {
      this.socket?.destroy();
      this.socket = null;
      this.epoch = 0;
      this.lease = null;
      throw error;
    } finally {
      this.reconnecting = null;
    }
  }

  private async connectOnce(): Promise<BridgeLease> {
    const [endpointText, token] = await Promise.all([
      readPrivateFile(this.paths.endpoint),
      readPrivateFile(this.paths.token),
    ]);
    const parsed: unknown = JSON.parse(endpointText);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("socket" in parsed)
    ) {
      throw new Error("Invalid supervisor endpoint file");
    }
    const endpoint = parsed as EndpointFile;
    if (endpoint.version !== RUNTIME_PROTOCOL_VERSION || typeof endpoint.socket !== "string")
      throw new Error("Supervisor endpoint protocol mismatch");
    this.token = token.trim();
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(endpoint.socket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.consume(chunk));
    this.socket.once("close", () => this.handleClose(new Error("Supervisor connection closed")));
    this.socket.on("error", (error) => this.handleClose(error));
    const lease = (await this.send({
      method: "bridge.claim",
      bridgeId: this.bridgeId,
      takeover: this.takeover,
    })) as BridgeLease;
    this.epoch = lease.epoch;
    this.lease = lease;
    this.armHeartbeat(lease.heartbeatIntervalMs);
    return lease;
  }

  async ensureWorkspace(workspaceId: string): Promise<RuntimeDescriptor> {
    await this.ensureLease();
    return (await this.send({
      method: "workspace.ensure",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      workspaceId,
    })) as RuntimeDescriptor;
  }

  async requestWorkspace(
    workspaceId: string,
    operation: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    await this.ensureLease();
    return (await this.send({
      method: "workspace.request",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      workspaceId,
      operation,
      input,
    })) as JsonValue;
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.ensureLease();
    await this.send({
      method: "workspace.archive",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      workspaceId,
    });
  }

  async closeWorkspace(workspaceId: string, runtimeId: string): Promise<void> {
    await this.ensureLease();
    await this.send({
      method: "workspace.close",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      workspaceId,
      runtimeId,
    });
  }
  async requestBrowser<Result = JsonValue>(operation: string, input: JsonValue): Promise<Result> {
    await this.ensureLease();
    return (await this.send({
      method: "browser.request",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      operation,
      input,
    })) as unknown as Result;
  }

  async issueAgentTicket(ticket: string): Promise<void> {
    await this.ensureLease();
    await this.send({
      method: "ticket.issue",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      ticket,
    });
  }

  async bindAgentTicket(ticket: string, agentId: string, workspaceId: string): Promise<void> {
    await this.ensureLease();
    await this.send({
      method: "ticket.bind",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      ticket,
      agentId,
      workspaceId,
    });
  }

  async revokeAgent(agentId: string): Promise<void> {
    await this.ensureLease();
    await this.send({
      method: "agent.revoke",
      bridgeId: this.bridgeId,
      epoch: this.epoch,
      agentId,
    });
  }

  disconnect(): void {
    this.closed = true;
    this.clearHeartbeat();
    this.socket?.destroy();
    this.lease = null;
    this.socket = null;
  }

  private async send(request: ClientRuntimeRequest): Promise<RuntimeResult> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Supervisor client is not connected");
    const id = randomUUID();
    const message = {
      ...request,
      id,
      token: this.token,
      version: RUNTIME_PROTOCOL_VERSION,
    } as RuntimeRequest;
    const result = new Promise<RuntimeResult>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    socket.write(`${JSON.stringify(message)}\n`);
    return await result;
  }

  private consume(chunk: string): void {
    this.receiveBuffer += chunk;
    if (this.receiveBuffer.split("\n").some((line) => Buffer.byteLength(line) > 1024 * 1024)) {
      this.handleClose(new Error("Supervisor reply exceeded the private transport limit"));
      this.receiveBuffer = "";
      return;
    }
    let newline = this.receiveBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline);
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          this.handleClose(new Error("Supervisor returned invalid JSON"));
          return;
        }
        if (!isRuntimeResponse(parsed)) {
          this.handleClose(new Error("Supervisor returned an invalid response"));
          return;
        }
        this.settle(parsed);
      }
      newline = this.receiveBuffer.indexOf("\n");
    }
  }

  private settle(response: RuntimeResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new RuntimeProtocolError(response.error.code, response.error.message));
  }

  private armHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // A delayed response must not produce duplicate maintenance or let an old
      // connection's completion replace or close the current bridge lease.
      if (this.heartbeatInFlight) return;
      const socket = this.socket;
      const epoch = this.epoch;
      const operation = this.send({ method: "bridge.heartbeat", bridgeId: this.bridgeId, epoch })
        .then((result) => {
          if (this.socket !== socket || this.epoch !== epoch) return;
          const lease = result as BridgeLease;
          this.epoch = lease.epoch;
          this.lease = lease;
        })
        .catch((error: unknown) => {
          if (this.socket !== socket || this.epoch !== epoch) return;
          this.handleClose(
            error instanceof Error ? error : new Error("Supervisor heartbeat failed"),
          );
        })
        .finally(() => {
          if (this.heartbeatInFlight === operation) this.heartbeatInFlight = null;
        });
      this.heartbeatInFlight = operation;
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = null;
  }

  private async ensureLease(): Promise<void> {
    if (this.epoch !== 0 && this.socket && !this.socket.destroyed) return;
    await this.connect();
  }

  private handleClose(error: Error): void {
    this.receiveBuffer = "";
    if (this.closed && this.pending.size === 0) return;
    this.clearHeartbeat();
    this.socket?.destroy();
    this.socket = null;
    this.epoch = 0;
    this.lease = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export interface AgentSupervisorClientOptions {
  ticket: string;
  paths?: SupervisorPaths;
}

export class AgentSupervisorClient {
  private readonly ticket: string;
  private readonly paths: SupervisorPaths;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: Socket | null = null;
  private receiveBuffer = "";
  private closed = false;

  constructor(options: AgentSupervisorClientOptions) {
    this.ticket = options.ticket;
    this.paths = options.paths ?? resolveSupervisorPaths();
  }

  async open(): Promise<void> {
    if (this.socket) throw new Error("Agent supervisor client is already connected");
    this.closed = false;
    const endpointText = await readPrivateFile(this.paths.endpoint);
    const parsed: unknown = JSON.parse(endpointText);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("socket" in parsed)
    )
      throw new Error("Invalid supervisor endpoint file");
    const endpoint = parsed as EndpointFile;
    if (endpoint.version !== RUNTIME_PROTOCOL_VERSION || typeof endpoint.socket !== "string")
      throw new Error("Supervisor endpoint protocol mismatch");
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(endpoint.socket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.consume(chunk));
    this.socket.once("close", () => this.handleClose(new Error("Supervisor connection closed")));
    this.socket.on("error", (error) => this.handleClose(error));
  }
  async request(operation: AgentBrowserOperation, input: JsonValue): Promise<JsonValue> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Agent supervisor client is not connected");
    const id = randomUUID();
    const message: RuntimeRequest = {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method: "agent.request",
      ticket: this.ticket,
      operation,
      input,
    };
    const result = new Promise<RuntimeResult>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    socket.write(`${JSON.stringify(message)}\n`);
    return (await result) as JsonValue;
  }

  disconnect(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }

  private consume(chunk: string): void {
    this.receiveBuffer += chunk;
    if (this.receiveBuffer.split("\n").some((line) => Buffer.byteLength(line) > 1024 * 1024)) {
      this.handleClose(new Error("Supervisor reply exceeded the private transport limit"));
      this.receiveBuffer = "";
      return;
    }
    let newline = this.receiveBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline);
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          this.handleClose(new Error("Supervisor returned invalid JSON"));
          return;
        }
        if (!isRuntimeResponse(parsed)) {
          this.handleClose(new Error("Supervisor returned an invalid response"));
          return;
        }
        const pending = this.pending.get(parsed.id);
        if (pending) {
          this.pending.delete(parsed.id);
          if (parsed.ok) pending.resolve(parsed.result);
          else pending.reject(new RuntimeProtocolError(parsed.error.code, parsed.error.message));
        }
      }
      newline = this.receiveBuffer.indexOf("\n");
    }
  }

  private handleClose(error: Error): void {
    this.receiveBuffer = "";
    if (this.closed && this.pending.size === 0) return;
    this.socket?.destroy();
    this.socket = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function readPrivateFile(path: string): Promise<string> {
  if (process.platform !== "win32") {
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`Supervisor file is not private: ${path}`);
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`Supervisor file is owned by another user: ${path}`);
    }
  }
  return await readFile(path, "utf8");
}
