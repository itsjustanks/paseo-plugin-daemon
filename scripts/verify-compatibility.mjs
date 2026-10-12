#!/usr/bin/env node
// Exercise real upstream compilers, then evaluate both bundles with their host API boundaries.
// Pinned releases cover the manifest's minimum and the native-screen runtime.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const project = resolve(import.meta.dirname, "..");
const require = createRequire(join(project, "package.json"));
const sdk = require("@getpaseo/plugin");
const serverSdk = require("@getpaseo/plugin/server");
const references = {
  "0.9.0": "7f7e60bcbbfe57bf5250b10d01c5f97847b43db0",
  "0.11.1": "ab10a6694ccf068959d1a6b67b6c915e21a9fe91",
};
await mkdir(join(project, "node_modules", ".cache"), { recursive: true });
const directory = await mkdtemp(join(project, "node_modules", ".cache", "daemon-link-compat-"));
const previousHome = process.env.PASEO_HOME;
const serverContracts = [];

async function compiler(version, commit) {
  const destination = join(directory, version);
  await mkdir(destination);
  for (const name of ["compiler", "compiler-imports", "plugin-sdk-specifiers"]) {
    const url = `https://raw.githubusercontent.com/getpaseo/paseo/${commit}/packages/server/src/server/plugins/${name}.ts`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Cannot fetch pinned ${version} ${name}: HTTP ${response.status}`);
    const result = await transform(await response.text(), { loader: "ts", format: "esm", target: "node20" });
    await writeFile(join(destination, `${name}.js`), result.code);
  }
  return import(pathToFileURL(join(destination, "compiler.js")).href);
}

function evaluate(bundle, target) {
  const clientModules = new Set(["react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod"]);
  const load = (name) => {
    if (name === "@getpaseo/plugin") return sdk;
    if (name === "@getpaseo/plugin/server") { assert.equal(target, "server"); return serverSdk; }
    if (["@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native"].includes(name)) {
      assert.equal(target, "client", "Server must not load UI helpers");
      // Registration smoke test, not a claim that a mocked component renders.
      return name.endsWith("/ui") ? { SidebarRow: () => null } : {};
    }
    if (target === "client") assert(clientModules.has(name), `Unexpected client dependency: ${name}`);
    return require(name === "react-native" ? "react-native-web" : name);
  };
  return new Function(`return ${bundle}`)()(load).default;
}

async function checkServer(bundle, version) {
  const handlers = new Map();
  const projectPath = join(process.env.PASEO_HOME, "project");
  await mkdir(projectPath, { recursive: true });
  await mkdir(join(process.env.PASEO_HOME, "plugin-settings", "daemon-link"), { recursive: true });
  // Never run automation against the test runner's machine.
  await writeFile(join(process.env.PASEO_HOME, "plugin-settings", "daemon-link", "hosts.json"), JSON.stringify({ version: 1, values: {
    backgroundHealthChecks: false, autoStopRunaways: false, closeTunnelsOnArchive: false,
    housekeeping: { enabled: false, dryRun: true },
  } }));
  const context = { paseo: {
    projects: { list: async () => ({ projects: [{ projectId: "fixture", projectDisplayName: "Fixture", projectRootPath: projectPath }] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
  } };
  const contribute = evaluate(bundle, "server");
  const cleanup = contribute({ registerSettings() {}, on() { return () => {}; }, handle(contract, handler) {
    assert(!handlers.has(contract.name), `Duplicate RPC: ${contract.name}`);
    handlers.set(contract.name, { contract, handler });
  } });
  assert.equal(typeof cleanup, "function");
  try {
    assert(handlers.size >= 25, "The supported runtime must register the existing core RPCs");
    for (const name of ["daemon-link.status", "daemon-link.peers.status", "daemon-link.sync.status"]) {
      const { contract, handler } = handlers.get(name);
      const result = await handler(contract.input.parse({}), context);
      contract.output.parse(result);
    }
    const monitor = handlers.get("monitor.snapshot");
    const snapshot = monitor.contract.output.parse(await monitor.handler({}, context));
    assert.equal(snapshot.scope.status, "ready");
    assert.equal(snapshot.scope.projects.length, 1);
    const selfSnapshot = monitor.contract.output.parse(await monitor.handler({ query: String(process.pid) }, context));
    const self = selfSnapshot.processes.find((row) => row.pid === process.pid);
    assert(self, "Same-user inventory includes the verifier outside the registered fixture project");
    assert.equal(self.project, null);
    assert.equal(self.actionable, false, "The plugin process remains protected");
    assert.equal(self.actionToken, null);
    assert(self.protectedReason);
    for (const row of snapshot.services) {
      if (row.project?.shareable) assert(row.ports.every((port) => row.project.shareablePorts.includes(port)));
      if (!row.actionable) assert.equal(row.actionToken, null);
    }
    const { contract, handler } = handlers.get("daemon-link.peers.pair");
    await assert.rejects(() => handler(contract.input.parse({ invitation: "invalid" }), context), /valid Hosts pairing code/);
    serverContracts.push([...handlers.keys()].sort());
    console.log(`${version}: ${handlers.size} server RPCs registered; status, validation, and cleanup verified`);
  } finally { await cleanup(); await cleanup(); }
}

async function checkClient(bundle, version, supportsShortcuts) {
  const registrations = new Map();
  const context = {
    rpc: async () => ({ status: "ready", values: { showComposerPill: false } }),
    paseo: {
      observeEvents() {},
      agents: { list: async () => ({ entries: [], subscription: {
        subscribe: () => () => {}, release: async () => {},
      } }) },
    },
  };
  for (const method of ["addSurface", "addSidebarItem", "addWorkspacePanel", "addSettingsScreen", "addCommandCenterItem"]) {
    context[method] = (...args) => { registrations.set(method, args); return () => {}; };
  }
  if (version === "0.11.1") for (const method of ["addScreen", "addSidebarHeaderItem"]) {
    context[method] = (...args) => { registrations.set(method, args); return () => {}; };
  }
  if (version === "0.11.1") context.openScreen = () => {};
  if (supportsShortcuts) context.addSlashCommand = (...args) => {
    registrations.set(`slash:${args[0].name}`, args[0]); return () => {};
  };
  const cleanup = evaluate(bundle, "client")(context);
  assert.equal(typeof cleanup, "function");
  try {
    if (version === "0.11.1") {
      assert.equal(registrations.get("addScreen")[0].id, "daemon-link");
      assert.equal(registrations.get("addSidebarHeaderItem")[0].title, "Hosts");
      assert(!registrations.has("addSurface"), "Do not register both navigation formats");
    } else {
      assert.equal(registrations.get("addSurface")[0], "daemon-link");
      assert.equal(registrations.get("addSidebarItem")[0].surface, "daemon-link");
      assert.equal(registrations.get("addSidebarItem")[0].title, "Hosts");
    }
    assert.equal(registrations.get("addWorkspacePanel")[0].id, "daemon-link");
    assert.equal(registrations.get("addSettingsScreen")[0].id, "hosts");
    assert.equal(registrations.has("slash:hosts"), supportsShortcuts);
    const Surface = version === "0.11.1" ? registrations.get("addScreen")[0].Component : registrations.get("addSurface")[1];
    assert.equal(Surface({}).props.shortcuts, supportsShortcuts);
    if (supportsShortcuts) {
      let opened;
      const command = registrations.get("slash:hosts");
      assert.equal(command.name, "hosts");
      command.onSubmit({ openPanel(id) { opened = id; } });
      assert.equal(opened, "daemon-link");
    }
  } finally { await cleanup(); await cleanup(); }
  console.log(`${version}: client registrations verified; composer shortcut ${supportsShortcuts ? "enabled" : "hidden"}`);
}

// Compile the exact policy modules with each upstream compiler. The adapter and
// signal function are deterministic fixtures: this check never signals OS PIDs.
async function checkMonitorPolicy(compilePlugin, version) {
  const fixture = join(directory, `${version}-monitor-policy`);
  await mkdir(fixture);
  await cp(join(project, "server"), join(fixture, "server"), { recursive: true });
  await cp(join(project, "shared"), join(fixture, "shared"), { recursive: true });
  const adapter = (await readFile(join(project, "tests", "fake-adapter.ts"), "utf8"))
    .replaceAll('../server/platform', './platform').replaceAll('../server/redaction', './redaction');
  await writeFile(join(fixture, "server", "compatibility-adapter.ts"), adapter);
  await writeFile(join(fixture, "index.server.ts"), POLICY_FIXTURE);
  const bundle = await compilePlugin({ server: join(fixture, "index.server.ts") });
  await evaluate(bundle.serverBundle, "server")();
  console.log(`${version}: outside inventory, shared manual preview/stop/force, protected/stale identities, automation and verified share ports checked with fake adapters`);
}

const POLICY_FIXTURE = String.raw`
import assert from "node:assert/strict";
import { createMonitorHandlers } from "./server/handlers";
import { ProjectScope } from "./server/scope";
import { hashArgv } from "./server/redaction";
import { FakeAdapter, FakeClock, proc } from "./server/compatibility-adapter";

export default async function check() {
  const scope = new ProjectScope(async (path) => path, "/home/fixture");
  scope.bind({
    projects: { list: async () => ({ projects: [{ projectId: "fixture", projectDisplayName: "Fixture", projectRootPath: "/home/fixture/project" }] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as never);
  const adapter = new FakeAdapter();
  adapter.processes = [
    proc({ pid: 101, cwd: "/outside/project", argv: ["node", "/outside/node_modules/vite/bin/vite.js"] }),
    proc({ pid: 102, cwd: "/home/fixture/project", argv: ["python3", "-m", "http.server"] }),
    proc({ pid: 103, cwd: "/outside/project", argv: ["postgres"] }),
    proc({ pid: 104, uid: 1001, cwd: "/outside/project" }),
  ];
  for (const pid of [101, 102, 103]) adapter.ports.set(pid, [8765, 9229]);
  const signals: Array<[number, string]> = [];
  const monitor = createMonitorHandlers({ adapter, scope, uid: 1000, selfPid: 900, parentPid: 901, clock: new FakeClock(), kill: (pid, signal) => { signals.push([pid, signal]); } });
  const snapshot = await monitor.snapshot({});
  const outside = snapshot.services.find((row) => row.pid === 101)!;
  const inside = snapshot.services.find((row) => row.pid === 102)!;
  const protectedRow = snapshot.services.find((row) => row.pid === 103)!;
  assert(outside, "Outside-project dev server remains in inventory");
  assert.equal(outside.project, null);
  assert.equal(outside.actionable, true);
  assert(outside.actionToken);
  assert(!snapshot.processes.some((row) => row.pid === 104), "Other-user process remains excluded");
  assert.equal(inside.project?.id, "fixture");
  assert.equal(inside.project?.shareable, true);
  assert.deepEqual(inside.project?.shareablePorts, [8765]);
  assert.deepEqual(inside.ports, [8765], "Debugger port cannot enter Open/share controls");
  assert.equal(scope.match(adapter.processes[0], [8765]), null, "Inventory cannot grant outside-project sharing");
  assert.equal(protectedRow.actionable, false);
  assert.equal(protectedRow.actionToken, null);
  assert(protectedRow.protectedReason);
  const manager = monitor.internals!.manager;
  const plan = await manager.preview([outside.actionToken]);
  assert.equal(plan.targets[0].ok, true, "Monitor token is accepted by the shared manager preview");
  assert.equal(plan.targets[0].outsidePaseo, true);
  assert.equal((await monitor.forceStop({ token: outside.actionToken })).status, "needs-graceful-first");
  assert.deepEqual(signals, []);
  assert.equal((await monitor.stop({ token: outside.actionToken })).status, "signaled");
  assert.equal((await monitor.forceStop({ token: outside.actionToken })).status, "signaled");
  assert.deepEqual(signals, [[101, "SIGTERM"], [101, "SIGKILL"]]);
  adapter.processes[0].startId = "reused-pid";
  assert.equal((await manager.preview([outside.actionToken])).targets[0].ok, false);
  assert.equal((await monitor.stop({ token: outside.actionToken })).status, "denied");
  assert.equal((await monitor.forceStop({ token: outside.actionToken })).status, "denied");
  const protectedToken = manager.guard.mint(adapter.processes[2], hashArgv(adapter.processes[2].argv));
  assert.equal((await manager.preview([protectedToken])).targets[0].ok, false);
  assert.equal((await monitor.stop({ token: protectedToken })).status, "denied");
  assert.equal((await monitor.forceStop({ token: protectedToken })).status, "needs-graceful-first");
  adapter.processes[1].rssBytes = adapter.sample.memoryTotalBytes;
  monitor.internals!.collector.invalidate();
  assert.equal(await manager.autoStopBiggest(1, async () => true), null, "Workspace attribution cannot grant automation authority");
  assert.equal(signals.length, 2, "Only stubbed manual fixture signals occurred");
  manager.close();
}
`;

try {
  for (const [version, commit] of Object.entries(references)) {
    process.env.PASEO_HOME = join(directory, `${version}-state`);
    const { compilePlugin } = await compiler(version, commit);
    const bundles = await compilePlugin({
      client: join(project, "index.client.tsx"), server: join(project, "index.server.ts"),
    });
    await checkServer(bundles.serverBundle, version);
    await checkMonitorPolicy(compilePlugin, version);
    await checkClient(bundles.clientBundle, version, true);
    await checkClient(bundles.clientBundle, version, false);
  }
  assert.deepEqual(...serverContracts);
  console.log("Paseo 0.9.0 and 0.11.1 compile both entries and register the same RPCs. No live daemon was modified.");
} finally {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
}
