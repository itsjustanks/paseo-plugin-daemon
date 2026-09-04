import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ActionResult } from "./contracts.shared";
import type { Clock, PlatformAdapter, ProcessIdentity, RawProcess } from "./platform.server";
import { systemClock } from "./platform.server";
import { hashArgv } from "./redaction.server";

/**
 * Everything that can signal a process lives here and fails closed.
 *
 * Invariants:
 * - Only current-user processes. Never uid 0, PID 1, kernel threads, zombies.
 * - Never Monitor itself, nor any ancestor (daemon, supervisor, launcher…).
 * - A token binds PID + uid + start identity + argv hash; all must still match
 *   a fresh read at action time. Reused PIDs are denied.
 * - Descendants are resolved fresh and filtered by the same rules; process
 *   groups are never signalled blindly.
 * - SIGKILL requires a verified SIGTERM attempt on the same identity within
 *   the grace window.
 */

export const TOKEN_TTL_MS = 5 * 60 * 1000;
export const GRACEFUL_WINDOW_MS = 60 * 1000;
export const MAX_DESCENDANTS = 512;
const MAX_GRACEFUL_RECORDS = 256;

type Signal = "SIGTERM" | "SIGKILL";
export type KillFn = (pid: number, signal: Signal) => void;

interface TokenPayload {
  pid: number;
  uid: number;
  startId: string;
  argvHash: string;
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

export interface TreeRow {
  pid: number;
  ppid: number;
  uid: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function identityKey(identity: { pid: number; uid: number; startId: string; argvHash: string }): string {
  return `${identity.pid}:${identity.uid}:${identity.startId}:${identity.argvHash}`;
}

/** PID 1 plus the full ancestor chain of `selfPid`, walked over the given tree. */
export function protectedSet(tree: readonly TreeRow[], selfPid: number, extra: readonly number[] = []): Set<number> {
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
 * other-user node (and never descending through one either).
 */
export function descendants(tree: readonly TreeRow[], root: number, uid: number, protectedPids: ReadonlySet<number>): number[] {
  const children = new Map<number, TreeRow[]>();
  for (const row of tree) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const out: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0 && out.length < MAX_DESCENDANTS) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (child.uid !== uid || protectedPids.has(child.pid)) continue;
      out.push(child.pid);
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
    const rows: TreeRow[] = [];
    for (const row of sampleTree.values()) rows.push({ pid: row.pid, ppid: row.ppid, uid: row.uid });
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
    const payload: TokenPayload = { pid: process.pid, uid: process.uid, startId: process.startId, argvHash, exp: now + this.tokenTtlMs };
    const body = base64url(JSON.stringify(payload));
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  /** Returns the payload only if the signature verifies and it has not expired. */
  verify(token: string, now: number = this.clock.now()): TokenPayload | null {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const signature = Buffer.from(token.slice(dot + 1), "base64url");
    const expected = Buffer.from(this.sign(body), "base64url");
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
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
   * verified identity plus the descendants that may be signalled, or a denial.
   */
  private async authorize(token: string): Promise<{ ok: true; identity: ProcessIdentity; targets: number[] } | { ok: false; result: ActionResult }> {
    const deny = (message: string, pid: number | null = null): { ok: false; result: ActionResult } => ({
      ok: false,
      result: { ok: false, status: "denied", message, pid, signaledCount: 0 },
    });
    const payload = this.verify(token);
    if (!payload) return deny("Action token is invalid or expired. Refresh and try again.");
    const identity = await this.adapter.readIdentity(payload.pid);
    if (!identity) return { ok: false, result: { ok: true, status: "already-exited", message: "Process has already exited.", pid: payload.pid, signaledCount: 0 } };
    if (identity.uid !== payload.uid || identity.startId !== payload.startId || identity.argvHash !== payload.argvHash) {
      return deny("Process identity changed since the snapshot (PID may have been reused).", payload.pid);
    }
    const tree = await this.adapter.readTree();
    const protectedPids = protectedSet(tree, this.selfPid, this.alwaysProtected);
    const decision = this.evaluateAgainst(identity, protectedPids);
    if (!decision.actionable) return deny(`Refusing to signal: ${decision.reason}.`, identity.pid);
    return { ok: true, identity, targets: descendants(tree, identity.pid, this.uid, protectedPids) };
  }

  private signalAll(pids: readonly number[], signal: Signal): { delivered: number; primaryExited: boolean; error: string | null } {
    let delivered = 0;
    let primaryExited = false;
    let error: string | null = null;
    pids.forEach((pid, index) => {
      try {
        this.kill(pid, signal);
        delivered += 1;
      } catch (caught) {
        const code = (caught as { code?: unknown }).code;
        if (code === "ESRCH") {
          if (index === 0) primaryExited = true;
          return;
        }
        if (index === 0) error = code === "EPERM" ? "Permission denied by the operating system." : "Signal failed.";
      }
    });
    return { delivered, primaryExited, error };
  }

  /** SIGTERM the verified process and its eligible descendants; record the attempt. */
  async stop(token: string): Promise<ActionResult> {
    const auth = await this.authorize(token);
    if (!auth.ok) return auth.result;
    const { identity, targets } = auth;
    const outcome = this.signalAll([identity.pid, ...targets], "SIGTERM");
    if (outcome.primaryExited) return { ok: true, status: "already-exited", message: "Process has already exited.", pid: identity.pid, signaledCount: 0 };
    if (outcome.error) return { ok: false, status: "failed", message: outcome.error, pid: identity.pid, signaledCount: outcome.delivered };
    this.recordGraceful(identity);
    return {
      ok: true,
      status: "signaled",
      message: targets.length > 0 ? `Sent SIGTERM to PID ${identity.pid} and ${targets.length} child process(es).` : `Sent SIGTERM to PID ${identity.pid}.`,
      pid: identity.pid,
      signaledCount: outcome.delivered,
    };
  }

  /** SIGKILL, gated on a recent verified SIGTERM for the same identity. */
  async forceStop(token: string): Promise<ActionResult> {
    const auth = await this.authorize(token);
    if (!auth.ok) return auth.result;
    const { identity, targets } = auth;
    if (!this.hadRecentGraceful(identity)) {
      return {
        ok: false,
        status: "needs-graceful-first",
        message: "Send a graceful stop first. Force stop is only allowed shortly after a stop attempt.",
        pid: identity.pid,
        signaledCount: 0,
      };
    }
    const outcome = this.signalAll([identity.pid, ...targets], "SIGKILL");
    if (outcome.primaryExited) return { ok: true, status: "already-exited", message: "Process has already exited.", pid: identity.pid, signaledCount: 0 };
    if (outcome.error) return { ok: false, status: "failed", message: outcome.error, pid: identity.pid, signaledCount: outcome.delivered };
    this.graceful.delete(identityKey(identity));
    return {
      ok: true,
      status: "signaled",
      message: targets.length > 0 ? `Sent SIGKILL to PID ${identity.pid} and ${targets.length} child process(es).` : `Sent SIGKILL to PID ${identity.pid}.`,
      pid: identity.pid,
      signaledCount: outcome.delivered,
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
    typeof v.argvHash === "string" &&
    typeof v.exp === "number" &&
    Number.isFinite(v.exp)
  );
}

/** Helper for tests and handlers: identity of a raw sample as safety sees it. */
export function identityOf(process: RawProcess): ProcessIdentity {
  return { pid: process.pid, ppid: process.ppid, uid: process.uid, startId: process.startId, argvHash: hashArgv(process.argv), state: process.state };
}
