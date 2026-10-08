/**
 * The one redactor (0.15.0: shared, so the app uses the same rules for
 * toasts, dialogs, previews and copied text). Pure: no Node modules.
 *
 * Redaction happens before anything leaves the daemon. The raw argv is hashed
 * for process identity and then discarded; what crosses the RPC is a bounded
 * display string with secret-looking values removed.
 *
 * Strategy, most specific first: known context (flag names, env names, URL
 * userinfo/query parameters, JSON properties, HTTP headers, executable-aware
 * short flags) and then well-known credential formats. There is deliberately
 * no generic "high entropy" guess in process commands: it would eat commit
 * SHAs, file hashes, and UUIDs, which are exactly what a developer needs to
 * see in the Processes list. Free text (messages, toasts, dialogs, agent
 * messages, terminal output, copied text) also hides long hex and mixed-case
 * base64 runs (`redactLongTokens`), keeping a commit named as one.
 */

export const DISPLAY_COMMAND_MAX = 240;
const REDACTED = "[redacted]";

/**
 * Flag, env, query-parameter, header, or JSON-property names whose *value*
 * must never be shown. Matched on whole name parts (0.15.0 review fix), so
 * `token`, `GITHUB_TOKEN`, `x-api-key`, `apiKey`, `client_secret`,
 * `PGPASSWORD` and `Authorization` are secret while `tokenizer`, `author`,
 * `monkey`, `keyboard` and `max_tokens` stay visible. A name is secret when
 *  - squeezed of separators, it ends in password, passwd, passphrase, secret,
 *    token, apikey or credential(s) (GITHUB_TOKEN, PGPASSWORD, x-auth-token); or
 *  - its last part (split on _ - . and camelCase) is auth, authorization,
 *    bearer, cookie, session, signature, sig, dsn, key, pass or pwd
 *    (api_key, SIGNING_KEY, REDIS_PASS, SENTRY_DSN); or
 *  - it names a connection string or database URL.
 */
const SECRET_SUFFIX = /(password|passwd|passphrase|secret|token|apikey|credentials?)$/i;
const SECRET_LAST_PART = new Set(["auth", "authorization", "bearer", "cookie", "session", "signature", "sig", "dsn", "key", "pass", "pwd"]);
const SECRET_SPECIAL = /(database[_-]?ur[il]|connection[_-]?string)$/i;

