import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const Port = z.number().int().min(1).max(65535);
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  // A hostname, SSH config alias, or user@hostname. Never a command or URL.
  destination: z.string().max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/),
  sshPort: Port.default(22),
  remotePort: Port,
  localPort: Port.min(1024),
  autoConnect: z.boolean().default(false),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const LinkStateSchema = z.object({
  id: z.string(),
  state: z.enum(["stopped", "starting", "connected", "retrying", "error"]),
  message: z.string(),
});
export type LinkState = z.infer<typeof LinkStateSchema>;
export const TunnelSchema = LinkStateSchema.extend({ port: Port, expiresAt: z.number(), url: z.string().nullable() });
export type Tunnel = z.infer<typeof TunnelSchema>;
const Empty = z.object({});
const Id = z.object({ id: z.string().uuid() });
const Ok = z.object({ ok: z.literal(true) });
export const tunnelInstall = defineRpc({ name: "daemon-link.tunnel.install", input: Empty, output: Ok });
export const linkStatus = defineRpc({
  name: "daemon-link.status", input: Empty,
  output: z.object({
    ssh: z.boolean(), cloudflared: z.boolean(),
    profiles: z.array(ProfileSchema), connections: z.array(LinkStateSchema), tunnels: z.array(TunnelSchema),
  }),
});
export const ProfileInputSchema = ProfileSchema.omit({ id: true }).extend({ id: z.string().uuid().optional() });
export const linkSave = defineRpc({ name: "daemon-link.save", input: ProfileInputSchema, output: Ok });
export const linkRemove = defineRpc({ name: "daemon-link.remove", input: Id, output: Ok });
export const linkConnect = defineRpc({ name: "daemon-link.connect", input: Id, output: Ok });
export const linkDisconnect = defineRpc({ name: "daemon-link.disconnect", input: Id, output: Ok });
export const tunnelStart = defineRpc({
  name: "daemon-link.tunnel.start",
  input: z.object({ port: Port, minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30) }),
  output: TunnelSchema,
});
export const tunnelStop = defineRpc({ name: "daemon-link.tunnel.stop", input: Id, output: Ok });
export const tunnelOpen = defineRpc({
  name: "daemon-link.tunnel.open", input: Id,
  output: z.object({ url: z.string().url() }),
});
