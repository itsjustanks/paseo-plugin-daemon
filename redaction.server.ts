import { createHash } from "node:crypto";

/**
 * Redaction happens before anything leaves the daemon. The raw argv is hashed
 * for process identity and then discarded; what crosses the RPC is a bounded
 * display string with secret-looking values removed.
 *
 * Strategy, most specific first: known context (flag names, env names, URL
 * userinfo/query parameters, JSON properties, HTTP headers, executable-aware
 * short flags) and then well-known credential formats. There is deliberately
 * no generic "high entropy" guess: it would eat commit SHAs, file hashes, and
 * UUIDs, which are exactly what a developer needs to see.
 */

export const DISPLAY_COMMAND_MAX = 240;
const REDACTED = "[redacted]";

/**
 * Flag, env, query-parameter, header, or JSON-property names whose *value*
 * must never be shown. Matched case-insensitively against the bare name.
 */
const SECRET_NAME =
  /(token|secret|passw(or)?d|passphrase|(^|[_-])pass($|[_-])|(^|[_-])pwd$|auth|cookie|credential|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|session|signature|(^|[_-])sig$|\bkey\b|_key$|-key$|(^|[_-])dsn$|connection[-_]?string|database[-_]?ur[il])/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Values that look like credentials regardless of the flag they follow. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\b(sk|pk|rk|ak)[-_](live|test|proj|ant|api)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}\b/g, // HashiCorp Vault
  /\bdop_v1_[a-f0-9]{40,}\b/g, // DigitalOcean
  /\bpypi-AgEI[A-Za-z0-9_-]{20,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, // SendGrid
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(-----END[ A-Z]*PRIVATE KEY-----|$)/g,
];

