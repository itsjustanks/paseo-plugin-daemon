> The sidebar is now **Hosts**. For the current navigation and Project Sync workflow,
> see the [README](../README.md). Runtime identifiers below remain `daemon-link`.

# Daemon Link technical reference

Bring remote dev servers to your computer's localhost, and monitor each daemon from Paseo.

One plugin for **Paseo 0.7.2 and the upcoming 0.8 API**. Both versions provide private localhost
forwarding, service discovery, fallback tunnels, and monitoring. Hosts with the 0.8 composer API
also get a `/daemon-link` shortcut; it appears only when that capability is available.
The package is `paseo-plugin-daemon`; the runtime ID and sidebar surface are `daemon-link`.

## What each tab does

| Tab | Use it for |
| --- | --- |
| **Dev servers** | Verified dev servers with one-press Open, link state, Extend, private routes, and the guide. |
| **Connect** | Pair hosts for private localhost access, manage temporary browser links, or save SSH forwards. |
| **Daemon Health** | Read whole-machine CPU/memory and a sortable, paginated table of project processes. |

“Local” always means the selected Paseo host, which may be a remote server. To open a remote app on
your computer's localhost, select your computer's daemon in Connect first. Closing a forward or
browser link only closes access; the dev server keeps running.

## Project scope and process controls

The backend verifies directories against Paseo's project/workspace registry through the plugin SDK.
It matches directory boundaries, resolves registered roots, and includes managed worktrees. Home and
filesystem-root projects are too broad and are excluded. Unrelated processes and infrastructure
listeners are hidden. If registry verification fails, project sharing and process controls fail closed.

- Recognized web dev servers and running Paseo service scripts are eligible for sharing.
- Unknown project listeners remain read-only and cannot be shared. Register a custom server as a
  Paseo service script with its port so the plugin can verify its purpose.
- Agent tools and other project processes are read-only. Manage agents from their Paseo agent tabs.
- Stop controls appear in Daemon Health only, for verified project dev servers, after confirmation.
  Stop/force-stop rechecks current project membership and the process identity; excluded descendants
  and their children are skipped. Existing same-user and daemon-protection rules still apply.
- Process headings sort by name, PID, CPU, or memory in either direction. Pages contain 15 rows;
  desktop column headings remain above the scrolling rows.

The project registry refreshes while the plugin is used, including during service lease checks.
After a plugin/daemon restart, open Daemon Link on that host once to initialize the borrowed SDK
session. Incoming project access remains unavailable until then. This is a current plugin API
lifecycle limitation; daemon credentials are never stored to work around it.

## Platform support

Remote service discovery supports **Linux and macOS**. Receiving relay forwards uses portable Node APIs;
Windows receiving hosts are not yet verified. On an unsupported platform the
plugin loads and says so, rather than showing broken or invented numbers.

## Trust and security

**Daemon Link is a trusted, unsandboxed plugin.** Paseo runs plugin server code with the same
privileges as the Paseo daemon itself — there is no sandbox boundary between Daemon Link's code and
your machine. That means:

- Only install plugins you trust, from sources you trust. Read the source before installing,
  especially anything that touches processes.
- Daemon Link samples same-user process information to attribute work to verified Paseo projects.
  Only project-associated rows reach its UI. It cannot see or touch other users' processes.
