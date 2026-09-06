import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { ProjectScope } from "../server/scope";
import { ProjectTransfers } from "../server/transfers";
import { PeerManager, decodeOffer } from "../server/peers";
import { relayFixture } from "./relay-fixture";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error("Condition timed out"); }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hosts-transfer-test-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project"); await mkdir(project);
  const git = (...args: string[]) => run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "-C", project, ...args]);
  await git("init"); await writeFile(join(project, "README.md"), "Fictional committed project\n"); await git("add", "README.md"); await git("commit", "-m", "Fixture commit");
  await writeFile(join(project, ".env"), "DEMO=untracked-do-not-copy\n");
  let registered = true;
  const scope = new ProjectScope(undefined, join(directory, "home"));
  scope.bind({ projects: { list: async () => ({ projects: registered ? [{ projectId: "demo-project", projectDisplayName: "Demo project", projectRootPath: project }] : [] }) }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi);
  return { directory, project, scope, git, unregister: async () => { registered = false; await scope.refresh(true); } };
}

describe("reviewed project transfers", () => {
  it("requires separate sharing, previews committed history, receives an isolated checkout over encrypted relay, persists history, and revokes access", async () => {
    const f = await fixture(); const relay = await relayFixture(); cleanups.push(() => relay.close());
    const source = new ProjectTransfers(f.scope, join(f.directory, "exports"));
    const receiver = new ProjectTransfers(f.scope, join(f.directory, "receives"));
    const host = new PeerManager(join(f.directory, "host"), undefined, async () => [], source);
    const client = new PeerManager(join(f.directory, "client"));
    cleanups.push(() => source.close(), () => receiver.close(), () => host.close(), () => client.close());
    const { invitation } = await host.offer({ label: "Fictional source", relay: relay.endpoint });
    await client.pair(invitation);
    const peerId = (await client.status()).peers[0]!.id;
    await until(async () => (await host.status()).relayState === "connected");
    expect((await client.projectList(peerId)).projects).toEqual([]);
    await expect(client.projectPreview(peerId, "demo-project")).rejects.toThrow();
    const grantId = decodeOffer(invitation).grantId;
    await expect(host.shareProjects(grantId, ["not-registered"])).rejects.toThrow("registered");
    await host.shareProjects(grantId, ["demo-project"]);
    expect((await client.projectList(peerId)).projects[0]!.name).toBe("Demo project");
    const preview = await receiver.inspect(client, peerId, "demo-project");
    expect(preview.commits).toBe(1);
    await expect(receiver.receive(client, peerId, "00000000-0000-4000-8000-000000000000")).rejects.toThrow("Preview");
    const accepted = await receiver.receive(client, peerId, preview.token);
    await until(async () => (await receiver.history())[0]?.state !== "receiving");
    const history = await receiver.history();
    expect(history[0]!.state).toBe("done");
    const checkout = join(f.directory, "receives", "received", accepted.id, "repository");
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("Fictional committed project\n");
    await expect(readFile(join(checkout, ".env"))).rejects.toThrow();
    expect(await readFile(join(f.project, ".env"), "utf8")).toContain("untracked-do-not-copy");
    expect((await f.git("status", "--porcelain")).stdout).toContain("?? .env");
    expect(Buffer.concat(relay.wire).toString()).not.toContain("Fictional committed project");
    const restored = new ProjectTransfers(f.scope, join(f.directory, "receives")); cleanups.push(() => restored.close());
    expect((await restored.history())[0]!.id).toBe(accepted.id);
    await host.shareProjects(grantId, []);
    await expect(client.projectDownload(peerId, preview.token)).rejects.toThrow();
    expect((await client.projectList(peerId)).projects).toEqual([]);
    await host.shareProjects(grantId, ["demo-project"]); await f.unregister();
    expect((await client.projectList(peerId)).projects).toEqual([]);
    await expect(source.download(preview.token, grantId)).rejects.toThrow("registered");
  }, 25_000);

  it("rejects expired or wrong-grant previews, bounds reserved exports, rejects corruption, and records interrupted history", async () => {
    const f = await fixture(); let now = Date.now();
    const source = new ProjectTransfers(f.scope, join(f.directory, "exports"), () => now); cleanups.push(() => source.close());
    const preview = await source.preview("demo-project", "grant-a");
    await expect(source.download(preview.token, "grant-b")).rejects.toThrow("expired");
    for (let i = 0; i < 3; i++) await source.preview("demo-project", "grant-a");
    await expect(source.preview("demo-project", "grant-a")).rejects.toThrow("Four project previews");
    now += 11 * 60_000; await expect(source.download(preview.token, "grant-a")).rejects.toThrow("expired");
    expect((await source.preview("demo-project", "grant-a")).expiresAt).toBeGreaterThan(now);
    const brokenDir = join(f.directory, "broken"); await mkdir(brokenDir); await writeFile(join(brokenDir, "history.json"), "broken");
    const broken = new ProjectTransfers(f.scope, brokenDir); cleanups.push(() => broken.close());
    await expect(broken.history()).rejects.toThrow("cannot be read");
    expect(await readFile(join(brokenDir, "history.json"), "utf8")).toBe("broken");
    const interruptedDir = join(f.directory, "interrupted"); await mkdir(interruptedDir);
    await writeFile(join(interruptedDir, "history.json"), JSON.stringify([{ id: preview.token, peerId: preview.token, projectName: "Demo project", head: preview.head, startedAt: now, finishedAt: null, state: "receiving", bytes: 0, directory: null, message: "Receiving" }]));
    const interrupted = new ProjectTransfers(f.scope, interruptedDir, () => now); cleanups.push(() => interrupted.close());
    expect((await interrupted.history())[0]).toMatchObject({ state: "interrupted", finishedAt: now, directory: null });
  });

  it("rejects a changed payload without touching projects and prevents simultaneous receives", async () => {
    const f = await fixture(); const source = new ProjectTransfers(f.scope, join(f.directory, "exports"));
    const receiver = new ProjectTransfers(f.scope, join(f.directory, "receives")); cleanups.push(() => source.close(), () => receiver.close());
    const peerId = "00000000-0000-4000-8000-000000000001";
    const peer = { projectList: () => source.list(["demo-project"]), projectPreview: (_peerId: string, projectId: string) => source.preview(projectId, "grant"), projectDownload: async (_peerId: string, token: string) => { await new Promise((r) => setTimeout(r, 100)); const output = await source.download(token, "grant"); return { ...output, bytes: Buffer.from("corrupted") }; } };
    const preview = await receiver.inspect(peer, peerId, "demo-project");
    const next = await receiver.inspect(peer, peerId, "demo-project");
    await receiver.receive(peer, peerId, preview.token);
    await expect(receiver.receive(peer, peerId, next.token)).rejects.toThrow("already running");
    await until(async () => (await receiver.history())[0]?.state !== "receiving");
    expect((await receiver.history())[0]!.state).toBe("failed");
    expect((await receiver.history())[0]!.directory).toBe(null);
    expect(await readFile(join(f.project, "README.md"), "utf8")).toBe("Fictional committed project\n");
  });

  it("does not export a parent repository through a registered subdirectory, and rejects concurrent preparation", async () => {
    const f = await fixture();
    const source = new ProjectTransfers(f.scope, join(f.directory, "exports")); cleanups.push(() => source.close());
    const preparing = source.preview("demo-project", "grant");
    await expect(source.preview("demo-project", "grant")).rejects.toThrow("already being prepared");
    await preparing;
    const child = join(f.project, "child"); await mkdir(child);
    const childScope = new ProjectScope(undefined, join(f.directory, "home"));
    childScope.bind({ projects: { list: async () => ({ projects: [{ projectId: "child", projectDisplayName: "Child", projectRootPath: child }] }) }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi);
    const childSource = new ProjectTransfers(childScope, join(f.directory, "child-exports")); cleanups.push(() => childSource.close());
    await expect(childSource.preview("child", "grant")).rejects.toThrow("repository root");
    await source.close();
    await expect(source.preview("demo-project", "grant")).rejects.toThrow("already being prepared");
  });
});