/** `scheme://user:pass@host` → `scheme://[redacted]@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+)(:[^/\s@]*)?@/gi;

/** `?a=1&api_key=x` — any position in the query string. */
const URL_QUERY_PARAM = /([?&])([^=&\s#]+)=([^&\s#]*)/g;

/** `dbname=app password=x`, `a=1;token=x` — key=value pairs inside one token. */
const INLINE_ASSIGNMENT = /(^|[\s;,])([A-Za-z_][A-Za-z0-9_.-]*)=([^\s;,]+)/g;

/** `"password": "x"` / `"token":123` inside JSON carried in argv. */
const JSON_PROPERTY = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/g;

/** `Header-Name: value` as passed to `-H`. */
const HTTP_HEADER = /^([A-Za-z][A-Za-z0-9-]*):\s+(\S.*)$/s;

/**
 * Executable-aware short flags whose meaning is only secret for that tool.
 * `flags` take their value as the next token; `attached` also accept it glued
 * on (`-pSECRET`). Wrappers such as `sudo`/`env` are skipped to find the tool.
 */
interface ExecutableRule {
  exe: RegExp;
  when?: (argv: readonly string[]) => boolean;
  flags: readonly string[];
  attached: readonly string[];
}

const EXECUTABLE_RULES: readonly ExecutableRule[] = [
  { exe: /^curl$/, flags: ["-u", "-U", "--user", "--proxy-user", "--oauth2-bearer", "--tlspassword", "--proxy-tlspassword"], attached: ["-u", "-U"] },
  { exe: /^redis-cli$/, flags: ["-a", "--pass"], attached: [] },
  // mysql's bare `-p` means "prompt", so only the attached form carries a secret.
  { exe: /^(mysql|mariadb|mysqldump|mariadb-dump|mysqladmin|mysqlcheck|mysqlimport|mysqlsh)$/, flags: [], attached: ["-p"] },
  { exe: /^(mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)$/, flags: ["-p"], attached: ["-p"] },
  { exe: /^sshpass$/, flags: ["-p"], attached: ["-p"] },
  { exe: /^openssl$/, flags: ["-pass", "-passin", "-passout", "-k", "-K", "-kfile"], attached: [] },
  { exe: /^sqlcmd$/, flags: ["-P"], attached: ["-P"] },
  { exe: /^ldap(search|modify|add|delete|passwd|whoami)$/, flags: ["-w"], attached: ["-w"] },
  { exe: /^smbclient$/, flags: ["-U", "--user"], attached: ["-U"] },
  { exe: /^docker$/, when: (argv) => argv.includes("login"), flags: ["-p"], attached: [] },
];

function baseName(path: string): string {
  return path.split("/").pop() ?? "";
}

/**
 * The first known tool named in the leading tokens. Looking past argv[0]
 * handles wrappers (`sudo -u root mysql -pX`, `env FOO=1 redis-cli -a X`);
 * a false match only ever redacts more, never less.
 */
const EXECUTABLE_LOOKAHEAD = 6;

function ruleFor(argv: readonly string[]): ExecutableRule | null {
  for (const arg of argv.slice(0, EXECUTABLE_LOOKAHEAD)) {
    const exe = baseName(arg);
    const rule = EXECUTABLE_RULES.find((candidate) => candidate.exe.test(exe));
    if (rule) return rule.when === undefined || rule.when(argv) ? rule : null;
  }
  return null;
}

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

function redactValue(token: string): string {
  const header = HTTP_HEADER.exec(token);
  if (header && isSecretName(header[1]!)) return `${header[1]}: ${REDACTED}`;
  let out = token.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(URL_QUERY_PARAM, (whole, sep: string, name: string) => (isSecretName(name) ? `${sep}${name}=${REDACTED}` : whole));
  out = out.replace(INLINE_ASSIGNMENT, (whole, sep: string, name: string) => (isSecretName(name) ? `${sep}${name}=${REDACTED}` : whole));
  out = out.replace(JSON_PROPERTY, (whole, key: string, colon: string) => (isSecretName(key) ? `"${key}"${colon}"${REDACTED}"` : whole));
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** `--flag`, `-f`, or `ENV_NAME` in front of an `=`; anything else is a value. */
const FLAG_OR_ENV_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Redact a single argv token. Handles `--flag=value` and `NAME=value`
 * env-style prefixes; everything else (URLs, headers, JSON, conninfo
 * strings) is scanned whole so an embedded `=` cannot hide a credential.
 */
export function redactArg(arg: string): string {
  const eq = arg.indexOf("=");
  if (eq > 0) {
    const name = arg.slice(0, eq);
    if (FLAG_OR_ENV_NAME.test(name)) {
      if (isSecretName(name.replace(/^-+/, ""))) return `${name}=${REDACTED}`;
      return `${name}=${redactValue(arg.slice(eq + 1))}`;
    }
  }
  return redactValue(arg);
}

export interface RedactOptions {
  /**
   * argv came from a space-joined command line (macOS `ps`), so a quoted
   * secret may have been split into several tokens. After a known secret flag
   * everything up to the next flag is redacted, not just one token.
   */
  lossy?: boolean;
}

/**
 * Render argv for display. A flag whose name looks secret redacts the *next*
 * token too (`--token abc` → `--token [redacted]`). Home paths collapse to `~`.
 */
export function redactArgv(argv: readonly string[], home: string, options: RedactOptions = {}): string[] {
  const rule = ruleFor(argv);
  const out: string[] = [];
  let redactNext = false;
  /** Lossy mode: keep swallowing non-flag tokens after a redacted value. */
  let swallowing = false;
  for (const raw of argv) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      swallowing = options.lossy === true;
      continue;
    }
    const arg = homeRelative(raw, home);
    const isFlag = arg.startsWith("-");
    if (swallowing) {
      if (!isFlag) continue;
      swallowing = false;
    }
    const bare = arg.replace(/^-+/, "");
    if (isFlag && !arg.includes("=") && (isSecretName(bare) || rule?.flags.includes(arg))) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    const attached = rule?.attached.find((prefix) => arg.startsWith(prefix) && arg.length > prefix.length && !arg.includes("="));
    if (attached !== undefined) {
      out.push(`${attached}${REDACTED}`);
      swallowing = options.lossy === true;
      continue;
    }
    const redacted = redactArg(arg);
    out.push(redacted);
    if (options.lossy && arg.includes("=") && redacted.endsWith(`=${REDACTED}`)) swallowing = true;
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
export function displayCommand(argv: readonly string[], home: string, options: RedactOptions = {}): string {
  const joined = redactArgv(argv, home, options)
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
