/** Refuse protocol rollover while an older private owner can still use the saved profiles. */
import { lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolveSupervisorPaths } from "./supervisor-paths";
import { assertUpgradeReceiptVerified } from "./browser-upgrade-receipt";
import { BROWSER_RUNTIME_UPGRADE_REQUIRED } from "../../shared/managed-browser/browser-runtime-upgrade";
const MIGRATION_MESSAGE = `${BROWSER_RUNTIME_UPGRADE_REQUIRED}: The previous workspace browser runtime is still running. Use Restart Hosts browser runtime to close ALL managed browser sessions on this host and finish the upgrade. Saved site profiles are retained; existing browser-enabled agents need new configuration.`;
/** Liveness probe only: never claim the old bridge, send commands, signal or delete state. */
export async function assertPreviousBrowserStopped(paseoHome: string): Promise<void> {
  assertUpgradeReceiptVerified(paseoHome);
  const paths = resolveSupervisorPaths(paseoHome, 2);
  let metadata;
  try { metadata = await lstat(paths.endpoint); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4096 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Previous browser runtime metadata is not private; migration refused");
  }
  let endpoint: unknown;
  try { endpoint = JSON.parse(await readFile(paths.endpoint, "utf8")); }
  catch { throw new Error("Previous browser runtime metadata is invalid; migration refused"); }
  if (!endpoint || typeof endpoint !== "object" || !("version" in endpoint) ||
      endpoint.version !== 2 || !("socket" in endpoint) || endpoint.socket !== paths.socket) {
    throw new Error("Previous browser runtime metadata does not match its private endpoint");
  }
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(paths.socket);
    const timer = setTimeout(() => finish(new Error(MIGRATION_MESSAGE)), 250);
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.removeAllListeners(); socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.once("connect", () => finish(new Error(MIGRATION_MESSAGE)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish();
      else finish(new Error("Previous browser runtime could not be checked; migration refused"));
    });
  });
  // A confirmed restart may have begun while the read-only socket probe awaited.
  // Its missing endpoint is not permission to claim a new bridge yet.
  assertUpgradeReceiptVerified(paseoHome);
}
