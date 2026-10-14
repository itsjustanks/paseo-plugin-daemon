/** Composer presence adapted from Omer Cohen's MIT Shared Browser, pinned at 504b5907.
 * License: managed-browser/LICENSE.txt. No browser is opened by these reads. */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listOpenBrowserWorkspacesRpc } from "../shared/managed-browser/browser";
import { canObserveAgents, supportsButtonPills } from "../shared/host-features";

const POLL_MS = 5_000;
const READ_MS = 5_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
type Placement = { id: string; workspaceId?: string };
type Page = { entries: Array<{ agent: Placement }>; pageInfo: { hasMore: boolean; nextCursor: string | null } };
type Update = { kind: "remove"; agentId: string } | { kind: "upsert"; agent: Placement };
type Observation = {
  subscribe(observer: { snapshot(page: Page): void; update(message: { type: string; payload: Update }): void; error(): void }): () => void;
  release(): Promise<void>;
};
export type BrowserPresencePort = {
  list(options: { cursor?: string; signal: AbortSignal; subscribe: boolean }): Promise<Page & { subscription?: Observation }>;
  read(): Promise<{ workspaceIds: string[] }>;
  add(agent: Required<Placement>): () => void;
};

/** One bounded presence read per installation, shared by every chat. Timed-out reads keep their
 * slot until settled, so an offline connection cannot accumulate background requests. */
export function followBrowserPresence(port: BrowserPresencePort): () => void {
  const lifetime = new AbortController();
  const agents = new Map<string, Required<Placement>>();
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let open = new Set<string>();
  let reading = false;
  let directoryBusy = false;
  let directory: Observation | null = null;
  let unsubscribe: (() => void) | null = null;
  let transaction: { generation: number; updates: Update[] } | null = null;
  let generation = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stopped = () => lifetime.signal.aborted;
  const later = (run: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!stopped()) run(); }, ms);
    timers.add(timer); return timer;
  };
  const clear = (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); };
  const remove = (id: string) => { pills.get(id)?.remove(); pills.delete(id); };
  const sync = () => {
    for (const [id, pill] of pills) {
      const agent = agents.get(id);
      if (!agent || agent.workspaceId !== pill.workspaceId || !open.has(pill.workspaceId)) remove(id);
    }
    for (const agent of agents.values()) {
      if (!open.has(agent.workspaceId) || pills.has(agent.id)) continue;
      try { pills.set(agent.id, { workspaceId: agent.workspaceId, remove: port.add(agent) }); }
      catch { /* The app may have removed the chat; retry on the next presence read. */ }
    }
  };
  const apply = (target: Map<string, Required<Placement>>, update: Update) => {
    if (update.kind === "remove") target.delete(update.agentId);
    else if (update.agent.workspaceId) target.set(update.agent.id, { id: update.agent.id, workspaceId: update.agent.workspaceId });
    else target.delete(update.agent.id);
  };
  const read = async () => {
    if (stopped() || reading || agents.size === 0 || !directory) return;
    reading = true;
    const source = directory;
    let expired = false;
    const deadline = later(() => { expired = true; open.clear(); sync(); }, READ_MS);
    try {
      const result = await port.read();
      if (stopped() || expired || directory !== source) return;
      open = new Set(result.workspaceIds); sync();
    } catch { if (!stopped()) { open.clear(); sync(); } }
    finally { clear(deadline); reading = false; }
  };
  const snapshot = async (first: Page) => {
    const current = { generation: ++generation, updates: [] as Update[] };
    transaction = current;
    const next = new Map<string, Required<Placement>>();
    const cursors = new Set<string>();
    const active = () => !stopped() && transaction === current;
    let expired = false;
    const abort = new AbortController();
    const stop = () => abort.abort();
    lifetime.signal.addEventListener("abort", stop, { once: true });
    const deadline = later(() => { expired = true; abort.abort(); }, READ_MS);
    try {
      let page = first;
      for (let count = 0; count < MAX_PAGES; count++) {
        for (const { agent } of page.entries) apply(next, { kind: "upsert", agent });
        const cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
        if (!cursor) break;
        if (count === MAX_PAGES - 1 || cursors.has(cursor)) throw new Error("Agent directory is incomplete");
        cursors.add(cursor);
        page = await port.list({ cursor, signal: abort.signal, subscribe: false });
        if (!active() || expired) return;
      }
      if (!active() || expired) return;
      for (const update of current.updates) apply(next, update);
      agents.clear(); for (const [id, agent] of next) agents.set(id, agent);
      sync(); void read();
    } catch { /* Keep the prior directory until the next authoritative snapshot. */ }
    finally {
      clear(deadline); lifetime.signal.removeEventListener("abort", stop);
      if (transaction === current) transaction = null;
    }
  };
  const release = () => {
    transaction = null;
    unsubscribe?.(); unsubscribe = null;
    const old = directory; directory = null;
    void old?.release().catch(() => undefined);
  };
  const connect = async () => {
    if (stopped() || directoryBusy || directory) return;
    directoryBusy = true;
    const abort = new AbortController();
    const stop = () => abort.abort();
    lifetime.signal.addEventListener("abort", stop, { once: true });
    let expired = false;
    const deadline = later(() => { expired = true; abort.abort(); }, READ_MS);
    try {
      const result = await port.list({ signal: abort.signal, subscribe: true });
      if (stopped() || expired) { void result.subscription?.release().catch(() => undefined); return; }
      if (!result.subscription) return;
      directory = result.subscription;
      const source = directory;
      void snapshot(result);
      unsubscribe = directory.subscribe({
        snapshot: (page) => { if (directory === source && !stopped()) void snapshot(page); },
        update: (message) => {
          if (stopped() || directory !== source || message.type !== "agent_update") return;
          if (transaction) {
            if (transaction.updates.length >= PAGE_LIMIT * MAX_PAGES) transaction = null;
            else transaction.updates.push(message.payload);
          }
          apply(agents, message.payload); sync(); void read();
        },
        error: () => { if (directory !== source || stopped()) return; release(); open.clear(); sync(); },
      });
    } catch { /* The timer retries after a failed connection has settled. */ }
    finally { clear(deadline); lifetime.signal.removeEventListener("abort", stop); directoryBusy = false; }
  };
  const tick = () => { void connect(); void read(); later(tick, POLL_MS); };
  tick();
  return () => {
    if (stopped()) return;
    lifetime.abort(); generation++; transaction = null;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    release(); for (const id of pills.keys()) remove(id);
    agents.clear(); open.clear();
  };
}

export function registerBrowserPresence(client: PluginClientContext): () => void {
  if (!supportsButtonPills(client) || !canObserveAgents(client.paseo)) return () => {};
  return followBrowserPresence({
    list: (options) => client.paseo.agents.list({ scope: "active", page: { limit: PAGE_LIMIT, ...(options.cursor ? { cursor: options.cursor } : {}) }, signal: options.signal, ...(options.subscribe ? { subscribe: {} } : {}) }) as unknown as ReturnType<BrowserPresencePort["list"]>,
    read: () => client.rpc(listOpenBrowserWorkspacesRpc, {}),
    add: ({ id, workspaceId }) => client.addComposerPill({ id: "hosts-workspace-browser", workspaceId, agentId: id,
      button: { title: "Open this workspace's browser", label: "Browser", icon: "Globe",
        behavior: { kind: "action", onPress: () => client.openPanel("hosts-browser", { workspaceId, agentId: id }) } } }).remove,
  });
}
