import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir } from "./temp-dir.test-support";

const fixture = vi.hoisted(() => ({ path: "", packagePath: "", packageInfo: {} as unknown }));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  return { ...actual, createRequire: (file: string) => {
    const real = actual.createRequire(file);
    const fake = (specifier: string) => specifier === fixture.packagePath ? fixture.packageInfo : real(specifier);
    fake.resolve = (specifier: string) => specifier === "@getpaseo/cli/package.json" ? fixture.packagePath : specifier.startsWith("@getpaseo/") ? fixture.path : real.resolve(specifier);
    return fake;
  } };
});
import { loadPaseoDaemon, resolvePaseoCli } from "../../server/cross-daemon/paseo-daemon.server";

type State = { home: unknown; url: unknown; serverId: unknown; calls: unknown[][] };
function setup(exports = true) {
  const dir = makeTempDir("hcd-adapter-");
  fixture.path = join(dir, "fixture.mjs");
  fixture.packagePath = join(dir, "package.json");
  fixture.packageInfo = { bin: { paseo: "dist/cli.js" } };
  const state: State = { home: dir, url: "https://fixture.invalid/#offer=" + "c3ludGhldGlj", serverId: "fixture", calls: [] };
  (globalThis as any).__hcdAdapterTest = state;
  writeFileSync(fixture.path, exports ? `
    const state = () => globalThis.__hcdAdapterTest;
    export function resolvePaseoHome() { return state().home; }
    export function readPersistedConfig(...args) { state().calls.push(args); return { fixture: true }; }
    export function resolveConfigFromPersisted(...args) { state().calls.push(args); return { relayEndpoint: "fixture" }; }
    export async function generateLocalPairingOffer(...args) { state().calls.push(args); return { url: state().url }; }
    export function parseConnectionOfferFromUrl(...args) { state().calls.push(args); return { serverId: state().serverId }; }
  ` : "export const unsupported = true;");
  return state;
}
afterEach(() => { delete (globalThis as any).__hcdAdapterTest; });

it("resolves only the running daemon's packages and adapts validated synthetic pairing results", async () => {
  const state = setup();
  const daemon = await loadPaseoDaemon();
  expect(daemon.home).toBe(state.home);
  expect(await daemon.readOwnPeer(false)).toMatchObject({ serverId: "fixture", link: state.url });
  expect((state.calls[2][0] as any)).toMatchObject({ paseoHome: state.home, relayEnabled: false, includeQr: false });
  expect(await daemon.readOwnIdentity()).toMatchObject({ serverId: "fixture" });
  expect((state.calls[6][0] as any).relayEnabled).toBe(true);
  expect(resolvePaseoCli(daemon.home)).toEqual({ command: process.execPath, args: [join(daemon.home, "dist/cli.js")], home: daemon.home });
});
it("fails closed for missing package exports or a malformed home", async () => {
  setup(false); await expect(loadPaseoDaemon()).rejects.toThrow("lacks");
  const state = setup(); state.home = null;
  await expect(loadPaseoDaemon()).rejects.toThrow("no home");
});
it("rejects malformed offers and cannot manufacture an identity from an absent link", async () => {
  const state = setup(); const daemon = await loadPaseoDaemon();
  for (const url of [null, "", 42]) { state.url = url; expect(await daemon.readOwnPeer(true)).toBeNull(); }
  await expect(daemon.readOwnIdentity()).rejects.toThrow("no pairing link");
  state.url = "synthetic"; state.serverId = null;
  await expect(daemon.readOwnPeer(true)).rejects.toThrow("cannot parse");
});
it("refuses invalid CLI package metadata", () => {
  setup(); fixture.packageInfo = { bin: { paseo: 4 } };
  expect(() => resolvePaseoCli("/fixture")).toThrow();
});
