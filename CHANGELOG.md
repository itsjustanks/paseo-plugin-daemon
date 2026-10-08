# Changelog

## 0.15.0 — 2026-10-08

Paseo's own toasts, clipboard and dialogs where the app has them, one redactor for everything you
see or copy, and a check for dev servers an archived workspace left running. Older apps keep what
0.14 did (the message bar, react-native's clipboard, questions in place). `requirements.paseo`
stays `>=0.9.0`; no settings change; nothing stops by itself.

- **Replies are toasts.** Stop, force stop, Restart, watch OmniRoute, browser links, terminals, SSH
  saves and Command Center checks show as Paseo's toast (errors stay up longer) instead of the
  message bar under the tabs, on the Hosts screen and in a workspace's Hosts tab. One way, never
  both. A disk check you started says when it's done ("about 3.2 GB looks safe to clear").
- **Ask first, in a dialog, once.** Stop dev server, Revoke access and Remove pairing now ask in
  Paseo's dialog and say what happens next. Removing a saved SSH connection asks first (it didn't).
  Restart asks in a dialog on a page and in place in the sidebar popover. Every confirm, the Stop and
  Force stop sheets included, acts once however fast it's pressed.
- **Copy.** "Copy details" on a process (name, PID, ports, folder, command), "Copy SSH command" on
  a saved connection, the local link and the pairing code. Copying uses Paseo's clipboard, falls
  back to react-native's, and says "Couldn't copy" when the browser refuses. Browser links are still
  never shown or copied.
- **One redactor.** The rules that cleaned commands and agent messages now live in
  `shared/redaction.ts` and also cover every toast, message bar, note, dialog, error and copied text,
  plus long hex and mixed-case base64 runs in free text. A pairing code you just created is copied
  as shown (carrying it to the other computer is the point).
- **Archived workspaces.** With Paseo's `workspace.archived` hook (newer Paseo), Hosts looks in an
  archived workspace's folder for a day for anything still listening on a port, and lists it under
  What needs attention with Stop (asks first) and Ask an agent.
- **Help:** "I archived a workspace. Is anything still running?".

## 0.14.0 — 2026-10-08

Disk usage by workspace, and an agent to clean up. "Dev servers" became **Workspaces**: each Paseo
workspace with what's running in it, what it uses on disk, and what looks safe to clear. Hosts
deletes nothing in this release: "Ask an agent to clean this up" hands an agent the exact list.
One-press clearing went through three independent deletion-safety reviews and is held back for a
later version (kept on a branch, not shipped).

