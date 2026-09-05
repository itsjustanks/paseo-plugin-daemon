# Contributing to Daemon Link

Thanks for looking at Monitor's code. This is a **trusted, unsandboxed** Paseo plugin that reads
process information and can send stop/kill signals — so the bar for changes that touch process
control or data collection is higher than a typical UI PR.

## Setup

```sh
git clone https://github.com/itsjustanks/paseo-plugin-daemon.git
cd paseo-plugin-daemon
npm install
npm run typecheck
npm test
```

## Safety invariants (non-negotiable)

Any change touching process discovery, collection, or the stop/force-stop path must preserve every
one of these. A PR that weakens one of these will not be merged, no matter how it's framed.

- **Same-user only.** Monitor must never gain the ability to see or act on a process owned by a
  different OS user, escalate privileges, or reach across a container/namespace boundary. If a
  change makes cross-user visibility or control even theoretically possible, it's out.
- **Identity is re-verified at action time, not just at discovery time.** A process seen in a
  snapshot must be re-checked (PID, start-time identity, owning user) immediately before any signal
  is sent — including every descendant a cascading stop touches, each matched individually against
  its own start identity, not inherited from the parent's match. Acting on stale identity from an
  earlier read is not acceptable — PIDs get reused.
- **Protected processes stay protected.** Monitor's own process, the Paseo daemon/supervisor, PID 1,
  kernel/uid-0 processes, zombies, and every ancestor up through Paseo must remain unkillable
  through Monitor, and this protection must be checked freshly, not cached.
- **Graceful before force, always.** There is no direct force-kill path. `forceStop` must only be
  reachable after a verified graceful attempt has already been made and given time to work, and it
  must re-verify the same identity before escalating.
- **No blind process-group signaling.** Never signal a process group wholesale — that can kill the
  shell or terminal that launched a target process, not just the target.
- **No silent destructive actions.** Stop and force-stop are always explicit, user-initiated, and
  clearly confirmed in the UI. There is no "stop everything" / bulk-kill action in v1, and none
  should be added without a fresh security review.
- **Redaction happens before data leaves the server boundary.** Secret-shaped values (tokens,
  passwords, keys, credentials in URLs) must never reach the client, logs, or test fixtures in raw
  form. Raw argv and its hash are server-side only; when an action token needs to prove argv
  identity across the RPC boundary, it carries a keyed HMAC proof over the hash, never the hash
  itself.

## Making changes

- Keep collection code free of shell string interpolation — use Node built-ins, direct procfs
  reads, or fixed-argv `execFile` calls only. No `exec` with a composed shell string.
- If you touch `server/safety.ts`, `server/handlers.ts`, `server/redaction.ts`, or the platform
  collectors, add or update tests that exercise the specific invariant you touched
  (tampered/expired tokens, reused PIDs, uid mismatches, protected ancestors, force-without-graceful
  denial, etc.) — not just the happy path.
- Test fixtures must not contain literal credential-shaped strings. Build synthetic secrets at
  runtime from fragments (see `tests/synthetic-secrets.ts`) so generic secret scanners stay quiet
  while the redaction logic is still genuinely exercised.
- Run `npm run typecheck`, `npm run test:coverage`, and `npm run check:hygiene` before opening a
  PR — CI runs the same three.
- Describe in your PR what you tested manually, especially for anything in the stop/force-stop
  path — automated tests alone aren't enough sign-off for that code.

## Reporting a security issue

Connection work must include tests for authentication, revocation, bounded buffering, port conflicts,
and shutdown. Tests must use loopback fixtures and synthetic credentials. Do not open real developer
services through a public relay or tunnel as part of the default test suite. Keep Node imports in
`server/`, UI imports in `client/`, and contracts in `shared/`. See `types/README.md` for the v0.8
preview declaration boundary and its validation limits. Run `npm run test:compatibility` for both
entry formats. The small `index.ts` adapter is intentional: only 0.7 loads it. Keep its registrations
aligned with the runtime entries, and never import it from a 0.8 runtime module.

Please don't open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md) for
how to report one privately.
