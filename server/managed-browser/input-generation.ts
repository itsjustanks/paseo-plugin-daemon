/**
 * Private runtime metadata codec for attachment and document counters. This is
 * produced by agent-browser-runtime and consumed only by browser-policy. Unknown
 * older formats cannot prove same-attachment completion after input publication.
 */

/** Serialize native counters without treating document navigation as target replacement. */
export function formatRuntimeInputGeneration(attachment: number, document: number): string {
  if (
    !Number.isSafeInteger(attachment) ||
    attachment < 0 ||
    !Number.isSafeInteger(document) ||
    document < 0
  ) {
    throw new Error("Invalid native input generation");
  }
  return `${attachment}:${document}`;
}

/** Compare only independently serialized attachment identity; malformed or absent metadata refuses completion. */
export function sameRuntimeInputAttachment(
  original: string | null,
  current: string | null,
): boolean {
  const before = readNativeCounters(original);
  const after = readNativeCounters(current);
  return before !== null && after !== null && before.attachment === after.attachment;
}

/** Require the complete native codec, including a bounded valid document counter. */
function readNativeCounters(value: string | null): { attachment: number; document: number } | null {
  if (!value || value.length > 33 || !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(value)) return null;
  const [attachment, document] = value.split(":").map(Number);
  if (!Number.isSafeInteger(attachment) || !Number.isSafeInteger(document)) return null;
  return { attachment: attachment!, document: document! };
}