- **Disk at a glance.** Free and used space on the disk your workspaces live on, read with statfs
  every 10 seconds by the check loop (statfs and stat only, never a folder walk there). Overview gets
  a Disk row; the sidebar dot warns at 85% full ("Clearing build files and caches under Workspaces can
  help") and turns red at 95% ("Agents will start failing to write files soon").
- **By workspace.** Every Paseo workspace from the SDK, biggest first: its size, how much looks safe
  to clear, its status (agent working now, waiting for you, idle since…), branch, and dev servers.
  Workspaces sharing one folder are one row ("Used by 3 workspaces"). Worktrees under
  `$PASEO_HOME/worktrees` that no workspace claims are shown as "Not linked to a workspace" with their
  size and Ask an agent (it checks for unpushed work and removes the worktree properly with git, after
  asking). Folders and paths appear only when a row is opened.
- **Looks safe to clear** means an allow-listed build folder (node_modules, .next, .nuxt, .turbo,
  .vite, .svelte-kit, .parcel-cache, .cache, coverage, test-results, playwright-report,
  storybook-static, __pycache__, .pytest_cache, and dist/build/out) that git says is ignored, with
  nothing tracked and nothing untracked-but-not-ignored beneath it, no .env, .git or bare repository
  inside, no symlink on its path, outside every protected place (home, Paseo's data, agents' history,
  Hosts' folder, workspace and worktree roots), in a workspace where no agent is working and no dev
  server runs. Folders outside a git repository never look safe.
- **Shared caches and temporary files, by size:** npm's cache and npx downloads, pnpm's store,
  browser downloads (Playwright, Puppeteer, agent-browser, including the fleet's second agent-browser
  home), known tool caches (pip, uv, Yarn, Go, node-gyp, TypeScript, Cypress, Prisma…), and this
  user's folders in /tmp (each with Ask an agent).
- **Ask an agent to clean this up**, on one workspace, every idle workspace, or the caches. The
  message (shown before it's sent, through 0.12's ask flow) lists the exact items with paths and
  sizes, and tells the agent to check each one for tracked, uncommitted or unpushed work, running
  processes and open files before deleting; never to delete .git, any repository, .env files,
  ~/.claude, ~/.codex or Paseo's data, nor a whole project or worktree; to use npm's and pnpm's own
  clean commands; to skip anything unsure; and to report what it freed.
- **Scans are gentle.** Only when asked ("Check disk space", or Refresh on Workspaces), cached
  in memory and `$PASEO_HOME/daemon-link/disk-scan.json` with "Checked 4 min ago", one at a time, in
  child processes at the lowest priority (nice 19, idle disk class on Linux), each in its own process
  group that unloading kills. One deadline (4 minutes) covers reading Paseo's workspaces, finding
  folders, the walk and git; cut-off sizes say "at least". Plugin calls get 30 seconds, so a scan runs
  in the background and the app polls.
- **Fewer calls to the daemon.** Passive reads (the sidebar dot, Overview, Processes, Workspaces)
  now share one cached copy of the project and workspace registry for 60 seconds (was 5), with one
  read in flight at a time and a 10-second back-off after a failed read. A busy daemon logged about
  110 slow `project.list` requests an hour from Hosts polling. User actions (Refresh, stop, share or
  receive a project, start a disk check) still read it fresh, and Workspaces adds no polling of its
  own: it reads the same cache.
- **Disk in the places Hosts already uses** (no new tab, no new polling, and nothing here starts a
  check; only Refresh on Workspaces, "Check disk space" and `/disk` do):
  - **A workspace's Hosts tab** speaks up when 500 MB or more of that workspace looks safe to clear,
    or the disk is 85% full: its size, what looks safe to clear, how full the disk is, and "Ask an
    agent to clean this up" for that workspace. Otherwise it's one quiet line at the bottom. It reads
    the last check, never starts one.
  - **The sidebar dot** already warned at 85% and turned red at 95%; its popover now adds "Free up
    space", which opens Workspaces.
  - **The chip under the message box** appears for the disk only when it's 95% full or more
    ("Disk nearly full"), since agents start failing to write files then. Same button as the other
    chips; it opens the workspace's Hosts tab.
  - **Command Center:** "Check disk space" (starts a fresh check and opens Workspaces) and "Clean up
    disk space" (opens Workspaces with the ask for every idle workspace's safe-to-clear items, or for
    the shared caches when nothing in an idle workspace looks safe).
  - **`/disk`** in a chat's message box does what "Check disk space" does; `/disk clean` opens the
    ask. It's separate from `/check-host`, which stays a quick health check of this workspace and
    never starts the heavier folder check.
  - **"Disk report"** in the message box's Hosts attachments: free space, workspaces by size with
    what looks safe to clear, and the shared caches and temporary files, from the last check.
  - **"Ask an agent" about a heavy process** mentions the disk when it's 85% full or more ("disk 91%
    full (8 GB free)"), from the same host line.
- **Review fixes (before release):**
  - A child that dies while Hosts is still writing to it (EPIPE) no longer crashes the plugin: every
    pipe of every disk child has an error handler.
  - Hosts signals a child's process group only while that child hasn't exited; once it has, nothing
    is signalled again, even if a descendant keeps its pipes open (stops reading after 2 seconds).
  - Git can't run the repository's code: every query pins `core.fsmonitor=false`,
    `core.untrackedCache=false`, `core.hooksPath=/dev/null` and `protocol.allow=never` on the command
    line (which beats every config file), skips the system config and drops inherited `GIT_*`
    variables. The user's global config stays readable for their own excludes file.
  - pnpm never runs (`pnpm store path` writes under home). Its store is found from `store-dir` in the
    environment, ~/.npmrc or pnpm's rc, else the default place; "pnpm store: not found." when a
    workspace uses pnpm and none exists.
  - Every "Ask an agent" message, folder and cleanup asks included, goes through the same redactor
    as the Disk report, so a workspace or branch named like `API_KEY=…` is hidden.
  - No automatic disk check: with none yet, Workspaces shows free and used space and a "Check disk
    space" button. The disk report is read and polled only while Workspaces shows.
  - A disk report or ask waits at most 5 seconds for Paseo's registry or the process list; a check
    starts before either is read. One registry read gives up after 20 seconds (a late answer is
    dropped), and the scan's discovery steps stop at its deadline or on unload.
  - Unloading during a check never leaves a rejected promise unhandled: once cancelled, no step
    starts new work, and every started step's failure is handled even after it was given up on.
  - pnpm's config files are read safely: regular files only (a symlink only to one), opened
    non-blocking, at most 64 KB, and dropped when the check is cancelled.
- **Help:** "My disk is filling up. What can I clear?", "What does the agent check before it
  deletes anything?" and "Where else does Hosts show disk space?". Old `tab=servers` links land on
  Workspaces. No settings change.
- **Tests:** a temp home with a git workspace, a real git worktree no workspace claims, caches,
  ~/.claude, ~/.codex, Paseo's data and /tmp folders, through the real scanner and walker: what looks
  safe (git's three answers, no repository, git timeouts, untracked work, bare repositories, symlinked
  folders and parents, protected places, busy workspaces), the agent's messages, the deadline and
  unload, statfs-only disk readings, and a check that the shipped server code has no delete path.

## 0.13.0 — 2026-10-07

The two things that took a daemon down this week, caught early, each with a one-press fix. A plugin
that stopped answering wedged Paseo's plugin manager three times, and a test run that grew to 36 GB
filled memory until the daemon stopped answering. Both were fixed by hand; now Hosts sees them coming.

- **Plugin health.** Hosts reads Paseo's own log (`$PASEO_HOME/daemon.log`) for "Plugin RPC timed
  out: <plugin>.<method>" and says, per plugin, "Activity isn't answering (12 timeouts in 10 min)", or
  that a plugin began stopping and never finished. Three timeouts in 10 minutes is the bar; a restart
  clears the count. Shown on Overview's status card, the sidebar dot's popover and Processes. Slow
  plugin requests are counted as context (the log doesn't say which plugin).
- **Restart <plugin>.** Asks first, in place, saying what will and won't happen. It runs
  `paseo plugin reload <id>` (the `paseo` that ships with the daemon, found from Hosts' own path)
  with a 45-second timeout. If the reload hangs because the plugin manager is wedged, Hosts stops
  only that plugin's process (SIGTERM, then SIGKILL after 10 seconds if the very same process is
  still there), gives Paseo's queued reload 15 seconds to finish, and reloads again if it didn't. An
  old copy stuck stopping is stopped the same way. Never the daemon, never Hosts, never anything that
  isn't one of the daemon's plugin processes, and nothing at all when the process can't be told
  apart. A reload that fails for another reason stops nothing. Every step is logged. A restart that
  takes longer than Paseo lets one call wait answers "running" and the app follows it.
- **How a plugin's process is found.** Plugin processes carry no plugin id in their argv,
  environment or folder. The daemon logs "Loading plugin" just before forking a plugin's process and
  "Plugin ready" just after, one plugin at a time, so a plugin process (`plugin-process.js`, a direct
  child of this daemon, this user's) belongs to the plugin whose window holds its start time (Linux:
  boot time plus start ticks; macOS: `lstart`), with 2 seconds of slack. A match must be unique both
  ways; the window holding Hosts' own start time is Hosts. Identity (start time, command, parent,
  user) is re-read immediately before each signal.
- **Runaway memory, said plainly.** A process holding 25% or more of this computer's memory (the
  container's limit when there is one; was 40%), or one already at 10% that added at least 10% of
  memory (and at least 2 GB) in 5 minutes, is flagged: "A test run is using 36 GB, 61% of this
  computer's memory. The computer will slow to a crawl soon." Urgent at 50%, or at any share while
  memory is under pressure. Memory pressure now reads PSI "full" as well as "some" (the cgroup's
  `memory.pressure`, else `/proc/pressure/memory`) and OOM kills from `memory.events`: "Memory is
  nearly full: programs are stalled waiting for memory 84% of the time." `node --test`, `bun test`
  and `*.test.*` / `*.spec.*` scripts now count as test runs.
- **Stop and Ask an agent beside it.** Overview's attention list and the Processes banner offer Stop
  (the same ask-first sheet: SIGTERM, SIGKILL after 10 seconds) for a runaway Hosts may stop, even
  when its row isn't on the current page, next to Ask an agent.
- **The check loop.** Starts when the plugin loads, not on the first app visit, and runs every 10
  seconds (30 on macOS) whether or not Paseo is open: a few small /proc and cgroup files, one short
  read per process, at most 1 MB of new log. Anything that goes through the daemon is given at most
  5 seconds, so a starved daemon can't stall it.
- **Optional memory guard, off by default.** Settings → Hosts → "Stop a runaway automatically when
  memory is nearly full". Only after memory has been critical (PSI full ≥ 20%, some ≥ 50%, or OOM
  kills while 90% full) for over 60 seconds, it stops the biggest process a person could stop with
  the Stop button (started from Paseo or inside a project; never Paseo, an agent, a terminal's shell
  or a database) that holds at least 10% of memory, through the same checked stop, then waits 90
  seconds before considering another. Logged as an automatic stop; the sidebar dot says so for 30
  minutes.
