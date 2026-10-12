// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { join } from "node:path";
import { z } from "zod";
import { type Peer, peerSchema } from "../../shared/cross-daemon/cross-daemon.shared";
import { readPrivateJson, writePrivateJson } from "./private-json.server";

export function createPeerStore(stateDir: string) {
  const peersFile = join(stateDir, "peers.json");
  return {
    read: (): Peer[] => readPrivateJson(peersFile, z.array(peerSchema), []),
    write: (peers: readonly Peer[]) => writePrivateJson(peersFile, peers),
  };
}
