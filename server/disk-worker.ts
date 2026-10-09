import { spawn } from "node:child_process";
import { ChildGroup, lowPriority, watchChild } from "./disk-children";

/**
 * The heavy part of 0.14.0's disk scan (walking folders to measure them),
 * run in a child process at the lowest CPU and disk priority, so a scan of
 * dozens of node_modules folders on a starved host never slows Paseo, the
 * plugin's own calls, or the 10-second check loop.
 *
 * `diskWorker` is self-contained on purpose: it uses only its arguments, no
 * imports and no outer variables, because its source is what the child
 * runs (`node -e`). Tests call it directly with the real `fs`.
 *
 * Rules it keeps: lstat only (a symlink is never followed, only counted as
 * itself or unlinked as itself); never cross onto another device; stop at the
 * deadline and say so (partial); every byte counted once per inode. It only
 * reads: nothing in Hosts deletes.
 */

export interface WalkRoot { id: string; path: string; mode: "workspace" | "whole" }
export interface ScanRequest {
  op: "scan";
  roots: WalkRoot[];
  /** Epoch ms after which nothing more is read. */
  deadline: number;
  clearable: string[];
  ignoredOnly: string[];
  ignoredMaxDepth: number;
  maxItemsPerRoot: number;
  /** Final gate: credential-shaped names anywhere inside, and source files directly inside (regex sources, folded names). */
  credential?: string;
  topSource?: string;
  /** Final gate: what each tool puts at the top level of its folder, by item name (scan) or for the root (the look inside). */
  layouts?: Record<string, ReadonlyArray<readonly [string, "f" | "d" | "c"]>>;
  rootLayout?: ReadonlyArray<readonly [string, "f" | "d" | "c"]>;
  /** node_modules: list its top level and one level into @scope folders (scan items / the root), for the check outside the walk. */
  nodeModules?: boolean;
  rootNodeModules?: boolean;
}
/** A top-level entry: name ("@scope/pkg" one level into a scope) and type: "d" folder, "f" file, "l" link, "o" other or unreadable. */
export type TopEntry = [name: string, type: "d" | "f" | "l" | "o"];
/** node_modules listings stop here and say so (overflow), which refuses. */
export const TOP_ENTRIES_MAX = 50_000;
export interface WalkItem { rel: string; name: string; dev: number; ino: number; mtimeMs: number; bytes: number; sharedBytes: number; partial: boolean; hasEnv: boolean; hasGit: boolean; depth: number; ignoredOnly: boolean; hasCredential?: boolean; hasTopSource?: boolean; topUnexpected?: string | null; conditional?: string[]; top?: TopEntry[]; topOverflow?: boolean }
export interface WalkResult {
  id: string;
  ok: boolean;
  error?: string;
  skipped?: boolean;
  dev: number;
  ino: number;
  totalBytes: number;
  /** Newest change anywhere inside. */
  newestMtimeMs: number;
  partial: boolean;
  entries: number;
  hasEnv: boolean;
  /** A .git file or folder, or a bare repository (HEAD + objects/ + refs/), anywhere inside or at the root itself. */
  hasGit: boolean;
  /** A credential-shaped name anywhere inside / a source file directly inside the root. */
  hasCredential?: boolean;
  hasTopSource?: boolean;
  /** The first top-level entry outside rootLayout (null: none; absent: not checked). */
  topUnexpected?: string | null;
  /** Top-level files allowed only after a check outside the walk ("c" rules). */
  conditional?: string[];
  /** node_modules (rootNodeModules): its top-level listing. */
  top?: TopEntry[];
  topOverflow?: boolean;
  items: WalkItem[];
}

type FsLike = {
  lstatSync(path: string): { dev: number; ino: number; nlink: number; size: number; blocks?: number; mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean };
  readdirSync(path: string): string[];
};

