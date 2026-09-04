import { createHash } from "node:crypto";

/**
 * Redaction happens before anything leaves the daemon. The raw argv is hashed
 * for process identity and then discarded; what crosses the RPC is a bounded
 * display string with secret-looking values removed.
 */

export const DISPLAY_COMMAND_MAX = 240;
const REDACTED = "[redacted]";

/** Flag or env names whose *value* must never be shown. Matched case-insensitively. */
const SECRET_NAME = /(token|secret|passw(or)?d|passphrase|auth|cookie|credential|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|session|signature|\bkey\b|_key$|-key$)/i;

/** Values that look like credentials regardless of the flag they follow. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\b(sk|pk|rk|ak)[-_](live|test|proj|ant|api)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(-----END[ A-Z]*PRIVATE KEY-----|$)/g,
];

/** `scheme://user:pass@host` → `scheme://[redacted]@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+)(:[^/\s@]*)?@/gi;

/**
 * Hash the raw argv for identity. The hash is keyed by nothing: it is only
 * ever compared against another hash of the same live process and never
 * leaves the daemon, so a plain SHA-256 is sufficient.
 */
export function hashArgv(argv: readonly string[]): string {
  const hash = createHash("sha256");
  for (const arg of argv) {
    hash.update(arg);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function redactValue(token: string): string {
  let out = token.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Redact a single argv token. Handles `--flag=value`, `NAME=value` env-style
 * prefixes, and bare values that match known credential formats.
 */
export function redactArg(arg: string): string {
  const eq = arg.indexOf("=");
  if (eq > 0) {
    const name = arg.slice(0, eq);
    const bare = name.replace(/^-+/, "");
    if (SECRET_NAME.test(bare)) return `${name}=${REDACTED}`;
    return `${name}=${redactValue(arg.slice(eq + 1))}`;
  }
  return redactValue(arg);
}

/**
 * Render argv for display. A flag whose name looks secret redacts the *next*
 * token too (`--token abc` → `--token [redacted]`). Home paths collapse to `~`.
 */
export function redactArgv(argv: readonly string[], home: string): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const raw of argv) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }
    const arg = homeRelative(raw, home);
    const isFlag = arg.startsWith("-");
    if (isFlag && !arg.includes("=") && SECRET_NAME.test(arg.replace(/^-+/, ""))) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(redactArg(arg));
  }
  return out;
}

export function homeRelative(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  // Also catch a home path embedded after `=` or similar (e.g. --root=/home/u/x),
  // but only at a path boundary so `/home/alicex` is left alone.
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return path.replace(new RegExp(`${escaped}(?=/|$|[\\s"'])`, "g"), "~");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Bounded, redacted, home-relative display command. */
export function displayCommand(argv: readonly string[], home: string): string {
  const joined = redactArgv(argv, home)
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(joined, DISPLAY_COMMAND_MAX);
}

/** A short, safe process name from argv[0] or the kernel comm. */
export function displayName(argv: readonly string[], comm: string): string {
  const first = argv[0] ?? "";
  const base = first.split("/").pop() ?? "";
  const candidate = base && !base.startsWith("-") ? base : comm;
  return truncate(redactValue(candidate) || "unknown", 64);
}
