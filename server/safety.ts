import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ActionResult } from "../shared/contracts";
import type { Clock, PlatformAdapter, ProcessIdentity, RawProcess, TreeRow } from "./platform";
import { systemClock } from "./platform";
import { hashArgv } from "./redaction";

/**
 * Everything that can signal a process lives here and fails closed.
 *
 * Invariants:
 * - Only current-user processes. Never uid 0, PID 1, kernel threads, zombies.
 * - Never Monitor itself, nor any ancestor (daemon, supervisor, launcher…).
 * - A token binds PID + uid + start identity + a keyed proof of the argv
 *   hash; all must still match a fresh read at action time. Reused PIDs are
 *   denied. The plain argv hash never leaves the daemon.
 * - Descendants are resolved from a fresh tree, then each one is re-read
 *   immediately before its signal and must still carry the same uid and start
 *   identity. A PID is never signalled just because it was a child earlier.
 * - The primary is signalled first. If that fails for any reason other than
 *   "already exited", no descendant is touched.
 * - SIGKILL requires a verified SIGTERM attempt on the same identity within
 *   the grace window.
 * - Any failure to read identity or the process table denies the action.
 *
 * Known, unavoidable limitation: between the fresh identity read and the
 * kill(2) syscall there is a window of a few microseconds in which the PID
 * could exit and be reused. Closing it would need pidfd_send_signal (Linux
 * 5.1+) or similar, which Node does not expose. Every other race is closed.
 */

export const TOKEN_TTL_MS = 5 * 60 * 1000;
export const GRACEFUL_WINDOW_MS = 60 * 1000;
export const MAX_DESCENDANTS = 512;
const MAX_GRACEFUL_RECORDS = 256;
const PROOF_DOMAIN = "monitor-argv-proof\0";

export type { TreeRow };

type Signal = "SIGTERM" | "SIGKILL";
export type KillFn = (pid: number, signal: Signal) => void;

interface TokenPayload {
  pid: number;
  uid: number;
  startId: string;
  /** HMAC(key, pid|uid|startId|argvHash): proves the argv without revealing its hash. */
  proof: string;
  exp: number;
}

export interface GuardOptions {
  adapter: PlatformAdapter;
  uid: number;
  selfPid?: number;
  /** Extra PIDs that are always protected (e.g. the parent daemon). */
  alwaysProtected?: readonly number[];
  clock?: Clock;
  kill?: KillFn;
  key?: Buffer;
  tokenTtlMs?: number;
  gracefulWindowMs?: number;
}

type SignalOutcome = "delivered" | "exited" | "denied" | "failed";

