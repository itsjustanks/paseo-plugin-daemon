import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol";

export interface SupervisorPaths {
  root: string;
  socket: string;
  token: string;
  endpoint: string;
  lock: string;
}

export function resolveSupervisorPaths(
  paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): SupervisorPaths {
  const root = join(
    paseoHome,
    "plugin-data",
    "daemon-link", "browser",
    `supervisor-v${RUNTIME_PROTOCOL_VERSION}`,
  );
  const socketId = createHash("sha256").update(root).digest("hex");
  const socket =
    process.platform === "win32"
      ? String.raw`\\.\pipe\paseo-hosts-browser-${socketId}`
      : join(tmpdir(), `psb-${socketId.slice(0, 16)}.sock`);
  return {
    root,
    socket,
    token: join(root, "runtime.token"),
    endpoint: join(root, "runtime.json"),
    lock: join(root, "startup.lock"),
  };
}
