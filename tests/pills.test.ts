import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HealthVerdict } from "../shared/health";
import { canObserveAgents, externalUrlOpener, supportsButtonPills, supportsNativeScreens } from "../shared/host-features";
import { createPillRegistry, pillFace, type PillFace } from "../shared/pills";

const verdict = (over: Partial<HealthVerdict> = {}): HealthVerdict => ({
  status: "ok", checkedAt: 1, background: true, issues: [],
  services: [{ name: "next", cwd: "~/app", ports: [3000], project: { path: "~/app", workspace: null } }],
  ...over,
});
/** The app workspace's dev server on :3000 has stopped: the kind of thing that earns a chip. */
const stopped = (over: Partial<HealthVerdict> = {}): HealthVerdict => verdict({
  status: "warning", services: [],
  issues: [{ code: "port-gone", severity: "warning", scope: "process", message: "The dev server on :3000 stopped.", ports: [3000], cwd: "~/app" }],
  ...over,
});
const targets: Record<string, { directory: string; projectRootPath: string; name: string }> = {
  app: { directory: "/home/alice/app", projectRootPath: "/home/alice/app", name: "App" },
  quiet: { directory: "/home/alice/quiet", projectRootPath: "/home/alice/quiet", name: "Quiet" },
};

function harness(initial = stopped(), settings = { showComposerPill: true, snapshotIntervalSeconds: 30 }) {
  let current = initial;
  const added: Array<{ agent: string; face: PillFace }> = [];
  const updates: Array<{ agent: string; face: PillFace }> = [];
  const removed: string[] = [];
  const timers: Array<() => void> = [];
  const registry = createPillRegistry({
    addPill(agent, face) {
      added.push({ agent: agent.id, face });
      return { update: (next) => updates.push({ agent: agent.id, face: next }), remove: () => removed.push(agent.id) };
    },
    readSettings: async () => settings,
    readVerdict: async () => current,
    target: async (id) => targets[id] ?? null,
    schedule: (run) => { timers.push(run); return timers.length; },
    cancel: () => undefined,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { registry, added, updates, removed, timers, settle, setVerdict: (next: HealthVerdict) => { current = next; }, settings };
}

describe("composer pill registry", () => {
  it("adds a chip only for agents whose workspace needs attention, as a button face", async () => {
    const h = harness();
    h.registry.start();
    h.registry.replaceAll([{ id: "a1", workspaceId: "app" }, { id: "a2", workspaceId: "quiet" }, { id: "", workspaceId: "app" }]);
    await h.settle();
    expect(h.registry.shown()).toEqual({ a1: "Dev server :3000 stopped" });
    expect(h.added).toEqual([{ agent: "a1", face: { label: "Dev server :3000 stopped", icon: "TriangleAlert" } }]);
  });

  it("never shows a chip for healthy dev servers or host-wide trouble (0.11.0: that is the sidebar dot's job)", async () => {
    const hostWide = verdict({ status: "critical", issues: [
      { code: "memory-pressure", severity: "critical", scope: "host", message: "Memory is nearly full.", ports: [], cwd: null },
      { code: "service-down", severity: "critical", scope: "host", message: "OmniRoute is down.", ports: [], cwd: null, subject: "OmniRoute" },
      { code: "host-unreachable", severity: "critical", scope: "host", message: "x", ports: [], cwd: null },
    ] });
    for (const calm of [verdict(), hostWide]) {
      const h = harness(calm);
      h.registry.replaceAll([{ id: "a1", workspaceId: "app" }, { id: "a2", workspaceId: "quiet" }]);
      await h.settle();
      expect(h.registry.shown()).toEqual({});
    }
  });

  it("pushes a new label when the verdict changes, and removes chips that have nothing left to say", async () => {
    const h = harness();
    h.registry.upsert({ id: "a1", workspaceId: "app" });
    await h.settle();
    h.setVerdict(stopped({ status: "critical", issues: [
      { code: "tunnel-failed", severity: "critical", scope: "process", message: "The browser link for :3000 failed.", ports: [3000], cwd: "~/app" },
      ...stopped().issues,
    ] }));
    h.timers.shift()!();
    await h.settle();
    expect(h.updates).toEqual([{ agent: "a1", face: { label: "Browser link :3000 failed +1", icon: "CircleAlert" } }]);
    h.setVerdict(verdict());
    h.timers.shift()!();
    await h.settle();
    expect(h.removed).toEqual(["a1"]);
    expect(h.registry.shown()).toEqual({});
  });

  it("follows agents that move or end, honours the setting, and cleans up on stop", async () => {
    const h = harness();
    h.registry.upsert({ id: "a1", workspaceId: "app" });
    await h.settle();
    h.registry.upsert({ id: "a1", workspaceId: "quiet" });
    await h.settle();
    expect(h.removed).toEqual(["a1"]);
    h.registry.upsert({ id: "a2", workspaceId: "app" });
    await h.settle();
    h.registry.remove("a2");
    expect(h.removed).toEqual(["a1", "a2"]);
    h.registry.upsert({ id: "a3", workspaceId: "app" });
    await h.settle();
    h.settings.showComposerPill = false;
    h.timers.shift()!();
    await h.settle();
    expect(h.removed).toContain("a3");
    h.settings.showComposerPill = true;
    h.timers.shift()!();
    await h.settle();
    h.registry.stop();
    expect(h.registry.shown()).toEqual({});
  });

  it("retries an app that refuses a chip on the next read", async () => {
    let refuse = true;
    const added: string[] = [];
    const timers: Array<() => void> = [];
    const registry = createPillRegistry({
      addPill(agent) { if (refuse) throw new Error("unknown workspace"); added.push(agent.id); return { update() {}, remove() {} }; },
      readSettings: async () => ({ showComposerPill: true, snapshotIntervalSeconds: 30 }),
      readVerdict: async () => stopped(),
      target: async (id) => targets[id] ?? null,
      schedule: (run) => { timers.push(run); return 1; },
      cancel: () => undefined,
    });
    registry.upsert({ id: "a1", workspaceId: "app" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(added).toEqual([]);
    refuse = false;
    timers.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(added).toEqual(["a1"]);
  });

  it("faces: a warning icon carries the tone, so colour is never the only channel", () => {
    expect(pillFace(verdict({ services: [] }), targets.app!)).toBeNull();
    expect(pillFace(verdict(), targets.app!)).toBeNull();
    expect(pillFace(stopped(), targets.app!)).toEqual({ label: "Dev server :3000 stopped", icon: "TriangleAlert" });
    expect(pillFace(stopped(), targets.quiet!)).toBeNull();
    expect(pillFace(verdict({ status: "critical", issues: [{ code: "runaway", severity: "critical", scope: "process", message: "tsc is stuck at full CPU.", ports: [], cwd: "~/app", subject: "tsc" }] }), targets.app!)).toEqual({ label: "Runaway: tsc", icon: "CircleAlert" });
  });
});

describe("host features", () => {
  it("detects button chips, agent observations, native screens and the external opener", () => {
    expect(supportsButtonPills({ addHeaderButton() {} })).toBe(true);
    expect(supportsButtonPills({})).toBe(false);
    expect(canObserveAgents({ observeEvents() {} })).toBe(true);
    expect(canObserveAgents({ agents: {} })).toBe(false);
    expect(supportsNativeScreens({ addScreen() {}, addSidebarHeaderItem() {}, openScreen() {} }, () => null)).toBe(true);
    expect(supportsNativeScreens({ addScreen() {}, addSidebarHeaderItem() {}, openScreen() {} }, null)).toBe(false);
    expect(externalUrlOpener({ openExternalUrl: async () => {} })).toEqual(expect.any(Function));
    expect(externalUrlOpener({})).toBeNull();
  });

  it("no plugin file imports an SDK path Paseo 0.9.1 can't build, and client code never imports server/", () => {
    const OLD_HOST_SDK = new Set(["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native"]);
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && files.push(join(dir, entry.name))));
    for (const dir of ["client", "server", "shared"]) walk(join(root, dir));
    files.push(join(root, "index.client.tsx"), join(root, "index.server.ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [, specifier] of text.matchAll(/(?:from|import\()\s*"(@getpaseo\/plugin[^"]*)"/g)) {
        expect(OLD_HOST_SDK.has(specifier!), `${file.slice(root.length + 1)} imports ${specifier}`).toBe(true);
      }
      const clientSide = file.includes("/client/") || file.endsWith("index.client.tsx") || file.includes("/shared/");
      if (clientSide) expect(/from\s+"\.\.?\/(\.\.\/)?server\//.test(text), `${file.slice(root.length + 1)} imports server code`).toBe(false);
    }
  });
});
