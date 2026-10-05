/**
 * The Hosts chip on each live agent's composer, as a registry with
 * everything it touches passed in, so it can be tested without an app.
 *
 * A chip exists only while the agent's workspace has something to report (a
 * verified dev server, or an issue that touches it). Paseo 0.8.0 stable and
 * later take a chip as a `button` and hand back `{ update, remove }`; the old
 * shape (a React `Component`, from the 0.8.0-beta.1 SDK) throws there, so on
 * 0.9 and 0.11 apps no chip ever showed. With buttons the label is a string
 * this registry pushes; on an app that still takes the component, the
 * component draws its own label and `update` does nothing.
 */
import { pillText, workspaceHealth, type HealthStatus, type HealthVerdict } from "./health";
import type { WorkspaceTarget } from "./workspace-filter";

export type PillAgent = { id: string; workspaceId: string };
export type PillFace = { label: string; icon: string };
export type PillHandle = { update(face: PillFace): void; remove(): void };

const ICONS: Record<HealthStatus, string> = { ok: "Server", warning: "TriangleAlert", critical: "CircleAlert", unknown: "Server" };

/** What the chip says and shows for one workspace, or null when there is nothing worth a chip. */
export function pillFace(verdict: HealthVerdict, target: WorkspaceTarget): PillFace | null {
  const health = workspaceHealth(verdict, target);
  const label = pillText(health);
  return label === null ? null : { label, icon: ICONS[health.status] };
}

export type PillDeps = {
  addPill(agent: PillAgent, face: PillFace): PillHandle;
  readSettings(): Promise<{ showComposerPill: boolean; snapshotIntervalSeconds: number }>;
  readVerdict(): Promise<HealthVerdict>;
  /** The workspace's directory and name; null when the app doesn't know it (yet). */
  target(workspaceId: string): Promise<WorkspaceTarget | null>;
  /** Tell the old component shape about a new verdict (it renders its own label). */
  publish?(verdict: HealthVerdict): void;
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

export function createPillRegistry(deps: PillDeps) {
  const agents = new Map<string, PillAgent>();
  const pills = new Map<string, { handle: PillHandle; label: string }>();
  let verdict: HealthVerdict | null = null;
  let timer: unknown = null;
  let polling = false;
  let again = false;
  let stopped = false;

  const remove = (id: string) => { pills.get(id)?.handle.remove(); pills.delete(id); };

  const reconcile = async (show: boolean) => {
    for (const id of [...pills.keys()]) if (!agents.has(id) || !show || !verdict) remove(id);
    if (!show || !verdict) return;
    for (const agent of [...agents.values()]) {
      const target = await deps.target(agent.workspaceId).catch(() => null);
      if (stopped || agents.get(agent.id) !== agent) continue;
      const face = target && verdict ? pillFace(verdict, target) : null;
      const shown = pills.get(agent.id);
      if (!face) { if (shown) remove(agent.id); continue; }
      if (!shown) {
        try { pills.set(agent.id, { handle: deps.addPill(agent, face), label: face.label }); }
        catch { /* An app that refuses this chip (a workspace it doesn't know yet) gets another try on the next read. */ }
      } else if (shown.label !== face.label) {
        try { shown.handle.update(face); shown.label = face.label; } catch { /* Removed meanwhile. */ }
      }
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (polling) { again = true; return; }
    polling = true;
    timer = null;
    let interval = 30;
    try {
      const settings = await deps.readSettings().catch(() => ({ showComposerPill: true, snapshotIntervalSeconds: 30 }));
      interval = settings.snapshotIntervalSeconds || 30;
      if (settings.showComposerPill && agents.size > 0) {
        try { verdict = await deps.readVerdict(); deps.publish?.(verdict); }
        catch { /* The host is unreachable from here; keep the last verdict until it answers again. */ }
      }
      if (!stopped) await reconcile(settings.showComposerPill);
    } finally {
      polling = false;
      if (!stopped) {
        if (again) { again = false; void poll(); }
        else timer = deps.schedule(() => void poll(), interval * 1000);
      }
    }
  };

  const pollNow = () => {
    if (timer !== null) deps.cancel(timer);
    timer = null;
    void poll();
  };

  return {
    /** An agent appeared or moved to another workspace. */
    upsert(agent: PillAgent) {
      if (stopped || !agent.id || !agent.workspaceId) return;
      const known = agents.get(agent.id);
      if (known?.workspaceId === agent.workspaceId) return;
      agents.set(agent.id, agent);
      if (known) remove(agent.id);
      // A new agent should not wait a full interval for its chip.
      pollNow();
    },
    remove(agentId: string) {
      agents.delete(agentId);
      remove(agentId);
    },
    /** A full list (a snapshot after connecting or reconnecting) replaces what was known. */
    replaceAll(list: PillAgent[]) {
      if (stopped) return;
      const next = new Map(list.filter((agent) => agent.id && agent.workspaceId).map((agent) => [agent.id, agent]));
      let changed = next.size !== agents.size;
      for (const [id, agent] of next) if (agents.get(id)?.workspaceId !== agent.workspaceId) { changed = true; if (agents.has(id)) remove(id); }
      for (const id of agents.keys()) if (!next.has(id)) remove(id);
      agents.clear();
      for (const [id, agent] of next) agents.set(id, agent);
      if (changed) pollNow();
    },
    start() { void poll(); },
    stop() {
      stopped = true;
      if (timer !== null) deps.cancel(timer);
      timer = null;
      for (const id of [...pills.keys()]) remove(id);
      agents.clear();
    },
    /** For tests: which agents have a chip, and what it says. */
    shown(): Record<string, string> {
      return Object.fromEntries([...pills].map(([id, pill]) => [id, pill.label]));
    },
  };
}
