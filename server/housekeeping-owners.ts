import { execFile } from "node:child_process";
import { mapLimit } from "./platform";
import { PaseoCli } from "./paseo-cli";
import type { OwnerKind } from "./housekeeping-plan";

/**
 * Who owns a leftover browser (0.18.0): Paseo's own answer for one chat, read
 * fresh for every decision. The background loop has no Paseo session of its
 * own (RPC and hook sessions belong to their callback), so it asks the daemon's
 * `paseo` command, the same way Restart does: `paseo inspect <id> --json`,
 * no shell, a timeout, cancelled with the cycle. Only an answer for exactly
 * that ID that says closed or archived counts as finished. A missing agent,
 * an error, a timeout or anything unexpected is "unknown", and unknown keeps.
 */

export const LOOKUP_TIMEOUT_MS = 10_000;
export const LOOKUP_CONCURRENCY = 4;
export const MAX_LOOKUPS = 64;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type InspectRun = (file: string, args: readonly string[], timeoutMs: number, signal: AbortSignal) => Promise<{ code: number | null; stdout: string }>;

export const runInspect: InspectRun = (file, args, timeoutMs, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve({ code: null, stdout: "" }); return; }
  const child = execFile(file, [...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, signal, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
    const failure = error as { code?: unknown } | null;
    resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? "") });
  });
  child.stdin?.end();
});

/**
 * `paseo inspect <id> --json`: Id, Status, Archived (boolean), ArchivedAt.
 * Paseo stores an archived chat's last status with running/initializing
 * normalised to idle, so "Archived: true, ArchivedAt: <time>, Status: idle"
 * is a genuinely archived chat. A live chat says Archived false (or null) and
 * no ArchivedAt; live idle is not finished. Contradictions (archived while
 * running, an archive flag without a valid time or the reverse), another ID,
 * or anything malformed are unknown, and unknown keeps.
 */
export function parseInspect(id: string, stdout: string): OwnerKind {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return "unknown"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const record = value as Record<string, unknown>;
  if (record.Id !== id) return "unknown";
  const status = typeof record.Status === "string" ? record.Status.trim().toLowerCase() : null;
  if (!status) return "unknown";
  const archivedAt = record.ArchivedAt;
  const validTime = typeof archivedAt === "string" && archivedAt.trim() !== "" && Number.isFinite(Date.parse(archivedAt));
  const noTime = archivedAt === null || archivedAt === undefined || archivedAt === "";
  if (record.Archived === true) {
    if (!validTime) return "unknown";
    return status === "idle" || status === "closed" || status === "error" ? "archived" : "unknown";
  }
  if (record.Archived !== false && record.Archived !== null) return "unknown";
  if (!noTime) return "unknown";
  if (status === "closed") return "closed";
  if (status === "running" || status === "initializing") return "running";
  if (status === "idle") return "idle";
  return "unknown";
}

export interface OwnerLookup { lookup(ids: readonly string[], signal: AbortSignal): Promise<Map<string, OwnerKind>> }

export class CliOwners implements OwnerLookup {
  constructor(private readonly cli: Pick<PaseoCli, "resolve"> = new PaseoCli(), private readonly run: InspectRun = runInspect, private readonly timeoutMs = LOOKUP_TIMEOUT_MS) {}

  async lookup(ids: readonly string[], signal: AbortSignal): Promise<Map<string, OwnerKind>> {
    const out = new Map<string, OwnerKind>();
    const unique = [...new Set(ids)].filter((id) => AGENT_ID.test(id));
    for (const id of unique) out.set(id, "unknown");
    if (signal.aborted || !unique.length) return out;
    const file = await this.cli.resolve().catch(() => null);
    if (!file || signal.aborted) return out;
    await mapLimit(unique.slice(0, MAX_LOOKUPS), LOOKUP_CONCURRENCY, async (id) => {
      if (signal.aborted) return;
      const result = await this.run(file, ["inspect", id, "--json"], this.timeoutMs, signal).catch(() => ({ code: null, stdout: "" }));
      if (!signal.aborted && result.code === 0) out.set(id, parseInspect(id, result.stdout));
    });
    // A cancelled cycle learns nothing: every answer goes back to unknown.
    if (signal.aborted) for (const id of unique) out.set(id, "unknown");
    return out;
  }
}
