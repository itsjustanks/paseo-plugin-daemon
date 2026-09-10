# Documentation screenshots

These PNGs capture the real plugin UI with the fictional RPC fixtures in `tests/ui/plugin.tsx`.
They are not captures of an authenticated Paseo installation. The preview imports the client surface
only; it does not read daemon settings, credentials, processes, or project directories.

## Reproduce

1. Run `npm ci`, then `npm run preview:ui` from the repository root.
2. Open `http://127.0.0.1:43197` in a fresh browser session without saved authentication.
3. Use a 1280 × 1060 viewport for Dev servers, Connect, Project Sync, Daemon Health, and the workspace
   panel (`?view=panel`).
4. Use a 390 × 844 viewport with `?light` for the narrow Dev servers view with its collapsed guide.
5. Headless: `AGENT_BROWSER_ARGS=--no-sandbox agent-browser open http://127.0.0.1:43197/` then
   `agent-browser screenshot <file>`; press Open on a card first for the link-ready state.
6. Capture the viewport directly, inspect every image, then commit the reviewed PNGs.

| File | View |
| --- | --- |
| `dev-servers.png` | Dev servers with a live browser link on one card, dark theme |
| `workspace-panel.png` | Workspace Hosts tab (`?view=panel`) after pressing Open, dark theme |
| `dev-relay.png` | Connect → Private localhost, dark theme |
| `project-sync.png` | Project Sync → Receive a project → Development server → Preview Website |
| `daemon-health.png` | Daemon Health → Project processes, dark theme |
| `guide-mobile.png` | Dev servers with the collapsed setup guide, light theme and narrow viewport |

Fixture names, paths, ports, process IDs, metrics, and peer records are fictional. Never replace
these images with a live daemon screenshot. Redaction patterns cannot reliably remove every account
name, project detail, session identifier, or access URL from a real installation.
