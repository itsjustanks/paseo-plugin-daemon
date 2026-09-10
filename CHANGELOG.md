# Changelog

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
