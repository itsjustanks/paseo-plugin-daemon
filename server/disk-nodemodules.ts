import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CREDENTIAL_PATTERN, NODE_MODULES_OWN, PACKAGE_NAME, foldName, isWithin, probeChecksFor, strayWords, type NodeModulesContext, type ProbeChecks } from "../shared/disk";
import { redactSecrets } from "../shared/redaction";
import type { TopEntry } from "./disk-worker";

/**
 * The checks outside the walk (final gate): a node_modules against its
 * lockfile, and a .turbo's logs against the scripts beside it. Package
 * internals aren't looked at: hand-placed files deep inside a tool-wiped
 * folder are an accepted, documented limit (npm ci deletes them too).
 */

export const NO_LOCKFILE = "There's no lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock) beside its package.json, so an install might not bring it back. Hosts leaves it.";
const UNREADABLE = (file: string) => `Hosts couldn't read ${file}, so it can't tell what an install brings back. Hosts leaves it.`;

const isFile = async (path: string) => { const st = await lstat(path).catch(() => null); return !!st && st.isFile(); };

/** Nearest first, in this order when a folder has more than one. */
const LOCKS: ReadonlyArray<readonly [string, NodeModulesContext["lock"]]> = [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]];

/**
 * The lockfile that restores a node_modules: a package.json right beside it
 * and a lockfile next to that package.json or next to the package.json of a
 * folder above it, up to the workspace root (a monorepo's one lockfile).
 * Regular files only; anything unreadable says no.
 */
export async function findLock(nodeModules: string, root: string): Promise<{ file: string; lock: NodeModulesContext["lock"]; dir: string } | null> {
  const owner = dirname(nodeModules);
  if (!await isFile(join(owner, "package.json"))) return null;
  for (let dir = owner; ; dir = dirname(dir)) {
    if (await isFile(join(dir, "package.json"))) for (const [name, lock] of LOCKS) if (await isFile(join(dir, name))) return { file: join(dir, name), lock, dir };
    if (dir === root || !isWithin(dir, root)) return null;
  }
}

