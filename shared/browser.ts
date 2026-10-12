import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BROWSER_FRAME_INTERVAL_MS = 1_000;
export const BROWSER_LEASE_MS = 15_000;
export const BROWSER_MAX_BASE64 = 700_000;
export const BROWSER_MAX_WIDTH = 1280;
export const BROWSER_MAX_HEIGHT = 900;
const identity = z.string().min(1).max(128);
export const BrowserTabSchema = z.object({ id: identity, title: z.string().max(240), url: z.string().max(500) });
export const BrowserSessionSchema = z.object({
  id: identity, name: z.string().max(160), pid: z.number().int().positive(), version: z.string().max(40).nullable(),
  workspaceId: z.string().nullable(), workspace: z.string().max(240).nullable(),
  chatId: z.string().nullable(), chat: z.string().max(240).nullable(),
  attribution: z.enum(["chat", "workspace", "unknown"]),
  viewable: z.boolean(), limitation: z.string().max(500).nullable(),
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export const browserSessions = defineRpc({
  name: "daemon-link.browser.sessions", input: z.object({ workspaceId: z.string().max(128).optional() }).strict(),
  output: z.object({ sessions: z.array(BrowserSessionSchema).max(32), warnings: z.array(z.string()).max(10) }),
});
export const browserViewOpen = defineRpc({
  name: "daemon-link.browser.open", input: z.object({ sessionId: identity }).strict(),
  output: z.object({ viewerId: identity, tabs: z.array(BrowserTabSchema).max(100), expiresInMs: z.number() }),
});
export const BrowserFrameSchema = z.object({
  tabId: identity, data: z.string().max(BROWSER_MAX_BASE64), width: z.number().int().positive().max(BROWSER_MAX_WIDTH),
  height: z.number().int().positive().max(BROWSER_MAX_HEIGHT), capturedAt: z.number(),
});
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;
export const browserViewFrame = defineRpc({
  name: "daemon-link.browser.frame", input: z.object({ viewerId: identity, tabId: identity }).strict(),
  output: z.object({ frame: BrowserFrameSchema.nullable(), tabs: z.array(BrowserTabSchema).max(100), message: z.string().nullable() }),
});
export const browserViewClose = defineRpc({
  name: "daemon-link.browser.close", input: z.object({ viewerId: identity }).strict(), output: z.object({ ok: z.literal(true) }),
});
