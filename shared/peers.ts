import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { Port } from "./link";

const Empty = z.object({});
const Id = z.object({ id: z.string().uuid() });
const Ok = z.object({ ok: z.literal(true) });
export const ServiceSchema = z.object({ port: Port, label: z.string(), project: z.string().nullable() });
export const peerStatus = defineRpc({ name: "daemon-link.peers.status", input: Empty, output: z.object({
  relayState: z.string(),
  grants: z.array(z.object({ id: z.string(), label: z.string() })),
  peers: z.array(z.object({ id: z.string(), label: z.string() })),
  forwards: z.array(z.object({ id: z.string(), peerId: z.string(), remotePort: Port, localPort: Port })),
}) });
export const peerOffer = defineRpc({
  name: "daemon-link.peers.offer", input: z.object({ label: z.string().trim().min(1).max(60), relay: z.string().optional() }),
  output: z.object({ invitation: z.string() }),
});
export const peerPair = defineRpc({ name: "daemon-link.peers.pair", input: z.object({ invitation: z.string().max(8192) }), output: Ok });
export const peerRevoke = defineRpc({ name: "daemon-link.peers.revoke", input: Id, output: Ok });
export const peerRemove = defineRpc({ name: "daemon-link.peers.remove", input: Id, output: Ok });
export const peerServices = defineRpc({ name: "daemon-link.peers.services", input: Id, output: z.object({ services: z.array(ServiceSchema) }) });
export const peerForward = defineRpc({ name: "daemon-link.peers.forward", input: Id.extend({ port: Port }), output: z.object({ url: z.string().url(), localPort: Port }) });
export const peerDisconnect = defineRpc({ name: "daemon-link.peers.disconnect", input: Id, output: Ok });
