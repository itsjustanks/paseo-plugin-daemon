export const RUNTIME_PROTOCOL_VERSION = 2 as const;
export const DEFAULT_ORPHAN_GRACE_MS = 120_000;
export const DEFAULT_BRIDGE_HEARTBEAT_MS = 10_000;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeDescriptor {
  workspaceId: string;
  runtimeId: string;
  createdAt: number;
}

export interface BridgeLease {
  bridgeId: string;
  epoch: number;
  heartbeatIntervalMs: number;
  expiresAt: number;
}

interface RuntimeRequestBase {
  id: string;
  version: typeof RUNTIME_PROTOCOL_VERSION;
}

interface AdminRequestBase extends RuntimeRequestBase {
  token: string;
  bridgeId: string;
}

export type AgentBrowserOperation =
  | "status"
  | "capture"
  | "acquire-control"
  | "release-control"
  | "navigate"
  | "input"
  | "viewport"
  | "tabs.list"
  | "tabs.create"
  | "tabs.select"
  | "tabs.close";

export type RuntimeRequest =
  | (AdminRequestBase & { method: "bridge.claim"; takeover?: boolean })
  | (AdminRequestBase & { method: "bridge.heartbeat"; epoch: number })
  | (AdminRequestBase & {
      method: "workspace.ensure";
      epoch: number;
      workspaceId: string;
    })
  | (AdminRequestBase & {
      method: "workspace.request";
      epoch: number;
      workspaceId: string;
      operation: string;
      input: JsonValue;
    })
  | (AdminRequestBase & {
      method: "workspace.archive";
      epoch: number;
      workspaceId: string;
    })
  | (AdminRequestBase & {
      method: "workspace.close";
      epoch: number;
      workspaceId: string;
      runtimeId: string;
    })
  | (AdminRequestBase & {
      method: "browser.request";
      epoch: number;
      operation: string;
      input: JsonValue;
    })
  | (AdminRequestBase & {
      method: "ticket.issue";
      epoch: number;
      ticket: string;
    })
  | (AdminRequestBase & {
      method: "ticket.bind";
      epoch: number;
      ticket: string;
      agentId: string;
      workspaceId: string;
    })
  | (AdminRequestBase & {
      method: "agent.revoke";
      epoch: number;
      agentId: string;
    })
  | (RuntimeRequestBase & {
      method: "agent.request";
      ticket: string;
      operation: AgentBrowserOperation;
      input: JsonValue;
    });

export type RuntimeResult = BridgeLease | RuntimeDescriptor | JsonValue | { archived: true };

export type RuntimeResponse =
  | { id: string; ok: true; result: RuntimeResult }
  | {
      id: string;
      ok: false;
      error: { code: RuntimeErrorCode; message: string };
    };

export type RuntimeErrorCode =
  | "AUTHENTICATION_FAILED"
  | "BRIDGE_FENCED"
  | "INVALID_REQUEST"
  | "PROTOCOL_MISMATCH"
  | "WORKSPACE_ARCHIVED"
  | "WORKSPACE_NOT_FOUND"
  | "RUNTIME_BUSY"
  | "UNKNOWN_OUTCOME"
  | "RUNTIME_LOST"
  | "RUNTIME_FAILURE";

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeProtocolError";
    this.code = code;
  }
}

/** The owned runtime can never serve again; the next explicit attach must replace it. */
export class RuntimeLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeLostError";
  }
}

export function isRuntimeResponse(value: unknown): value is RuntimeResponse {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean")
    return false;
  if (value.ok) return "result" in value;
  return (
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  if (!isRecord(value))
    throw new RuntimeProtocolError("INVALID_REQUEST", "Request must be an object");
  const id = requireString(value, "id");
  const method = requireString(value, "method");
  if (value.version !== RUNTIME_PROTOCOL_VERSION) {
    throw new RuntimeProtocolError(
      "PROTOCOL_MISMATCH",
      `Expected protocol version ${RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  if (method === "agent.request") {
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      ticket: requireString(value, "ticket"),
      operation: requireAgentOperation(value.operation),
      input: requireJsonValue(value, "input"),
    };
  }

  const token = requireString(value, "token");
  const bridgeId = requireString(value, "bridgeId");
  if (method === "bridge.claim")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      takeover: value.takeover === true,
    };
  const epoch = requireInteger(value, "epoch");
  if (method === "bridge.heartbeat")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
    };
  if (method === "workspace.ensure" || method === "workspace.archive")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      workspaceId: requireString(value, "workspaceId"),
    };
  if (method === "workspace.close")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      workspaceId: requireString(value, "workspaceId"),
      runtimeId: requireString(value, "runtimeId"),
    };
  if (method === "workspace.request")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      workspaceId: requireString(value, "workspaceId"),
      operation: requireString(value, "operation"),
      input: requireJsonValue(value, "input"),
    };
  if (method === "browser.request")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      operation: requireString(value, "operation"),
      input: requireJsonValue(value, "input"),
    };
  if (method === "ticket.issue")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      ticket: requireString(value, "ticket"),
    };
  if (method === "ticket.bind")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      ticket: requireString(value, "ticket"),
      agentId: requireString(value, "agentId"),
      workspaceId: requireString(value, "workspaceId"),
    };
  if (method === "agent.revoke")
    return {
      id,
      version: RUNTIME_PROTOCOL_VERSION,
      method,
      token,
      bridgeId,
      epoch,
      agentId: requireString(value, "agentId"),
    };
  throw new RuntimeProtocolError("INVALID_REQUEST", `Unknown method: ${method}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0)
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be a non-empty string`);
  return result;
}

function requireInteger(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result))
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be a safe integer`);
  return result;
}

function requireAgentOperation(value: unknown): AgentBrowserOperation {
  if (
    value === "status" ||
    value === "capture" ||
    value === "acquire-control" ||
    value === "release-control" ||
    value === "navigate" ||
    value === "input" ||
    value === "viewport"
  )
    return value;
  throw new RuntimeProtocolError("INVALID_REQUEST", "Unknown agent browser operation");
}

function requireJsonValue(value: Record<string, unknown>, key: string): JsonValue {
  if (!(key in value) || !isJsonValue(value[key]))
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be valid JSON`);
  return value[key];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
