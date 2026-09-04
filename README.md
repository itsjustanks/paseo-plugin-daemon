<div align="center">

# paseo-plugin-monitor

**Machine pressure, made obvious — right inside Paseo.**

[![CI](https://github.com/itsjustanks/paseo-plugin-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/itsjustanks/paseo-plugin-monitor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Linux-informational)
![Paseo](https://img.shields.io/badge/Paseo-plugin-8A63D2)

</div>

**Monitor** is a Paseo plugin that answers one question at a glance: *is this machine under load,
and what's causing it?* It shows live CPU and memory pressure, the dev servers and listening
processes running on your box, and the specific user processes eating resources — then lets you
stop the offending one without leaving Paseo.

## Features

- **System pressure at a glance** — current CPU and memory usage, load averages, swap, and a plain
  `normal / high / critical` pressure state with the reasons behind it (not a mystery score).
- **Dev servers and listening processes** — anything with an open port gets surfaced, with a
  best-effort label (`vite`, `next`, `uvicorn`, …) when the command pattern is recognizable, and an
  honest **Listening Process** label when it isn't.
- **Process attribution** — a searchable, sortable table of your own processes (CPU, memory, age,
  state) so you can see exactly what's driving the number at the top.
- **Safe stop** — send a graceful stop to a process you own, with an explicit, separately-confirmed
  force path if it doesn't exit.

<!-- screenshot: dashboard overview -->
<!-- screenshot: processes tab with search and sort -->
<!-- screenshot: stop / force-stop confirmation flow -->

## Platform support

Monitor supports **Linux and macOS**. There is no Windows build. On an unsupported platform the
plugin loads and says so, rather than showing broken or invented numbers.

## Trust and security

**Monitor is a trusted, unsandboxed plugin.** Paseo runs plugin server code with the same
privileges as the Paseo daemon itself — there is no sandbox boundary between Monitor's code and
your machine. That means:

- Only install plugins you trust, from sources you trust. Read the source before installing,
  especially anything that touches processes.
- Monitor can read process information (command lines, working directories, resource usage) for
  processes owned by the same OS user running Paseo. It cannot see or touch other users' processes.
- Monitor can send stop/kill signals — see [Safe stop](#safe-stop-and-its-limits) below for
  exactly what that can and can't do.

If you wouldn't run a piece of code directly on your machine with your own user privileges, don't
install it as a Paseo plugin either.

## Privacy and redaction

Monitor is built to describe your machine, not leak it:

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

Monitor doesn't compute a single opaque "health score." Instead:

- **System pressure** (`normal | high | critical`) reflects sustained CPU saturation and memory
  availability — using OS pressure signals (Linux PSI, macOS memory-pressure) where the platform
  provides them, plus swap activity.
- **Per-process impact** (`idle | normal | high | pressure-driver`) is only escalated to "pressure
  driver" when the machine is *actually* under matching system pressure and that process is a
  sustained top contributor — not just because a number looks big for a moment.
- Every label comes with a short, human reason (`CPU 96% for 14s`, `12% of memory`) so you can
  check Monitor's homework. Sorting is always by a real column (CPU, memory, name, PID) — never by
  the hidden score.

## Safe stop and its limits

Monitor's stop/force-stop actions are **same-user identity-bound**: they can only signal processes
owned by the same OS user that Paseo is running as. Before sending a signal, Monitor re-verifies
the process's identity (PID, start time, and owning user) so a reused PID or a process that
already exited can't be hit by mistake.

What this means in practice:

- **No cross-user process control.** Monitor cannot stop or signal a process owned by a different
  user, even if it's technically visible to the OS (e.g. via `ps`).
- **Descendants are re-verified individually, not inherited.** When a stop/force-stop cascades to
  child processes, each descendant is freshly re-matched by owning user and process start identity
  right before it's signaled — a descendant is never trusted just because its parent matched.
- **No container or namespace escape.** Monitor only ever signals processes visible to it through
  the normal process table — it does not reach into containers or other PID namespaces.
- **Graceful first, always.** Stop always sends a graceful termination signal first. Force-stop is
  a separate, explicitly-confirmed action, and only becomes available after a graceful attempt has
  been made and given a chance to work.
- **Best-effort protection for important processes.** Monitor tries to protect its own process,
  Paseo itself, and their ancestors from being targeted — but see
  [Known limitations](#known-limitations) below for the honest edge cases.

## Install

### From GitHub (recommended)

```sh
paseo plugin add itsjustanks/paseo-plugin-monitor --id monitor
```

### From a local checkout

```sh
git clone https://github.com/itsjustanks/paseo-plugin-monitor.git
paseo plugin add ./paseo-plugin-monitor --id monitor
```

Open **Monitor** from the Paseo sidebar once it's installed and running.

## Usage

- **Overview** shows current CPU and memory pressure, load averages, uptime, swap, any processes
  currently flagged as pressure drivers, and every detected dev server / listening service with its
  port, working directory, and resource usage.
- **Processes** is a searchable, sortable list of your own processes. Expand a row to see its full
  resource detail and stop it.

## Development

```sh
git clone https://github.com/itsjustanks/paseo-plugin-monitor.git
cd paseo-plugin-monitor
npm install
npm run typecheck
npm test
```

CI also runs `npm run test:coverage` (Vitest with V8 coverage and enforced thresholds) and
`npm run check:hygiene` (no secret-shaped literals outside the redaction pattern source, no
trailing whitespace or CRLF line endings, and Markdown wrapped to a readable width). Run both
before opening a PR.

Install the local checkout into a Paseo dev instance to iterate against the real app:

```sh
paseo plugin add /path/to/paseo-plugin-monitor --id monitor
paseo plugin logs monitor
```

## Known limitations

Monitor is honest about what it can't do in v1:

- **No Windows support.** Linux and macOS only.
- **Same-user only.** No cross-user process visibility or control, by design — see
  [Safe stop and its limits](#safe-stop-and-its-limits).
- **No container/namespace escape.** Monitor cannot see or act on processes isolated in a
  different container or PID namespace.
- **macOS identity matching is second-precision.** Process start-time identity on macOS is only as
  precise as the OS reports it, which is coarser than Linux; in rare cases this can make identity
  re-verification slightly less exact.
- **Orphan-process race.** Between reading a process snapshot and sending a signal, a process can
  exit and its PID can be reused by an unrelated process. Monitor re-verifies identity immediately
  before acting to minimize this window, but it cannot be closed to zero.
- **Zombie processes.** A process that has exited but not yet been reaped by its parent will show
  up as a zombie and cannot be meaningfully "stopped" — signaling it has no effect.
- **Force-stop is never the first action.** Force-stop (`SIGKILL`) is only ever offered after a
  graceful stop (`SIGTERM`) has already been attempted — there is no direct force-kill path.

## License

MIT