- **Help.** Two plain questions: "A job is eating all the memory. What happens?" and "A plugin isn't
  answering. What do I do?". "Recent stops" is now "Recent stops and restarts". Overview's Technical
  details say whether plugin health can be read here and whether the memory guard is on.
- **Safety review fixes (before release).** A plugin launch whose "Loading plugin" line is gone
  (rotated away, outside the read budget, or a lone "Plugin ready") no longer gets a guessed window,
  so it can never match another plugin's healthy process: Hosts says it can't tell and stops nothing.
  A Ready line pairs with a Loading line only within 2 minutes, and no window is longer than that.
  The memory guard now asks again immediately before every signal it sends, the SIGKILL follow-up
  included: the switch must still be on and a reading taken right then must be critical, or nothing
  is sent. Only one automatic stop runs at a time, and unloading Hosts disarms one in progress. A
  failed or missing reading, or a gap of more than three check intervals, restarts the "critical for
  over a minute" count.
- **Known limit.** Between the last identity check and the signal, a process could exit and its PID
  be reused within microseconds; closing that needs `pidfd_send_signal`, which Node doesn't expose.
  This applies to every stop, as before.
- **Settings** document version 5 (adds the guard switch); older documents keep every value.
- **Tests.** Log parsing and the budgeted tail, launch history, plugin-process matching (start times
  measured on a real host), the reload-then-stop escalation against a fake daemon that wedges, the
  runaway and pressure thresholds with the incident's numbers, the auto-guard's rules, and the loop
  surviving a hung settings read.

