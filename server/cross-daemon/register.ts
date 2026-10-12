import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { registerCrossDaemon } from "./cross-daemon.server";
import { createPaseoCli } from "./paseo-cli.server";
import { loadPaseoDaemon, resolvePaseoCli } from "./paseo-daemon.server";

/** Parent entry calls this explicitly. No work happens merely by importing it. */
export function contributeCrossDaemon(server: PluginServerContext) {
  let daemon: ReturnType<typeof loadPaseoDaemon> | undefined;
  const getDaemon = () => {
    daemon ??= loadPaseoDaemon();
    void daemon.catch(() => {});
    return daemon;
  };
  return registerCrossDaemon(server, {
    readOwnPeer: async (relayEnabled) => (await getDaemon()).readOwnPeer(relayEnabled),
    stateDir: () => getDaemon().then(({ home }) => join(home, "plugin-data", "hosts-cross-daemon")),
    cli: {
      run: async (link, args, options) => createPaseoCli(resolvePaseoCli((await getDaemon()).home)).run(link, args, options),
      runLocal: async (args, options) => createPaseoCli(resolvePaseoCli((await getDaemon()).home)).runLocal(args, options),
    },
    ownDaemon: async () => (await getDaemon()).readOwnIdentity(),
  });
}
