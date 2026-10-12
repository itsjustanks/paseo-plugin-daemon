// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { describe, expect, it } from "vitest";
import { resolveToolProvider, withCrossDaemonTools } from "../../server/cross-daemon/agent-injection.server";

const launch = { command: "/usr/local/bin/node", proxyPath: "/home/p/.paseo/plugin-data/cross-daemon/tool-proxy.cjs" };

describe("withCrossDaemonTools", () => {
  it("gives a Claude agent the cross-daemon tool server", () => {
    const config = withCrossDaemonTools({ provider: "claude", cwd: "/repo" }, launch, ["list_daemons"]);
    expect(config.mcpServers?.["hosts-cross-daemon"]).toEqual({
      type: "stdio",
      command: "/usr/local/bin/node",
      args: [launch.proxyPath],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("pre-approves the tools for Claude and Codex, so an unattended agent is not stopped by a permission prompt", () => {
    for (const provider of ["claude", "codex"]) {
      const config = withCrossDaemonTools({ provider, cwd: "/repo" }, launch, ["list_daemons", "list_agents"]);
      expect(config.toolPolicy?.preapproved).toEqual([
        { kind: "mcp", server: "hosts-cross-daemon", tool: "list_daemons" },
        { kind: "mcp", server: "hosts-cross-daemon", tool: "list_agents" },
      ]);
    }
  });

  it("gives OpenCode the tools without a tool policy, which would switch off its auto-accept", () => {
    const config = withCrossDaemonTools({ provider: "opencode", cwd: "/repo" }, launch, ["list_daemons"]);
    expect(config.mcpServers?.["hosts-cross-daemon"]).toBeDefined();
    expect(config.toolPolicy).toBeUndefined();
  });

  it("leaves other providers unchanged, since Paseo refuses to create them with these tools", () => {
    for (const provider of ["copilot", "pi", "cursor"]) {
      const original = { provider, cwd: "/repo" };
      expect(withCrossDaemonTools(original, launch, ["list_daemons"])).toBe(original);
    }
  });

  it("keeps the agent's other tool servers and approvals, without granting a tool twice", () => {
    const github = { type: "stdio" as const, command: "gh-mcp" };
    const grant = { kind: "mcp" as const, server: "github", tool: "search" };
    const ours = { kind: "mcp" as const, server: "hosts-cross-daemon", tool: "list_daemons" };
    const config = withCrossDaemonTools(
      { provider: "claude", cwd: "/repo", mcpServers: { github }, toolPolicy: { preapproved: [grant, ours] } },
      launch,
      ["list_daemons"],
    );
    expect(config.mcpServers?.github).toBe(github);
    expect(config.toolPolicy?.preapproved).toEqual([grant, ours]);
  });
});

describe("configured provider inheritance", () => {
  it.each(["claude", "codex", "opencode"])("resolves aliases and chains to %s with exact root approval rules", (root) => {
    const providers = { custom: { extends: "intermediate", command: ["custom-command"], env: { PRIVATE: "secret" } }, intermediate: { extends: root } };
    const original = { provider: "custom", cwd: "/repo", model: "original-model" };
    expect(resolveToolProvider("custom", providers)).toBe(root);
    const result = withCrossDaemonTools(original, launch, ["list_daemons", "list_agents"], resolveToolProvider("custom", providers));
    expect(result.provider).toBe("custom"); expect(result.model).toBe(original.model);
    expect(result.mcpServers?.["hosts-cross-daemon"]).toBeDefined();
    expect(result.toolPolicy?.preapproved).toEqual(root === "opencode" ? undefined : [
      { kind: "mcp", server: "hosts-cross-daemon", tool: "list_daemons" },
      { kind: "mcp", server: "hosts-cross-daemon", tool: "list_agents" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(providers.custom.command).toEqual(["custom-command"]);
  });
  it.each([
    { a: { extends: "a" } }, { a: { extends: "b" }, b: { extends: "a" } },
    { a: { extends: "missing" } }, { a: { extends: "pi" } }, { a: { extends: "acp" } },
    { a: {} }, { a: { extends: 1 } }, { a: null },
  ])("leaves unresolved and cyclic providers unchanged: %j", (providers) => {
    const original = { provider: "a", cwd: "/repo" };
    const root = resolveToolProvider("a", providers);
    expect(root).toBeNull();
    expect(withCrossDaemonTools(original, launch, ["list_daemons"], root)).toBe(original);
  });
  it("bounds chain depth and ignores inherited properties", () => {
    const providers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["p" + i, { extends: i === 19 ? "claude" : "p" + (i + 1) }]));
    expect(resolveToolProvider("p0", providers)).toBeNull();
    expect(resolveToolProvider("inherited", Object.create({ inherited: { extends: "claude" } }))).toBeNull();
  });
});
