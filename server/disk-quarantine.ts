import { lstat, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QuarantineEntry } from "./disk-remove";

/**
 * Every quarantine Hosts makes (0.14.0, third pass), kept in
 * `$PASEO_HOME/daemon-link/quarantine.json` (mode 600). An entry is written
 * before the item is moved aside and removed only once the quarantine is gone
 * (rm finished) or the item was put back. If Hosts stops in between (a crash,
 * an unload mid-delete), the next load puts the item back when its original
 * place is still free; otherwise it stays listed as "Left over from an
 * interrupted clear", with its size and Ask an agent. Hosts never deletes a
 * quarantine by itself.
 */

export interface RecoveryOutcome { restored: QuarantineEntry[]; left: QuarantineEntry[] }

const isEntry = (value: unknown): value is QuarantineEntry => {
  const entry = value as QuarantineEntry;
  return !!entry && typeof entry.quarantine === "string" && entry.quarantine.startsWith("/") && typeof entry.original === "string" && entry.original.startsWith("/") && typeof entry.name === "string" && !entry.name.includes("/");
};

export class QuarantineInventory {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<QuarantineEntry[]> {
    await this.queue.catch(() => undefined);
    return this.read();
  }

  private async read(): Promise<QuarantineEntry[]> {
    try { const parsed: unknown = JSON.parse(await readFile(this.file, "utf8")); return Array.isArray(parsed) ? parsed.filter(isEntry) : []; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error; // unreadable inventory: callers fail closed
    }
  }

  private change(edit: (entries: QuarantineEntry[]) => QuarantineEntry[]): Promise<void> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const entries = edit(await this.read());
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.queue = next;
    return next;
  }

  add(entry: QuarantineEntry): Promise<void> { return this.change((entries) => [...entries.filter((item) => item.quarantine !== entry.quarantine), entry]); }
  done(quarantine: string): Promise<void> { return this.change((entries) => entries.filter((item) => item.quarantine !== quarantine)); }

  /**
   * On load: an entry whose quarantine is gone is forgotten (rm finished);
   * one whose item can go back to a free original place is put back; the rest
   * stay listed, untouched.
   */
  async recover(): Promise<RecoveryOutcome> {
    const outcome: RecoveryOutcome = { restored: [], left: [] };
    let entries: QuarantineEntry[];
    try { entries = await this.list(); } catch { return outcome; }
    for (const entry of entries) {
      const quarantine = await lstat(entry.quarantine).catch(() => null);
      if (!quarantine) { await this.done(entry.quarantine).catch(() => undefined); continue; }
      const moved = join(entry.quarantine, entry.name);
      const item = await lstat(moved).catch(() => null);
      const originalFree = !(await lstat(entry.original).catch(() => null));
      if (item && !item.isSymbolicLink() && item.isDirectory() && quarantine.isDirectory() && !quarantine.isSymbolicLink() && originalFree) {
        try {
          await rename(moved, entry.original);
          await rmdir(entry.quarantine).catch(() => undefined);
          await this.done(entry.quarantine);
          outcome.restored.push(entry);
          continue;
        } catch { /* Fall through: left as it is. */ }
      }
      outcome.left.push(entry);
    }
    return outcome;
  }
}
