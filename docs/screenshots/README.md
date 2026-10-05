# Documentation screenshots

These PNGs capture the real plugin UI with the fictional RPC fixtures in `tests/ui/plugin.tsx`.
They are not captures of an authenticated Paseo installation. The preview imports the client surface
only; it does not read daemon settings, credentials, processes, or project directories.

## Reproduce

1. Run `npm ci` in the repository root.
2. Point `PLAYWRIGHT_CORE` at any checkout of `playwright-core` (it is not a dependency of this
   plugin) and have Google Chrome installed.
3. Run `node tests/screenshots.mjs <folder>`. It renders every state in light and dark, at 1280 and
   420 px wide, and reports page errors and clipped boxes. `SHOTS=overview,processes` limits it.
4. Inspect every image, copy the reviewed ones here, then commit them.

Preview query strings: `?busy` (a runaway, memory near the container limit, a slow watched
service), `?mac` (no container), `?light`, `?view=panel`, `?view=settings`, `?view=popover`,
`?tab=processes`.

| File | View |
| --- | --- |
| `overview.png` | Overview with four issues (`?busy`), light theme |
| `processes.png` | Processes with runaways and the heaviest processes (`?busy`), dark theme |
| `popover.png` | The quick health check from the sidebar dot, narrow, light theme |
| `dev-servers.png` | Dev servers, dark theme |
| `dev-relay.png` | Connect, dark theme |
| `project-sync.png` | Project Sync, light theme |
| `workspace-panel.png` | A workspace's Hosts tab with issues (`?view=panel&busy`), light theme |
