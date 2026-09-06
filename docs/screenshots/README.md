# Documentation screenshots

These PNGs capture the real plugin UI with the fictional RPC fixtures in `tests/ui/plugin.tsx`.
They are not captures of an authenticated Paseo installation. The preview imports the client surface
only; it does not read daemon settings, credentials, processes, or project directories.

## Reproduce

1. Run `npm ci`, then `npm run preview:ui` from the repository root.
2. Open `http://127.0.0.1:43197` in a fresh browser session without saved authentication.
3. Use a 1280 × 960 viewport for Local Projects, Dev Relay, and Daemon Health → Project processes.
4. Use a 390 × 844 viewport with `?light` for Guide & Setup.
5. Capture the viewport directly, inspect every image, then commit the reviewed PNGs.

| File | View |
| --- | --- |
| `local-projects.png` | Local Projects, dark theme |
| `dev-relay.png` | Dev Relay → Private localhost, dark theme |
| `daemon-health.png` | Daemon Health → Project processes, dark theme |
| `guide-mobile.png` | Guide & Setup, light theme and narrow viewport |

Fixture names, paths, ports, process IDs, metrics, and peer records are fictional. Never replace
these images with a live daemon screenshot. Redaction patterns cannot reliably remove every account
name, project detail, session identifier, or access URL from a real installation.
