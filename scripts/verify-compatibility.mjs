#!/usr/bin/env node
// Exercise real upstream compilers, then evaluate both bundles with their host API boundaries.
// Pinned releases cover the manifest's minimum and the native-screen runtime.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    assert(snapshot.processes.every((process) => process.project?.id === "fixture"));
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

try {
  for (const [version, commit] of Object.entries(references)) {
    process.env.PASEO_HOME = join(directory, `${version}-state`);
    const { compilePlugin } = await compiler(version, commit);
    const bundles = await compilePlugin({
      client: join(project, "index.client.tsx"), server: join(project, "index.server.ts"),
    });
    await checkServer(bundles.serverBundle, version);
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
