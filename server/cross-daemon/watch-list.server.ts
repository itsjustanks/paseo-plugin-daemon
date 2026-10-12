// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json.server";

const watchSchema = z.object({
  id: z.string(),
  peerServerId: z.string(),
  agentId: z.string(),
  callerAgentId: z.string(),
  // The agent's UpdatedAt just before the message went in; a later value means its turn ran.
  updatedAtBeforeSend: z.string(),
  sawBusy: z.boolean(),
  watchedAt: z.string().datetime(),
});
export type Watch = z.infer<typeof watchSchema>;

// Agents on other daemons whose sender asked to be told when they finish.
export function createWatchList(stateDir: string) {
  const watchFile = join(stateDir, "watches.json");
  const list = (): Watch[] => readPrivateJson(watchFile, z.array(watchSchema), []);
  return {
    list,
    clear: () => writePrivateJson(watchFile, []),
    add(watch: Omit<Watch, "id" | "sawBusy" | "watchedAt">, watchedAt: Date): void {
      if (list().length >= 1000) throw new Error("Cross-daemon watch list is full");
      writePrivateJson(watchFile, [...list(), { ...watch, id: randomUUID(), sawBusy: false, watchedAt: watchedAt.toISOString() }]);
    },
    markBusy(id: string): void {
      writePrivateJson(watchFile, list().map((watch) => (watch.id === id ? { ...watch, sawBusy: true } : watch)));
    },
    remove(id: string): void {
      writePrivateJson(watchFile, list().filter((watch) => watch.id !== id));
    },
  };
}
export type WatchList = ReturnType<typeof createWatchList>;
