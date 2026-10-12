import { redactSecrets } from "../redaction";

/** Pairing offers are credentials even when synthetic or too short for Hosts' token rules. */
export function safeCrossDaemonText(text: string, links: readonly string[] = []): string {
  let safe = text;
  for (const link of links) if (link) safe = safe.replaceAll(link, "[pairing link redacted]");
  safe = safe.replace(/https?:\/\/[^\s<>"']*#offer=[^\s<>"']*/gi, "[pairing link redacted]");
  safe = safe.replace(/#offer=[A-Za-z0-9_%=-]+/gi, "[pairing offer redacted]");
  return redactSecrets(safe);
}
