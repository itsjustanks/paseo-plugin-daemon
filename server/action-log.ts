import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ActionLogEntrySchema, type ActionLogEntry } from "../shared/processes";
import { stateDirectory } from "./binaries";

/**
 * Every stop, force stop and automatic force stop, one JSON line each, in
 * `$PASEO_HOME/daemon-link/actions.jsonl` (mode 0600). Entries carry the
 * process's display name, PID, owner label and outcome; never its command
 * line, environment or a token. The file keeps the newest KEEP entries.
 * Writes are serialized; a failed write is reported to the daemon log and
 * never fails the action itself.
 */

export const KEEP = 500;
const TRIM_AT = 600;

export class ActionLog {
  private queue: Promise<void> = Promise.resolve();
  private lines: number | null = null;

  constructor(private readonly file = join(stateDirectory(), "actions.jsonl"), private readonly print: (line: string) => void = (line) => console.log(line)) {}

  /** Record one action; resolves once it is on disk (or the write failed). */
  append(entry: ActionLogEntry): Promise<void> {
    const parsed = ActionLogEntrySchema.parse(entry);
    this.print(`daemon-link: ${parsed.action} ${parsed.name}${parsed.pid ? ` (PID ${parsed.pid})` : ""}${parsed.owner ? ` · ${parsed.owner}` : ""}: ${parsed.status}, ${parsed.signaled} signaled`);
    this.queue = this.queue.then(() => this.write(parsed)).catch((error) => {
      console.error("daemon-link: action log write failed", error instanceof Error ? error.name : "unknown");
    });
    return this.queue;
  }

  private async write(entry: ActionLogEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.lines = this.lines === null ? (await this.read()).length : this.lines + 1;
    if (this.lines > TRIM_AT) {
      const kept = (await this.read()).slice(-KEEP);
      await writeFile(this.file, kept.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
      this.lines = kept.length;
    }
  }

  private async read(): Promise<ActionLogEntry[]> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); } catch { return []; }
    const entries: ActionLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = ActionLogEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch { /* A torn or foreign line is skipped, never fatal. */ }
    }
    return entries;
  }

  /** The newest `limit` entries, newest first. */
  async recent(limit = 50): Promise<ActionLogEntry[]> {
    await this.queue;
    return (await this.read()).slice(-limit).reverse();
  }
}
