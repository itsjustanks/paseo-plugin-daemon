# Daemon Link for Paseo

**Open a remote project's dev server on your computer's localhost, directly from Paseo.**

Find running project apps, pair two Paseo hosts, and open a private local URL. Receive selected Git
projects with a preview and history. Check host health from the same place.

The plugin is **Daemon Link**; its sidebar entry is **Hosts**, matching Paseo's host terminology.

[Install](#install) · [First connection](#your-first-connection) · [Screenshots](#inside-the-plugin) ·
[Troubleshooting](#troubleshooting) · [Contributing](#development-and-contributing)

![Hosts overview with fictional projects and guided next steps.](docs/screenshots/overview.png)

*Actual plugin components rendered with fictional data. Every screenshot in this repository uses
an isolated preview: no real accounts, host addresses, project names, credentials, or conversations.*

## What you get

- **Project apps you can recognize.** Running servers grouped by registered Paseo projects and worktrees.
- **Private localhost access.** Pair hosts once, then open a remote app without typing an SSH command.
- **A route for other devices.** Temporary browser links for a phone or guest device; saved SSH forwards
  when you already use SSH keys.
- **Reviewed project transfers.** Separate sharing permissions, a commit preview, isolated checkouts,
  and persistent transfer history. Nothing syncs automatically.
- **Useful health information.** Whole-machine CPU and memory, alongside searchable project processes
  with sortable columns and 15 rows per page.
- **Guidance where you need it.** Descriptive tabs, setup checks, clear empty states, and recovery steps.

Agent Browser is not required. Daemon Link forwards traffic; your normal browser renders the app.

## Install

Add `itsjustanks/paseo-plugin-daemon` in **Paseo → Settings → Plugins**, or use the CLI:

```sh
paseo plugin add itsjustanks/paseo-plugin-daemon
paseo plugin ls
```

Enable plugins if needed, confirm **daemon-link** is `running`, and open **Hosts** from the
sidebar. Paseo installs dependencies in its managed checkout; no manual build or daemon restart
is needed. The plugin also provides a workspace panel and a Command Center entry.

Plugins run as trusted code with your daemon's privileges. Install from a source you trust.
For private localhost access, install this plugin on **both** computers running Paseo.
A browser-only device can use a temporary browser link instead.

Update a Git-managed installation with:

```sh
paseo plugin update daemon-link
```

## Your first connection

Imagine a development server running Paseo and a laptop also running Paseo. The server hosts the
app; the laptop receives a local port. You can manage either through Paseo's host picker.

```text
Development server                         Your laptop
Paseo + Daemon Link                         Paseo + Daemon Link
Project app on port 3000  <── encrypted ──  Local forward on port 3000
                             relay                   ↑
                                           Browser: localhost:3000
```

### 1. Start a project app

On the development server, open a project in Paseo, then start its normal dev command in that
project's terminal. For example:

```sh
npm run dev
```

Keep that terminal running. Open **Hosts → Local Projects** with the server selected.
Recognized apps appear automatically with their project, framework, and listening port.
The plugin discovers an existing server; opening the panel does not start your project for you.

### 2. Pair the two hosts

On the development server, open **Hosts → Dev Relay → Private localhost → Pair hosts → Create pairing code**.
Use Paseo's host picker to select your **laptop's daemon**, then paste the code under **Pair host**.

Pairing establishes permission for one host to discover and access the other's eligible project
apps. It does not grant agent, file, process-control, or daemon-management access. Pair separately
in the other direction if both computers will host apps.

### 3. Open the remote app

Keep your laptop selected. Choose the paired development server and press **Create local link**
beside its app. **Copy local URL** and open it on your laptop, or use **Open in this browser**
when this browser runs on that same computer. If the preferred local port is occupied, Daemon Link
chooses a free one instead.

**A local port belongs to the selected daemon's computer.** Selecting the remote daemon does not
create a port on your laptop. The host label and in-app guide explain this throughout the flow.

### 4. Finish or reconnect

**Close forward** removes local access while leaving the project server running. **Revoke access**
on the hosting daemon removes a peer's permission and closes its active connections.

Pairings persist. Active forwards close when the plugin stops; use **Create local link** to recreate
them. After a plugin or daemon restart, open Hosts on the hosting daemon once to initialize
project access. Both plugins must remain running while you use a connection.

## Inside the plugin

| Tab | What to do here |
| --- | --- |
| **Overview** | Start with a task, see host totals, and follow the next setup step. |
| **Local Projects** | Find and search running apps on the selected host; choose one to access from another device. |
| **Dev Relay** | Pair hosts, open localhost forwards, or choose a temporary browser link or saved SSH forward. |
| **Project Sync** | Share selected Git projects, review a transfer, and inspect receive history. |
| **Daemon Health** | Check CPU and memory; search, sort, and inspect processes associated with Paseo projects. |
| **Guide & Setup** | Follow the walkthrough and check project discovery, pairing, relay state, and optional helpers. |

The same six tabs appear in the **Hosts** sidebar surface. Each workspace also gets a **Hosts** tab;
what it shows depends on the panel scope setting described below.

### Hosts workspace tab: only what belongs to this workspace

By default the workspace tab narrows the host view to the open workspace: dev servers and other
processes whose working directory sits inside the workspace directory (or that share one of its
ports), plus any temporary browser links pointing at those ports. Stop and force-stop controls are
the same as in Daemon Health and keep the same server-side checks. Switch the scope to **Whole
host** to get the full Hosts surface inside the tab instead.

### Settings: Hosts

Open **Settings → Plugins → Daemon Link → Hosts**, or run **Configure Hosts** from the Command
Center. Settings are saved per host and shared by every client of that host.

| Setting | Default | Effect |
| --- | --- | --- |
| Panel shows | This workspace only | Workspace tab lists only the workspace's processes, or the whole host. |
| Refresh interval | 20 seconds | How often the workspace tab re-reads the host (5–120 seconds). |
| Close browser links on archive | On | Archiving a workspace stops browser links that point at its dev servers. |

Archive cleanup runs on the daemon, so it works even when no app is connected. It only stops
temporary browser links; the dev server itself keeps running. If the saved settings file cannot be
read, cleanup is skipped rather than guessed.

### Local Projects: apps with a recognizable owner

![Local Projects with fictional running apps.](docs/screenshots/local-projects.png)

### Dev Relay: choose an access method

![Dev Relay explains private localhost access between fictional hosts.](docs/screenshots/dev-relay.png)

| Method | Best fit | What it requires |
| --- | --- | --- |
| **Private localhost** | Two Paseo computers; HMR, WebSockets, SSE | Daemon Link on both hosts and one-time pairing |
| **Temporary browser link** | Phone or guest device; another network route | Explicit helper setup on the app host |
| **Saved SSH forward** | Existing SSH workflow | SSH keys/agent and a trusted known host |

**Remote apps**, **Pair hosts**, and **Manage access** keep everyday connections separate from
pairing and revocation. Creating a link shows the receiving host and a copyable URL; it does not
automatically open a browser on a potentially different computer.

Private forwarding uses an encrypted channel over Paseo's relay with outbound TLS WebSockets,
usually on port 443. Machines do not need to share a LAN or accept new inbound ports.
You may configure a compatible self-hosted relay using `PASEO_DAEMON_LINK_RELAY` on both hosts.

Temporary browser links use an authenticated HTTPS gate and expire after 30 minutes in the UI.
The optional Cloudflare helper is pinned and checksum-verified, and installed only in the plugin's
user state directory. Links are created explicitly; a failed private connection never silently
publishes an app. Cloudflare Quick Tunnels do not support SSE and cannot bypass every firewall.

Saved SSH forwarding uses your existing keys and strict host verification. It does not store SSH
passwords or wait on a hidden password prompt.

### Project Sync: preview before receiving

![A fictional project transfer preview.](docs/screenshots/project-sync.png)

This brings the Sync plugin's selected-project, preview, and history workflow into Hosts using
its existing encrypted relay. Install this version on both hosts; no SSH credentials are needed.

1. Pair the hosts under **Dev Relay → Private localhost → Pair hosts**.
2. Select the source in Paseo. Open **Project Sync → Share with a host** and allow a project for
   the intended pairing code. Existing pairings start with **no project access**.
3. Select the receiving host. Under **Receive a project**, choose the source and preview a project.
4. Review its commit, history count, and size. Press **Receive into a new checkout** when ready.
5. **Transfer history** shows the result and a copyable directory. Add that directory as a Paseo
   project when you want to work on it.

Each receive is a new checkout under the plugin's private state directory. Existing projects,
branches, and working files stay in place. One receive runs at a time; the latest 50 results persist.
Clearing project permission stops future downloads. It cannot remove a copy already received.

The first version transfers the selected repository root's **committed HEAD and reachable history**,
up to **32 MiB**, with a preview that expires in ten minutes. It verifies the received bytes against
that preview. Projects must be registered in Paseo at their Git repository root.

This is an explicit transfer workflow, not continuous folder mirroring, a mounted drive, or an
automatic backup. It does not include uncommitted or untracked files, chat sessions, daemon settings,
Git LFS objects, or submodule contents. **Files already committed to Git travel with its history**,
including private data or secrets someone committed. Review the project before granting access.
No project permission or transfer is enabled by installing or updating the plugin.

### Daemon Health: manageable process lists

![Daemon Health shows sortable, paginated fictional project processes.](docs/screenshots/daemon-health.png)

Click **Process**, **PID**, **CPU**, or **Memory** to sort; click again to reverse the order.
Search by process or project, and use the page controls to browse 15 rows at a time. Expand a row
for details. Agents and unknown project tools are read-only; manage agents from their Paseo tabs.

Stop controls appear only for recognized project servers and require confirmation. The backend
rechecks project membership and process identity before acting. Force-stop is available only
after a graceful stop attempt.

### Guide & Setup: start with the next step

![Guide and Setup on a narrow screen with a light theme.](docs/screenshots/guide-mobile.png)

The guide explains which host to select, how to start a project server, how pairing works, and
what to try when discovery or a connection fails. Setup checks report observed state rather than
assuming that a saved pairing means the other machine is online.

## Scope, privacy, and limits

Daemon Link verifies project directories and workspaces through Paseo's SDK, then matches them
against the server's process working directories. A dev server started manually inside a registered
project can qualify too; the plugin does not claim every matching process was launched by Paseo.

- Unrelated listeners and infrastructure processes are hidden. Broad home-directory or filesystem-root
  projects are excluded; register each project directory separately.
- Unknown project tools and agents are read-only. Custom web servers can be registered as running
  Paseo service scripts with explicit ports.
- If project verification fails, sharing and process controls pause. Global health stays readable.
- Process commands are redacted before display, paths are home-relative, and secrets are not logged.
- Pairing codes and temporary access links grant access. Share them only with the intended recipient.

Discovery and process monitoring support **Linux and macOS**. Receiving forwards on Windows and
native mobile rendering remain unverified. The plugin loads an explicit unsupported state where
appropriate. macOS identity checks use the precision provided by that OS; process-stop race windows
cannot be eliminated completely.

See the [technical reference](docs/technical-reference.md) for process protections, relay behavior,
framework handling, pressure thresholds, and known limitations.

## Paseo compatibility

Requires Paseo 0.8 or newer. Version 0.5.0 moved to the 0.8 runtime layout: `index.client.tsx`
and `index.server.ts` entries with code under `client/`, `server/`, and `shared/`, and
`requirements.paseo` set to `>=0.8.0`. Paseo 0.7 hosts should stay on 0.4.0.

Features depend on the selected host's actual capabilities, so a newer host never lends its APIs
to an older one. The `/daemon-link` composer shortcut appears only when the host provides that API.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No apps listed | Start the app in a registered project. Refresh Local Projects; check the selected host. |
| Custom server is missing | Configure it as a Paseo service script with its listening port. |
| Project access is unavailable | Open Hosts on that host after restart; refresh project access. |
| Localhost opens the wrong app | Select your receiving daemon and use the exact URL beside its forward. |
| Private connection fails | Keep both plugins running; check the peer and outbound relay access. |
| Phone has no Paseo daemon | Create a temporary browser link on the app host. |
| No shared projects | Grant project access on the source, separately from dev relay pairing. |
| Preview cannot be prepared | Register the Git root; ensure it has a commit and history fits the size limit. |
| Transfer failed | Check both hosts, preview again, and inspect Transfer history. Existing projects stay intact. |
| SSH reports authentication failure | Check SSH keys/agent and known hosts; password prompts are unsupported. |
| Next.js blocks a dev resource | Use the displayed localhost URL; custom hostnames need explicit `allowedDevOrigins`. |
| Live updates fail on a browser link | Use private forwarding for SSE; check app URLs and cookie settings. |

Daemon Link does not patch project configuration. Applications with absolute URLs, OAuth callbacks,
custom cookie domains, or HTTPS-only upstreams may need their own settings. Temporary browser links
currently target HTTP services on IPv4 loopback.

## Development and contributing

```sh
git clone https://github.com/itsjustanks/paseo-plugin-daemon.git
cd paseo-plugin-daemon
npm ci
npm run typecheck
npm test
npm run test:compatibility
npm run test:coverage
npm run check:hygiene
```

For a safe UI preview:

```sh
npm run preview:ui
# Open http://127.0.0.1:43197
```

The preview substitutes plugin RPCs with fictional fixtures and does not connect to Paseo.
Use `?light`, `?empty`, `?error`, or `?unverified` to inspect theme and recovery states.
See [screenshot instructions](docs/screenshots/README.md) before refreshing public images.

The runtime ID is `daemon-link`; the package name is `paseo-plugin-daemon`. Install a local checkout
in a development daemon with `paseo plugin install /absolute/path/to/checkout --id daemon-link`.
Use `paseo plugin reload daemon-link` after source changes; a daemon restart is unnecessary.

## Acknowledgments

The selected-project, preview, and history workflow draws on
[itsjustanks/paseo-plugin-sync](https://github.com/itsjustanks/paseo-plugin-sync).
The transfer implementation here uses Daemon Link's relay and separate per-project permissions.

## License

[MIT](LICENSE)