## 0.12.1 — 2026-10-06

Fixes from an audit of the real Paseo app (0.11.0-beta.5), checked again in the real app before
release. One name, one way to refresh, nothing technical in plain view.

- **Optional steps aren't to-dos.** "Start a dev server" is optional, so a calm host no longer shows
  "Setup checks: 1 still to do".
- **One name: Hosts.** The slash command is `/hosts` (was `/daemon-link`; the SDK has no hidden
  aliases, so the old name is gone, and "daemon-link" stays a Command Center keyword). Messages,
  the pairing box, the stop rules, the link page's title and the health check's user-agent say
  "Hosts". The plugin's own process reads "Hosts (this plugin)".
- **Processes rows can be told apart.** Paseo's parts are named ("Paseo · window", "Paseo · graphics",
  "Paseo · plugin host", "Paseo · daemon"), browser and desktop-app helpers get their role ("Outside
  Paseo · window or tab", "· network", "· audio"), an agent outside a project shows its folder, and
  rows that still look the same show their PID.
- **Dev servers.** "None running" is neutral (no green dot), "Checking…" until it knows. Copying a
  project isn't about dev servers, so Project Sync folds out on Overview now; `sync` links land there.
  Dev-server cards drop the folder path and PID.
- **Workspace panel, rebuilt in the new style.** The Hosts header with the workspace's name and state
  and one Refresh link; its dev servers; what needs attention (with Ask an agent); then folded: what
  the workspace uses, its other processes, browser links, and Technical details (folder, ports,
  schedule). No path, PIDs, "Every 30s" or "daemon" in plain view.
- **Words.** "Whole machine" is said once, in the header. Heavy jobs explain the number: "builds, tests
  and dev servers running now; 4 at once is the limit" (Overview, Processes, the quick check).
- **Consistency with the other plugins.** Help is folded questions only; the walkthrough is the
  question "How does Hosts work?". One Refresh link in the page header (no "Check again", grey Refresh
  or "Run checks again"). The app's header title follows the tab ("Hosts · Processes"): the screen
  title comes from `params.tab`, and changing tab reopens the screen with it, as Memories does. A
  link that reopens the screen while it's showing now moves it to that tab.
- **Manifest.** `paseo-plugin.json` has a plain `description`, shown in Settings → Plugins. Paseo
  0.8's manifest schema is strict and has no `description`, so `requirements.paseo` is now `>=0.9.0`
  (the first version that accepts it); a 0.8 host should stay on 0.12.0.
- **Tests.** `tests/ux.test.ts` (manifest, role names, duplicate rows, no "Daemon Link" in visible
  text, `/hosts`); tab mapping covers `sync` on Overview and the header titles.

## 0.12.0 — 2026-10-06

The theme of this release: from "something is wrong" to "an agent is on it" in two presses, because
the user's aim for Hosts is fixing the outages they have had before. Everything is feature-detected
and sits in the existing rows; there are no new tabs.

- **Ask an agent.** Beside a runaway process (the Processes banner, and any flagged row), a dev
  server that stopped serving, or a watched service that is slow or down (Overview's new "What needs
  attention" row, and the workspace panel's Health card), "Ask an agent" opens a sheet. Pick a chat
  in that workspace (it is offered first), another recent chat, or start a new chat there with the
  provider and model of your latest one. The sheet shows the exact message before anything is sent:
  what's wrong, CPU, memory, how long it has run, the command, the host's load, the last 50 lines of
  the dev server's output when Hosts can find them, and a suggested next step. It asks the agent to
  check before stopping, restarting or deleting anything. Nothing is sent until Send.
- **Busy agents are steered, not interrupted.** Messages go with `activeTurnBehavior: "steer"`. Every
  client since 0.8 forwards that option; only the handle's type gained it in 0.11.0-beta.1, so it is
  passed through a local type.
- **Finding the output, without guessing.** A Paseo service script on that port names its own
  terminal; otherwise a terminal in the server's folder is used only if its recent output names the
  port or the program. When neither is found the message says so rather than guess.
- **No secrets.** The daemon builds the message (`daemon-link.ask.context`). Commands are the
  Processes tab's redacted ones, and every output line passes the new `redactText` (secret flags and
  env names, URL credentials, secret query parameters, JSON properties, headers, known token formats,
  home paths as `~`). Tested against the synthetic credentials suite.
- **Hosts attachments** (`addAttachmentSource`, Paseo 0.8+). "Hosts" in the message box's attach menu
  offers Heavy processes now, What needs attention, each dev server's recent output, each stopped dev
  server, and each watched service's recent checks (`daemon-link.attachments.search`, searchable by
  word). Output is read for at most four dev servers per search.
