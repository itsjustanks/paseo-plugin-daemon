// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { safeCrossDaemonText } from "../../shared/cross-daemon/privacy";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";
import type { MessageQueue, QueuedMessage } from "./message-queue.server";
import type { PaseoCli, PaseoCliOptions } from "./paseo-cli.server";
import type { Watch, WatchList } from "./watch-list.server";

const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_WAITING_PER_AGENT = 20;
const ROUND_BATCH_SIZE = 32;
const inspectedAgentSchema = z.object({
  Id: z.string(),
  Status: z.string(),
  UpdatedAt: z.string(),
  Archived: z.boolean().default(false),
});
const PERMANENT_FAILURE = /agent not found|no agent found|ambiguous|is archived/i;
// The CLI stopped by the plugin's own timeout: the daemon may already have taken the message.


// Null means this daemon: a notice to the agent that sent a message.
type Daemon = Peer | null;

// Keeps pairing links out of anything an agent or a log sees.
export function describeError(error: unknown, daemon: Daemon): string {
  const reason = error instanceof Error ? error.message : String(error);
  return safeCrossDaemonText(reason, daemon ? [daemon.link] : []);
}

export class MaybeDeliveredError extends Error {}

export interface SendRequest {
  peer: Peer;
  agentRef: string;
  text: string;
  callerAgentId: string | null;
  notifyOnFinish: boolean;
}

export type SendOutcome = { kind: "sent" | "queued" | "queued-behind"; agentId: string };

interface MessengerDependencies {
  queue: MessageQueue;
  watches: WatchList;
  readPeers(): Peer[];
  cli: PaseoCli;
  now?: () => number;
  isActive?: () => boolean;
}

function runOn(cli: PaseoCli, daemon: Daemon, args: readonly string[], options?: PaseoCliOptions) {
  return daemon ? cli.run(daemon.link, args, options) : cli.runLocal(args, options);
}

function composeFinishNotice(peer: Peer, agentId: string, lastMessage: string): string {
  const marker = randomBytes(16).toString("hex");
  return [
    `[cross-daemon notice ${marker}] Agent ${agentId} on daemon "${peer.name}" (${peer.serverId}) finished the task you sent it. ` +
      `Its last message is between the two ${marker} lines.`,
    `----- ${marker} begin -----`,
    safeCrossDaemonText(lastMessage).slice(0, 64_000) || "(none)",
    `----- ${marker} end -----`,
  ].join("\n");
}

