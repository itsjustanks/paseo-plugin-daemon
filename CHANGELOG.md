# Changelog

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