export function diskWorker(fs: FsLike, request: ScanRequest, emit: (result: unknown) => void): void {
  var bytesOf = function (st: { blocks?: number; size: number }) { return typeof st.blocks === "number" && st.blocks >= 0 ? st.blocks * 512 : st.size; };
  var join = function (a: string, b: string) { return a.endsWith("/") ? a + b : a + "/" + b; };

  // 0.16.0 review fix: names compared folded (Unicode NFC, lower case), as a case-insensitive disk sees them.
  var fold = function (name: string) { return String(name).normalize("NFC").toLowerCase(); };
  var clearable: Record<string, true> = {}, ignoredOnly: Record<string, true> = {};
  // Eligibility is exact (the spelling readdir returns must be the allow-listed one); protection folds.
  request.clearable.forEach(function (name) { clearable[name] = true; });
  request.ignoredOnly.forEach(function (name) { ignoredOnly[name] = true; });
  var isEnv = function (name: string) { var folded = fold(name); return folded === ".env" || folded.indexOf(".env.") === 0; };
  var isGit = function (name: string) { return fold(name) === ".git"; };
  var credential = request.credential ? new RegExp(request.credential) : null;
  var topSource = request.topSource ? new RegExp(request.topSource) : null;
  var isCredential = function (name: string) { return !!credential && credential.test(fold(name)); };
  var isTopSource = function (name: string) { return !!topSource && topSource.test(fold(name)); };
  // Layout rules match the exact name, as the tool writes it; anything else (or a link, or anything not a plain file/folder) is a stray.
  var compile = function (rules: ReadonlyArray<readonly [string, "f" | "d" | "c"]>) { return rules.map(function (rule) { return { rx: new RegExp("^(?:" + rule[0] + ")$"), type: rule[1] }; }); };
  var layouts: Record<string, Array<{ rx: RegExp; type: string }>> = {};
  if (request.layouts) Object.keys(request.layouts).forEach(function (name) { layouts[name] = compile(request.layouts![name]!); });
  var rootLayout = request.rootLayout ? compile(request.rootLayout) : null;
  var typeOf = function (st: ReturnType<FsLike["lstatSync"]> | null) { return !st ? "o" : st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "o"; };
  // 0: doesn't fit; 1: fits; 2: a file that fits only after a check outside the walk ("c").
  var fits = function (rules: Array<{ rx: RegExp; type: string }>, name: string, st: ReturnType<FsLike["lstatSync"]> | null) {
    var type = typeOf(st);
    if (type === "l" || type === "o") return 0;
    for (var i = 0; i < rules.length; i += 1) {
      if (!rules[i]!.rx.test(name)) continue;
      if (rules[i]!.type === type) return 1;
      if (rules[i]!.type === "c" && type === "f") return 2;
    }
    return 0;
  };
  var judge = function (holder: { topUnexpected?: string | null; conditional?: string[] }, rules: Array<{ rx: RegExp; type: string }>, name: string, st: ReturnType<FsLike["lstatSync"]> | null) {
    if (holder.topUnexpected !== null) return;
    var fit = fits(rules, name, st);
    if (fit === 0) holder.topUnexpected = name;
    else if (fit === 2) (holder.conditional = holder.conditional || []).push(name);
  };
  var list = function (holder: { top?: TopEntry[]; topOverflow?: boolean }, inside: string, st: ReturnType<FsLike["lstatSync"]> | null) {
    var parts = inside.split("/");
    if (parts.length > 2 || (parts.length === 2 && parts[0]!.charAt(0) !== "@")) return;
    var top = holder.top = holder.top || [];
    if (top.length >= 50000) { holder.topOverflow = true; return; } // TOP_ENTRIES_MAX (the worker can't import it)
    top.push([inside, typeOf(st) as TopEntry[1]]);
  };
  // A direct child of a laid-out item (or of the root) that doesn't fit: the first one is kept. Unreadable counts as a stray.
  var checkTop = function (entry: { rel: string; depth: number; item: number }, st: ReturnType<FsLike["lstatSync"]> | null) {
    var name = entry.rel.slice(entry.rel.lastIndexOf("/") + 1);
    if (entry.item >= 0) {
      var owner = result.items[entry.item]!;
      var rules = Object.prototype.hasOwnProperty.call(layouts, owner.name) ? layouts[owner.name]! : null;
      if (rules && entry.depth === owner.depth + 1) judge(owner, rules, name, st);
      if (request.nodeModules && owner.name === "node_modules" && entry.depth <= owner.depth + 2) list(owner, entry.rel.slice(owner.rel.length + 1), st);
    } else {
      if (rootLayout && entry.depth === 1) judge(result, rootLayout, name, st);
      if (request.rootNodeModules && entry.depth >= 1 && entry.depth <= 2) list(result, entry.rel, st);
    }
  };

  for (var r = 0; r < request.roots.length; r += 1) {
    var spec = request.roots[r]!;
    var left = request.roots.length - r;
    var now = Date.now();
    if (now >= request.deadline) { emit({ id: spec.id, ok: false, skipped: true, dev: 0, ino: 0, totalBytes: 0, newestMtimeMs: 0, partial: true, entries: 0, hasEnv: false, hasGit: false, items: [] }); continue; }
    // A fair share of what's left, so one huge folder can't starve the rest.
    var rootDeadline = Math.min(request.deadline, now + Math.max(10000, (request.deadline - now) / left));
    var result: WalkResult = { id: spec.id, ok: true, dev: 0, ino: 0, totalBytes: 0, newestMtimeMs: 0, partial: false, entries: 0, hasEnv: false, hasGit: false, hasCredential: credential ? false : undefined, hasTopSource: topSource ? false : undefined, topUnexpected: rootLayout ? null : undefined, top: request.rootNodeModules ? [] : undefined, items: [] };
    var rootStat: ReturnType<FsLike["lstatSync"]>;
    try { rootStat = fs.lstatSync(spec.path); } catch (error) { result.ok = false; result.error = String(error && (error as { code?: string }).code || error); emit(result); continue; }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) { result.ok = false; result.error = "not a folder"; emit(result); continue; }
    result.dev = rootStat.dev; result.ino = rootStat.ino;
    var seen: Record<string, true> = {};
    // Each entry: path, path relative to the root, depth, the item it belongs to (index), and whether it is inside .git.
    var queue: Array<{ path: string; rel: string; depth: number; item: number; git: boolean }> = [{ path: spec.path, rel: "", depth: 0, item: -1, git: false }];
    var count = 0;
    while (queue.length) {
      if ((count++ & 255) === 0 && Date.now() > rootDeadline) {
        result.partial = true;
        for (var q = 0; q < queue.length; q += 1) if (queue[q]!.item >= 0) result.items[queue[q]!.item]!.partial = true;
        break;
      }
      var entry = queue.pop()!;
      var stat: ReturnType<FsLike["lstatSync"]>;
      try { stat = fs.lstatSync(entry.path); } catch { checkTop(entry, null); continue; }
      checkTop(entry, stat);
      result.entries += 1;
      if (stat.dev !== result.dev) continue; // another disk mounted inside: not counted, not entered
      var bytes = bytesOf(stat);
      if (stat.nlink > 1 && !stat.isDirectory()) {
        var key = stat.dev + ":" + stat.ino;
        if (seen[key]) bytes = 0; else seen[key] = true;
      }
      result.totalBytes += bytes;
      if (stat.mtimeMs > result.newestMtimeMs) result.newestMtimeMs = stat.mtimeMs;
      var name = entry.rel.slice(entry.rel.lastIndexOf("/") + 1);
      if (entry.item >= 0) {
        var owner = result.items[entry.item]!;
        owner.bytes += bytes;
        if (stat.nlink > 1 && !stat.isDirectory()) owner.sharedBytes += bytes;
        if (entry.rel !== owner.rel) {
          if (isEnv(name)) owner.hasEnv = true;
          if (isGit(name)) owner.hasGit = true;
          if (isCredential(name)) owner.hasCredential = true;
          if (entry.depth === owner.depth + 1 && isTopSource(name)) owner.hasTopSource = true;
        }
      } else if (entry.depth > 0) {
        if (isEnv(name)) result.hasEnv = true;
        if (isGit(name)) result.hasGit = true;
        if (isCredential(name)) result.hasCredential = true;
        if (entry.depth === 1 && isTopSource(name)) result.hasTopSource = true;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      var item = entry.item;
      var inGit = entry.git || isGit(name);
      if (spec.mode === "workspace" && item < 0 && !inGit && entry.depth > 0 && result.items.length < request.maxItemsPerRoot) {
        var only = Object.prototype.hasOwnProperty.call(ignoredOnly, name) && entry.depth <= request.ignoredMaxDepth;
        if (Object.prototype.hasOwnProperty.call(clearable, name) || only) {
          result.items.push({ rel: entry.rel, name: name, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: bytes, sharedBytes: 0, partial: false, hasEnv: false, hasGit: false, depth: entry.depth, ignoredOnly: !Object.prototype.hasOwnProperty.call(clearable, name), hasCredential: credential ? false : undefined, hasTopSource: topSource ? false : undefined, topUnexpected: Object.prototype.hasOwnProperty.call(layouts, name) ? null : undefined, top: request.nodeModules && name === "node_modules" ? [] : undefined });
          item = result.items.length - 1;
        }
      }
      var children: string[] = [];
      try { children = fs.readdirSync(entry.path); } catch { if (item >= 0) result.items[item]!.partial = true; else result.partial = true; continue; }
      // A bare git repository has no ".git" entry: HEAD, objects/ and refs/ side by side. It counts as .git.
      var folded = children.map(fold);
      if (folded.indexOf("head") >= 0 && folded.indexOf("objects") >= 0 && folded.indexOf("refs") >= 0) {
        if (item >= 0) result.items[item]!.hasGit = true; else result.hasGit = true;
      }
      for (var c = 0; c < children.length; c += 1) {
        var child = children[c]!;
        queue.push({ path: join(entry.path, child), rel: entry.rel ? entry.rel + "/" + child : child, depth: entry.depth + 1, item: item, git: inGit });
      }
    }
    emit(result);
  }
}

