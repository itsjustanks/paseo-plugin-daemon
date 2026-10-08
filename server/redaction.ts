import { createHash } from "node:crypto";

/** The redactor lives in shared/ (0.15.0) so the app uses the same rules; the daemon adds only argv hashing. */
export * from "../shared/redaction";

/**
 * Hash the raw argv for identity. The hash never leaves the daemon: tokens
 * carry only a keyed proof of it, and it is compared against another hash of
 * the same live process, so a plain SHA-256 is sufficient.
 */
export function hashArgv(argv: readonly string[]): string {
  const hash = createHash("sha256");
  for (const arg of argv) {
    hash.update(arg);
    hash.update("\0");
  }
  return hash.digest("hex");
}
