import { lstat, mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
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
 * `stage` (second review): "moving" before the rename (the original may still
 * be where it was), "moved" after the look inside (with `manifest`: what was
 * in it), "removing" just before rm starts. `outcome`, once known, is what
 * the report says: "left" (whole, couldn't go back), "partial" (rm removed
 * part of it), "unconfirmed" (Hosts can't tell how complete it is).
 */
export interface QuarantineEntry {
  quarantine: string; original: string; name: string; dev: number; ino: number; bytes: number; at: number;
  stage?: "moving" | "moved" | "removing";
  manifest?: { entries: number; bytes: number };
  outcome?: "left" | "partial" | "unconfirmed";
}
export interface JournalRead { entries: QuarantineEntry[]; problem: string | null }
export interface RecoveryOutcome { restored: QuarantineEntry[]; dropped: QuarantineEntry[]; left: QuarantineEntry[]; partial: QuarantineEntry[]; unconfirmed: QuarantineEntry[]; unchecked: QuarantineEntry[]; problem: string | null }
export type EntryState = "left" | "partial" | "unconfirmed" | "unchecked";
export interface JournalStatus { problem: string | null; entries: Array<QuarantineEntry & { state: EntryState }> }
export type Measure = (path: string) => Promise<{ entries: number; bytes: number } | null>;

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
    && (entry.stage === undefined || entry.stage === "moving" || entry.stage === "moved" || entry.stage === "removing")
    && (entry.outcome === undefined || entry.outcome === "left" || entry.outcome === "partial" || entry.outcome === "unconfirmed")
    && (entry.manifest === undefined || (!!entry.manifest && Number.isFinite(entry.manifest.entries) && Number.isFinite(entry.manifest.bytes)));
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

  add(entry: QuarantineEntry): Promise<void> { return this.change((entries) => [...entries.filter((item) => item.quarantine !== entry.quarantine), { stage: "moving" as const, ...entry }]); }
  /** After the look inside: set aside, untouched, with what was in it. */
  moved(quarantine: string, manifest: { entries: number; bytes: number }): Promise<void> { return this.change((entries) => entries.map((item) => (item.quarantine === quarantine ? { ...item, stage: "moved" as const, manifest } : item))); }
  /** What the report says about it, once known. */
  outcome(quarantine: string, outcome: "left" | "partial" | "unconfirmed"): Promise<void> { return this.change((entries) => entries.map((item) => (item.quarantine === quarantine ? { ...item, outcome } : item))); }
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
      // An entry without an outcome yet is a delete in progress or one recovery hasn't looked at: unconfirmed.
      entries.push({ ...entry, state: quarantine.state === "unknown" ? "unchecked" : entry.outcome ?? "unconfirmed" });
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
    const entry = status.entries.find((item) => item.quarantine === quarantine && (item.state === "partial" || item.state === "unconfirmed"));
    if (!entry) return false;
    await this.done(quarantine);
    return true;
  }

  /**
   * On load: an entry whose quarantine is gone is forgotten (rm finished);
   * one whose item can go back without replacing anything is put back; the
   * rest stay listed, untouched. A damaged journal is reported, not acted on.
   */
  /**
   * On load. Only ENOENT is "gone"; any other error keeps the entry
   * (unchecked, blocks deletes). Then, by stage:
   *  - "moving": the original is still there and the quarantine is empty or
   *    gone: nothing happened, the entry is dropped. Otherwise the item was
   *    moved but never counted: unconfirmed, left set aside.
   *  - "moved" / "removing": counted again; exactly the manifest means
   *    untouched, so it goes back whole (never replacing anything; a conflict
   *    leaves it whole, set aside). Anything else: "removing" was partly
   *    removed, "moved" changed while set aside (unconfirmed).
   * Nothing is ever said to be restored unless it went back whole.
   */
  async recover(measure: Measure): Promise<RecoveryOutcome> {
    const outcome: RecoveryOutcome = { restored: [], dropped: [], left: [], partial: [], unconfirmed: [], unchecked: [], problem: null };
    const read = await this.inspect();
    if (read.problem) return { ...outcome, problem: read.problem };
    const settle = async (entry: QuarantineEntry, state: "left" | "partial" | "unconfirmed") => {
      if (entry.outcome !== state) await this.outcome(entry.quarantine, state).catch(() => undefined);
      outcome[state].push(entry);
    };
    for (const entry of read.entries) {
      const quarantine = await look(entry.quarantine);
      if (quarantine.state === "absent") { await this.done(entry.quarantine).catch(() => undefined); continue; }
      if (quarantine.state === "unknown") { outcome.unchecked.push(entry); continue; }
      const moved = join(entry.quarantine, entry.name);
      const item = await look(moved);
      if (item.state === "unknown") { outcome.unchecked.push(entry); continue; }
      if (entry.stage === "moving") {
        const original = await look(entry.original);
        const empty = item.state === "absent" && (await readdir(entry.quarantine).catch(() => null))?.length === 0;
        if (original.state === "present" && empty) {
          await rmdir(entry.quarantine).catch(() => undefined);
          await this.done(entry.quarantine).catch(() => undefined);
          outcome.dropped.push(entry);
          continue;
        }
        await settle(entry, "unconfirmed");
        continue;
      }
      if (entry.outcome === "partial") { outcome.partial.push(entry); continue; }
      if (item.state !== "present" || !item.isDir || item.isLink || !quarantine.isDir || quarantine.isLink || !entry.manifest) { await settle(entry, entry.stage === "removing" ? "partial" : "unconfirmed"); continue; }
      const now = await measure(moved).catch(() => null);
      if (!now) { await settle(entry, "unconfirmed"); continue; }
      if (now.entries === entry.manifest.entries && now.bytes === entry.manifest.bytes) {
        const result = await moveNoReplace(moved, entry.original, item.ino);
        if (result === "moved") {
          await rmdir(entry.quarantine).catch(() => undefined);
          await this.done(entry.quarantine).catch(() => undefined);
          outcome.restored.push(entry);
          continue;
        }
        await settle(entry, "left");
        continue;
      }
      await settle(entry, entry.stage === "removing" ? "partial" : "unconfirmed");
    }
    outcome.problem = outcome.unchecked.length ? UNCHECKED_PROBLEM : null;
    return outcome;
  }
}
