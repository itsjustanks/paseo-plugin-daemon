# Changelog

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
