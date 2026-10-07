import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, sep } from "node:path";
import { PLUGIN_ID } from "../shared/guard";

/**
 * The `paseo` command, for `paseo plugin reload <id>` (0.13.0). Plugins have
 * no SDK call to reload another plugin, so Hosts runs the same command a
 * person would. Which `paseo`: the one that ships with the daemon Hosts runs
 * under, found from this process's own path (a login shell's PATH can hold
 * an older copy), then PATH. Every call has a timeout and runs without a
 * shell; the plugin id is checked before it gets near the command line.
 */

export interface CliResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type CliRun = (file: string, args: readonly string[], timeoutMs: number) => Promise<CliResult>;

export const runCli: CliRun = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, [...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
    const timedOut = !!failure && (failure.killed === true || failure.signal === "SIGKILL") && !(typeof failure.code === "number");
    resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
  });
});

/**
 * Where the daemon's own `paseo` should be, from this plugin process's path:
 *  - npm install: …/node_modules/@getpaseo/server/… → …/node_modules/@getpaseo/cli/bin/paseo
 *  - the desktop app: …/Resources/app.asar/… → …/Resources/bin/paseo
 * then plain `paseo` from PATH.
 */
export function cliCandidates(entry = process.argv[1] ?? ""): string[] {
  const out: string[] = [];
  const server = entry.lastIndexOf(`${sep}@getpaseo${sep}server${sep}`);
  if (server >= 0) out.push(join(entry.slice(0, server), "@getpaseo", "cli", "bin", "paseo"));
  const asar = entry.indexOf(`${sep}app.asar${sep}`);
  if (asar >= 0) out.push(join(dirname(entry.slice(0, asar + 1 + "app.asar".length)), "bin", "paseo"));
  out.push("paseo");
  return [...new Set(out)];
}

const executable = async (file: string) => {
  if (!file.includes(sep)) return true;
  try { await access(file, constants.X_OK); return true; } catch { return false; }
};

export interface PluginListing { id: string; status: string; enabled: boolean }

export class PaseoCli {
  private resolved: Promise<string | null> | null = null;
  private reloadable: Promise<boolean> | null = null;

  constructor(private readonly run: CliRun = runCli, private readonly candidates: readonly string[] = cliCandidates()) {}

  /** The first candidate that answers `--version`, cached. */
  resolve(): Promise<string | null> {
    this.resolved ??= (async () => {
      for (const file of this.candidates) {
        if (!await executable(file)) continue;
        const result = await this.run(file, ["--version"], 8000);
        if (result.code === 0) return file;
      }
      return null;
    })();
    return this.resolved;
  }

  /** Feature check: this `paseo` has `plugin reload` (cached; a failed check is retried next time). */
  async canReload(): Promise<boolean> {
    this.reloadable ??= (async () => {
      const file = await this.resolve();
      if (!file) return false;
      const result = await this.run(file, ["plugin", "reload", "--help"], 8000);
      return result.code === 0 && /reload/i.test(result.stdout + result.stderr);
    })();
    const ok = await this.reloadable;
    if (!ok) { this.reloadable = null; this.resolved = null; }
    return ok;
  }

  async reload(pluginId: string, timeoutMs: number): Promise<CliResult> {
    if (!PLUGIN_ID.test(pluginId)) return { code: null, stdout: "", stderr: "invalid plugin id", timedOut: false };
    const file = await this.resolve();
    if (!file) return { code: null, stdout: "", stderr: "paseo command not found", timedOut: false };
    return this.run(file, ["plugin", "reload", pluginId], timeoutMs);
  }

  /** `paseo plugin ls --json`, or null when it can't be read. */
  async list(timeoutMs = 10_000): Promise<PluginListing[] | null> {
    const file = await this.resolve();
    if (!file) return null;
    const result = await this.run(file, ["plugin", "ls", "--json"], timeoutMs);
    if (result.code !== 0) return null;
    try { return parsePluginList(JSON.parse(result.stdout)); } catch { return null; }
  }
}

/** Tolerant of shape changes: an array of rows, or `{ plugins: [...] }`, with id/status/enabled under a few names. */
export function parsePluginList(value: unknown): PluginListing[] | null {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { plugins?: unknown }).plugins) ? (value as { plugins: unknown[] }).plugins : null;
  if (!rows) return null;
  const out: PluginListing[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = [record.id, record.plugin, record.pluginId].find((value) => typeof value === "string") as string | undefined;
    if (!id || !PLUGIN_ID.test(id)) continue;
    const status = typeof record.status === "string" ? record.status : "unknown";
    const enabled = typeof record.enabled === "boolean" ? record.enabled : record.enabled === "yes" || status === "running";
    out.push({ id, status, enabled });
  }
  return out;
}