/** The child's whole program: read the request on stdin, write one JSON line per result. */
export const WORKER_SCRIPT = `var __name=function(f){return f};var fs=require("fs");var input="";process.stdin.setEncoding("utf8");process.stdin.on("data",function(c){input+=c});process.stdin.on("end",function(){var request=JSON.parse(input);(${diskWorker.toString()})(fs,request,function(o){process.stdout.write(JSON.stringify(o)+"\\n")});});`;

export interface WorkerRun<T> { results: T[]; timedOut: boolean; error: string | null }

/**
 * Runs the worker at the lowest priority (nice 19; idle disk class on Linux
 * when `ionice` exists) and collects its lines as they come. `onResult` sees
 * each one at once (scan progress). The child is killed at `hardLimitMs`.
 */
export function runWorker<T>(request: ScanRequest, hardLimitMs: number, onResult?: (result: T) => void, group?: ChildGroup): Promise<WorkerRun<T>> {
  return new Promise((resolve) => {
    const results: T[] = [];
    let buffer = "", timedOut = false, settled = false;
    if (group?.closed) { resolve({ results, timedOut: false, error: "Hosts is unloading." }); return; }
    // Its own process group, so unloading Hosts can end it (group.killAll); tracked only until it exits.
    const child = spawn(process.execPath, ["-e", WORKER_SCRIPT], { detached: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    const own = group ?? new ChildGroup();
    const untrack = child.pid ? own.track(child.pid) : () => undefined;
    const done = (error: string | null) => { if (settled) return; settled = true; clearTimeout(timer); untrack(); resolve({ results, timedOut, error }); };
    const timer = setTimeout(() => { timedOut = true; own.signal(child.pid); }, hardLimitMs);
    (timer as { unref?: () => void }).unref?.();
    if (child.pid) lowPriority(child.pid);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const parsed = JSON.parse(line) as T; results.push(parsed); onResult?.(parsed); } catch { /* A torn line is skipped. */ }
      }
    });
    // EPIPE on stdin (it died mid-write) is a result: the run ends with what arrived, never a crash.
    watchChild(child, untrack, (_code, _killed, error) => done(timedOut ? null : error && !/EPIPE|ECONNRESET/.test(error) ? error : null));
    child.stdin.end(JSON.stringify(request));
  });
}
