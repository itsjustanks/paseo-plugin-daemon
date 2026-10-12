import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RECOVERY_PROFILE_MAX, RecoveryProfileSchema, RecoverySaveSchema, type RecoveryProfile, type RecoverySave } from "../../shared/recovery";

const Document = z.object({ schemaVersion: z.literal(1), profiles: z.array(RecoveryProfileSchema).max(RECOVERY_PROFILE_MAX) }).strict();
const fail = () => new Error("Recovery storage is unavailable. Check owner-only permissions and remove symlinks from its path on this runner.");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
/** Refuse symlinks in every existing path component, including the destination. */
function noLinks(path: string): void {
  let part = parse(path).root;
  for (const name of path.slice(part.length).split("/").filter(Boolean)) {
    part = join(part, name);
    try { if (lstatSync(part).isSymbolicLink()) throw fail(); } catch (e) { if (!missing(e)) throw e; }
  }
}
function owned(stat: Stats, directory = false): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) throw fail();
}

/** Synchronous, small atomic transactions: no target IO and no async lost-update window. */
export class RecoveryStore {
  readonly directory: string;
  readonly file: string;
  constructor(directory: string) { this.directory = resolve(directory); this.file = join(this.directory, "profiles.json"); }
  list(): RecoveryProfile[] {
    try {
      noLinks(this.file);
      const directory = lstatSync(this.directory); owned(directory, true);
      if ((directory.mode & 0o777) !== 0o700) throw fail();
      owned(lstatSync(this.file)); // Reject special files before opening; recheck the opened descriptor below.
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd); owned(stat);
        if ((stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) throw fail();
        const doc = Document.parse(JSON.parse(readFileSync(fd, "utf8")));
        if (new Set(doc.profiles.map(p => p.id)).size !== doc.profiles.length) throw fail();
        return doc.profiles;
      } finally { closeSync(fd); }
    } catch (e) { if (missing(e)) return []; throw fail(); }
  }
  get(id: string, revision: number): RecoveryProfile {
    const profile = this.list().find(p => p.id === id);
    if (!profile || profile.revision !== revision) throw new Error("The saved connection changed. Refresh it and review again.");
    return profile;
  }
  save(value: RecoverySave): RecoveryProfile {
    const parsed = RecoverySaveSchema.safeParse(value);
    if (!parsed.success) throw new Error("Check the connection fields. Passwords, private keys and command text are not accepted.");
    const input = parsed.data, profiles = this.list();
    const old = input.id ? this.get(input.id, input.expectedRevision) : undefined;
    if (!old && input.expectedRevision !== 0) throw new Error("The saved connection changed. Refresh it and review again.");
    if (!old && profiles.length >= RECOVERY_PROFILE_MAX) throw new Error("Save up to 20 recovery connections on this runner.");
    const profile = { ...input.details, id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1 };
    this.write([...profiles.filter(p => p.id !== profile.id), profile]);
    return profile;
  }
  remove(id: string, revision: number): void { this.get(id, revision); this.write(this.list().filter(p => p.id !== id)); }
  private write(profiles: RecoveryProfile[]): void {
    const temp = join(this.directory, `.profiles-${randomUUID()}.tmp`);
    try {
      noLinks(this.file);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      noLinks(this.file);
      const directory = lstatSync(this.directory); owned(directory, true);
      if ((directory.mode & 0o777) !== 0o700) throw fail();
      // Recheck the destination immediately before replacing it. Rename never follows it.
      try { owned(lstatSync(this.file)); } catch (e) { if (!missing(e)) throw e; }
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify({ schemaVersion: 1, profiles }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      noLinks(this.file); renameSync(temp, this.file);
    } catch { throw fail(); }
    finally { try { unlinkSync(temp); } catch { /* Absent after rename. */ } }
  }
}
