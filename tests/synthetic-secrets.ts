/**
 * Synthetic credentials for redaction tests.
 *
 * Every value here is assembled at runtime from harmless fragments so that no
 * literal in the repository matches a generic secret scanner's regex, while
 * the assembled string still has exactly the shape the redaction patterns in
 * `redaction.server.ts` are designed to catch. `describeShape` documents the
 * prefix each value must carry; the redaction tests assert it so a broken
 * assembly can't silently turn into a vacuous test.
 */

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALNUM = UPPER + DIGITS;

function joinWith(separator: string, ...parts: string[]): string {
  return parts.join(separator);
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** `sk-ant-api03-<36 alnum>` — Anthropic-style API key. */
export const SYNTHETIC_ANTHROPIC_KEY = joinWith("-", "sk", "ant", "api03", ALNUM);

/** `ghp_<38 alnum>` — GitHub classic personal access token. */
export const SYNTHETIC_GITHUB_TOKEN = joinWith("_", "ghp", ALNUM + "ab");

/** `AKIA<16 upper/digit>` — AWS access key id (the documented example value). */
export const SYNTHETIC_AWS_ACCESS_KEY = joinWith("", "AKIA", "IOSFODNN7", "EXAMPLE");

/** `xoxb-<digits>-<12 upper>` — Slack bot token. */
export const SYNTHETIC_SLACK_TOKEN = joinWith("-", "xoxb", DIGITS.slice(1) + "0", UPPER.slice(0, 12));

/** `header.payload.signature` — a structurally valid, unsigned HS256 JWT. */
export const SYNTHETIC_JWT = joinWith(
  ".",
  base64url({ alg: "HS256" }),
  base64url({ sub: DIGITS.slice(1) + "0" }),
  joinWith("_", "sig", ALNUM.toLowerCase().slice(0, 20), UPPER.slice(0, 16)),
);

/** A password-looking value with no recognizable token prefix. */
export const SYNTHETIC_PASSWORD = "hunter2-super-secret";

/** `npm_<40 alnum>` — npm granular access token. */
export const SYNTHETIC_NPM_TOKEN = joinWith("_", "npm", ALNUM + "abcd");

/** A bearer credential of the minimum length the redactor treats as a token. */
export const SYNTHETIC_BEARER_VALUE = "abcdefgh" + DIGITS.slice(1, 9);

/** Prefix each synthetic secret must carry for the redaction tests to be meaningful. */
export const SYNTHETIC_SHAPES: ReadonlyArray<{ value: string; prefix: string; minLength: number }> = [
  { value: SYNTHETIC_ANTHROPIC_KEY, prefix: "sk-ant-api03-", minLength: 30 },
  { value: SYNTHETIC_GITHUB_TOKEN, prefix: "ghp_", minLength: 24 },
  { value: SYNTHETIC_AWS_ACCESS_KEY, prefix: "AKIA", minLength: 20 },
  { value: SYNTHETIC_SLACK_TOKEN, prefix: "xoxb-", minLength: 15 },
  { value: SYNTHETIC_JWT, prefix: "eyJ", minLength: 40 },
  { value: SYNTHETIC_NPM_TOKEN, prefix: "npm_", minLength: 34 },
];