- **Open a terminal here.** Each dev server's card (Dev servers tab and workspace panel) can open a
  Paseo terminal in its folder, inside its workspace, and then show that workspace
  (`daemon-link.terminal.open`). Never outside a Paseo workspace.
- **Help** gains "Can an agent help fix it?". Health issues carry the process `pid` they are about
  (optional, so older readers are unaffected). Fixed: the Watched services row no longer lowercases
  service names.
- **Tests.** `tests/ask.test.ts`: the message, every next step, output tails, output redaction, the
  context for a runaway, a stopped server (terminal found, service script preferred, an unrelated
  terminal ignored) and a watched service, attachments, and terminals only inside a workspace.
  `tests/ask-preview.mjs` drives the sheet in the preview: steer to a busy chat, a new chat, Cancel,
  and both buttons absent without a Paseo session.
- `requirements.paseo` is unchanged and no dependencies were added.

## 0.11.0 — 2026-10-06

The theme of this release: Hosts for someone who has never heard of a port. The user found the
nesting "a bit weird… too technical… it just needs to work for dummies", and asked for fewer composer
chips. This follows the design standard's update of 2026-10-06 and copies paseo-mcp 0.19.0's
fold-out rows, so the plugins look like one family. Every option is still reachable.

- **Four tabs, by what you came to do.** Overview (is this computer fine?), Processes (what is making
  it slow?), Dev servers (open my app) and Help (how does this work?). 0.10's Connect and Project
  Sync tabs were both about other computers, so they now fold out under Dev servers, beside the
  apps they reach.
- **Fold-out rows for the technical parts** (`Accordion` / `AccordionItem` in `client/kit.tsx`, from
  paseo-mcp 0.19.0). Overview: Watched services, Setup checks (open until setup is done) and
  Technical details (check interval, limits, link length, where the stop log and host summary are
  written). Processes: Recent stops and What can be stopped here. Dev servers: Browser links you've
  opened, Open privately on your own computer (pairing, paired computers' apps, access), Use your
  SSH keys instead, and Copy a project from another computer (Project Sync).
- **No tab intros.** One plain sentence under Processes and Dev servers, none elsewhere. "What you
  can do here", the troubleshooting list and the "New to Hosts? How it works" guide became the Help
  tab: ten plain questions, each folded with a button to the right place, then how Hosts works.
- **Dev servers is simpler.** Each card's Open button is the main path; the "Browser link / Private
  forward" switch is gone, and the private route per port (with its forward status) sits inside
  Open privately on your own computer. Each card still offers "Private forward…".
- **Old links still work.** `shared/tabs.ts` maps every old tab id: `connect` and `pair` open Dev
  servers with the private fold-out open, `ssh` the SSH one, `sync` Project Sync, `health` opens
  Processes and `guide` opens Help. Screens also accept `params.open` for a Dev servers fold-out.
  The sidebar screen, status-dot popover, workspace panel and composer chip are unchanged entry
  points.
- **A composer chip only when a chat needs attention.** It now appears only when that workspace's
  dev server stopped, a browser link or forward to it failed, or one of its jobs drives the host's
  load (`chipText`, `CHIP_CODES` in `shared/health.ts`). It never counts healthy dev servers, and
  host-wide trouble (memory, CPU, watched services, an unreachable host) stays on the sidebar dot
  and its quick check instead of appearing in every chat. The setting is now "Show a chip when a
  chat needs attention".
- **Commands for the common actions.** Command Center: Open Hosts, Show heavy processes (renamed
  from "Heavy processes on this host"), and the new Check host now, which runs a fresh check and
  opens Overview. Slash commands, where the app has them: `/daemon-link` (as before),
  `/heavy-processes` and `/check-host`. No sidebar footer item: on every app that offers one, the
  sidebar row's dot and popover already show the same thing.
- **Tests.** New `tests/tabs.test.ts` (four tabs, every old id, `open`, and every deep link in the
  client resolving to itself); the chip tests now cover attention-only faces and the cases that
  must stay quiet.
- `requirements.paseo` is unchanged and every newer API is still feature-detected. No new
  dependencies, and nothing new on the server.

## 0.10.0 — 2026-10-05

The theme of this release: manage the large running processes behind the outages (OmniRoute pegging
a CPU, Next.js dev servers piling up, a container near its memory limit, heavy builds and tests
stacking up on an 8-core host), and look and behave like the other Paseo plugins on Paseo 0.11.

- **Processes tab (was Daemon Health).** Lists every process the daemon's OS user owns, heaviest
  first (CPU, memory, age or name), with how long each has run and the workspace, dev server or
  "Started from Paseo" it belongs to. Heavy jobs (builds, tests, type checks, installs and dev
  servers) are counted once per tree and can be shown as trees with their totals. Runaways are
  flagged in plain sentences: a process holding a full CPU core for two minutes, one holding 40% of
  the memory limit, memory near the container's limit, and more heavy jobs at once than the limit
  (new setting, default 4). Nothing is ever stopped automatically. New RPC
  `daemon-link.processes.report`.
- **Ask-first stop.** Select processes and press Stop: a sheet (`daemon-link.processes.preview`)
  lists exactly what will stop, children included, and what won't, with why. Confirming
  (`daemon-link.processes.stop`) sends SIGTERM, then SIGKILL after 10 seconds to whatever is still
  the same process. Only processes Paseo started or running inside a registered project qualify;
  Paseo itself (daemon, supervisor, plugin hosts, terminal workers), anything a plugin started,
  agent CLIs, terminal shells and infrastructure never do. A separate guard key, every rule
  re-checked against a fresh read before each signal. Every stop, including the workspace tab's, is
  appended to `$PASEO_HOME/daemon-link/actions.jsonl` without command lines
  (`daemon-link.processes.log`).
- **Container limits.** Memory and CPU are read from the container's cgroup (v2, v1 fallback), so
  memory pressure and per-process shares are judged against the container's limit (7.3 GB on the
  fleet) rather than the 64 GB machine; new OOM kills count as critical. macOS uses the whole
  machine. The snapshot gains an optional `container` field.
