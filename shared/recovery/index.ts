import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const RECOVERY_PROFILE_MAX = 20;
export const RECOVERY_SCHEMA_VERSION = 1;
const Name = z.string().trim().min(1).max(60).regex(/^[^\x00-\x1f\x7f]+$/);
const Host = z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const User = z.string().max(64).regex(/^(?:[a-zA-Z_][a-zA-Z0-9_-]*)?$/);
const Identity = z.string().min(2).max(1024).regex(/^\/[^\x00-\x1f\x7f]+$/);
export const RecoveryDetailsSchema = z.object({
  name: Name, hostname: Host, user: User.default(""),
  // Null preserves the port in the runner's SSH config. An explicit port overrides it.
  port: z.number().int().min(1).max(65535).nullable().default(null),
  auth: z.discriminatedUnion("kind", [z.object({ kind: z.literal("config") }).strict(), z.object({ kind: z.literal("identity"), path: Identity }).strict()]),
  preset: z.enum(["docker", "systemd"]),
  container: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).default("paseo-dev-stack-paseo"),
  unit: z.string().min(9).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/).default("paseo.service"),
  sudo: z.boolean().default(false),
}).strict();
export const RecoveryProfileSchema = RecoveryDetailsSchema.extend({ id: z.string().uuid(), revision: z.number().int().positive() });
export type RecoveryDetails = z.infer<typeof RecoveryDetailsSchema>;
export type RecoveryProfile = z.infer<typeof RecoveryProfileSchema>;
export const RecoverySaveSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid().optional(), expectedRevision: z.number().int().nonnegative(), details: RecoveryDetailsSchema }).strict();
export type RecoverySave = z.infer<typeof RecoverySaveSchema>;
export const RecoveryActionSchema = z.enum(["start", "restart", "container_restart", "reboot", "remove"]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
export const ACTION_LABELS: Record<RecoveryAction, string> = { start: "Start Paseo", restart: "Restart Paseo", container_restart: "Restart existing container", reboot: "Reboot host", remove: "Remove connection" };
export const PRESET_LABELS = { docker: "Docker / Dev Stack", systemd: "Systemd service" } as const;
export const RecoveryResultSchema = z.object({
  code: z.enum(["checked", "sent", "removed", "host_key", "auth", "unreachable", "unavailable", "failed", "uncertain", "cancelled", "busy"]),
  message: z.string().max(500), checkedAt: z.number(), state: z.enum(["running", "stopped", "unknown"]).default("unknown"),
});
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>;
export const RecoveryPreviewSchema = z.object({ token: z.string().uuid(), profile: RecoveryProfileSchema, action: RecoveryActionSchema, expiresAt: z.number() });
export type RecoveryPreview = z.infer<typeof RecoveryPreviewSchema>;
const Id = z.object({ id: z.string().uuid() }).strict();
const VersionedId = Id.extend({ revision: z.number().int().positive() });
const Token = z.object({ token: z.string().uuid() }).strict();
const Ok = z.object({ ok: z.literal(true) });
export const recoveryList = defineRpc({ name: "hosts.recovery.list", input: z.object({}).strict(), output: z.object({ profiles: z.array(RecoveryProfileSchema).max(20), checks: z.record(z.string(), RecoveryResultSchema) }) });
export const recoverySave = defineRpc({ name: "hosts.recovery.save", input: RecoverySaveSchema, output: RecoveryProfileSchema });
export const recoveryTest = defineRpc({ name: "hosts.recovery.test", input: VersionedId, output: RecoveryResultSchema });
export const recoveryPreview = defineRpc({ name: "hosts.recovery.preview", input: VersionedId.extend({ action: RecoveryActionSchema }), output: RecoveryPreviewSchema });
export const recoveryConfirm = defineRpc({ name: "hosts.recovery.confirm", input: Token.extend({ targetName: z.string().max(60).optional() }), output: RecoveryResultSchema });
export const recoveryCancel = defineRpc({ name: "hosts.recovery.cancel", input: Token, output: Ok });
export function recoveryActionLabel(profile: RecoveryProfile, action: RecoveryAction): string {
  if (profile.preset === "docker" && action === "start") return "Start container";
  if (profile.preset === "docker" && action === "restart") return "Restart Paseo worker";
  return ACTION_LABELS[action];
}
export function recoveryWarning(profile: RecoveryProfile, action: RecoveryAction, runner: string): string {
  if (action === "reboot") return `Reboot ${profile.name} (${profile.hostname}) from ${runner}? All work on the target host will be interrupted, including every Paseo daemon, agent and service. A lost SSH connection does not prove recovery. Check separately after the host returns.`;
  if (action === "container_restart") return `Restart the existing ${profile.container} container on ${profile.name} (${profile.hostname}) from ${runner}? All work inside this container will be interrupted, including every agent, terminal and service. The container is never recreated. A disconnect may leave the outcome uncertain; check separately before retrying.`;
  if (action === "remove") return `Remove ${profile.name} from ${runner}? This deletes the saved connection only. The target and its key files are unchanged.`;
  if (action === "restart") return `Restart Paseo on ${profile.name} (${profile.hostname}) from ${runner}? Running agents on this Paseo instance will be interrupted. ${profile.preset === "docker" ? "Only the worker inside the existing container is restarted." : `The ${profile.unit} service is restarted.`}`;
  return `Start Paseo on ${profile.name} (${profile.hostname}) from ${runner}? ${profile.preset === "docker" ? `This starts the existing ${profile.container} container. It never creates or recreates a container.` : `This starts the configured ${profile.unit} service.`}`;
}