- Daemon Link can send stop/kill signals to verified project dev servers — see [Safe
stop](#safe-stop-and-its-limits) below for
  exactly what that can and can't do.

If you wouldn't run a piece of code directly on your machine with your own user privileges, don't
install it as a Paseo plugin either.

## Privacy and redaction

Daemon Link is built to describe your machine, not leak it:

- Raw command-line arguments never leave the server: they're hashed for identity checks, and the
  version sent to the UI has secret-shaped values (tokens, passwords, API keys, auth headers,
  credentials embedded in URLs) stripped before it ever crosses the plugin boundary. The raw argv
  hash itself never crosses that boundary either — action tokens carry a keyed HMAC proof computed
  over the hash, not the hash, so a client holding a token still can't learn or replay the
  underlying argv.
- Home directory paths are shown relative to `~`, never as an absolute path that might reveal your
  username or machine layout.
- Nothing sensitive — raw argv, environment variables, action tokens, or secrets — is written to
  plugin logs.

## Pressure and thresholds

Daemon Link doesn't compute a single opaque "health score." Instead:

- **System pressure** (`normal | high | critical`) reflects sustained CPU saturation and memory
  availability — using OS pressure signals (Linux PSI, macOS memory-pressure) where the platform
  provides them, plus swap activity.
- **Per-process impact** (`idle | normal | high | pressure-driver`) is only escalated to "pressure
  driver" when the machine is *actually* under matching system pressure and that process is a
  sustained top contributor — not just because a number looks big for a moment.
- Every label comes with a short, human reason (`CPU 96% for 14s`, `12% of memory`) so you can
  check Daemon Link's homework. Sorting is always by a real column (CPU, memory, name, PID) — never by
  the hidden score.

## Safe stop and its limits

Daemon Link's stop/force-stop actions are **same-user identity-bound**: they can only signal processes
owned by the same OS user that Paseo is running as. Before sending a signal, Daemon Link re-verifies
the process's identity (PID, start time, and owning user) so a reused PID or a process that
already exited can't be hit by mistake.

What this means in practice:

- **No cross-user process control.** Daemon Link cannot stop or signal a process owned by a different
  user, even if it's technically visible to the OS (e.g. via `ps`).
- **Descendants are re-verified individually, not inherited.** When a stop/force-stop cascades to
  child processes, each descendant is freshly re-matched by owning user and process start identity
  right before it's signaled — a descendant is never trusted just because its parent matched.
- **No container or namespace escape.** Daemon Link only ever signals processes visible to it through
  the normal process table — it does not reach into containers or other PID namespaces.
- **Graceful first, always.** Stop always sends a graceful termination signal first. Force-stop is
  a separate, explicitly-confirmed action, and only becomes available after a graceful attempt has
  been made and given a chance to work.
- **Best-effort protection for important processes.** Daemon Link tries to protect its own process,
  Paseo itself, and their ancestors from being targeted — but see
  [Known limitations](#known-limitations) below for the honest edge cases.

## Install

In **Settings → Plugins**, add `itsjustanks/paseo-plugin-daemon`, or run:

```sh
paseo plugin add itsjustanks/paseo-plugin-daemon
paseo plugin ls
```

Enable plugins in Settings if necessary. Require `running` with no error, then open **Daemon Link**
in the sidebar or workspace panel. Install on both machines for localhost forwarding. Paseo runs
`npm ci --ignore-scripts` in its managed checkout automatically; no manual build is needed.
No daemon restart or SSH setup is required. If the CLI asks for a daemon password, use the already
connected app's Settings to install, or authenticate the CLI with your normal daemon password.

The same checkout contains an isolated 0.7 entry and the 0.8 runtime entries. Each loader selects its
own entry, so users do not choose branches. Compatibility is checked against 0.7.2 and pinned 0.8
preview compiler source; the final 0.8 release and native mobile rendering still need verification.

## Version-aware features

| Feature | Paseo 0.7.2 | Paseo 0.8 preview |
| --- | --- | --- |
| Pair hosts and open localhost services | Yes | Yes |
| Daemon Link, temporary HTTPS links, saved SSH forwards | Yes | Yes |
| Sidebar, workspace panel, Command Center | Yes | Yes |
| `/daemon-link` workspace composer shortcut | Hidden | Shown when supported |

The selected host's entry controls its features. Capability checks are local to that installation;
switching hosts cannot borrow a newer host's APIs or credentials. Future additions should follow
that same pattern instead of relying solely on a version string.

## Everyday use

1. Start the dev server inside a Paseo project. On that host, open
   **Connect → Private localhost → Create pairing code**.
2. Use Paseo's host picker to select the daemon running on your computer. Paste that code under
   **Pair host**. This is one-time pairing; no SSH password, key setup, or Cloudflare account is needed.
3. Choose the paired host and press **Open localhost** beside its detected service. The plugin binds
   `127.0.0.1:<port>` on your computer and opens `http://localhost:<port>` in your browser.
4. Leave both plugins running. **Close forward** closes the local port. **Revoke access** on the remote
   daemon closes active connections and invalidates that pairing.

If the requested local port is occupied, a free port is allocated and the actual URL is displayed.
A local port belongs to the **selected daemon's machine**. Select your own computer's daemon to
use localhost in that computer's browser. Phones and browser-only devices can press **Open** on a
Dev servers card, or use **Connect → Browser link** instead.

A pairing lets a trusted peer discover and connect to this OS user's verified Paseo project dev servers.
It does not grant agent, file, process-control, or daemon-management access. Pair separately in the
other direction if both machines should offer services. Pairings persist; active local listeners
close when the plugin stops. After restart, Open localhost recreates them.

The plugin uses its own identity and encrypted channel over Paseo's v2 relay protocol. It does not
reuse, modify, or restart the native daemon's relay connection or any agent provider. The
plugin API exposes only the selected host, so its saved app host credentials cannot be borrowed:
a separate plugin pairing is currently required. A future host-selection API could remove that step.

### Fallback routes

- **Temporary browser link** (Open on a Dev servers card, or Connect → Browser link) creates an
  authenticated HTTPS link to one verified project app.
  One-time setup downloads a pinned, checksum-verified `cloudflared` binary into this user's plugin
  state directory. Nothing is installed system-wide. A link lives for the configured duration (2 hours by default;
  the RPC accepts 15, 30, 60, 120, 240, or 480 minutes) and `daemon-link.tunnel.extend` renews a live
  link in place, never past 24 hours after `createdAt`. The gate's session cookie and token are
  unchanged by a renewal; only its expiry moves. Disconnect, expiry, the lifetime cap, a failed
  service lease, and plugin shutdown all revoke access.
- **Saved SSH forward** in Connect is optional; a Dev servers card's **Private forward…** opens it with
  the remote port preset. Save a hostname or SSH config alias and a port mapping on
  your local daemon.
  It uses existing keys or an SSH agent, strict known-host verification, loopback binding, keepalives,
  and reconnects. It never stores an SSH password or launches an invisible password prompt.
- **Daemon Health** contains whole-machine metrics and verified project processes.
- **Setup guide & checks**, a collapsed card under Dev servers, explains the selected host, pairing,
  the routes, and actionable setup checks.

The private relay uses outbound WebSockets over TLS (normally port 443). Set
`PASEO_DAEMON_LINK_RELAY=wss://your-relay.example` on both plugin hosts before creating pairings to
use a compatible self-hosted relay. No particular machine IP, project hostname, or framework is
embedded in forwarding. The default is Paseo's hosted relay; its availability and limits still apply.

The Cloudflare fallback uses HTTP/2 over outbound TCP port 7844, including when UDP is blocked.
It is a separate provider path, not guaranteed access through every firewall. It is never started
silently after a private connection fails: select Temporary browser link explicitly to create a browser link.
Quick Tunnels have provider limits, including no Server-Sent Events support; use private forwarding
for SSE applications. The fallback is for temporary development access, not production hosting.

### Framework behavior

Private forwarding transports bytes, including HTTP, WebSockets/HMR, and SSE. It does not patch
project files. Open the displayed `localhost` URL for Next.js's normal local-origin handling.
A custom browser hostname may still require that framework's explicit development-origin setting.

The temporary HTTPS gate validates the browser's origin and session before forwarding, then maps
Host/Origin to the selected local service. It also forwards WebSocket upgrades. Unknown origins
remain blocked; no wildcard internet origin is allowed. Frameworks that embed absolute URLs, OAuth
callbacks, HTTPS-only upstreams, or custom cookie domains may need application-specific settings.
The gate currently targets an HTTP upstream on IPv4 loopback.

## Development

```sh
git clone https://github.com/itsjustanks/paseo-plugin-daemon.git
cd paseo-plugin-daemon
npm ci
npm run typecheck
npm test
npm run test:compatibility
```

CI also runs `npm run test:coverage` (Vitest with V8 coverage and enforced thresholds) and
`npm run check:hygiene` (no secret-shaped literals outside the redaction pattern source, no
trailing whitespace or CRLF line endings, and Markdown wrapped to a readable width). Run both
before opening a PR.

Install the local checkout into a Paseo dev instance to iterate against the real app:

```sh
paseo plugin install /absolute/path/to/this-checkout --id daemon-link
paseo plugin logs daemon-link
```

## Known limitations

Daemon Link is honest about what it can't do in v1:

- **Remote discovery requires Linux or macOS.** Receiving relay forwards on Windows is not yet verified.
- **Same-user only.** No cross-user process visibility or control, by design — see
  [Safe stop and its limits](#safe-stop-and-its-limits).
- **No container/namespace escape.** Daemon Link cannot see or act on processes isolated in a
  different container or PID namespace.
- **macOS identity matching is second-precision.** Process start-time identity on macOS is only as
  precise as the OS reports it, which is coarser than Linux; in rare cases this can make identity
  re-verification slightly less exact.
- **Orphan-process race.** Between reading a process snapshot and sending a signal, a process can
  exit and its PID can be reused by an unrelated process. Daemon Link re-verifies identity immediately
  before acting to minimize this window, but it cannot be closed to zero.
- **Zombie processes.** A process that has exited but not yet been reaped by its parent will show
  up as a zombie and cannot be meaningfully "stopped" — signaling it has no effect.
- **Force-stop is never the first action.** Force-stop (`SIGKILL`) is only ever offered after a
  graceful stop (`SIGTERM`) has already been attempted — there is no direct force-kill path.

## License

MIT
