#!/usr/bin/env node
// Compile the isolated feature with real pinned upstream compilers. Only fake adapters execute.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

const project = resolve(import.meta.dirname, "../..");
const require = createRequire(join(project, "package.json"));
const sdk = require("@getpaseo/plugin");
const versions = { "0.11.2": "75953250959979b8f088bbca8dbd6ee61d0151b1", "0.11.1": "ab10a6694ccf068959d1a6b67b6c915e21a9fe91" };
const scratch = await mkdtemp(join(tmpdir(), "hcd-compat-"));
const previousHome = process.env.PASEO_HOME;

async function compiler(version, commit) {
  const dir = join(scratch, version); await mkdir(dir);
  for (const name of ["compiler", "compiler-imports", "plugin-sdk-specifiers"]) {
    const response = await fetch(`https://raw.githubusercontent.com/getpaseo/paseo/${commit}/packages/server/src/server/plugins/${name}.ts`, { signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Pinned ${version} compiler unavailable: ${response.status}`);
    const compiled = await transform(await response.text(), { loader: "ts", format: "esm", target: "node20" });
    await writeFile(join(dir, name + ".js"), compiled.code);
  }
  return import(pathToFileURL(join(dir, "compiler.js")).href);
}

function evaluate(bundle, target) {
  const loaded = new Function(`return ${bundle}`)()((name) => {
    if (name === "@getpaseo/plugin") return sdk;
    if (name === "@getpaseo/plugin/server") return require(name);
    if (name.startsWith("@getpaseo/plugin/client")) { assert.equal(target, "client"); return {}; }
    if (target === "client") assert(["react", "react/jsx-runtime", "react-native", "zod", "@tanstack/react-query"].includes(name));
    return require(name === "react-native" ? "react-native-web" : name);
  });
  assert.equal(typeof loaded.default, "function", `Unexpected ${target} contribution export`);
  return loaded.default;
}

try {
  await symlink(join(project, "node_modules"), join(scratch, "node_modules"));
  const root = join(scratch, "plugin"); await mkdir(root);
  for (const area of ["server", "client", "shared"]) await cp(join(project, area), join(root, area), { recursive: true });
  await symlink(join(project, "node_modules"), join(root, "node_modules"));
  await writeFile(join(root, "index.server.ts"), `import { registerCrossDaemon } from "./server/cross-daemon/cross-daemon.server";
export default function contribute(server) { return registerCrossDaemon(server, {
  stateDir: () => Promise.resolve(process.env.PASEO_HOME + "/cross"),
  ownDaemon: async () => ({ name: "Fixture", serverId: "fixture" }),
  readOwnPeer: async () => { throw new Error("No pairing permitted in compatibility tests"); },
  cli: { run: async () => { throw new Error("No production sends permitted"); }, runLocal: async () => { throw new Error("No local sends permitted"); } },
}); }`);
  await writeFile(join(root, "index.client.tsx"), `import { contributeCrossDaemonClient } from "./client/cross-daemon/register";
export { CrossDaemonSection } from "./client/cross-daemon/section";
export default function contribute(client) { return contributeCrossDaemonClient(client); }`);
  for (const [version, commit] of Object.entries(versions)) {
    process.env.PASEO_HOME = join(scratch, version + "-home");
    const { compilePlugin } = await compiler(version, commit);
    const bundles = await compilePlugin({ client: join(root, "index.client.tsx"), server: join(root, "index.server.ts") });
    assert(bundles.clientBundle && bundles.serverBundle);
    for (const [supported, enabled] of ["0.11.1", "0.11.2"].includes(version) ? [[false, false], [true, false], [true, true]] : [[false, false]]) {
      const handlers = new Map(); const hooks = new Map();
      const state = { status: "ready", revision: "fixture", values: { enabled, fullAuthorityConfirmed: enabled } };
      const server = { handle(contract, handler) { handlers.set(contract.name, { contract, handler }); }, registerSettings() { return supported ? { read: async () => state, subscribe: () => () => {} } : undefined; } };
      if (supported) server.before = (name, handler) => { hooks.set(name, handler); return () => {}; };
      const stop = evaluate(bundles.serverBundle, "server")(server);
      try {
        assert.equal(handlers.size, 4);
        const { contract, handler } = handlers.get("hosts-cross-daemon.describe");
        const status = contract.output.parse(await handler({}));
        assert.equal(status.available, supported);
        assert.equal(status.switchedOn, supported && enabled);
        assert(!JSON.stringify(status).includes("offer"));
        if (supported) {
          const toolNames = ["list_daemons", "list_workspaces", "list_agents", "get_agent_activity", "send_agent_prompt"];
          const providers = { "fixture-claude": { extends: "claude", command: ["fixture-command"] }, "fixture-codex": { extends: "codex" }, chained: { extends: "fixture-claude" } };
          const context = { signal: new AbortController().signal, paseo: { config: { get: async () => ({ config: { providers } }) } } };
          for (const [provider, rootProvider] of [["claude", "claude"], ["codex", "codex"], ["opencode", "opencode"], ["fixture-claude", "claude"], ["fixture-codex", "codex"], ["chained", "claude"], ["unknown", null]]) {
            const request = { config: { provider, cwd: "/fixture" } };
            const result = await hooks.get("agent.create")({ request }, context);
            if (!enabled || !rootProvider) assert.deepEqual(result, request);
            else {
              assert.equal(result.config.provider, provider);
              const mcp = result.config.mcpServers["hosts-cross-daemon"];
              assert.equal(mcp.type, "stdio"); assert.equal(mcp.command, process.execPath);
              assert.deepEqual(mcp.args, [join(process.env.PASEO_HOME, "cross", "tool-proxy.cjs")]);
              assert.deepEqual(mcp.env, { ELECTRON_RUN_AS_NODE: "1" });
              assert.deepEqual(result.config.toolPolicy?.preapproved, rootProvider === "opencode" ? undefined : toolNames.map((tool) => ({ kind: "mcp", server: "hosts-cross-daemon", tool })));
            }
          }
        } else assert.equal(hooks.size, 0);
      } finally { await stop(); await stop(); }
    }
    const client = evaluate(bundles.clientBundle, "client");
    const stop = client({ rpc: async () => { throw new Error("No host calls in registration smoke test"); } }); stop();
    console.log(`${version}: feature client/server compiled; missing APIs unavailable${["0.11.1", "0.11.2"].includes(version) ? "; enabled MCP injection and five exact approvals checked with fake adapters" : ""}`);
  }
} finally {
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  await rm(scratch, { recursive: true, force: true });
}
