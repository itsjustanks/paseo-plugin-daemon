# Security Policy

## Daemon Link connections

Pairing codes are credentials. The authenticated Paseo RPC returns a code only after the user
selects Create pairing code. The receiving daemon stores the credential with mode 0600; the
serving daemon stores its digest. Private E2EE keys also stay in the mode-0600 peer store.
Pairings authorize discovery and TCP access to the serving OS user's unprotected services, not
Paseo agent or process-management actions. Revoke access closes existing relay sessions.

Each connection uses a fresh Paseo encrypted channel. Service identity and ownership are checked
before connecting and checked again while a connection is alive. Loopback port ownership checks
are best effort: an OS process can change the listener between a check and a TCP connect.
This is not an isolation boundary between hostile processes under one OS account.

The optional Cloudflare gate exposes only its authentication bootstrap without a session. Its
bearer credential is in a URL fragment, then exchanged for a Secure, HttpOnly cookie. The gate
rejects foreign Host/Origin values, strips its own cookie before proxying, and disconnects both
HTTP and WebSocket sockets at expiry or stop. Cloudflare terminates TLS for this fallback and
can see its application traffic; use private E2EE forwarding when that distinction matters.

Opening a web link is an explicit fallback action. Pairings and open URLs must never appear in
logs, screenshots committed to Git, generic status RPCs, or process command lines. The pairing
RPC and explicit Open RPC intentionally return credentials to the authenticated plugin client.

Optional helper installation verifies the pinned official release checksum and installs only
within the current user's Daemon Link state directory. It never uses sudo or starts a system service.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Report it privately through
[GitHub Security Advisories](https://github.com/itsjustanks/paseo-plugin-daemon/security/advisories/new)
for this repository. Include:

- What the issue is and why it matters (what can an attacker do, and under what conditions).
- Steps to reproduce, or a minimal proof of concept.
- The Monitor version and platform (Linux/macOS) you tested on.

We'll acknowledge reports and work with you on a fix and coordinated disclosure timeline before any
public write-up.

## Threat model and boundary

**Monitor is a trusted, unsandboxed Paseo plugin.** It assumes a trusted operator running it on
their own machine — it is **not** designed as a hardened boundary between mutually distrusting
users or tenants on the same host. Concretely:

- Paseo plugin server code runs with the same OS privileges as the Paseo daemon. There is no
  sandbox between Monitor's code and the machine it runs on. Installing Monitor means trusting its
  code the same way you'd trust any other script you run directly.
- Monitor's process visibility and control are **same-user only, by design**: it can see and
  stop/signal processes owned by the OS user running Paseo, and nothing else. It does not attempt
  to enforce isolation *within* that user's own processes — any process you can already see or
  kill yourself from a terminal, Monitor can also see or (with confirmation) stop.
- Action tokens exchanged with the client encode process identity (PID, uid, start time, expiry)
  plus a keyed HMAC proof computed over the server-side argv hash — never the raw argv or its hash.
  A client holding a token cannot learn or replay the underlying command line through it, and every
  primary and descendant process instance is freshly re-verified by ownership and start identity
  right before any signal is sent, not trusted from an earlier snapshot.
- Monitor does not attempt to defend against a malicious *user* of the same machine account —
  that's outside its scope. Its safety mechanisms (identity re-verification, protected-ancestor
  checks, graceful-before-force) exist to prevent Monitor itself from being the cause of an
  accidental or automated mistake (stale PID, wrong target, unconfirmed action), not to resist a
  determined local attacker who already has your user's shell access.
- If you need isolation between untrusted users or workloads on the same machine, that has to come
  from the OS (separate accounts, containers, VMs) — Monitor does not provide it and should not be
  relied on for it.

We still want to hear about anything that breaks Monitor's stated invariants (cross-user action,
privilege escalation, protected-process bypass, secret leakage) — those are real bugs, even within
a trusted-operator model.
