// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { type DaemonPort, syncPeers } from "./peer-sync.client";

const SYNC_DEBOUNCE_MS = 1_000;
const RESYNC_INTERVAL_MS = 60_000;

interface SyncScheduler {
  ports: Set<DaemonPort>;
  generation: number;
  pending: ReturnType<typeof setTimeout> | null;
  resync: ReturnType<typeof setInterval> | null;
  running: boolean;
  rerunRequested: boolean;
}

declare global {
  var __hostsCrossDaemonSchedulerV2: SyncScheduler | undefined;
}

// Paseo evaluates this bundle once per connected host, so module state is per host. The scheduler
// lives on globalThis so that one sync sees every updated host. V2 isolates bounded rounds
// from older bundles whose never-settling V1 round could otherwise stall this scheduler.
function getSharedScheduler(): SyncScheduler {
  globalThis.__hostsCrossDaemonSchedulerV2 ??= {
    ports: new Set(),
    generation: 0,
    pending: null,
    resync: null,
    running: false,
    rerunRequested: false,
  };
  return globalThis.__hostsCrossDaemonSchedulerV2;
}

// One sync at a time: an older sync finishing late would otherwise restore a link a newer one removed.
async function runSync(state: SyncScheduler): Promise<void> {
  if (state.running) {
    state.rerunRequested = true;
    return;
  }
  state.running = true;
  try {
    do {
      state.rerunRequested = false;
      const generation = state.generation;
      await syncPeers([...state.ports], (port) => generation === state.generation && state.ports.has(port));
    } while (state.rerunRequested);
  } finally {
    state.running = false;
  }
}

export function requestPeerSync(): void {
  const state = getSharedScheduler();
  state.generation++;
  if (state.pending) clearTimeout(state.pending);
  state.pending = setTimeout(() => {
    state.pending = null;
    void runSync(state);
  }, SYNC_DEBOUNCE_MS);
}

export function listRegisteredDaemons(): DaemonPort[] {
  return [...getSharedScheduler().ports];
}

export function registerDaemon(port: DaemonPort): () => void {
  const state = getSharedScheduler();
  state.ports.add(port);
  state.resync ??= setInterval(requestPeerSync, RESYNC_INTERVAL_MS);
  requestPeerSync();
  return () => {
    state.ports.delete(port);
    requestPeerSync();
    if (state.ports.size > 0) return;
    if (state.resync) clearInterval(state.resync);
    if (state.pending) clearTimeout(state.pending);
    state.resync = null;
    state.pending = null;
  };
}
