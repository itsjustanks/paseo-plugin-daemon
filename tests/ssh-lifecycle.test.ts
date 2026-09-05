import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { SshLink } from "../server/ssh";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((_name: string, args: string[], options: object) => {
    const mapping = args[args.indexOf("-L") + 1]!;
    const port = Number(mapping.split(":")[1]);
    const failure = args.at(-1) === "denied.example";
    return actual.spawn(process.execPath, ["-e", failure
      ? "console.error('Permission denied'); process.exit(1)"
      : `require('net').createServer(s => s.end()).listen(${port}, '127.0.0.1')`], options);
  }) };
});
const links: SshLink[] = [];
afterEach(async () => { for (const link of links) await link.close(); links.length = 0; });
async function port() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
it("reports a live forward, then closes its listener on plugin shutdown", async () => {
  const link = new SshLink({ id: randomUUID(), name: "Fixture", destination: "fixture.example", localPort: await port(), remotePort: 3000, sshPort: 22, autoConnect: false });
  links.push(link); link.start();
  for (let i = 0; i < 30 && link.status.state !== "connected"; i++) await wait(50);
  expect(link.status.state).toBe("connected");
  await link.close(); expect(link.status.state).toBe("stopped");
});
it("reports key authentication failure and cancels pending retries on disconnect", async () => {
  const link = new SshLink({ id: randomUUID(), name: "Fixture", destination: "denied.example", localPort: await port(), remotePort: 3000, sshPort: 22, autoConnect: false });
  links.push(link); link.start();
  for (let i = 0; i < 30 && link.status.state !== "retrying"; i++) await wait(20);
  expect(link.status.state).toBe("retrying"); expect(link.status.message).toContain("key authentication");
  await link.close(); await wait(1100); expect(link.status.state).toBe("stopped");
});