export function isSecretName(name: string): boolean {
  const bare = name.replace(/^-+/, "").replace(/^["']|["']$/g, "").trim();
  if (!bare) return false;
  if (SECRET_SUFFIX.test(bare.replace(/[_\-.\s]/g, "")) || SECRET_SPECIAL.test(bare)) return true;
  const parts = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).filter(Boolean);
  return SECRET_LAST_PART.has((parts[parts.length - 1] ?? "").toLowerCase());
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
 * on (`-pSECRET`). Both also accept `flag=value`. Wrappers such as `sudo`/`env`
 * are skipped to find the tool.
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

/** `--user=x` / `-u=x` for a flag the tool treats as secret; the flag spelling is kept. */
function equalsFlagFor(rule: ExecutableRule, arg: string): string | null {
  const eq = arg.indexOf("=");
  if (eq <= 0 || !arg.startsWith("-")) return null;
  const flag = arg.slice(0, eq);
  return rule.flags.includes(flag) || rule.attached.includes(flag) ? flag : null;
}

function ruleFor(argv: readonly string[]): ExecutableRule | null {
  for (const arg of argv.slice(0, EXECUTABLE_LOOKAHEAD)) {
    const exe = baseName(arg);
    const rule = EXECUTABLE_RULES.find((candidate) => candidate.exe.test(exe));
    if (rule) return rule.when === undefined || rule.when(argv) ? rule : null;
  }
  return null;
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
    // Executable context runs first. It must win over the generic checks below:
    // `curl --user=a:x` would otherwise reach redactArg, where `user` is not a
    // secret name, and `mysql -pMySecretPw` would be mistaken for a flag *named*
    // "secret" and echoed verbatim.
    const equalsFlag = rule ? equalsFlagFor(rule, arg) : null;
    if (equalsFlag !== null) {
      out.push(`${equalsFlag}=${REDACTED}`);
      swallowing = options.lossy === true;
      continue;
    }
    // An attached value may itself contain `=` (`mysql -pS3cr3t=x`); it is still the whole secret.
    const attached = rule?.attached.find((prefix) => arg.startsWith(prefix) && arg.length > prefix.length);
    if (attached !== undefined) {
      out.push(`${attached}${REDACTED}`);
      swallowing = options.lossy === true;
      continue;
    }
    const bare = arg.replace(/^-+/, "");
    if (isFlag && !arg.includes("=") && (isSecretName(bare) || rule?.flags.includes(arg))) {
      out.push(arg);
      redactNext = true;
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

/**
 * Redact free text, such as a dev server's terminal output, line by line
 * (0.12.0). Each line is treated like a command line (`--token x`,
 * `API_KEY=x`) and then scanned whole for URLs with credentials, secret query
 * parameters, JSON properties, headers and known credential formats. Home
 * paths collapse to `~`.
 */
export function redactText(lines: readonly string[], home: string): string[] {
  return lines.map((line) => {
    const words = redactArgv(redactSpans(line).split(" "), home);
    return redactLongTokens(redactValue(homeRelative(words.join(" "), home)));
  });
}

/**
 * Whole spans in one line of text, before it's split into words (0.15.0
 * review fix): a quoted value is masked to its closing quote (or the end of
 * the line), so `password="correct horse battery staple"` hides all four
 * words; an `Authorization:` header with any scheme, any case and any
 * length is masked; and so is a quoted value after a secret flag
 * (`--password "a b"`, `--token='x y'`).
 */
export function redactSpans(line: string): string {
  return line
    .replace(/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*)("[^"\n]*"?|'[^'\n]*'?|[^\n"']*)/gi, (_match, name: string, sep: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${name}${sep}${quote}${REDACTED}${quote && value.length > 1 && value.endsWith(quote) ? quote : ""}`;
    })
    .replace(/(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)(["'])((?:\\.|(?!\4)[^\\\n])*)(\4|$)/g, (match, q1: string, name: string, sep: string, q: string, _value: string, end: string) =>
      (isSecretName(name) ? `${q1}${name}${q1}${sep}${q}${REDACTED}${end}` : match))
    .replace(/(^|\s)(--?[A-Za-z][\w.-]*)(\s+|=)(["'])((?:\\.|(?!\4)[^\\\n])*)(\4|$)/g, (match, lead: string, flag: string, sep: string, q: string, _value: string, end: string) =>
      (isSecretName(flag) ? `${lead}${flag}${sep}${q}${REDACTED}${end}` : match));
}

/**
 * Long secret-shaped runs in free text: 32+ hex characters (unless named as a
 * commit: `--ref …`, `#…`, `@…`, `/commit/…`, `/tree/…`, "commit …"), and
 * 32+ characters of base64 or base64url mixing upper case, lower case and a
 * digit (paths and ids rarely mix all three).
 */
export function redactLongTokens(text: string): string {
  return text
    .replace(/(--ref[ =]|[#@]|\/(?:commit|tree)\/|\bcommit\s)?\b([0-9a-f]{32,})\b/gi, (match, ref: string | undefined) => (ref ? match : REDACTED))
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (run) => (run.includes(REDACTED) || !(/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run)) ? run : REDACTED));
}

/**
 * Any user-visible text (a toast, an inline message, a dialog body, a
 * preview, copied text): every rule above, line by line. `home`, when known,
 * collapses home paths to `~`.
 */
export function redactSecrets(text: string, home = ""): string {
  if (typeof text !== "string" || !text) return text;
  return redactText(text.split("\n"), home).join("\n");
}

/** Strings (alone or in an array, as React children often are) redacted; anything else left as it was. */
export function redactNode<T>(node: T): T {
  if (typeof node === "string") return redactSecrets(node) as T;
  if (Array.isArray(node)) return node.map(redactNode) as T;
  return node;
}
