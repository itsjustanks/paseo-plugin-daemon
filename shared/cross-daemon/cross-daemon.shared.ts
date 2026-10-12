// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const crossDaemonSettings = defineSettings({
  id: "hosts-cross-daemon",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    fullAuthorityConfirmed: z.boolean().default(false),
  }).refine((values) => !values.enabled || values.fullAuthorityConfirmed, {
    message: "Confirm full daemon authority before sharing pairing links.",
  }),
});

const PAIRING_LINK = /^https:\/\/[^\s#]+#offer=[A-Za-z0-9_-]+={0,2}$/;

export const peerSchema = z.object({
  serverId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  link: z.string().max(16384).regex(PAIRING_LINK, "not a Paseo pairing link"),
});
export type Peer = z.infer<typeof peerSchema>;

// Credential transport exclusively for the connected-host sync, never a status/table query.
export const shareDaemon = defineRpc({
  name: "hosts-cross-daemon.sync-offer",
  input: z.object({}),
  output: z.object({ serverId: z.string(), switchedOn: z.boolean(), member: peerSchema.nullable() }),
});

// Normal status contains no pairing link.
export const describeDaemon = defineRpc({
  name: "hosts-cross-daemon.describe",
  input: z.object({}),
  output: z.object({ serverId: z.string(), switchedOn: z.boolean(), available: z.boolean() }),
});

export const setPeers = defineRpc({
  name: "hosts-cross-daemon.set-peers",
  input: z.object({ peers: z.array(peerSchema).max(100), answeredServerIds: z.array(z.string().max(200)).max(200) }),
  output: z.object({ stored: z.number() }),
});

// Names and server IDs only: a peer's link never leaves the daemon.
export const listPeers = defineRpc({
  name: "hosts-cross-daemon.list-peers",
  input: z.object({}),
  output: z.object({ peers: z.array(z.object({ serverId: z.string(), name: z.string() })) }),
});
