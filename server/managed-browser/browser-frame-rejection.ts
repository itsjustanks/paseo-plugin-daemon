/**
 * Explains stale input observations through ordinary RPC errors. Only fixed
 * stage/reason labels and bounded elapsed age leave the policy boundary; frame
 * IDs, page details and control authority stay private. Diagnostics grant no
 * retry or non-publication guarantee for an already admitted input.
 */
export function createBrowserFrameRejection(
  stage: "admission" | "admitted-input",
  reason: "expired" | "missing-or-revoked" | "context-changed",
  ageMs?: number,
): Error {
  const details = [`stage=${stage}`, `reason=${reason}`];
  if (ageMs !== undefined && Number.isFinite(ageMs)) {
    details.push(`ageMs=${Math.min(60_000, Math.max(0, Math.floor(ageMs)))}`);
  }
  return new Error(`Browser frame is stale (${details.join("; ")})`);
}
