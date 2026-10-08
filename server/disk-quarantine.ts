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

/**
 * `stage` (0.16.0 review fix): "moved" once the item is set aside, "removing"
 * just before rm starts. A "removing" entry (or one without a stage) is never
 * put back as if whole: part of it may already be gone.
 */
export interface QuarantineEntry { quarantine: string; original: string; name: string; dev: number; ino: number; bytes: number; at: number; stage?: "moved" | "removing" }
export interface JournalRead { entries: QuarantineEntry[]; problem: string | null }
export interface RecoveryOutcome { restored: QuarantineEntry[]; left: QuarantineEntry[]; partial: QuarantineEntry[]; unchecked: QuarantineEntry[]; problem: string | null }
/** What the report shows for each entry: left (couldn't go back), partial (an interrupted delete removed part of it), unchecked (couldn't be looked at). */
export type EntryState = "left" | "partial" | "unchecked";
export interface JournalStatus { problem: string | null; entries: Array<QuarantineEntry & { state: EntryState }> }

export const JOURNAL_PROBLEM = "Hosts' record of interrupted deletes couldn't be read, so it isn't sure what was set aside. Nothing is deleted until it's checked.";
export const UNCHECKED_PROBLEM = "Hosts couldn't check a leftover from an interrupted delete, so nothing is deleted until it can.";

/** Only "no such file" means absent; any other error (EACCES, EIO…) means Hosts can't tell. */
async function look(path: string): Promise<{ state: "present"; isDir: boolean; isLink: boolean; ino: number } | { state: "absent" } | { state: "unknown" }> {
  try {
    const st = await lstat(path);
    return { state: "present", isDir: st.isDirectory(), isLink: st.isSymbolicLink(), ino: st.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unknown" };
  }
}

const isEntry = (value: unknown): value is QuarantineEntry => {
  const entry = value as QuarantineEntry;
  return !!entry && typeof entry === "object"
    && typeof entry.quarantine === "string" && entry.quarantine.startsWith("/")
    && typeof entry.original === "string" && entry.original.startsWith("/")
    && typeof entry.name === "string" && entry.name.length > 0 && !entry.name.includes("/")
    && Number.isFinite(entry.dev) && Number.isFinite(entry.ino) && Number.isFinite(entry.bytes) && Number.isFinite(entry.at)
    && (entry.stage === undefined || entry.stage === "moved" || entry.stage === "removing");
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

  add(entry: QuarantineEntry): Promise<void> { return this.change((entries) => [...entries.filter((item) => item.quarantine !== entry.quarantine), { stage: "moved" as const, ...entry }]); }
  done(quarantine: string): Promise<void> { return this.change((entries) => entries.filter((item) => item.quarantine !== quarantine)); }
  /** Recorded just before rm starts: from here on the item is never put back as if whole. */
  removing(quarantine: string): Promise<void> { return this.change((entries) => entries.map((item) => (item.quarantine === quarantine ? { ...item, stage: "removing" as const } : item))); }

  /** Each entry and what the report says about it; read-only. Entries whose quarantine is verifiably gone are left out. */
  async status(): Promise<JournalStatus> {
    const read = await this.inspect();
    if (read.problem) return { problem: read.problem, entries: [] };
    const entries: JournalStatus["entries"] = [];
    for (const entry of read.entries) {
      const quarantine = await look(entry.quarantine);
      if (quarantine.state === "absent") continue;
      entries.push({ ...entry, state: quarantine.state === "unknown" ? "unchecked" : entry.stage === "moved" ? "left" : "partial" });
    }
    return { problem: entries.some((entry) => entry.state === "unchecked") ? UNCHECKED_PROBLEM : null, entries };
  }

  /** Why no delete may run now (a damaged journal, or a leftover Hosts can't check), or null. */
  async blocker(): Promise<string | null> {
    return (await this.status().catch(() => ({ problem: JOURNAL_PROBLEM, entries: [] }))).problem;
  }

  /** The person read "an interrupted delete removed part of…" and dismissed it: only then is that record dropped. */
  async dismiss(quarantine: string): Promise<boolean> {
    const status = await this.status();
    const entry = status.entries.find((item) => item.quarantine === quarantine && item.state === "partial");
    if (!entry) return false;
    await this.done(quarantine);
    return true;
  }

  /**
   * On load: an entry whose quarantine is gone is forgotten (rm finished);
   * one whose item can go back without replacing anything is put back; the
   * rest stay listed, untouched. A damaged journal is reported, not acted on.
   */
  async recover(): Promise<RecoveryOutcome> {
    const outcome: RecoveryOutcome = { restored: [], left: [], partial: [], unchecked: [], problem: null };
    const read = await this.inspect();
    if (read.problem) return { ...outcome, problem: read.problem };
    for (const entry of read.entries) {
      const quarantine = await look(entry.quarantine);
      // Only ENOENT is "gone" (rm finished); any other error keeps the entry and blocks deletes.
      if (quarantine.state === "absent") { await this.done(entry.quarantine).catch(() => undefined); continue; }
      if (quarantine.state === "unknown") { outcome.unchecked.push(entry); continue; }
      // rm had started: part of it may be gone, so it's never put back as if whole. It stays listed until dismissed.
      if (entry.stage !== "moved") { outcome.partial.push(entry); continue; }
      const moved = join(entry.quarantine, entry.name);
      const item = await look(moved);
      if (item.state === "unknown") { outcome.unchecked.push(entry); continue; }
      if (item.state === "present" && item.isDir && !item.isLink && item.ino === entry.ino && quarantine.isDir && !quarantine.isLink) {
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
    outcome.problem = outcome.unchecked.length ? UNCHECKED_PROBLEM : null;
    return outcome;
  }
}
