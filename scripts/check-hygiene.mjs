#!/usr/bin/env node
/**
 * Repository hygiene check. Runs on Node 20+ on Linux and macOS with no
 * dependencies beyond git.
 *
 *  1. No credential-shaped literals in tracked files. The only allowed home
 *     for such shapes is `server/redaction.ts`, which intentionally contains
 *     the regex *sources* that detect them. Test fixtures must assemble
 *     synthetic secrets at runtime (see `tests/synthetic-secrets.ts`).
 *  2. No trailing whitespace and no CRLF line endings in tracked text files.
 *  3. Markdown prose is wrapped to a readable width (code blocks and bare
 *     links are exempt).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

const MARKDOWN_MAX_WIDTH = 120;

/** Files whose whole purpose is to name secret shapes. */
const SECRET_SHAPE_ALLOWLIST = new Set(["server/redaction.ts", "scripts/check-hygiene.mjs"]);

/** Binary-ish or generated files we do not lint for whitespace. */
const WHITESPACE_SKIP = new Set(["package-lock.json"]);
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt", ""]);

// Assembled from fragments so this file does not itself match a scanner.
const K = (...parts) => parts.join("");
const SECRET_SHAPES = [
  { name: "OpenAI/Anthropic-style key", re: new RegExp(K("\\bsk-", "[A-Za-z0-9_-]{16,}\\b")) },
  { name: "GitHub token", re: new RegExp(K("\\bgh[pousr]_", "[A-Za-z0-9]{20,}\\b")) },
  { name: "GitHub fine-grained token", re: new RegExp(K("\\bgithub_pat_", "[A-Za-z0-9_]{20,}\\b")) },
  { name: "Slack token", re: new RegExp(K("\\bxox[abprs]-", "[A-Za-z0-9-]{10,}\\b")) },
  { name: "AWS access key id", re: new RegExp(K("\\bAKIA", "[0-9A-Z]{16}\\b")) },
  { name: "Google API key", re: new RegExp(K("\\bAIza", "[0-9A-Za-z_-]{30,}\\b")) },
  { name: "GitLab token", re: new RegExp(K("\\bglpat-", "[A-Za-z0-9_-]{16,}\\b")) },
  { name: "npm token", re: new RegExp(K("\\bnpm_", "[A-Za-z0-9]{30,}\\b")) },
  { name: "JWT", re: new RegExp(K("\\bey[A-Za-z0-9_-]{10,}\\.", "[A-Za-z0-9_-]{10,}\\.", "[A-Za-z0-9_-]{10,}\\b")) },
  { name: "PEM private key", re: new RegExp(K("-----BEGIN", "[ A-Z]*PRIVATE KEY-----")) },
  { name: "Slack webhook", re: new RegExp(K("hooks\\.slack\\.com/", "services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/")) },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(extname(file));
}

function checkSecretShapes(file, text, problems) {
  if (SECRET_SHAPE_ALLOWLIST.has(file)) return;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of SECRET_SHAPES) {
      if (re.test(line)) problems.push(`${file}:${i + 1}: credential-shaped literal (${name}); assemble it at runtime instead`);
    }
  });
}

function checkWhitespace(file, text, problems) {
  if (WHITESPACE_SKIP.has(file)) return;
  if (text.includes("\r")) problems.push(`${file}: contains CRLF line endings`);
  text.split("\n").forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${file}:${i + 1}: trailing whitespace`);
  });
  if (text.length > 0 && !text.endsWith("\n")) problems.push(`${file}: missing final newline`);
}

function checkMarkdownWidth(file, text, problems) {
  let inFence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || line.length <= MARKDOWN_MAX_WIDTH) return;
    // A line that is essentially one URL/badge/link cannot be wrapped.
    if (/^\s*(\[!?\[|\[[^\]]*\]\(|<?https?:\/\/|!\[)/.test(line) && !/\s\w+\s\w+\s\w+/.test(line)) return;
    problems.push(`${file}:${i + 1}: Markdown line is ${line.length} chars (max ${MARKDOWN_MAX_WIDTH})`);
  });
}

const problems = [];
let scanned = 0;
for (const file of trackedFiles()) {
  if (!isTextFile(file) || !existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  scanned += 1;
  checkSecretShapes(file, text, problems);
  checkWhitespace(file, text, problems);
  if (extname(file) === ".md") checkMarkdownWidth(file, text, problems);
}

if (problems.length > 0) {
  console.error(`check:hygiene found ${problems.length} problem(s) in ${scanned} tracked text files:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check:hygiene passed: ${scanned} tracked text files, no credential-shaped literals, clean whitespace, Markdown wrapped.`);
