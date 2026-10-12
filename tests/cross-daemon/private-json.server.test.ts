// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "../../server/cross-daemon/private-json.server";
import { makeTempDir } from "./temp-dir.test-support";

const tower = { serverId: "srv_tower", name: "tower", link: "https://app.paseo.sh/#offer=dG93ZXI" };

const peersSchema = z.array(z.object({ serverId: z.string(), name: z.string(), link: z.string() }));

function createPeerStore(dir: string) {
  const file = join(dir, "peers.json");
  return { read: () => readPrivateJson(file, peersSchema, []), write: (value: unknown) => writePrivateJson(file, value) };
}

describe("private JSON files", () => {
  it("reads no peers before any are written", () => {
    const store = createPeerStore(join(makeTempDir("cd-"), "state"));
    expect(store.read()).toEqual([]);
  });

  it("returns the peers it wrote", () => {
    const store = createPeerStore(join(makeTempDir("cd-"), "state"));
    store.write([tower]);
    expect(store.read()).toEqual([tower]);
  });

  it("keeps the links readable by the owner only, because each one grants full control of a daemon", () => {
    const dir = join(makeTempDir("cd-"), "state");
    createPeerStore(dir).write([tower]);
    expect(statSync(join(dir, "peers.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("keeps the file owner-only even when an interrupted write left a readable temp file", () => {
    const dir = join(makeTempDir("cd-"), "state");
    const store = createPeerStore(dir);
    store.write([]);
    writeFileSync(join(dir, "peers.json.tmp"), "[]", { mode: 0o644 });
    store.write([tower]);
    expect(statSync(join(dir, "peers.json")).mode & 0o777).toBe(0o600);
  });
});
