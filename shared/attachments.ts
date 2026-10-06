import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * "Hosts" in the message box's attach menu (0.12.0, `addAttachmentSource`,
 * Paseo 0.8+): heavy processes now, what needs attention, a dev server's
 * recent output, or a watched service's recent checks. The app calls the
 * search RPC with `{ query }` and attaches the chosen item's `text`. The
 * shapes copy the SDK's `PluginAttachmentItemSchema`.
 */
export const HostsAttachmentItemSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.url(),
  text: z.string(),
  resourceType: z.string(),
});
export type HostsAttachmentItem = z.infer<typeof HostsAttachmentItemSchema>;

export const hostsAttachmentSearch = defineRpc({
  name: "daemon-link.attachments.search",
  input: z.object({ query: z.string().max(200).default("") }),
  output: z.object({ items: z.array(HostsAttachmentItemSchema) }),
});

/** An address for an item; the app needs a URL, and this one is never fetched. */
export const attachmentUrl = (path: string) => `paseo-plugin://daemon-link/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Whether an item matches what was typed: every word somewhere in its title, subtitle or kind. */
export function matchesQuery(item: Pick<HostsAttachmentItem, "title" | "subtitle" | "resourceType" | "identifier">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${item.title} ${item.subtitle ?? ""} ${item.resourceType} ${item.identifier}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
