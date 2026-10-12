// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json.server";

const queuedMessageSchema = z.object({
  id: z.string(),
  // Null for an agent on this daemon: a notice to the agent that sent a message.
  peerServerId: z.string().nullable(),
  agentId: z.string(),
  text: z.string(),
  callerAgentId: z.string().nullable(),
  notifyOnFinish: z.boolean().default(false),
  // Set just before a send, so a send cut off by a restart is not repeated.
  inFlight: z.boolean().default(false),
  queuedAt: z.string().datetime(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

export function createMessageQueue(stateDir: string) {
  const queueFile = join(stateDir, "queue.json");
  const list = (): QueuedMessage[] => readPrivateJson(queueFile, z.array(queuedMessageSchema), []);
  return {
    list,
    clear: () => writePrivateJson(queueFile, []),
    add(message: Omit<QueuedMessage, "id" | "queuedAt" | "notifyOnFinish" | "inFlight"> & { notifyOnFinish?: boolean }, queuedAt: Date): QueuedMessage {
      const queued = { notifyOnFinish: false, ...message, id: randomUUID(), queuedAt: queuedAt.toISOString(), inFlight: false };
      const current = list();
      if (current.length >= 1000) throw new Error("Cross-daemon queue is full");
      writePrivateJson(queueFile, [...current, queued]);
      return queued;
    },
    remove(id: string): void {
      writePrivateJson(queueFile, list().filter((message) => message.id !== id));
    },
    setInFlight(id: string, inFlight: boolean): void {
      writePrivateJson(queueFile, list().map((message) => (message.id === id ? { ...message, inFlight } : message)));
    },
    countPendingFor(peerServerId: string | null, agentId: string): number {
      return list().filter((message) => message.peerServerId === peerServerId && message.agentId === agentId).length;
    },
  };
}
export type MessageQueue = ReturnType<typeof createMessageQueue>;
