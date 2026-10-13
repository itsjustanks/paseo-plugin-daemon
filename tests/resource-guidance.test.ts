import { expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { registerResourceGuidance, RESOURCE_GUIDANCE } from "../server/resource-guidance";

type Request = PluginBeforeRequests["agent.create"];
function fixture() {
  let transform!: (input: { request: Request }, context: PluginHookContext) => Request;
  const remove = vi.fn();
  const before = vi.fn((name, handler) => { expect(name).toBe("agent.create"); transform = handler; return remove; });
  const cleanup = registerResourceGuidance({ before } as unknown as PluginLifecycleRegistration);
  const controller = new AbortController();
  // A startup prompt must never probe the daemon or launch anything.
  const context = { signal: controller.signal, get paseo(): never { throw Error("Unexpected daemon access"); } } satisfies PluginHookContext;
  return { apply: (request: Request) => transform({ request }, context), cleanup, remove, controller };
}

it.each(["claude", "codex", "custom-provider"])("adds resource guidance without changing %s configuration or permissions", (provider) => {
  const { apply, cleanup, remove } = fixture();
  const request: Request = { config: { provider, cwd: "/workspace", systemPrompt: "Existing project instructions", model: "existing-model", mcpServers: {} }, env: { KEEP: "unchanged" } };
  const before = structuredClone(request);
  const result = apply(request);
  expect(result.config.systemPrompt).toBe(`Existing project instructions\n\n${RESOURCE_GUIDANCE}`);
  expect({ ...result.config, systemPrompt: before.config.systemPrompt }).toEqual(before.config);
  expect(result.env).toBe(request.env); expect(request).toEqual(before);
  expect(apply(result)).toBe(result);
  cleanup(); expect(remove).toHaveBeenCalledOnce();
});

it("handles an absent prompt without a marker alone suppressing the instructions", () => {
  const { apply } = fixture();
  expect(apply({ config: { provider: "codex", cwd: "/workspace" } }).config.systemPrompt).toBe(RESOURCE_GUIDANCE);
  const request = { config: { provider: "codex", cwd: "/workspace", systemPrompt: "Discuss <hosts-resource-guidance>" } };
  expect(apply(request).config.systemPrompt).toBe(`${request.config.systemPrompt}\n\n${RESOURCE_GUIDANCE}`);
});

it("leaves internal helpers and cancelled creation untouched", () => {
  const { apply, controller } = fixture();
  const internal = { config: { provider: "codex", cwd: "/workspace", internal: true } };
  expect(apply(internal)).toBe(internal);
  controller.abort();
  const cancelled = { config: { provider: "claude", cwd: "/workspace" } };
  expect(apply(cancelled)).toBe(cancelled);
});