interface DescendantOutcome {
  delivered: number;
  /** Exited, changed identity, or became protected between the tree read and the signal. */
  skipped: number;
  failed: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function identityKey(identity: { pid: number; uid: number; startId: string; argvHash: string }): string {
  return `${identity.pid}:${identity.uid}:${identity.startId}:${identity.argvHash}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "base64url");
  const right = Buffer.from(b, "base64url");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** PID 1 plus the full ancestor chain of `selfPid`, walked over the given tree. */
export function protectedSet(tree: readonly Pick<TreeRow, "pid" | "ppid">[], selfPid: number, extra: readonly number[] = []): Set<number> {
  const parents = new Map<number, number>();
  for (const row of tree) parents.set(row.pid, row.ppid);
  const set = new Set<number>([1, selfPid, ...extra]);
  let current = selfPid;
  const visited = new Set<number>([selfPid]);
  for (let hops = 0; hops < 128; hops += 1) {
    const parent = parents.get(current);
    if (parent === undefined || parent <= 0 || visited.has(parent)) break;
    visited.add(parent);
    set.add(parent);
    current = parent;
  }
  return set;
}

/**
 * Descendants of `root`, breadth-first, never crossing a protected or
 * other-user node (and never descending through one either). These are
 * *candidates*: each is re-verified against a fresh read before any signal.
 */
export function descendants(tree: readonly TreeRow[], root: number, uid: number, protectedPids: ReadonlySet<number>): TreeRow[] {
  const children = new Map<number, TreeRow[]>();
  for (const row of tree) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const out: TreeRow[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0 && out.length < MAX_DESCENDANTS) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (child.uid !== uid || protectedPids.has(child.pid)) continue;
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export class ProcessGuard {
  private readonly adapter: PlatformAdapter;
  private readonly uid: number;
  private readonly selfPid: number;
  private readonly alwaysProtected: readonly number[];
  private readonly clock: Clock;
  private readonly kill: KillFn;
  private readonly key: Buffer;
  private readonly tokenTtlMs: number;
  private readonly gracefulWindowMs: number;
  private readonly graceful = new Map<string, number>();

  constructor(options: GuardOptions) {
    this.adapter = options.adapter;
    this.uid = options.uid;
    this.selfPid = options.selfPid ?? process.pid;
    this.alwaysProtected = options.alwaysProtected ?? [];
    this.clock = options.clock ?? systemClock;
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    // Fresh key per subprocess: every token dies with a plugin reload.
    this.key = options.key ?? randomBytes(32);
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
    this.gracefulWindowMs = options.gracefulWindowMs ?? GRACEFUL_WINDOW_MS;
  }

  // ------------------------------------------------------------- snapshot side

  /** Static rules that need no fresh read; used to label the snapshot. */
  evaluate(process: Pick<RawProcess, "pid" | "uid" | "state">, sampleTree: ReadonlyMap<number, { pid: number; ppid: number; uid: number }>): {
    actionable: boolean;
    reason: string | null;
  } {
    const rows: Array<Pick<TreeRow, "pid" | "ppid">> = [];
    for (const row of sampleTree.values()) rows.push({ pid: row.pid, ppid: row.ppid });
    return this.evaluateAgainst(process, protectedSet(rows, this.selfPid, this.alwaysProtected));
  }

  private evaluateAgainst(process: Pick<RawProcess, "pid" | "uid" | "state">, protectedPids: ReadonlySet<number>): {
    actionable: boolean;
    reason: string | null;
  } {
    if (process.pid <= 1) return { actionable: false, reason: "init process" };
    if (process.uid === 0) return { actionable: false, reason: "owned by root" };
    if (process.uid !== this.uid) return { actionable: false, reason: "owned by another user" };
    if (process.state === "zombie") return { actionable: false, reason: "already exited (zombie); its parent must reap it" };
    if (process.pid === this.selfPid) return { actionable: false, reason: "this is Monitor" };
    if (protectedPids.has(process.pid)) return { actionable: false, reason: "Paseo or one of its parent processes" };
    return { actionable: true, reason: null };
  }

  mint(process: Pick<RawProcess, "pid" | "uid" | "startId">, argvHash: string, now: number = this.clock.now()): string {
    const payload: TokenPayload = {
      pid: process.pid,
      uid: process.uid,
      startId: process.startId,
      proof: this.proveArgv(process, argvHash),
      exp: now + this.tokenTtlMs,
    };
    const body = base64url(JSON.stringify(payload));
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  /**
   * Keyed proof over the argv hash. A client holding a token learns nothing
   * about the command line, and cannot test guesses against it, because the
   * proof cannot be recomputed without the per-subprocess key.
   */
  private proveArgv(identity: Pick<RawProcess, "pid" | "uid" | "startId">, argvHash: string): string {
    return createHmac("sha256", this.key)
      .update(PROOF_DOMAIN)
      .update(`${identity.pid}\0${identity.uid}\0${identity.startId}\0${argvHash}`)
      .digest("base64url");
  }

  /** Returns the payload only if the signature verifies and it has not expired. */
  verify(token: string, now: number = this.clock.now()): TokenPayload | null {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!constantTimeEqual(token.slice(dot + 1), this.sign(body))) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!isPayload(payload)) return null;
    if (payload.exp <= now) return null;
    return payload;
  }

  // --------------------------------------------------------------- action side

  /**
   * Verify the token against a fresh read and the live tree. Returns the
   * verified identity plus descendant candidates, or a denial. Any read
   * failure is a denial: we never guess.
   */
  private async authorize(
    token: string,
  ): Promise<{ ok: true; identity: ProcessIdentity; protectedPids: ReadonlySet<number>; candidates: TreeRow[] } | { ok: false; result: ActionResult }> {
    const deny = (message: string, pid: number | null = null): { ok: false; result: ActionResult } => ({
      ok: false,
      result: { ok: false, status: "denied", message, pid, signaledCount: 0 },
    });
    const payload = this.verify(token);
    if (!payload) return deny("Action token is invalid or expired. Refresh and try again.");
    let identity: ProcessIdentity | null;
    try {
      identity = await this.adapter.readIdentity(payload.pid);
    } catch {
      return deny("Could not verify the process identity; refusing to signal.", payload.pid);
    }
    if (!identity) return { ok: false, result: { ok: true, status: "already-exited", message: "Process has already exited.", pid: payload.pid, signaledCount: 0 } };
    if (identity.uid !== payload.uid || identity.startId !== payload.startId || !constantTimeEqual(payload.proof, this.proveArgv(identity, identity.argvHash))) {
      return deny("Process identity changed since the snapshot (PID may have been reused).", payload.pid);
    }
    let tree: TreeRow[];
    try {
      tree = await this.adapter.readTree();
    } catch {
      return deny("Could not read the process table; refusing to signal.", payload.pid);
    }
    const protectedPids = protectedSet(tree, this.selfPid, this.alwaysProtected);
    const decision = this.evaluateAgainst(identity, protectedPids);
    if (!decision.actionable) return deny(`Refusing to signal: ${decision.reason}.`, identity.pid);
    return { ok: true, identity, protectedPids, candidates: descendants(tree, identity.pid, this.uid, protectedPids) };
  }

  /**
   * One kill(2). The caller has just re-read this PID's identity; only the
   * syscall-sized window documented at the top of this file remains.
   */
  private trySignal(pid: number, signal: Signal): SignalOutcome {
    try {
      this.kill(pid, signal);
      return "delivered";
    } catch (caught) {
      const code = (caught as { code?: unknown }).code;
      if (code === "ESRCH") return "exited";
      return code === "EPERM" ? "denied" : "failed";
    }
  }

  /**
   * Re-verify each candidate immediately before signalling it. A candidate
   * is skipped when it has exited, when its uid or start identity no longer
   * matches the tree row (PID reuse), or when the static rules now reject it.
   */
  private async signalDescendants(candidates: readonly TreeRow[], protectedPids: ReadonlySet<number>, signal: Signal): Promise<DescendantOutcome> {
    const outcome: DescendantOutcome = { delivered: 0, skipped: 0, failed: 0 };
    for (const candidate of candidates) {
      let fresh: ProcessIdentity | null;
      try {
        fresh = await this.adapter.readIdentity(candidate.pid);
      } catch {
        fresh = null;
      }
      if (!fresh || fresh.uid !== candidate.uid || fresh.startId !== candidate.startId || !this.evaluateAgainst(fresh, protectedPids).actionable) {
        outcome.skipped += 1;
        continue;
      }
      const result = this.trySignal(candidate.pid, signal);
      if (result === "delivered") outcome.delivered += 1;
      else if (result === "exited") outcome.skipped += 1;
      else outcome.failed += 1;
    }
    return outcome;
  }

  private describe(signal: Signal, pid: number, candidates: number, kids: DescendantOutcome): string {
    if (candidates === 0) return `Sent ${signal} to PID ${pid}.`;
    const parts = [`Sent ${signal} to PID ${pid} and ${kids.delivered} of ${candidates} child process(es).`];
    if (kids.failed > 0) parts.push(`${kids.failed} child process(es) could not be signaled.`);
    if (kids.skipped > 0) parts.push(`${kids.skipped} had already exited or changed identity and were left alone.`);
    return parts.join(" ");
  }

  private failure(result: SignalOutcome, pid: number): ActionResult {
    const message = result === "denied" ? "Permission denied by the operating system." : "Signal failed.";
    return { ok: false, status: "failed", message, pid, signaledCount: 0 };
  }

  /** SIGTERM the verified process, record the attempt, then its re-verified descendants. */
  async stop(token: string): Promise<ActionResult> {
    const auth = await this.authorize(token);
    if (!auth.ok) return auth.result;
    const { identity, protectedPids, candidates } = auth;
    const primary = this.trySignal(identity.pid, "SIGTERM");
    if (primary === "exited") return { ok: true, status: "already-exited", message: "Process has already exited.", pid: identity.pid, signaledCount: 0 };
    if (primary !== "delivered") return this.failure(primary, identity.pid);
    this.recordGraceful(identity);
    const kids = await this.signalDescendants(candidates, protectedPids, "SIGTERM");
    return {
      ok: true,
      status: "signaled",
      message: this.describe("SIGTERM", identity.pid, candidates.length, kids),
      pid: identity.pid,
      signaledCount: 1 + kids.delivered,
    };
  }

  /** SIGKILL, gated on a recent verified SIGTERM for the same identity. */
  async forceStop(token: string): Promise<ActionResult> {
    const auth = await this.authorize(token);
    if (!auth.ok) return auth.result;
    const { identity, protectedPids, candidates } = auth;
    if (!this.hadRecentGraceful(identity)) {
      return {
        ok: false,
        status: "needs-graceful-first",
        message: "Send a graceful stop first. Force stop is only allowed shortly after a stop attempt.",
        pid: identity.pid,
        signaledCount: 0,
      };
    }
    const primary = this.trySignal(identity.pid, "SIGKILL");
    if (primary === "exited") return { ok: true, status: "already-exited", message: "Process has already exited.", pid: identity.pid, signaledCount: 0 };
    if (primary !== "delivered") return this.failure(primary, identity.pid);
    this.graceful.delete(identityKey(identity));
    const kids = await this.signalDescendants(candidates, protectedPids, "SIGKILL");
    return {
      ok: true,
      status: "signaled",
      message: this.describe("SIGKILL", identity.pid, candidates.length, kids),
      pid: identity.pid,
      signaledCount: 1 + kids.delivered,
    };
  }

  private recordGraceful(identity: ProcessIdentity): void {
    const now = this.clock.now();
    for (const [key, at] of this.graceful) if (now - at > this.gracefulWindowMs) this.graceful.delete(key);
    while (this.graceful.size >= MAX_GRACEFUL_RECORDS) {
      const oldest = this.graceful.keys().next().value;
      if (oldest === undefined) break;
      this.graceful.delete(oldest);
    }
    this.graceful.set(identityKey(identity), now);
  }

  private hadRecentGraceful(identity: ProcessIdentity): boolean {
    const at = this.graceful.get(identityKey(identity));
    return at !== undefined && this.clock.now() - at <= this.gracefulWindowMs;
  }
}

function isPayload(value: unknown): value is TokenPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.pid) &&
    (v.pid as number) > 0 &&
    Number.isInteger(v.uid) &&
    typeof v.startId === "string" &&
    typeof v.proof === "string" &&
    typeof v.exp === "number" &&
    Number.isFinite(v.exp)
  );
}

/** Helper for tests and handlers: identity of a raw sample as safety sees it. */
export function identityOf(process: RawProcess): ProcessIdentity {
  return { pid: process.pid, ppid: process.ppid, uid: process.uid, startId: process.startId, argvHash: hashArgv(process.argv), state: process.state };
}