- **Watched services.** Health URLs on other machines, checked on the health schedule (at most every
  30 seconds, 5 second timeout, GET without redirects, user-agent only) with a short history. Slow
  means over 2 s or five times slower than usual; down means no answer or the wrong status. Results
  reach the verdict (`service-slow`, `service-down`), the sidebar dot, the Overview card and the
  composer chip. When the AI Router plugin is set up on the daemon, watching its OmniRoute is
  offered in one press, from its `endpoint` only. URLs must be http(s) without user information or
  credential-like query keys.
- **Paseo 0.11 natives, feature-detected.** A Hosts screen with its own sidebar row and a status dot
  that opens a quick health check (memory, heavy jobs, issues, watched services, Open Hosts, See
  heavy processes, Check again); screens accept `params.tab`. External links use `openExternalUrl`
  (0.10+). Settings changes are picked up at once through `registerSettings().subscribe` (0.10+), and
  read through `read()` instead of the file. Older apps get exactly the 0.9 surface and behaviour.
- **Composer chip fixed.** Paseo 0.8.0 stable and later take composer chips as buttons and the old
  component shape threw on add, so the chip never appeared on 0.9 or 0.11 apps; and since 0.9,
  `agents.subscribe()` only hears an observation the plugin opens itself. The chip is now a button
  whose label is pushed (`shared/pills.ts`, tested), and on 0.9+ the plugin keeps its own agent
  observation, reopened with backoff. Both are detected at runtime, as in paseo-mcp 0.18.1.
- **For other plugins.** `daemon-link.host.summary` (version 1) and
  `$PASEO_HOME/daemon-link/host-summary.json`, rewritten after every check: status, plain issue
  sentences, memory and heavy-job figures and watched services; no paths, commands or URLs.
- **Design standard.** The shared layout of AI Router 0.15: an icon header with a one-line status,
  an underline tab bar (icons only when narrow), a plain intro on every tab with "What you can do
  here" folded away, and a calm Overview (the state in words, at most four rows, two buttons, one
  "New to Hosts? How it works" guide holding the walkthrough, setup checks, troubleshooting and a
  glossary). One type, spacing and radius scale (`client/kit.tsx`, also behind the older screens'
  tokens), 980 px page width, light and dark. Dev servers, Connect and Project Sync keep every
  control; copy is plainer throughout.
- **Settings document version 4.** Adds `maxHeavyJobs` (4) and `watchedServices` (none). Versions 1
  to 3 are migrated in place, keeping every saved value. The default refresh interval is now 30
  seconds (was 20) for a lighter load on shared daemons.
