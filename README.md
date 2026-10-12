# Daemon Link for Paseo

**Keep a Paseo host healthy, and open its dev servers in one press.**

See what is using a host's CPU and memory, against the container's own limit, and stop a runaway
build safely after a list of exactly what will stop. Watch services on other machines, such as
OmniRoute. See every dev server running on a host, press **Open**, and it appears in your browser.
Pair two Paseo hosts for a private local URL, or save an SSH forward. Receive selected Git projects
with a preview and history.

Supports Paseo 0.7 through 0.11 (current releases need 0.9 or newer; see
[Paseo compatibility](#paseo-compatibility)).

The plugin is **Daemon Link**; its sidebar entry is **Hosts**, matching Paseo's host terminology.

[Install](#install) · [One-press Open](#open-a-dev-server-in-one-press) ·
[Private connection](#your-first-private-connection) · [Screenshots](#inside-the-plugin) ·
[Troubleshooting](#troubleshooting) · [Contributing](#development-and-contributing)

![Hosts Overview: the state in words, memory against its limit, heavy jobs.](docs/screenshots/overview.png)

*Actual plugin components rendered with fictional data. Every screenshot in this repository uses
an isolated preview: no real accounts, host addresses, project names, credentials, or conversations.*

## Headless work in 0.19.0

[Feature sources and integration status](docs/feature-sources.md) maps the supplied references to this release.

Select the always-on **remote host** in Paseo. Under **Processes → Browsers**, watch an existing Agent Browser
session and select its tab. Workspace table **Watch browser** actions and a workspace's **Agent browsers**
panel scope the list to a verified workspace. The browser keeps running on the selected host when the viewer
closes. A sleeping laptop cannot keep its own local host running.

Capture travels over authenticated Paseo RPC into the native panel, including web/mobile. It does not use
`navigation.openBrowser`, which creates a local desktop tab. Hosts never installs a browser or starts a
missing session. Same-user local Chromium CDP listeners must be proven; unsupported sessions explain why.
[Support and limits](docs/browser-viewing.md).

**Connections** guides setup for agents across computers. Agent access stays off until confirmed and shares full
daemon authority between opted-in hosts, independently of restricted private app/file grants. Turning off
clears local peers and pending deliveries; revoke previously shared pairing credentials separately. Requires
connected-host APIs; older runtimes show an update explanation. [Integration and security
boundary](docs/cross-daemon-integration.md).

**Recover another host** on Overview or in Command Center opens Connections' SSH recovery fold. Select an online
helper in Paseo first. Save a target hostname or SSH alias and a local key/config reference; test SSH
explicitly, then review any start, restart, saved-connection removal or reboot.
No credentials are configured by default. No
background SSH, arbitrary saved commands, browser-control commands or automatic recovery. If all helpers are
offline, use the provider console. [Headless setup and recovery](docs/headless-setup.md).

MIT sources: browser transport patterns adapted from [Omer Cohen's shared
browser](https://github.com/omercnet/paseo-plugins/tree/daed6eb12f4156ca392f71c48e7a9ccca231ae8c/paseo-shared-browser)
([retained notice](server/browser-LICENSE.txt)); cross-daemon adapted from
[maxwell-01/maxs-paseo-plugins](https://github.com/maxwell-01/maxs-paseo-plugins/tree/975f8c4c062cb78ca82b203c8952e6c31621a9e6/cross-daemon)
([retained notice](docs/cross-daemon-LICENSE.txt)). See the pinned source notes for exact provenance.

## What you get

- **Heavy processes, first-class.** The Processes tab lists the heaviest processes with how long
  they have run and which workspace or dev server they belong to, groups each build or test run with
  everything it started, and flags runaways: a process holding a full CPU core for minutes, memory
  near the container's limit, or more heavy jobs at once than your limit (4 by default).
- **Memory against the real limit.** Inside a container, Daemon Link reads the container's own
  memory limit (cgroups), so "6.9 GB of 7.3 GB" is judged against what actually stops processes,
  not the 64 GB machine. On macOS it uses the whole machine.
- **A safe stop.** Select processes, see exactly what will stop (children included) and what won't,
  then stop: each is asked to exit, and anything still running after 10 seconds is stopped
  forcefully. Paseo itself, its plugins, agents, terminals and databases are never stopped, and
  every stop is logged.
- **Runaway memory, early.** A job holding a quarter of memory, or growing fast, is flagged in plain
  words ("A test run is using 36 GB, 61% of this computer's memory"), as is memory pressure, from a
  check loop that runs every 10 seconds even when Paseo is closed. Stop or Ask an agent sits beside
  it. An optional guard (off by default) stops the biggest stoppable job when memory stays nearly
  full for over a minute.
- **Disk usage and reviewed cleanup.** Free space at a glance (the sidebar dot warns at 85%
  full), every Paseo workspace by size with its status and what looks safe to clear, and shared
  caches and temporary files by size. Delete offers only verified tool-managed workspace folders,
  behind a warning listing exactly what will go. Shared caches, temporary folders and ambiguous
  contents use "Ask an agent to clean this up" with the list and checks to perform. A workspace's
  own Hosts tab speaks up
  when 500 MB or more of it looks safe to clear (or the disk is 85% full), the chip under the message
  box appears at 95% full, and the Hosts attachments include a Disk report. Linux Housekeeping
  separately offers automatic cleanup after its live-mode confirmation; it starts in preview.
- **Stuck plugins, restarted in one press.** When a Paseo plugin stops answering ("Activity isn't
  answering (12 timeouts in 10 min)"), Paseo can't add, update or reload plugins. Restart reloads just
  that plugin; if Paseo is stuck on it, Hosts stops only that plugin's own process and reloads it. The
  daemon is never restarted.
- **Watched services.** Add health URLs on other machines (such as the AI Router's OmniRoute, offered
  in one press when that plugin is set up). A slow or failing answer shows on the sidebar dot and the
  Overview card in plain words: "OmniRoute is slow: 4.2 s, usually 110 ms".
- **Native on Paseo 0.11.** A full Hosts screen with its own sidebar row and a status dot that opens
  a quick health check. Older apps keep the 0.9 sidebar surface.
- **One press to open.** Every verified dev server on the host is a card with an **Open** button, in
  the Hosts sidebar and in each workspace's Hosts tab. Open starts a browser link (or reuses the live
  one) and lands your browser on the app; the card shows starting, ready with time left, or why not.
- **Links that last a work session.** Browser links default to 2 hours (15 minutes to 8 hours in
  Settings), show their remaining time, and **Extend** in place without a new URL, up to 24 hours.
- **Private routes, side by side.** Pair hosts once for a private localhost link, or save an SSH
  forward preset to the server's port; nothing is published. The surface says when each is right.
- **Reviewed project transfers.** Separate sharing permissions, a commit preview, isolated checkouts,
  and persistent transfer history. Nothing syncs automatically.
- **Automatic health checks.** The daemon re-checks hosts on a schedule and flags a dev server that
  stopped serving, a failed browser link, an SSH forward that is down, a runaway, memory near the
  limit, too many heavy jobs, or a slow watched service, per workspace.
- **What this workspace costs.** The workspace tab sums the CPU and memory of the workspace's own
  processes and shows each as a share of the host, so you can tell a loaded machine from a loaded
  workspace.
- **A chip only when a chat needs you.** Under an agent's message box, a chip appears only when that
  workspace's dev server stopped, a link to it failed, or one of its jobs drives the host's load. It
  opens the Hosts tab for that workspace. A calm chat shows nothing; host-wide health is the sidebar
  dot's job.
- **Guidance where you need it.** Five tabs, technical parts folded into rows you open in place, and
  a Help tab of plain questions with live setup checks on Overview.

Agent Browser is not required. Daemon Link forwards traffic; your normal browser renders the app. The
app cannot be rendered inside Paseo itself: the plugin SDK has no WebView and no plugin HTTP route,
so a browser link, a paired-host forward, or an SSH forward is always the mechanism. Daemon Link's
job is to make that one press.

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

## Open a dev server in one press

With the remote host selected, open **Hosts → Workspaces** (or the **Hosts** tab of the workspace
the server runs in) and press **Open in browser** on its card. Daemon Link reserves a browser tab,
starts a temporary HTTPS link to that port (or reuses the live one), and sends the tab there once the
link is connected. The card reads **Starting link**, then **Link ready · 2 h left**, or **Link
failed** with the reason. Press **Extend** to renew a live link without a new URL, or **Close link**
when you are done. The dev server itself is never touched.

A browser link is a public URL protected by a private session cookie and by the service lease, and it
always expires. If you would rather publish nothing, switch the card row to **Private forward**: it
shows the same servers with an **SSH forward…** button that presets the remote port, and a
**Paired-host link…** button for the private relay described next.

## Your first private connection

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

Keep that terminal running. Open **Hosts → Workspaces** with the server selected.
Recognized apps appear automatically with their project, framework, and listening port.
The plugin discovers an existing server; opening the panel does not start your project for you.

### 2. Pair the two hosts

On the development server, open **Hosts → Connections → Private apps and project files → Pair hosts
→ Create pairing code**.
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
| **Overview** | The host's state in words; problems, watched services, setup, Project Sync and details fold out. |
| **Processes** | Heaviest processes, runaways, memory against the limit, the ask-first stop; recent stops fold out. |
| **Workspaces** | Current running-app snapshot with ownership, resources, Open and reviewed Stop; disk below. |
| **Connections** | Add computers, review agent access, private apps/files, SSH forwards and SSH recovery. |
| **Help** | Plain questions, each folded, starting with how Hosts works. |

Connections is a dedicated top-level tab. Old Connect, Pair, SSH and recovery links still open their
sections. Project Sync remains on Overview. Running apps are independent of disk measurements and
show up to 50 listeners from the current snapshot. Memory defaults highest first; CPU, workspace,
project, app, port and status can also be sorted. Unknown ownership stays visible.

A server labelled **Listening · waiting for requests** is waiting for work, not an offline computer.
A listening port does not prove app health. Stop first previews ownership warnings and affected children,
with Cancel as the default. Running-app Stop requests a graceful exit; Force stop is reviewed separately
if it remains running. Open remains restricted to verified shareable project ports.

Each workspace also gets a **Hosts** tab, in the workspace view and in the Projects explorer; what it
shows depends on the panel scope setting described below.

### Hosts workspace tab: only what belongs to this workspace

By default the workspace tab leads with **Dev servers in this workspace**: one card per verified dev
server whose working directory sits inside the workspace, each with the same **Open**, link state,
**Extend**, and **Close link** controls as the sidebar surface. A **Health** card follows: the
workspace's status, how many verified dev servers run inside it and on which ports, when the daemon
last checked, and every issue that touches it. Then a **Resources** card: the summed CPU and resident memory of the
workspace's processes, how many processes that is, and each figure as a share of the host (CPU
against the machine's cores and its current load; memory against total and used memory). The
numbers come from the same sample as the process rows; a process the host has not measured twice yet
is reported as still sampling rather than as zero, and a share is left out when the host total it
needs is not available. Below that come the other processes whose working directory sits inside the
workspace directory (or that share one of its ports), plus any temporary browser links pointing at
those ports with their remaining time. Its stop and force-stop controls apply to verified dev
servers and keep the same server-side checks; heavy builds and tests are stopped from Processes.
Switch the scope to **Whole host** to get the full Hosts surface
inside the tab instead; the whole-host surface shows machine totals, not a per-workspace rollup.

### Health checks and the composer pill

The daemon evaluates host health on the refresh interval and caches one verdict, so every panel and
pill reads the same result instead of probing the host. A host or workspace is flagged when:

- the host cannot be read, or its Paseo projects cannot be verified;
- a dev-server port that was serving at a recent check is no longer served by anything;
- a temporary browser link is in the error state;
- a saved SSH forward is retrying, or is set to auto-connect but is not running;
- a project process is a zombie;
- CPU or memory pressure is critical, or the container's memory is near its limit;
- more heavy jobs run at once than your limit, or a process has held a full CPU core for two minutes;
- a watched service is slow or doesn't answer;
- a project process is one of the top CPU or memory users while the host is under matching
  pressure. This is the only way a workspace is blamed for host load: a busy process on a quiet
  host, or a quiet workspace on a busy host, never triggers it.

An agent's composer gets a small chip only when its workspace needs attention: `Dev server :3000
stopped`, `Browser link :3000 failed`, `Forward :3000 down`, `Runaway: tsc` or `Driving host load`.
Pressing it opens the Hosts tab for that workspace. Healthy dev servers never earn a chip, and
neither does host-wide trouble (memory, CPU, a watched service, an unreachable host): that shows on
the dot beside **Hosts** in the sidebar, whose quick check opens on a press. The chip never shows
CPU or memory figures. The verdict never carries tokens, link URLs, or raw command lines.

### Ask an agent to fix it

Beside a runaway process, a dev server that stopped, or a watched service that is slow or down,
**Ask an agent** writes a plain message for a chat in that workspace (or a new chat there): what's
wrong, the figures, the last 50 lines of the dev server's output when Hosts can find them, and a
suggested next step. You see the exact text before it is sent. Secrets are removed on the daemon
first, and a busy chat is steered rather than interrupted. **Hosts** is also in the message box's
attach menu (heavy processes, what needs attention, a dev server's output, a watched service), and
each dev server's card can **Open a terminal here** in its folder.

The common actions are also commands. In the Command Center: **Open Hosts**, **Show heavy
processes**, **Check host now**, **Check disk space**, **Clean up disk space** and **Configure
Hosts**. In a chat's message box (when the app supports slash commands): `/hosts`,
`/heavy-processes`, `/check-host` and `/disk` (`/disk clean` asks an agent to clean up). There is no sidebar
footer item: the sidebar row's dot already says the same thing on every app that has one.

### Settings: Hosts

Open **Settings → Plugins → Daemon Link → Hosts**, or run **Configure Hosts** from the Command
Center. Settings are saved per host and shared by every client of that host.

| Setting | Default | Effect |
| --- | --- | --- |
| Panel shows | This workspace only | Workspace tab lists only the workspace's processes, or the whole host. |
| Refresh interval | 30 seconds | How often health is checked and the workspace tab re-reads the host (5–120 seconds). |
| Check host health in the background | On | The daemon re-checks on the refresh interval; off means only on demand. |
| Show a chip when a chat needs attention | On | Show the attention-only chip described above. |
| Link duration | 2 hours | How long Open keeps a new browser link alive, and what each Extend adds (15 min–8 h). |
| Close browser links on archive | On | Archiving a workspace stops browser links that point at its dev servers. |
| Heavy jobs at once | 4 | More builds, tests and dev servers than this is flagged; nothing stops on its own. |
| Stop a runaway automatically… | Off | Memory nearly full for a minute: stop an eligible job with verified origin. |
| Watched services | None | Health URLs elsewhere (http/https, no secrets), checked at most every 30 s. |

Archive cleanup and background health checks run on the daemon, so they work even when no app is
connected. Cleanup only stops temporary browser links; the dev server itself keeps running. If the
saved settings file cannot be read, cleanup is skipped rather than guessed. Settings saved by 0.6.0
through 0.17.0 are migrated in place: every value you chose is kept and new settings take their
defaults. Defaults are safe on a shared team daemon: nothing is published, paired or stopped until
someone presses a button, enables the memory guard, or confirms live Housekeeping.

### Housekeeping (0.18.0, Linux only)

**Processes → Housekeeping** is a small, folded row. Open it for free RAM, 1-minute load, each job's
last run, and the latest 20 redacted results and reasons. It starts enabled **in preview**, including
when upgrading an existing host. Preview records decisions and audit state; it does not change
processes, caches, browser profiles or helper scripts. Turn off **Preview only** to review the live-mode
warning. Cancel is the default; only **Turn on live Housekeeping** authorizes automation. The same
controls, schedules and numeric limits live in **Settings → Hosts → Housekeeping**, per selected host.

Live mode works while the app is closed. Its default schedules are:

- Every minute, lower matching builds/tests to nice 10 and agent Chrome processes to nice 5. Only
  the daemon's OS user, only increases to nice, never Paseo, plugin hosts or agent CLIs. Linux nice
  is per thread: only the main PID is changed; existing worker threads keep their priorities.
- Every hour, individually authorize leftover Chrome/session processes, agent-browser daemons,
  crash reporters and old orphaned `supabase db query` processes. Each needs its own `PASEO_AGENT_ID`
  and a fresh matching Paseo answer: closed, or validated archived status with an archive timestamp.
  Running/initializing, open idle, unknown, failed and timed-out lookups refuse. Age alone never
  authorizes a stop. A Supabase query also needs parent PID 1 and age over the configured limit.
- Send TERM to all independently authorized targets, wait three seconds once, then KILL only the
  same verified survivors that still qualify. Each signal checks fresh settings, owner, ancestors,
  executable and process identity. A delivered signal is logged as requested until exit is verified.
  A complete fresh scan must prove a browser profile unused before its checked removal.
- Daily, trim old owned regular, single-link Turbo cache files directly in registered workspaces'
  `.turbo/cache`. Only Turbo hash/archive or metadata names; no recursive cache walks, symlinks,
  source or credential names. Workspace state must explicitly be idle, with no running services or
  cache-using builds. Fresh registry and broad active-use checks precede each batch of at most 16 files. Every unlink
  still checks fresh policy/cancellation, the path chain, inode and age. Any same-user process
  working inside that workspace, including custom or unknown jobs, keeps its cache.
- Every minute, restore missing `/tmp/gate.sh` and `/tmp/heavy-run.sh` from the supplied scripts,
  exclusively, without replacing any file or link. A failed creation can leave a partial file;
  it is reported and preserved if cancellation or replacement prevents safe cleanup. These gates
  help only commands that choose to call them; they do not enforce a host-wide job cap themselves.

| Housekeeping setting | Default | Allowed values |
| --- | --- | --- |
| `housekeeping.enabled` | `true` | On/off |
| `housekeeping.dryRun` | `true` | Preview/live; live requires UI confirmation |
| `housekeeping.reniceIntervalMinutes` | `1` | 1–60 minutes |
| `housekeeping.reapIntervalMinutes` | `60` | 5–1440 minutes |
| `housekeeping.turboIntervalHours` | `24` | 1–168 hours |
| `housekeeping.browserMaxAgeHours` | `6` | 1–168; reporting only, never ownership authority |
| `housekeeping.stuckQueryMaxHours` | `2` | 1–72 |
| `housekeeping.turboCacheMaxDays` | `7` | 1–365 |
| `housekeeping.heavyNice` | `10` | 1–19 |
| `housekeeping.browserNice` | `5` | 1–19 |

The existing **memory guard** (`autoStopRunaways`, off by default) is separate and unchanged. It
requires verified live Paseo daemon ancestry; being inside a workspace alone never qualifies.

Schedules are elapsed intervals from the last completed pass, checked once a minute; the first pass
is due on load. Changing any Housekeeping setting cancels the current cycle. Helpers stay on a
one-minute check. Blocked, failed or cancelled passes retry on the next beat. The UI offers presets
within these ranges and preserves any existing valid value.

Manual Stop and its existing protections are unchanged. Only Housekeeping's individually authorized
finished-chat browser family has the narrow automated browser exception.

**Hand over from the standalone scripts.** Hosts holds the actual
`~/.local/state/agent-housekeeper.lock` flock descriptor for the entire cycle, including the grace
wait and file work. If busy it says **Standalone housekeeper active** and stays passive. Missing
`flock`, unsafe paths and failed checks also refuse; there is no unlocked fallback. To retire the
standalone housekeeper on a chosen host, remove its launch/guard block from `~/.bashrc`, identify and
stop that specific process by PID, then remove `~/.local/bin/agent-housekeeper` and
`~/.local/bin/reap-stale-agent-procs`. Keep the lock path and shared gate helpers. Hosts takes over
on its next cycle after the standalone releases the lock. Do not use pattern-based `pkill -f`.

**Limits and API workarounds.** The background loop asks the daemon's resolved Paseo CLI with fixed
argv (`inspect <id> --json`), bounded lookups and no shell, because callback SDK sessions are not a
background owner-lookup API. Paseo 0.11.1 archives idle records; a matching ID plus `Archived: true`
and a valid `ArchivedAt` distinguishes them from live idle chats. Cache discovery first uses fresh
SDK workspace descriptors, falling back to `paseo workspace ls --json`. That CLI omits workspace
and service state in 0.11.1, so its rows can be discovered but cannot authorize trimming. Unknown
state never defaults to idle. Temporary/protected roots, unreadable process paths and incomplete
scans refuse. Profile deletion is limited to plain, owned folders with no group/other permissions;
its complete non-use proof covers this OS user's processes, including unknown programs and unreadable
same-user paths. Foreign-user paths are never inspected; their presence (including root PID 1) alone
does not block this private-profile boundary. Privileged/root access is outside that boundary.

The loop never overlaps itself. Policy changes cancel the current cycle; no stale thresholds are
used. Shutdown invalidates authority immediately, waits up to ten seconds, and keeps the lock until
pending work settles. The final process read/syscall and final path check/unlink retain ordinary
kernel race windows; Node offers no pidfd or inode-conditional unlink API. A 45-second cycle action
budget aborts authority; an outstanding read may settle later while the lock stays held. Jobs are
bounded to 256 priority changes and TERM targets and 64 owner lookups per scan. Cache work considers
at most 16 workspaces, 1024 metadata entries per folder, 2048 metadata entries total and 256 candidates
per cycle. Activity is checked per 16-candidate batch (at most 31 batch checks across 16 workspaces),
while policy/cancellation and inode checks run per unlink. A new job can start within that bounded
batch window; the next batch refuses. There is no continuation cursor yet: later passes can revisit
the same first workspaces or entries, leaving later ones unexamined indefinitely. A scan-limit result
says so; use Workspaces for manual inspection of the rest. Refused, skipped and partial results are
reported; a count never proves an exit or delete.

Audit files are private (0600) under `$PASEO_HOME/daemon-link`: `housekeeping.jsonl` rotates at 600
results to retain 500; `housekeeping-state.json` keeps job timestamps across reloads. Reads are
bounded to 1 MiB, text is redacted on write and read, and the panel shows only 20 results. Audit and
lock bookkeeping still occur in preview. On macOS and other unsupported platforms, Housekeeping
starts no timers and performs none of its process or filesystem work.

### Browser links: how long they live

A temporary browser link is created with the configured duration and shows its expiry and remaining
time everywhere it is listed. **Extend** renews a live link in place: the public URL, the session
cookie in your browser, and the tunnel process all stay as they are; only the expiry moves. A link
can be renewed as often as you like but never past **24 hours after it was first started**; at that
point it is closed and a fresh one costs one press. The service lease keeps being re-verified every
two seconds, so an extended link still dies with the dev server it was issued for. Unlimited links
are deliberately not offered: the URL is public for as long as the link lives.

### Running apps and workspace ownership

The Workspaces table shows the current snapshot of up to 50 listening apps with memory, CPU, ownership,
Open where sharing is allowed, and reviewed Stop. App filter selects All apps, Can stop or No workspace;
Reset clears search and filtering. Disk measurement is separate; apps appear before a
disk check. The existing screenshots below predate this table layout.

![Earlier dev-server layout with fictional running apps.](docs/screenshots/dev-servers.png)

### Reaching a dev server from another computer

Under **Connections**, restricted **Private apps and project files**, **SSH port forwards**, and
**SSH recovery for an offline computer** are separate from full-authority agent access.
**Browser links you've opened** remains under Workspaces.

![Private localhost access between fictional hosts.](docs/screenshots/dev-relay.png)

| Method | Best fit | What it requires |
| --- | --- | --- |
| **Private localhost** | Two Paseo computers; HMR, WebSockets, SSE | Daemon Link on both hosts and one-time pairing |
| **Browser link** | Phone or guest device; another network route; one press | Explicit helper setup on the app host |
| **SSH forward** | Existing SSH workflow; private `127.0.0.1:PORT` | SSH keys/agent and a trusted known host |

**Remote apps**, **Pair hosts**, and **Manage access** keep everyday connections separate from
pairing and revocation. Creating a link shows the receiving host and a copyable URL; it does not
automatically open a browser on a potentially different computer.

Private forwarding uses an encrypted channel over Paseo's relay with outbound TLS WebSockets,
usually on port 443. Machines do not need to share a LAN or accept new inbound ports.
You may configure a compatible self-hosted relay using `PASEO_DAEMON_LINK_RELAY` on both hosts.

Temporary browser links use an authenticated HTTPS gate and expire after the configured duration
(2 hours by default), with a hard 24-hour lifetime even when extended. The optional Cloudflare helper
is pinned and checksum-verified, and installed only in the plugin's user state directory. Links are
created explicitly by pressing Open; a failed private connection never silently publishes an app.
Cloudflare Quick Tunnels do not support SSE and cannot bypass every firewall.

Saved SSH forwarding uses your existing keys and strict host verification. It does not store SSH
passwords or wait on a hidden password prompt.

### Project Sync: preview before receiving

![A fictional project transfer preview.](docs/screenshots/project-sync.png)

This brings the Sync plugin's selected-project, preview, and history workflow into Hosts using
its existing encrypted relay. Install this version on both hosts; no SSH credentials are needed.

It lives under **Overview → Copy a project from another computer**.

1. Pair the hosts under **Connections → Private apps and project files → Pair hosts**.
2. Select the source in Paseo. Open **Copy a project from another computer → Share with a host** and
   allow a project for
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

### Processes: heavy processes and a safe stop

![Processes: a runaway type check, memory near the limit, the heaviest processes.](docs/screenshots/processes.png)

Runaways have a separate attention banner, followed by load and a flat process table. Memory sorts
highest first by default; each numeric header starts descending and toggles on another press.
Name starts ascending. Search names, redacted commands, workspace/chat labels, folders and PIDs;
filter by heavy jobs, stoppable/protected processes, known/no chat or attention. Filtering and sorting
cover the whole sampled list before pagination. Heavy jobs use totals for everything they started.
Unknown readings stay last. Open a process name for its command, parent and folder.

**Which chat tagged it.** The workspace/chat column shows attribution on every row. Each tagged job
shows **Tagged by chat** with its title and workspace, including detached jobs and builds outside project
folders. **Open chat** opens that chat on hosts with native navigation; older apps keep the title.
Workspaces groups **Running here** by chat too. Tags are labels, not proof of origin. Unknown attribution stays unknown.

**Disk tables.** Workspaces shows project/path, status, disk use, reclaimable space and running-job
count. Search its last report or filter by status; total disk use starts highest first. Build folders,
shared caches and temporary entries also have size/name sorting and search, with cache group/type
filters. These controls never trigger a disk scan. Partial measurements and shared bytes stay
labelled. On narrow screens each row stacks labelled cells and keeps its actions visible.

**What can be stopped.** Processes owned by the daemon's OS user, including detached chat jobs and
jobs started outside Paseo. Outside jobs get an extra warning: "This wasn't started by Paseo. Make
sure you don't need it." Detached tag-only jobs warn: "Tagged as started by chat <title>, but Paseo can't confirm
it". Workspace jobs without verified ancestry warn: "Inside <workspace>, but Paseo didn't start it". The normal
warning applies only to verified daemon descendants. Never Paseo itself
(daemon, supervisor, plugin hosts, terminal workers),
anything a plugin started, an agent CLI (open its chat), an interactive terminal's shell, a database,
a system service or its children, init, or another user's/root process. On Mac, system executables and desktop app
bundles stay protected too. Only the agent CLI itself is protected; its dev servers, builds and scripts are
intentionally stoppable. Paseo descendant protection covers internal workers and plugin hosts, never agents' work.
Each protected row explains why without opening its details.

**How a stop works.** Use **Stop…** directly on a row, or select several rows and press **Stop**.
A missing or archived chat never removes manual Stop from an otherwise eligible process. Selection
uses the signed process identity, so sorting cannot select a different job and PID reuse clears it.
A sheet lists exactly what will stop,
children included, and anything that won't, with why. Confirming asks each process to exit; anything
still running 10 seconds later is stopped forcefully. Every rule is re-checked against a fresh read at
the moment of each signal. Signed identities include the executable path as well as PID, user, start time and argv
hash. Every step is written to `$PASEO_HOME/daemon-link/actions.jsonl`
(names, PIDs and outcomes only, never command lines). **Recent stops and restarts** lists them.

**Stuck plugins and the memory guard (0.13.0).** A banner at the top lists any Paseo plugin that isn't
answering, with **Restart** (see the [changelog](CHANGELOG.md) for exactly how its process is found
and stopped). Memory runaways show **Stop** beside them even when their row isn't on this page. With
the optional memory guard on, Hosts stops the biggest eligible Paseo job once memory has been
nearly full for over a minute, through the same checks, and logs it as an automatic stop. Only verified daemon
descendants qualify; workspace location and chat tags alone never qualify.

### Overview and the quick health check

![The quick health check opened from the sidebar dot.](docs/screenshots/popover.png)

Overview says the state in words, with up to four rows (memory, heavy jobs, dev servers, watched
services), the last stop and two buttons. Below it, **Watched services**, **Setup checks** (open
until setup is done) and **Technical details** fold out; the walkthrough and glossary are on Help.
On Paseo 0.11,
the dot beside **Hosts** in the sidebar opens the same check without leaving your chat.

### For other plugins: the host summary

Other plugins can read this host's health without depending on Daemon Link's internals:

- `daemon-link.host.summary` (version 1), for anything holding a Paseo daemon client:
  `invokePluginRpc("daemon-link", "daemon-link.host.summary", {})`;
- `$PASEO_HOME/daemon-link/host-summary.json`, rewritten after every health check, for another
  plugin's server on the same daemon. A missing file means Daemon Link isn't installed or hasn't
  checked yet.

Both carry the status, plain issue sentences, memory and heavy-job figures and watched services; never
paths, commands, URLs or tokens.

## Scope, privacy, and limits

Daemon Link verifies project directories and workspaces through Paseo's SDK, then matches them
against the server's process working directories. A dev server started manually inside a registered
project can qualify too; the plugin does not claim every matching process was launched by Paseo.

- Unrelated listeners and infrastructure processes are hidden. Broad home-directory or filesystem-root
  projects are excluded; register each project directory separately.
- Sharing is limited to verified dev servers; agents and unknown listeners are never shared. Custom web
  servers can be registered as running Paseo service scripts with explicit ports.
- If project verification fails, sharing pauses and some workspace/chat names may be missing.
  Process controls still check every protection rule; global health stays readable.
- Process commands are redacted before display, paths are home-relative, and secrets are not logged.
- Pairing codes and temporary access links grant access. Share them only with the intended recipient.

Discovery and process monitoring support **Linux and macOS**. Receiving forwards on Windows and
native mobile rendering remain unverified. The plugin loads an explicit unsupported state where
appropriate. macOS identity checks use the precision provided by that OS; process-stop race windows
cannot be eliminated completely.

See the [technical reference](docs/technical-reference.md) for process protections, relay behavior,
framework handling, pressure thresholds, and known limitations.

## Paseo compatibility

Supports Paseo 0.7 through 0.11. Paseo 0.9 and newer run the current version. Version 0.12.1 needs
Paseo 0.9: its manifest carries a `description` (shown in Settings → Plugins), and Paseo 0.8's strict
manifest schema rejects that key, so a 0.8 host should stay on 0.12.0. Paseo 0.7 hosts should stay on
0.4.0. Version 0.10.0 was built and checked on Paseo 0.11.0-beta.3 and kept `requirements.paseo` at
`>=0.8.0`: the 0.11 screen, sidebar row, status dot and popover, the 0.10
external-link opener and settings read/subscribe, and button-style composer chips are each detected at
runtime, and older apps get exactly what 0.9 drew. No plugin file imports an SDK path that Paseo 0.9.1
can't build. Compatibility tests compile and register both entries using pinned Paseo 0.9.0 and
0.11.1 runtimes, without installing the plugin into a live daemon.

Before 0.10.0, it required Paseo 0.8 or newer. Version 0.5.0 moved to the 0.8 runtime layout: `index.client.tsx`
and `index.server.ts` entries with code under `client/`, `server/`, and `shared/`, and
`requirements.paseo` set to `>=0.8.0`. Versions 0.6.0 through 0.9.0 add the workspace panel,
settings screen, lifecycle hooks, health checks, composer pill, workspace resource rollup, one-press
Open, and the named-tab surface on top of that layout. Paseo 0.7 hosts should stay on 0.4.0.

Features depend on the selected host's actual capabilities, so a newer host never lends its APIs
to an older one. The `/hosts` composer shortcut appears only when the host provides that API.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No apps listed | Start the app in a registered project. Refresh Workspaces; check the selected host. |
| Open does nothing | Allow pop-ups for Paseo. The card reads Starting link, then Link ready; Link failed shows why. |
| Link expired mid-session | Press Extend before it runs out; after 24 hours of life, Close it and press Open again. |
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
Use `?light`, `?empty`, `?error`, or `?unverified` to inspect theme and recovery states;
`?view=panel` mounts the workspace tab and `?view=settings` the Hosts settings screen; `?tunnelfail`
makes every browser link fail so the error path can be driven. The fixture stubs `window.open`, so a
headless run can assert where a reserved tab was sent without a real browser tab.
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
