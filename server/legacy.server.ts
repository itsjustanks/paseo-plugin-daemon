import { LinkManager } from "./links";
import { PeerManager } from "./peers";
export { handleMonitorForceStop, handleMonitorSnapshot, handleMonitorStop } from "./handlers";
export { installCloudflared } from "./binaries";

export function createRuntime() {
  return { links: new LinkManager(), peers: new PeerManager() };
}
