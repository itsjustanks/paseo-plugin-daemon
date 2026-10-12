import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";

type Owner = Awaited<ReturnType<typeof createRuntimeOwner>>;
type Runtime = Awaited<ReturnType<Owner["create"]>>;

/** Run a native smoke with explicit binaries, a private display, and a disposable home/profile. */
export async function withIsolatedBrowser(
  run: (owner: Owner, runtime: Runtime) => Promise<void>,
): Promise<void> {
  if (
    !process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE
  ) {
    throw new Error("Browser smoke requires explicit agent-browser and Chromium binary paths");
  }
  const home = await mkdtemp(join(tmpdir(), "hosts-browser-smoke-"));
  vi.stubEnv("PASEO_HOME", home);
  let owner: Owner | null = null;
  let runtime: Runtime | null = null;
  try {
    owner = await createRuntimeOwner({ initialUrl: "about:blank" });
    runtime = await owner.create("isolated-browser-smoke");
    await run(owner, runtime);
  } finally {
    try {
      if (owner && runtime) await owner.stop(runtime);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
