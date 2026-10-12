// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PaseoCliCommand } from "./paseo-cli.server";
import type { Peer } from "../../shared/cross-daemon/cross-daemon.shared";

export interface PaseoDaemon {
  home: string;
  readOwnPeer(relayEnabled: boolean): Promise<Peer | null>;
  readOwnIdentity(): Promise<{ name: string; serverId: string }>;
}

type DaemonFunction = (...args: unknown[]) => unknown;

function hasFunctions<Name extends string>(value: unknown, ...names: Name[]): value is Record<Name, DaemonFunction> {
  return typeof value === "object" && value !== null && names.every((name) => typeof Reflect.get(value, name) === "function");
}

// Paseo starts the plugin process from a script inside @getpaseo/server, so the running daemon's own
// packages resolve from there. The plugin API offers no pairing link, and the CLI is not always on PATH.
async function importFromDaemon<Name extends string>(specifier: string, ...names: Name[]) {
  const exports: unknown = await import(pathToFileURL(createRequire(process.argv[1]).resolve(specifier)).href);
  if (!hasFunctions(exports, ...names)) throw new Error(`${specifier} lacks ${names.join(", ")}`);
  return exports;
}

export async function loadPaseoDaemon(): Promise<PaseoDaemon> {
  const [control, configuration, pairing, offers] = await Promise.all([
    importFromDaemon("@getpaseo/server/daemon-control", "resolvePaseoHome"),
    importFromDaemon("@getpaseo/server/configuration", "readPersistedConfig", "resolveConfigFromPersisted"),
    importFromDaemon("@getpaseo/server/pairing", "generateLocalPairingOffer"),
    importFromDaemon("@getpaseo/protocol/connection-offer", "parseConnectionOfferFromUrl"),
  ]);
  const home = control.resolvePaseoHome();
  if (typeof home !== "string") throw new Error("Paseo returned no home directory");
  const readOwnPeer = async (relayEnabled: boolean): Promise<Peer | null> => {
    const persisted = configuration.readPersistedConfig(home, { defaultsIfMissing: true });
    const config = configuration.resolveConfigFromPersisted(home, persisted, { env: process.env });
    const offer = await pairing.generateLocalPairingOffer({
      paseoHome: home,
      relayEnabled,
      relayEndpoint: Reflect.get(Object(config), "relayEndpoint"),
      relayPublicEndpoint: Reflect.get(Object(config), "relayPublicEndpoint"),
      relayUseTls: Reflect.get(Object(config), "relayUseTls"),
      relayPublicUseTls: Reflect.get(Object(config), "relayPublicUseTls"),
      appBaseUrl: Reflect.get(Object(config), "appBaseUrl"),
      includeQr: false,
    });
    const link: unknown = Reflect.get(Object(offer), "url");
    if (typeof link !== "string" || link === "") return null;
    const serverId: unknown = Reflect.get(Object(offers.parseConnectionOfferFromUrl(link)), "serverId");
    if (typeof serverId !== "string") throw new Error("Paseo produced a pairing link it cannot parse");
    return { serverId, name: hostname(), link };
  };
  return {
    home,
    readOwnPeer,
    // The server ID travels inside the pairing link, which Paseo builds even for a daemon whose relay is off.
    async readOwnIdentity() {
      const own = await readOwnPeer(true);
      if (!own) throw new Error("Paseo built no pairing link with the relay on");
      return { name: own.name, serverId: own.serverId };
    },
  };
}

const cliPackageSchema = z.object({ bin: z.object({ paseo: z.string() }) });

// Run the CLI that ships with the running daemon, with the daemon's own Node, so a GUI-launched
// daemon without paseo on its PATH can still use it.
export function resolvePaseoCli(home: string): PaseoCliCommand {
  const requireFromDaemon = createRequire(process.argv[1]);
  const packagePath = requireFromDaemon.resolve("@getpaseo/cli/package.json");
  const { bin } = cliPackageSchema.parse(requireFromDaemon(packagePath));
  return { command: process.execPath, args: [join(dirname(packagePath), bin.paseo)], home };
}
