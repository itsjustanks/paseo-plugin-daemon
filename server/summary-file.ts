import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HealthVerdict } from "../shared/health";
import { summarize } from "../shared/summary";
import { stateDirectory } from "./binaries";

/** Rewrites `host-summary.json` atomically (temp file, then rename); failures are logged, never thrown. */
export function summaryWriter(directory = stateDirectory()) {
  let queue: Promise<void> = Promise.resolve();
  return (verdict: HealthVerdict): Promise<void> => {
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, "host-summary.json");
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(summarize(verdict))}\n`, { mode: 0o600 });
      await rename(temp, file);
    }).catch((error) => console.error("daemon-link: host summary write failed", error instanceof Error ? error.name : "unknown"));
    return queue;
  };
}