export function createMessenger({ queue, watches, readPeers, cli, now = Date.now, isActive = () => true }: MessengerDependencies) {
  const agentLocks = new Map<string, Promise<unknown>>();
  const activeSends = new Set<string>();

  // One check-then-send at a time per agent, shared by the tool and the delivery rounds, so two
  // messages can never both find an agent idle and the second interrupt the first.
  async function withAgentLock<T>(serverId: string | null, agentId: string, action: () => Promise<T>): Promise<T> {
    const key = `${serverId ?? "local"}/${agentId}`;
    const previous = agentLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(action);
    agentLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (agentLocks.get(key) === run) agentLocks.delete(key);
    }
  }

  async function inspect(daemon: Daemon, agentRef: string) {
    const inspected = inspectedAgentSchema.parse(JSON.parse(await runOn(cli, daemon, ["inspect", agentRef, "--json"])));
    if (inspected.Archived) throw new Error(`Agent ${inspected.Id} is archived`);
    return { id: inspected.Id, busy: inspected.Status !== "idle", updatedAt: inspected.UpdatedAt };
  }

  async function deliver(daemon: Daemon, agentId: string, text: string): Promise<void> {
    if (!isActive()) throw new Error("Cross-daemon is off or unavailable");
    try {
      await runOn(cli, daemon, ["send", agentId, "--no-wait"], { promptText: text });
    } catch (error) {
      // Any send failure can follow remote acceptance (disconnect, timeout, buffer limit, crash).
      // Preserve a known permanent rejection; every other failure is uncertain and never retried.
      if (PERMANENT_FAILURE.test(describeError(error, daemon))) throw error;
      throw new MaybeDeliveredError(`The send failed without acknowledgement, so the message may have been delivered to agent ${agentId}.`);
    }
  }

  function tellSender(callerAgentId: string | null, text: string): void {
    if (isActive() && callerAgentId) queue.add({ peerServerId: null, agentId: callerAgentId, text, callerAgentId: null }, new Date(now()));
  }

  function watchIfAsked(peer: Peer, agentId: string, callerAgentId: string | null, notify: boolean, updatedAt: string) {
    if (isActive() && notify && callerAgentId) {
      watches.add({ peerServerId: peer.serverId, agentId, callerAgentId, updatedAtBeforeSend: updatedAt }, new Date(now()));
    }
  }

  async function send(request: SendRequest): Promise<SendOutcome> {
    const { peer, text, callerAgentId, notifyOnFinish } = request;
    // Outside the lock this only resolves a prefix to the full ID: the reading may be stale by the
    // time the lock is held, so the agent is read again inside it.
    const { id: agentId } = await inspect(peer, request.agentRef);
    return withAgentLock(peer.serverId, agentId, async () => {
      if (!isActive()) throw new Error("Cross-daemon is off or unavailable");
      const waiting = queue.countPendingFor(peer.serverId, agentId);
      if (waiting >= MAX_WAITING_PER_AGENT) {
        throw new Error(`${MAX_WAITING_PER_AGENT} messages are already waiting for agent ${agentId}. Try again once it has read them.`);
      }
      const queueIt = () => queue.add({ peerServerId: peer.serverId, agentId, text, callerAgentId, notifyOnFinish }, new Date(now()));
      if (waiting > 0) {
        queueIt();
        return { kind: "queued-behind", agentId };
      }
      const state = await inspect(peer, agentId);
      if (!isActive()) throw new Error("Cross-daemon is off or unavailable");
      if (state.busy) {
        queueIt();
        return { kind: "queued", agentId };
      }
      // Persist before issuing even an immediate send; a restart must never replay it.
      const pending = queueIt();
      queue.setInFlight(pending.id, true);
      activeSends.add(pending.id);
      try { await deliver(peer, agentId, text); }
      finally { activeSends.delete(pending.id); }
      if (isActive()) queue.remove(pending.id);
      try { watchIfAsked(peer, agentId, callerAgentId, notifyOnFinish, state.updatedAt); }
      catch { /* Delivery was acknowledged. Never report failure that invites a duplicate send. */ }
      return { kind: "sent", agentId };
    });
  }

  function dropMessage(message: QueuedMessage, where: string, reason: string): void {
    console.warn("cross-daemon: a queued message was dropped; inspect activity before resending");
    queue.remove(message.id);
    tellSender(message.callerAgentId, `[cross-daemon notice] Delivery report for agent ${message.agentId} on ${where}: ${reason}`);
  }

  async function deliverQueued(message: QueuedMessage): Promise<void> {
    const daemon = message.peerServerId === null ? null : readPeers().find((peer) => peer.serverId === message.peerServerId);
    const where = daemon === null ? "this daemon" : (daemon?.name ?? message.peerServerId ?? "?");
    if (!isActive()) return;
    // Live sends hold the same agent lock. Do not block a round on them or misclassify them as restarts.
    if (activeSends.has(message.id)) return;
    await withAgentLock(message.peerServerId, message.agentId, async () => {
      const current = queue.list().find((entry) => entry.id === message.id);
      if (!current || !isActive() || activeSends.has(message.id)) return;
      if (current.inFlight) {
        dropMessage(current, where, "its send was cut off before acknowledgement, so it may have been delivered. Check before sending again.");
        return;
      }
      if (now() - Date.parse(current.queuedAt) > MAX_MESSAGE_AGE_MS) {
        dropMessage(current, where, "it waited more than 24 hours for the agent to become idle.");
        return;
      }
      // A daemon that is switched off, or not synced yet, keeps its messages until they expire.
      if (daemon === undefined) return;
      let sendStarted = false;
      try {
        const before = await inspect(daemon, message.agentId);
        if (before.busy || !isActive()) return;
        if (now() - Date.parse(message.queuedAt) > MAX_MESSAGE_AGE_MS) {
          dropMessage(message, where, "it waited more than 24 hours for the agent to become idle.");
          return;
        }
        queue.setInFlight(message.id, true);
        sendStarted = true;
        activeSends.add(message.id);
        try { await deliver(daemon, message.agentId, message.text); }
        finally { activeSends.delete(message.id); }
        if (!isActive()) return;
        queue.remove(message.id);
        if (daemon) watchIfAsked(daemon, message.agentId, message.callerAgentId, message.notifyOnFinish, before.updatedAt);
      } catch (error) {
        if (!isActive()) return;
        const reason = describeError(error, daemon);
        if (sendStarted || error instanceof MaybeDeliveredError || PERMANENT_FAILURE.test(reason)) {
          dropMessage(message, where, sendStarted && !(error instanceof MaybeDeliveredError) ? "The send may have been delivered; check activity before resending." : reason);
          return;
        }
        console.warn("cross-daemon: inspection failed; pending message will wait");
        queue.setInFlight(message.id, false);
      }
    });
  }

  async function checkWatch(watch: Watch): Promise<void> {
    if (!isActive()) return;
    if (now() - Date.parse(watch.watchedAt) > MAX_MESSAGE_AGE_MS) {
      watches.remove(watch.id);
      tellSender(watch.callerAgentId, `[cross-daemon notice] Gave up after 24 hours: did not see agent ${watch.agentId} finish.`);
      return;
    }
    const peer = readPeers().find((candidate) => candidate.serverId === watch.peerServerId);
    if (!peer) return;
    try {
      const state = await inspect(peer, watch.agentId);
      if (!isActive()) return;
      if (state.busy) {
        if (!watch.sawBusy) watches.markBusy(watch.id);
        return;
      }
      if (!watch.sawBusy && state.updatedAt === watch.updatedAtBeforeSend) return;
      const lastMessage = await cli.run(peer.link, ["logs", watch.agentId, "--filter", "text", "--tail", "1"]);
      if (!isActive()) return;
      tellSender(watch.callerAgentId, composeFinishNotice(peer, watch.agentId, lastMessage));
      watches.remove(watch.id);
    } catch (error) {
      const reason = describeError(error, peer);
      console.warn("cross-daemon: could not check a finish watch");
      if (isActive() && PERMANENT_FAILURE.test(reason)) watches.remove(watch.id);
    }
  }

  // Watches first, so a finish notice can go out in the same round. Only the oldest message per
  // agent is tried: once it is delivered the agent is busy, and the next one waits.
  let round: Promise<void> | null = null;
  let watchOffset = 0;
  let messageOffset = 0;
  function fairBatch<T>(items: readonly T[], offset: number): { batch: T[]; next: number } {
    if (!items.length) return { batch: [], next: 0 };
    const count = Math.min(ROUND_BATCH_SIZE, items.length);
    return { batch: Array.from({ length: count }, (_, index) => items[(offset + index) % items.length]), next: (offset + count) % items.length };
  }
  async function processRound(): Promise<void> {
    try {
      if (!isActive()) return;
      const selectedWatches = fairBatch(watches.list(), watchOffset);
      watchOffset = selectedWatches.next;
      await Promise.allSettled(selectedWatches.batch.map(checkWatch));
      if (!isActive()) return;
      const oldestPerAgent = new Map<string, QueuedMessage>();
      for (const message of queue.list()) {
        const key = `${message.peerServerId ?? "local"}/${message.agentId}`;
        if (!oldestPerAgent.has(key)) oldestPerAgent.set(key, message);
      }
      const selectedMessages = fairBatch([...oldestPerAgent.values()], messageOffset);
      messageOffset = selectedMessages.next;
      await Promise.allSettled(selectedMessages.batch.map(deliverQueued));
    } catch (error) {
      console.error("cross-daemon: a delivery round failed");
    }
  }

  function runRound(): Promise<void> {
    if (!round) round = processRound().finally(() => { round = null; });
    return round;
  }
  return { send, runRound };
}
export type Messenger = ReturnType<typeof createMessenger>;

export function startDeliveryWorker(messenger: Messenger, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    messenger.runRound().finally(() => {
      running = false;
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
