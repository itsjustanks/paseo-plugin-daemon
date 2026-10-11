import { mkdir, open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { HousekeepingEntrySchema, JobRunSchema, type HousekeepingEntry, type HousekeepingJob, type JobRun } from "../shared/housekeeping";
import { redactSecrets } from "./redaction";
import { stateDirectory } from "./binaries";

/**
 * Housekeeping's log (0.18.0): one JSON line per decision in
 * `$PASEO_HOME/daemon-link/housekeeping.jsonl` (mode 0600), newest KEEP kept.
 * Plain words, a count and a size; every text field passes the redactor, so
 * a path or token that slipped into a reason is masked before it's written.
 * The last run of each job sits beside it in housekeeping-state.json, so the
 * hourly and daily jobs keep their pace across reloads.
 */

export const KEEP = 500;
const TRIM_AT = 600;
const MAX_LOG_BYTES = 1024 * 1024;

async function readPrivate(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("Unsafe log file");
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOG_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function writePrivate(file: string, text: string, append = false): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : constants.O_EXCL), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("Unsafe log file");
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
  } finally { await handle.close(); }
}

export type Runs = Record<HousekeepingJob, JobRun | null>;
export const NO_RUNS: Runs = { renice: null, reap: null, turbo: null, helpers: null };

export class HousekeepingLog {
  private queue: Promise<void> = Promise.resolve();
  private lines: number | null = null;

  constructor(
    private readonly file = join(stateDirectory(), "housekeeping.jsonl"),
    private readonly stateFile = join(stateDirectory(), "housekeeping-state.json"),
    private readonly print: (line: string) => void = (line) => console.log(line),
  ) {}

  append(entry: HousekeepingEntry): Promise<void> {
    const clean = HousekeepingEntrySchema.parse({ ...entry, what: redactSecrets(entry.what).slice(0, 200), why: redactSecrets(entry.why).slice(0, 300) });
    this.print(`daemon-link: housekeeping ${clean.job} ${clean.outcome}: ${clean.what}; ${clean.why}`);
    this.queue = this.queue.then(() => this.write(clean)).catch((error) => { console.error("daemon-link: housekeeping log write failed", error instanceof Error ? error.name : "unknown"); });
    return this.queue;
  }

  private async write(entry: HousekeepingEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writePrivate(this.file, `${JSON.stringify(entry)}\n`, true);
    this.lines = this.lines === null ? (await this.read()).length : this.lines + 1;
    const current = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = await current.stat().then((s) => s.size).finally(() => current.close());
    if (this.lines > TRIM_AT || size > MAX_LOG_BYTES) {
      const kept = (await this.read()).slice(-KEEP);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writePrivate(temporary, kept.map((item) => JSON.stringify(item)).join("\n") + "\n");
      await rename(temporary, this.file);
      this.lines = kept.length;
    }
  }

  private async read(): Promise<HousekeepingEntry[]> {
    let text: string;
    try { text = await readPrivate(this.file); } catch { return []; }
    const entries: HousekeepingEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const parsed = HousekeepingEntrySchema.safeParse(JSON.parse(line)); if (parsed.success) entries.push({ ...parsed.data, what: redactSecrets(parsed.data.what), why: redactSecrets(parsed.data.why) }); } catch { /* A torn line is skipped. */ }
    }
    return entries;
  }

  /** Newest first. */
  async recent(limit = 20): Promise<HousekeepingEntry[]> {
    await this.queue;
    return (await this.read()).slice(-limit).reverse();
  }

  async runs(): Promise<Runs> {
    try {
      const value = JSON.parse(await readPrivate(this.stateFile)) as Record<string, unknown>;
      const pick = (job: HousekeepingJob) => { const parsed = JobRunSchema.safeParse(value[job]); return parsed.success ? { ...parsed.data, summary: redactSecrets(parsed.data.summary) } : null; };
      return { renice: pick("renice"), reap: pick("reap"), turbo: pick("turbo"), helpers: pick("helpers") };
    } catch { return { ...NO_RUNS }; }
  }

  async saveRuns(runs: Runs): Promise<void> {
    try {
      await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
      const clean = Object.fromEntries(Object.entries(runs).map(([job, run]) => [job, run ? { ...run, summary: redactSecrets(run.summary).slice(0, 300) } : null]));
      await writePrivate(temporary, JSON.stringify(clean));
      await rename(temporary, this.stateFile);
    } catch { /* Pace is a courtesy; a failed write only means a job may run early once. */ }
  }
}