- **Tests.** New suites for the process rules, stop and escalation, the action log, cgroups,
  watched services, the chip registry, host features, the summary, and a scan that fails on any SDK
  import path Paseo 0.9.1 can't build or any client import of server code. A screenshot script
  (`tests/screenshots.mjs`) renders every state wide and narrow, light and dark.

## 0.9.0 — 2026-09-10

The theme of this release: viewing a dev server that runs on a remote Paseo host should be one press,
not a six-tab expedition that has to be repeated every 30 minutes.

**What is and is not possible.** Rendering a `localhost:3000` page inside Paseo itself is not
possible with the current plugin SDK (`@getpaseo/plugin` 0.8): the client exports no WebView or
iframe primitive, and the server context has no HTTP route, proxy, or static-serving capability. A
tunnel (public browser link), a paired-host forward, or an SSH forward therefore remains the only way
to reach the server, and 0.9.0 makes those mechanisms cheap rather than pretending otherwise.

- **One-click Open.** Every verified dev server is a card with an **Open in browser** button, both in
  the Hosts sidebar surface and in each workspace's Hosts tab (which now leads with its dev servers,
  above Health and Resources). One press reserves a tab, starts a browser link with the configured
  duration or reuses the live one for that port, and sends the tab to the app once the daemon reports
  it connected. The row shows live state: **No link yet**, **Starting link**, **Link ready · 1 h 59
  min left**, **Link failed** with the daemon's reason (and a Retry that first clears the failed
  record), or **Link expired**. The flow is one shared hook, `client/open-service.ts`, used by both
  places; `prepareExternal()` is still called synchronously in the press so pop-up blockers allow it.
- **Longer, extendable links.** `daemon-link.tunnel.start` now accepts 15, 30, 60, 120, 240, or 480
  minutes (was 15/30/60). The default is 2 hours and comes from a new **Link duration** setting under
  Settings → Hosts. A new `daemon-link.tunnel.extend` RPC renews a live link *in place*: the public
  URL, the gate's session cookie, and the tunnel process are untouched; only the expiry moves. Every
  link list shows the expiry time and remaining minutes and offers **Extend** and **Close**. A link
  can be renewed as often as needed but never beyond **24 hours after it was created**
  (`TUNNEL_MAX_LIFETIME_MS`); an unlimited link is a permanently public URL, and 24 hours already
  covers any working day while forcing a fresh secret daily. The service lease is still re-verified
  every two seconds, so an extended link still dies with its dev server. `Tunnel` gains a
  `createdAt` field. Logic lives in `shared/tunnel-lease.ts` with its own tests.
- **Simplified sidebar: six tabs become four.** `Overview` and `Local Projects` both answered "what
  can I open?" and are now one tab, **Dev servers**, which is the first thing the surface shows. It
  carries the host counts that Overview had, the server cards and search that Local Projects had,
  and a **Browser link / Private forward** switch that explains in one line when each route is
  right. `Guide & Setup` is no longer a tab: it is a collapsed **Setup guide & checks** card at the
  foot of Dev servers whose header summarises the checks (`All checks passed`, `2 steps left`, `1
  check failing`) and expands into the same walkthrough, checks, and troubleshooting cards.
  `Dev Relay` is renamed **Connect**; its three routes are now labelled **Private localhost**,
  **Browser link**, and **SSH forward** with one-line trade-offs. `Project Sync` and `Daemon Health`
  are unchanged. Everything reachable in 0.8.0 is still reachable; only the entry points moved.
- **SSH forward as a first-class private choice.** A dev-server card's **Private forward…** jumps to
  Connect → SSH forward with the remote and local port preset to that server's port, and the
  Private-forward view of Dev servers shows `remote :3000 → your 127.0.0.1:3000` per server with
  SSH and paired-host buttons. The routes are explained side by side: a browser link is a public
  URL that works from any device and expires; a private forward publishes nothing and lives at
  `127.0.0.1` on your own computer.
- **Settings document version 3.** `tunnelMinutes` is added with a default of 120. Version 1 and
  version 2 documents (0.6.0 through 0.8.0) are migrated in place by both the daemon and the
  server-side file reader: every saved value (`closeTunnelsOnArchive`, `panelScope`,
  `snapshotIntervalSeconds`, `backgroundHealthChecks`, `showComposerPill`) is kept and only the new
  field takes its default. A naive version bump would have reset them, because the reader treats an
  unknown version as unreadable.
- **Preview harness.** `tests/ui` now mounts the sidebar surface, the workspace panel
  (`?view=panel`), and the settings screen (`?view=settings`); the fixture simulates link startup,
  connection, extension, failure (`?tunnelfail`), and settings persistence, and stubs `window.open`
  so a headless run can assert where a reserved tab was sent. Screenshots were regenerated from it.

