import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentBrowserRuntime } from "../../server/managed-browser/agent-browser-runtime";
import { RUNTIME_OWNER_VARIABLE } from "../../server/managed-browser/process-identity";
import { resolveBrowserRuntimeRoot } from "../../server/managed-browser/runtime-path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Live processes whose environment carries this runtime's private ownership nonce. */
function ownedProcesses(nonce: string): number[] {
  const owned: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (
        readFileSync(`/proc/${entry}/environ`, "utf8")
          .split("\0")
          .includes(`${RUNTIME_OWNER_VARIABLE}=${nonce}`)
      )
        owned.push(Number(entry));
    } catch {
      /* exited, or not ours to read */
    }
  }
  return owned;
}

/** A loopback port nothing listens on: navigation fails after the daemon has started. */
async function refusedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener has no port");
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${address.port}/`;
}

it.skipIf(process.platform !== "linux")(
  "stops the nonce-owned daemon when opening the initial page fails",
  async () => {
    const runtimeRoot = resolveBrowserRuntimeRoot(
      process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
    );
    const binaryPath =
      process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY ??
      join(runtimeRoot, "node_modules", ".bin", "agent-browser");
    const executablePath =
      process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE ??
      join(runtimeRoot, "chromium", "chrome");
    const root = await mkdtemp(join(tmpdir(), "sbf-"));
    roots.push(root);
    const runtime = new AgentBrowserRuntime({
      binaryPath,
      executablePath,
      profilePath: join(root, "profile"),
      ipcDirectory: join(root, "ipc"),
      session: "failed-open",
      initialUrl: await refusedOrigin(),
    });
    const nonce = (runtime as unknown as { ownerNonce: string }).ownerNonce;
    await expect(runtime.launch()).rejects.toThrow();
    // Failed creation cleanup must observe, stop and confirm the owned daemon.
    await runtime.shutdown();
    expect(ownedProcesses(nonce)).toEqual([]);
  },
  60_000,
);
