# Workspace browser

Open Browser in a workspace on the host that should run Chromium. Open browser starts `about:blank`;
merely loading Hosts or creating an agent does not start Chromium. The page owns the available height.
Use the address bar, back/forward/reload, tabs and direct input. Display options, optional native text
entry, close/reopen and Watch external browser live in the menu. A backgrounded viewer detaches;
the daemon-owned browser persists until closed, archived or its host stops.

New Claude, Codex and OpenCode workspace agents (including resolved provider aliases) receive a separate
`hosts-browser` MCP configuration when prepared assets are available. Existing servers and tool grants
are preserved; permissions still follow the user's provider configuration. Existing agents are not
retroactively changed. Missing preparation never prevents ordinary agent creation. Independent CLI or
Paseo desktop browser tools are not redirected to this browser. Human priority is enforced only within
the managed runtime; Watch external browser makes no exclusive-control promise.

## Explicit preparation and support

The manifest runs `node scripts/browser/bootstrap.mjs`, with `PASEO_HOME` provided by the host being
prepared. It requires network access, tar and unzip. Its builtins-only bootstrap works under the tested
Node 22.23.2 daemon and verifies official Node 24.20.0 artifact hashes before execution. Private Node runs
`npm ci --ignore-scripts` from the pinned lockfile. Do not manually run agent-browser postinstall: upstream
may modify a global shim. No global Node, CLI or browser is installed or replaced.

Assets live under `$PASEO_HOME/plugin-data/daemon-link/browser/.runtime-<uuid>`, selected by an atomic
`runtime-current` pointer. Supervisor/MCP launch descriptors bind to immutable directories. Profiles,
private CLI configuration, sockets and tickets remain Hosts-owned. These are same-user isolation and
authority boundaries, not an OS sandbox against arbitrary same-user code. On macOS, Chrome Crashpad
can still use its OS user-data path outside the private runtime; private HOME does not confine it.
Keep old asset versions while
their processes use them; automatic reclamation is intentionally deferred. Interrupted preparation may
leave `prepare.lock`; verify no preparation is running before removing that owned lock.

Pinned versions: Node 24.20.0; agent-browser 0.38.2; Chrome for Testing 155.0.8059.39, revision 1697595.
Exact official URLs and SHA-256 pins live in `scripts/browser/artifacts.mjs`; each runtime writes
`provenance.json`. Chrome is pinned independently, not through the CLI's floating Stable installer.
One prepared Mac arm64 runtime measured about 497 MiB, plus plugin dependencies and browser profiles.
Preparation temporarily needs archives, dependency cache and both old/new runtimes.

Preparation targets macOS arm64 and Linux x64/glibc. Node's macOS minimum is 13.5; Linux requires kernel
4.18+, glibc 2.28+ and libstdc++ GLIBCXX_3.4.25, plus Chrome's shared libraries. No system packages are
installed. Linux live acceptance remains a separate canary gate. Other architectures, Windows, musl and
display/Xvfb provisioning are outside this release's preparation support.

## Transport and input boundaries

JPEG frames use existing authenticated Paseo RPC over a private daemon/supervisor socket. Replies are
bounded to 1 MiB and JPEG payloads to 600,000 bytes. Native video effects and public stream ports are not
enabled. Identity, lease, bridge epoch, tab, navigation, viewport and current decoded-frame checks are
retained. No FPS guarantee is made. Pages and screenshots can contain secrets; private profiles persist
site state. Runtime failure logs omit raw CLI output and browser content. Detaching stops viewer capture,
but the upstream frame cache is not immediately purged. Missed workspace-archive events are not
reconciled automatically; no cleanup guarantee is made for an archive event the plugin did not receive.

## Validation

The full suite passed 1,717 tests with 13 skips; unchanged function coverage floor 85% passed at 85.48%.
Real 0.11.1/0.11.2 compilers and private bootstrap tests passed under exact Node 22.23.2. Three real Mac
Chromium smokes passed; two Linux-only smokes were skipped. Loopback Node 22 bridge to Node 24 supervisor
and MCP verified navigation, tabs, human priority and stale-agent rejection. Physical keyboard input through
the actual managed UI delivered Hello exactly once, with trusted key/input events. Desktop and 390px web
layouts were inspected. Synthetic pagehide stopped captures and preserved the runtime. Scoped independent
runtime and control-boundary reviews passed. The isolated Paseo 0.11.2 app passed actual bundled SVG,
UI and plugin RPC acceptance at 390px and 1440px: visible control labels, acquire/release status,
viewport resize and changing frames, with no horizontal document overflow. Five focused control-label
tests also passed after the full suite; the full suite was not repeated for that label-only change.

Paste and IME insertion/cancellation have adapter tests, not live OS clipboard/IME acceptance. Touch and
native compose have ported policy/input/component tests; physical React Native phone interaction remains
unverified, including native background behavior. Live Linux acceptance remains pending its separate
reviewer gate. Remote Paseo network latency and live OS clipboard/IME behavior remain unverified.
