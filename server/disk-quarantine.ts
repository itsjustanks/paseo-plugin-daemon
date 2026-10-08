import { lstat, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Every quarantine Hosts makes, kept in `$PASEO_HOME/daemon-link/quarantine.json`
 * (mode 600). Ported from the reviewed 0.14 cleanup branch; 0.16.0 review fixes:
 *
 *  - An entry is written before the item is moved aside and removed only once
 *    the quarantine is gone (rm finished) or the item was put back.
 *  - A journal that can't be read, isn't JSON, or holds an entry Hosts doesn't
 *    understand is never treated as empty: it's reported ("Left over from an
 *    interrupted clear: check"), Hosts doesn't rewrite it, and no clear runs
 *    until it's fixed.
 *  - Putting an item back never replaces anything (`moveNoReplace`). On a
 *    conflict it stays in its quarantine, listed as left over.
 *  - Hosts never deletes a quarantine by itself after a crash.
 */

export interface QuarantineEntry { quarantine: string; original: string; name: string; dev: number; ino: number; bytes: number; at: number }
export interface JournalRead { entries: QuarantineEntry[]; problem: string | null }
export interface RecoveryOutcome { restored: QuarantineEntry[]; left: QuarantineEntry[]; problem: string | null }

export const JOURNAL_PROBLEM = "Hosts' record of interrupted clears couldn't be read, so it isn't sure what was set aside. Nothing is cleared until it's checked.";

const isEntry = (value: unknown): value is QuarantineEntry => {
  const entry = value as QuarantineEntry;
  return !!entry && typeof entry === "object"
    && typeof entry.quarantine === "string" && entry.quarantine.startsWith("/")
    && typeof entry.original === "string" && entry.original.startsWith("/")
    && typeof entry.name === "string" && entry.name.length > 0 && !entry.name.includes("/")
    && Number.isFinite(entry.dev) && Number.isFinite(entry.ino) && Number.isFinite(entry.bytes) && Number.isFinite(entry.at);
};

/**
 * Move `from` to `to` without ever replacing what's at `to`: create `to` as a
 * fresh empty folder (fails if anything is there), rename onto that folder
 * (the only thing a directory rename can replace is an empty folder, and this
 * one is Hosts' own), then check `to` is the expected inode. "conflict" when
 * something is already there or appeared meanwhile; nothing is replaced.
 */
export async function moveNoReplace(from: string, to: string, ino: number): Promise<"moved" | "conflict" | "failed"> {
  try { await mkdir(to, { mode: 0o700 }); } catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST" ? "conflict" : "failed"; }
  const placeholder = await lstat(to).catch(() => null);
  try { await rename(from, to); }
  catch (error) {
    // Ours only if it's still the empty folder we just made: remove it then, never otherwise.
    const now = await lstat(to).catch(() => null);
    if (placeholder && now && now.ino === placeholder.ino) await rmdir(to).catch(() => undefined);
    return ["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "") ? "conflict" : "failed";
  }
  const moved = await lstat(to).catch(() => null);
  return moved && moved.ino === ino && moved.isDirectory() && !moved.isSymbolicLink() ? "moved" : "failed";
}

export class QuarantineInventory {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** The entries and, when the journal is damaged, why (callers then refuse to clear). */
  async inspect(): Promise<JournalRead> {
    await this.queue.catch(() => undefined);
    return this.read();
  }

  /** The entries; throws when the journal is damaged, so callers fail closed. */
  async list(): Promise<QuarantineEntry[]> {
    const read = await this.inspect();
    if (read.problem) throw new Error(read.problem);
    return read.entries;
  }

  private async read(): Promise<JournalRead> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { entries: [], problem: null } : { entries: [], problem: JOURNAL_PROBLEM }; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { entries: [], problem: JOURNAL_PROBLEM }; }
    if (!Array.isArray(parsed)) return { entries: [], problem: JOURNAL_PROBLEM };
    const entries = parsed.filter(isEntry);
    return { entries, problem: entries.length === parsed.length ? null : JOURNAL_PROBLEM };
  }

  private change(edit: (entries: QuarantineEntry[]) => QuarantineEntry[]): Promise<void> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const read = await this.read();
      // A damaged journal is never overwritten: what it held could be lost.
      if (read.problem) throw new Error(read.problem);
      const entries = edit(read.entries);
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
   * one whose item can go back without replacing anything is put back; the
   * rest stay listed, untouched. A damaged journal is reported, not acted on.
   */
  async recover(): Promise<RecoveryOutcome> {
    const outcome: RecoveryOutcome = { restored: [], left: [], problem: null };
    const read = await this.inspect();
    if (read.problem) return { ...outcome, problem: read.problem };
    for (const entry of read.entries) {
      const quarantine = await lstat(entry.quarantine).catch(() => null);
      if (!quarantine) { await this.done(entry.quarantine).catch(() => undefined); continue; }
      const moved = join(entry.quarantine, entry.name);
      const item = await lstat(moved).catch(() => null);
      if (item && !item.isSymbolicLink() && item.isDirectory() && item.ino === entry.ino && quarantine.isDirectory() && !quarantine.isSymbolicLink()) {
        const result = await moveNoReplace(moved, entry.original, entry.ino);
        if (result === "moved") {
          await rmdir(entry.quarantine).catch(() => undefined);
          await this.done(entry.quarantine).catch(() => undefined);
          outcome.restored.push(entry);
          continue;
        }
      }
      outcome.left.push(entry);
    }
    return outcome;
  }
}
