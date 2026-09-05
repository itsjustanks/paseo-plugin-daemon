#!/usr/bin/env node
// Exercise real upstream compilers, then evaluate both bundles with their host API boundaries.
// The 0.8 source is pinned because that runtime has not shipped on npm yet.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const project = resolve(import.meta.dirname, "..");
const require = createRequire(join(project, "package.json"));
const sdk = require("@getpaseo/plugin/server");
const references = {
  "0.7.2": "9400a49af670fdb5db4af58e73f8df98588dbea9",
  "0.8-preview": "f4b209be4d81d25a6143d12d374d797d485e8faa",
};
await mkdir(join(project, "node_modules", ".cache"), { recursive: true });
const directory = await mkdtemp(join(project, "node_modules", ".cache", "daemon-link-compat-"));
const previousHome = process.env.PASEO_HOME;
const serverContracts = [];

async function compiler(version, commit) {
  if (version === "0.7.2" && process.env.PASEO_VERIFY_INSTALLED_COMPILER) {
    return import(pathToFileURL(resolve(process.env.PASEO_VERIFY_INSTALLED_COMPILER)).href);
  }
  const destination = join(directory, version);
  await mkdir(destination);
  for (const name of ["compiler", "plugin-sdk-specifiers"]) {
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
    if (name === "@getpaseo/plugin" || name === "@getpaseo/plugin/server") return sdk;
    if (name === "@getpaseo/plugin/react-native") {
      assert.equal(target, "client", "Server must not load UI helpers");
      return {};
    }
    if (target === "client") assert(clientModules.has(name), `Unexpected client dependency: ${name}`);
    return require(name === "react-native" ? "react-native-web" : name);
  };
  return new Function(`return ${bundle}`)()(load).default;
}

async function checkServer(bundle, version) {
  const handlers = new Map();
  const contribute = evaluate(bundle, "server");
  const cleanup = contribute({ handle(contract, handler) {
    assert(!handlers.has(contract.name), `Duplicate RPC: ${contract.name}`);
    handlers.set(contract.name, { contract, handler });
  } });
  assert.equal(typeof cleanup, "function");
  try {
    assert.equal(handlers.size, 20);
    for (const name of ["daemon-link.status", "daemon-link.peers.status"]) {
      const { contract, handler } = handlers.get(name);
      const result = await handler(contract.input.parse({}), {});
      contract.output.parse(result);
    }
    const { contract, handler } = handlers.get("daemon-link.peers.pair");
    await assert.rejects(() => handler(contract.input.parse({ invitation: "invalid" }), {}), /valid Daemon Link pairing code/);
    serverContracts.push([...handlers.keys()].sort());
    console.log(`${version}: 20 server RPCs registered; status, validation, and cleanup verified`);
  } finally { await cleanup(); await cleanup(); }
}

async function checkClient(bundle, version, supportsShortcuts) {
  const registrations = new Map();
  const context = {};
  for (const method of ["addSurface", "addSidebarItem", "addWorkspacePanel", "addCommandCenterItem"]) {
    context[method] = (...args) => { registrations.set(method, args); return () => {}; };
  }
  if (supportsShortcuts) context.addSlashCommand = (...args) => {
    registrations.set("addSlashCommand", args); return () => {};
  };
  const cleanup = evaluate(bundle, "client")(context);
  assert.equal(typeof cleanup, "function");
  try {
    assert.equal(registrations.get("addSurface")[0], "daemon-link");
    assert.equal(registrations.get("addSidebarItem")[0].surface, "daemon-link");
    assert.equal(registrations.get("addWorkspacePanel")[0].id, "daemon-link");
    assert.equal(registrations.has("addSlashCommand"), supportsShortcuts);
    if (version === "0.8-preview") {
      const Surface = registrations.get("addSurface")[1];
      assert.equal(Surface({}).props.shortcuts, supportsShortcuts);
    }
    if (supportsShortcuts) {
      let opened;
      const command = registrations.get("addSlashCommand")[0];
      assert.equal(command.name, "daemon-link");
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
    const bundles = await compilePlugin(version === "0.7.2" ? join(project, "index.ts") : {
      client: join(project, "index.client.tsx"), server: join(project, "index.server.ts"),
    });
    await checkServer(bundles.serverBundle, version);
    await checkClient(bundles.clientBundle, version, version === "0.8-preview");
    if (version === "0.8-preview") await checkClient(bundles.clientBundle, version, false);
  }
  assert.deepEqual(...serverContracts);
  console.log("Both entry formats expose the same core features. No live daemon was modified.");
} finally {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
}