/** npm (lockfile v2/v3): the names under packages["<path to it>/node_modules/<name>"]; v1: dependencies, for a root node_modules only. */
export function npmNames(text: string, prefix: string): string[] | null {
  let lock: { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try { lock = JSON.parse(text); } catch { return null; }
  if (!lock || typeof lock !== "object") return null;
  const start = `${prefix ? `${prefix}/` : ""}node_modules/`;
  if (lock.packages && typeof lock.packages === "object") {
    return Object.keys(lock.packages).filter((key) => key.startsWith(start) && !key.slice(start.length).includes("/node_modules/")).map((key) => key.slice(start.length));
  }
  return !prefix && lock.dependencies && typeof lock.dependencies === "object" ? Object.keys(lock.dependencies) : null;
}

/** "react@19.0.0", "/react@18.2.0(peer)", "/react/18.2.0", "@types/node@22.0.0" → the package name. */
const pnpmKeyName = (key: string) => {
  const bare = key.replace(/^['"]|['"]$/g, "").replace(/^\//, "").replace(/\(.*$/, "");
  const at = bare.lastIndexOf("@");
  if (at > 0) return bare.slice(0, at);
  const slash = bare.lastIndexOf("/");
  return slash > 0 && !bare.startsWith("@") ? bare.slice(0, slash) : slash > bare.indexOf("/") ? bare.slice(0, slash) : bare;
};

/**
 * pnpm: every name pnpm-lock.yaml knows, from importers' dependency blocks,
 * the packages and snapshots keys, and (lockfile v5/v6) the top-level
 * dependency blocks. Read line by line on pnpm's fixed two-space layout; a
 * file without lockfileVersion is unreadable.
 */
export function pnpmNames(text: string): string[] | null {
  if (!/^lockfileVersion:/m.test(text)) return null;
  const names = new Set<string>();
  const DEPS = /^(dependencies|devDependencies|optionalDependencies)$/;
  let section = "", inDeps = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const key = raw.trim().replace(/:(\s.*)?$/, "").replace(/^['"]|['"]$/g, "");
    if (indent === 0) { section = key; continue; }
    if (section === "importers") {
      if (indent === 4) inDeps = DEPS.test(key);
      else if (indent === 6 && inDeps) names.add(key);
    } else if ((section === "packages" || section === "snapshots") && indent === 2) names.add(pnpmKeyName(key));
    else if (DEPS.test(section) && indent === 2) names.add(key);
  }
  return [...names];
}

/** What the node_modules check needs, or why it can't run (no lockfile, unreadable lockfile). */
export async function nodeModulesContext(nodeModules: string, root: string): Promise<NodeModulesContext | string> {
  const found = await findLock(nodeModules, root);
  if (!found) return NO_LOCKFILE;
  let names: string[] | null = null;
  if (found.lock === "npm" || found.lock === "pnpm") {
    const text = await readFile(found.file, "utf8").catch(() => null);
    names = text === null ? null : found.lock === "npm" ? npmNames(text, relative(found.dir, dirname(nodeModules))) : pnpmNames(text);
    if (!names) return UNREADABLE(found.file.slice(found.dir.length + 1));
  }
  // yarn.lock and bun.lock can't be read reliably here: their presence is the rule.
  return { lock: found.lock, names, original: nodeModules, root };
}

/**
 * node_modules' top level against its tools and its lockfile. `at` is where
 * it is now (the quarantine, during a delete); links are read there and
 * resolved from its original place. Returns why not (no trailing period),
 * or null when it may go.
 */
export async function nodeModulesVerdict(top: readonly TopEntry[] | undefined, overflow: boolean | undefined, context: NodeModulesContext, at: string): Promise<string | null> {
  if (!top) return "Hosts couldn't confirm what's at node_modules' top level";
  if (overflow) return "node_modules has more at its top level than Hosts checks";
  const credential = new RegExp(CREDENTIAL_PATTERN);
  const known = context.names ? new Set(context.names) : null;
  const store = [join(context.original, ".pnpm"), join(context.original, ".bun")];
  for (const [name, type] of top) {
    const scoped = name.includes("/");
    const leaf = scoped ? name.slice(name.indexOf("/") + 1) : name;
    // Credentials at the top level and one level into a scope; package internals are exempt (packages ship test keys).
    if (credential.test(foldName(leaf))) return `node_modules has something that looks like a key or credentials at its top level: ${redactSecrets(name).slice(0, 80)}`;
    if (!scoped && Object.prototype.hasOwnProperty.call(NODE_MODULES_OWN, name)) {
      if (NODE_MODULES_OWN[name] !== type) return strayWords("node_modules", name);
      continue;
    }
    if (!scoped && name.startsWith("@")) {
      if (type !== "d" || !PACKAGE_NAME.test(name.slice(1))) return strayWords("node_modules", name);
      continue;
    }
    if (!PACKAGE_NAME.test(leaf) || (type !== "d" && type !== "l")) return strayWords("node_modules", name);
    if (known) {
      if (!known.has(name)) return `node_modules has a package the lockfile can't restore: ${redactSecrets(name).slice(0, 80)}`;
      continue;
    }
    // yarn, bun: a link must point into this node_modules' own store, or to a folder in the workspace outside it (a workspace package).
    if (type === "l") {
      const text = await readlink(join(at, name)).catch(() => null);
      const target = text === null ? null : resolve(dirname(join(context.original, name)), text);
      const ok = !!target && (store.some((folder) => isWithin(target, folder)) || (isWithin(target, context.root) && target !== context.original && !isWithin(target, context.original)));
      if (!ok) return `node_modules has a link Hosts doesn't recognise: ${redactSecrets(name).slice(0, 80)}`;
    }
  }
  return null;
}

/** The log names turbo writes for the scripts in the package.json beside a .turbo (":" as "$colon$", as turbo 2.11 does). */
export async function turboLogNames(turbo: string): Promise<string[]> {
  const text = await readFile(join(dirname(turbo), "package.json"), "utf8").catch(() => null);
  if (text === null) return [];
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
    return scripts && typeof scripts === "object" ? Object.keys(scripts).map((task) => `turbo-${task.split(":").join("$colon$")}.log`) : [];
  } catch { return []; }
}

/** A .turbo's "c" files that aren't a log of one of its scripts: the first such name, or null. */
export const strayLog = (conditional: readonly string[] | undefined, allowed: readonly string[] | undefined) => (conditional ?? []).find((name) => !allowed?.includes(name)) ?? null;

/** The scan's checks outside the walk for one item: why not (a full sentence), or null. */
export async function outsideWalkReason(name: string, path: string, root: string, walked: { conditional?: string[]; top?: TopEntry[]; topOverflow?: boolean }): Promise<string | null> {
  if (name === ".turbo") {
    const stray = strayLog(walked.conditional, await turboLogNames(path));
    return stray ? `${strayWords(".turbo", stray)}. Hosts leaves it.` : null;
  }
  if (name !== "node_modules") return null;
  const context = await nodeModulesContext(path, root);
  if (typeof context === "string") return context;
  const why = await nodeModulesVerdict(walked.top, walked.topOverflow, context, path);
  return why ? `${why}. Hosts leaves it.` : null;
}

/** For a delete: what the look inside needs, worked out before the move (or why it can't go). */
export async function removalChecks(path: string, root: string): Promise<ProbeChecks | string> {
  const name = basename(path);
  const checks = probeChecksFor(name);
  if (name === ".turbo") return { ...checks, turboLogs: await turboLogNames(path) };
  if (name !== "node_modules") return checks;
  const context = await nodeModulesContext(path, root);
  return typeof context === "string" ? context : { ...checks, nodeModules: context };
}
