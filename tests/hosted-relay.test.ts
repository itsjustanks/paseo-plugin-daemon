import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { PeerManager } from "../server/peers";

// Explicit opt-in. This exposes only a disposable synthetic fixture, never a project or daemon.
it.runIf(!!process.env.DAEMON_LINK_TEST_RELAY)("forwards a synthetic app through a deployed Paseo relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-relay-test-"));
  const app = createServer((_req, res) => res.end("daemon-link-synthetic-check"));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const host = new PeerManager(join(directory, "host"), async (target) => { if (target !== port) throw new Error(); return async () => true; }, async () => [{ port, label: "Synthetic fixture", project: null }]);
  const client = new PeerManager(join(directory, "client"));
  try {
    const { invitation } = await host.offer({ label: "Synthetic host", relay: process.env.DAEMON_LINK_TEST_RELAY });
    await client.pair(invitation);
    const peerId = (await client.status()).peers[0]!.id;
    const forward = await client.forward(peerId, port);
    const nodeFetch = fetch as unknown as typeof import("undici-types").fetch;
    const response = await nodeFetch(forward.url, { signal: AbortSignal.timeout(20_000) });
    expect(await response.text()).toBe("daemon-link-synthetic-check");
  } finally {
    await client.close(); await host.close();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
