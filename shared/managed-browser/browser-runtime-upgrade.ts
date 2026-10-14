import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BROWSER_RUNTIME_UPGRADE_REQUIRED = "HOSTS_BROWSER_RUNTIME_UPGRADE_REQUIRED";
export function isBrowserRuntimeUpgradeRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.length > 4096) return false;
  const marker = BROWSER_RUNTIME_UPGRADE_REQUIRED + ":";
  return message.startsWith(marker) || (message.startsWith("Request failed: " + marker)
    && message.endsWith(" requestType=plugin.rpc.invoke.request code=handler_error"));
}

export const BROWSER_RUNTIME_RESTART_IMPACT = "This closes ALL Hosts managed browser sessions on the selected host. A browser that does not close normally may be forced to stop, and its most recent unsaved changes can be lost. Saved site profiles are kept. Existing browser-enabled agents need new configuration; create new agents after the restart.";
export const BROWSER_RUNTIME_RESTART_RECOVERY = "Shutdown could not be verified. Browser startup remains blocked. Recheck without sending another signal, or restart this host's container or computer, then recheck. If receipt or profile verification still fails, seek help; no files will be deleted automatically.";

export const browserRuntimeUpgradeReplySchema = z.object({
  status: z.enum(["confirmation-required", "complete", "blocked", "unknown", "cancelled", "not-sent"]),
  message: z.string().max(1024),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expiresAt: z.number().int().optional(),
  activeBrowserProcesses: z.number().int().nonnegative().optional(),
});
export type BrowserRuntimeUpgradeReply = z.output<typeof browserRuntimeUpgradeReplySchema>;
export const browserRuntimeUpgradeRpc = defineRpc({
  name: "daemon-link.browser.runtime.upgrade",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("preview") }).strict(),
    z.object({ action: z.literal("cancel") }).strict(),
    z.object({ action: z.literal("confirm"), approvalToken: z.string().regex(/^[a-f0-9]{64}$/), closeAllManagedSessions: z.literal(true) }).strict(),
    z.object({ action: z.literal("recheck") }).strict(),
  ]),
  output: browserRuntimeUpgradeReplySchema,
});
