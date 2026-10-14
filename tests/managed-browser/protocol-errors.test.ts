import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "../../server/managed-browser/runtime-protocol";
import { resolveSupervisorPaths, startSupervisorServer } from "../../server/managed-browser/supervisor";

it("correlates parser refusals without echoing malformed or unbounded IDs", async () => {
  const home = await mkdtemp(join(tmpdir(), "hosts-protocol-"));
  const paths = resolveSupervisorPaths(home);
  let nativeCalls = 0;
  const server = await startSupervisorServer({
    async create() { nativeCalls += 1; return { runtimeId: "unused" }; },
    async request() { nativeCalls += 1; return null; },
    async stop() {},
  }, paths);
  const socket = connect(paths.socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  async function send(value: unknown) {
    const response = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Parser refusal did not arrive")), 1_000);
      socket.once("data", (data) => { clearTimeout(timer); resolve(JSON.parse(String(data).trim())); });
    });
    socket.write(`${JSON.stringify(value)}\n`);
    return response;
  }
  try {
    const base = { version: RUNTIME_PROTOCOL_VERSION, method: "agent.request", ticket: "ungranted", input: {} };
    expect(await send({ ...base, id: "unknown-operation", operation: "tabs.force" })).toMatchObject({ id: "unknown-operation", ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await send({ ...base, id: "malformed-input", operation: "status", input: undefined })).toMatchObject({ id: "malformed-input", ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await send({ ...base, id: "wrong-version", version: -1, operation: "status" })).toMatchObject({ id: "wrong-version", ok: false, error: { code: "PROTOCOL_MISMATCH" } });
    for (const id of ["x".repeat(129), "line\nbreak", { secret: "never-echo" }]) {
      const response = await send({ ...base, id, operation: "status" });
      expect(response).toMatchObject({ id: "unknown", ok: false, error: { code: "INVALID_REQUEST" } });
      expect(JSON.stringify(response)).not.toContain("never-echo");
    }
    server.supervisor.claimBridge("owned-test-bridge");
    expect(await send({ ...base, id: "ungranted-tab", operation: "tabs.list" })).toMatchObject({ id: "ungranted-tab", ok: false, error: { code: "AUTHENTICATION_FAILED" } });
    expect(nativeCalls).toBe(0);
  } finally {
    socket.destroy(); await server.close(); await rm(home, { recursive: true, force: true });
  }
});
