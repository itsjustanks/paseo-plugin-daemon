import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";

/** Static instructions only: no probes, process actions, permissions or startup I/O. */
export const RESOURCE_GUIDANCE = `<hosts-resource-guidance>
This computer may run other Paseo chats and workspaces. Keep the daemon responsive.
- Before starting a dev server, browser, build, test suite or install, check for an existing suitable instance and current CPU/memory pressure using available Hosts information or a bounded read-only check. Verify its workspace and purpose before reuse. Do not inspect credentials or dump process environments.
- Reuse the correct dev server instead of starting another watcher for each task. Prefer the relevant app/package over starting every service in a monorepo. Start an additional server only when the task needs isolation or a different configuration; report why.
- Run heavy builds, tests, type checks and installs sequentially by default. Use documented worker/concurrency limits when needed; do not automatically consume all cores, raise heap limits, or run repeated full builds while a watcher is already compiling. A warning threshold is not a reserved quota.
- When Hosts browser tools are available, prefer the workspace's shared browser and respect human control. Reuse its tabs rather than launching more Chrome instances. Do not close a browser or server another chat or the user is using.
- List repository files with git ls-files or rg --files. Prune node_modules, .git, build outputs and caches before traversal; never recursively follow workspace dependency symlinks or collect an unbounded glob into memory.
- If pressure is high or uncertain, avoid adding parallel heavy work. Reduce your own task's concurrency, wait for your current job, or explain the constraint and ask how to proceed. Do not stop other jobs to make room without explicit permission; sleeping, old, archived or unlabelled does not mean safe to stop.
- Track the PID, workspace and purpose of temporary jobs you start; use bounded one-off commands and a known stop mechanism. When finished, clean up only your own no-longer-needed temporary jobs after verifying their identity. Preserve requested persistent dev servers. Never use a broad kill-by-name command.
These are operating instructions, not an enforced resource cap or permission to change host settings.
</hosts-resource-guidance>`;

export function registerResourceGuidance(server: PluginLifecycleRegistration): () => void {
  return server.before("agent.create", ({ request }, context) => {
    if (request.config.internal || context.signal.aborted) return request;
    const original = request.config.systemPrompt ?? "";
    if (original.includes(RESOURCE_GUIDANCE)) return request;
    return { ...request, config: { ...request.config,
      systemPrompt: original ? `${original}\n\n${RESOURCE_GUIDANCE}` : RESOURCE_GUIDANCE,
    } };
  });
}