## 0.8.0 — 2026-09-10

- The **Hosts** workspace tab now reports what the open workspace costs the host. A **Resources**
  card under the Health card sums the CPU (`cpuPercent`, one-core units) and resident memory
  (`rssBytes`) of the workspace's processes, counts them once even when a dev server appears in
  both snapshot lists, and shows each figure as a share of the host: CPU against the machine's
  `cores` and its current `cpu.percent` load, memory against `memory.totalBytes` and
  `memory.usedBytes`. Processes the host has not sampled twice read as "still sampling" and a share
  is omitted when the host total it needs is missing or zero, so nothing is reported as 0 that is
  merely unknown. The rollup is pure, dependency-free logic in `shared/workspace-resources.ts` with
  its own test suite.
- Health verdicts gain a `pressure-driver` issue: a project process the collector already marks as
  a top-3 CPU or memory user while the host is under matching pressure. It is scoped to that
  process's cwd and ports, so only the workspace running it is flagged; the host-level
  `cpu-pressure` and `memory-pressure` codes are unchanged, and a busy host alone never produces
  it. Zombie and driver issues are reported once per process even when the process is in both
  `services` and `processes`.
- The composer pill leads with an issue inside the workspace (`Driving host pressure`, `Dev server
  :3000 stopped`) before a host-wide one, and stays a chip: no CPU or memory figures.

## 0.7.0 — 2026-09-09

- Fixed the **Hosts** workspace tab never appearing in the Projects/Explorer view. The panel was
  registered without `locations`, which defaults to the workspace view alone; it is now registered
  for both `workspace` and `explorer`.
- Automatic health checks. The daemon evaluates host health on the refresh interval and caches one
  verdict, served over a new `daemon-link.health` RPC with a `checkedAt`, so every pill and panel
  reads the cache instead of probing. A host or workspace is flagged when the host cannot be read or
  its projects cannot be verified, a dev-server port that was serving has stopped, a temporary
  browser link failed, a saved SSH forward is retrying or should auto-connect but is not running, a
  project process is a zombie, or CPU or memory pressure is critical. The logic is pure and
  unit-tested in `shared/health.ts`; the verdict never carries tokens, link URLs, or command lines.
- Composer pill. Each agent's composer shows a chip while its workspace has something to report: the
  number of verified dev servers running inside it and their ports, or its first problem. Pressing it
  opens the Hosts tab for that workspace. Quiet workspaces get no chip.
- The workspace tab now leads with a **Health** card for the open workspace (status, dev servers,
  ports, last check, issues) above the dev servers, processes, and browser links it already listed.
- Two new Hosts settings, both on by default: **Check host health in the background** and **Show the
  composer pill**. The settings document moves to version 2; a saved 0.6.0 document is migrated in
  place (old values kept, new switches on) both by the daemon and by the server-side file reader,
  which previously treated any version other than 1 as unreadable.

## 0.6.0 — 2026-09-09

- Added a **Hosts** settings screen (Settings → Plugins → Daemon Link) with three host-scoped
  options: close browser links when a workspace is archived (default on), what the workspace panel
  shows (this workspace only, or the whole host; default workspace), and the workspace panel refresh
  interval (5–120 seconds, default 20). The Command Center item **Configure Hosts** opens it.
- The **Hosts** workspace tab is now workspace-aware. By default it lists only the dev servers,
  processes, and browser links that belong to the open workspace's directory (or share one of its
  ports), with the same stop and force-stop controls as Daemon Health, refreshed on the configured
  interval. Set the panel scope to "Whole host" to get the full Hosts surface in the tab instead. The
  sidebar surface is unchanged.
- Lifecycle hooks: when a workspace is archived and "Close browser links on archive" is on, Daemon
  Link stops every temporary browser link whose port belongs to a process running under that
  workspace's directory, and logs what it stopped. Workspace creation is logged. Hooks never throw;
  cleanup failures are logged and the archive proceeds. The server reads the saved setting from
  `$PASEO_HOME/plugin-settings/daemon-link/hosts.json` and fails closed (no cleanup) if that file is
  unreadable.

## 0.5.0 — 2026-09-09

Requires Paseo 0.8 or newer.

- Migrated to the Paseo 0.8 runtime layout: `index.client.tsx` and `index.server.ts` entries, code
  under `client/`, `server/`, and `shared/`, and `requirements.paseo` set to `>=0.8.0`.
- Client hooks and contexts now import from `@getpaseo/plugin/client`, server contexts from
  `@getpaseo/plugin/server`, against SDK `0.8.0-beta.1`.
- Removed the legacy `index.ts` bridge, the `legacy.client` and `legacy.server` shims, and the local 0.8 type stub.

## 0.4.0

- Simplified Hosts and added reviewed project transfers over the encrypted relay.
- Illustrated setup guide.
