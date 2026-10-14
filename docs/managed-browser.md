# Workspace browser

Open Hosts Browser in a workspace on the host that should run Chromium. Open browser starts `about:blank`;
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
The inherited agent-browser Linux launcher uses `--no-sandbox`; no Chromium OS sandbox is claimed.
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
installed. Isolated Linux x64 acceptance passed as described below. Other architectures, Windows, musl and
display/Xvfb provisioning are outside this release's preparation support.

## Upgrading existing browser sessions

The streaming runtime uses protocol 3. A protocol-2 runtime from Hosts 0.21 can keep running after a
plugin update, even when its browser windows are closed. Hosts blocks the new runtime until that
previous runtime has stopped and its shutdown is verified. It does not share profiles between them.

The blocked Browser panel offers **Restart Hosts browser runtime**. Review the selected host and
confirm closing **all** its Hosts-managed browser sessions; Cancel is the default. A browser that
does not close normally may be forced to stop by the old runtime, and recent unsaved changes can be
lost. Saved site profile folders are kept. This does not restart Paseo or the computer.

The action binds the old coordinator's identity and records the attempt before sending one SIGTERM.
An uncertain outcome keeps browser startup blocked. **Recheck browser runtime restart** verifies the
result without another signal; it never retries shutdown automatically. If verification remains
unavailable, restart that host's container or computer and recheck. Unreadable receipts or changed
profile ownership may still need manual support; Hosts does not delete them automatically.

Successful verification does not open a browser or take control. Open the browser explicitly when
ready. A historical chat card still points only to its original tab, which may now be unavailable.
Create new browser-enabled agents after the upgrade: existing agents retain their old MCP runtime
configuration and are not silently redirected.

## Browser access from chats

When a managed browser is open, its workspace chats show a Hosts Browser shortcut. Known Hosts MCP tool
steps also receive a compact history card labelled Hosts Browser, with the operation result and an
Open Hosts Browser action (Open this tab in Hosts Browser when the result identifies a tab). The
card uses the selected host's agent workspace; a missing or moved workspace cannot redirect it. When
the result names a tab, opening the card attaches only to that tab and does not create a browser. A
closed tab shows an unavailable state with an explicit way to see the remaining tabs.

Screenshots stay in Paseo's native image timeline. Cards do not capture additional screenshots or run
per-message polling. Their result is historical; it does not assert that the browser or host is online
now. The browser shortcut uses a shared, bounded presence read. URLs in history summaries omit their
path, query, fragment and credentials. Existing chats without the Hosts MCP configuration do not gain
browser tools automatically.

For sign-in, open that chat card or the Hosts Browser panel on the same host, take Control, sign in,
then Return control so the agent can continue. Opening a card only observes; it does not take control
or create a replacement for a missing tab. Agent instructions name this panel explicitly. The naming
guidance applies to new agents; existing agents retain their saved configuration and MCP runtime.

Paseo's built-in browser and the separately installed Shared Browser plugin use different sessions.
Hosts does not intercept their tool rows or open their panels: the supported plugin API scopes panel
navigation to the calling plugin. A sign-in prompt from either browser must be handled in that browser.
Hosts does not infer that sign-in is needed from a page title, URL or page content.

## Transport and input boundaries

Video and JPEG use authenticated Paseo RPC over a private daemon/supervisor socket; no public stream port
is exposed. WebCodecs clients can render VP8 video, with JPEG fallback for unsupported clients or
unavailable video. Display settings include resolution, bitrate and 15/30/60 frame-rate ceilings. These
are limits, not promised delivery rates. `HOSTS_BROWSER_VIDEO=0` disables native video on the host.

Screenshots can briefly restart video capture. In a synthetic local 1280 × 800 test, one agent capture
and input per second kept video visible, with a longest measured paint gap of 251 ms. A tight loop
of 186 capture/input pairs in 15 seconds exhausted video recovery and showed image updates instead,
with a longest presented-frame gap of 2.7 seconds. These are local test measurements, not remote or
phone performance guarantees.

Replies remain bounded to 1 MiB, video batches to 512 KiB of raw packets and 768 KiB of encoded packet
JSON, and JPEG payloads to 600,000 bytes. A complex page at a large resolution can exceed the video
packet bound even at a lower bitrate; it then uses JPEG fallback. Screenshot acquisition waits for native
video capture to stop, and video can resume afterward. Identity, lease, bridge epoch, tab, navigation, viewport and
current decoded-frame checks are retained. Pages and screenshots can contain secrets; private profiles persist
site state. Runtime failure logs omit raw CLI output and browser content. Detaching stops viewer capture,
but the upstream frame cache is not immediately purged. Missed workspace-archive events are not
reconciled automatically; no cleanup guarantee is made for an archive event the plugin did not receive.

## Current browser and chat checks

The isolated Paseo 0.11.2 app rendered browser history cards at desktop and 390-pixel widths in both
themes. Historical links opened the correct workspace without creating a browser; a later normal
open did not retain the historical tab. Explicit browser opening, live video, control, navigation and
trusted input passed. The composer shortcut followed the existing browser's presence. The mock chat
remained idle with only the six fixed plugin examples, without a provider turn.

This checks the real timeline renderer with fixed examples. Actual provider result transformation is
covered by compiled fixtures, not by a live provider turn. Current Linux streaming acceptance and the
legacy-runtime restart action remain separate pending gates; prior Linux results below do not cover
these changes. Physical phone, OS IME, background behaviour and remote-network latency are unverified.

## Prior 0.21 validation baseline

The full suite passed 1,717 tests with 13 skips; unchanged function coverage floor 85% passed at 85.48%.
Real 0.11.1/0.11.2 compilers and private bootstrap tests passed under exact Node 22.23.2. Three real Mac
Chromium smokes passed; two Linux-only smokes were skipped on Mac. Loopback Node 22 bridge to Node 24 supervisor
checks covered navigation, viewer tabs, human priority and stale-agent rejection. Those checks did not
validate all agent MCP tab operations: later testing found that the released parser rejected them and
lost the request ID in its error reply. The current fix admits the four declared tab operations and
preserves bounded request IDs in error replies; separate real MCP checks cover all four operations,
closed and foreign tab refusal, and prompt invalid-request errors. Physical keyboard input through
the actual managed UI delivered Hello exactly once, with trusted key/input events. Desktop and 390px web
layouts were inspected. Synthetic pagehide stopped captures and preserved the runtime. Scoped independent
runtime and control-boundary reviews passed. The isolated Paseo 0.11.2 app passed actual bundled SVG,
UI and plugin RPC acceptance at 390px and 1440px: visible control labels, acquire/release status,
viewport resize and changing frames, with no horizontal document overflow. Five focused control-label
tests also passed after the full suite; the full suite was not repeated for that label-only change.

Isolated Linux x64 acceptance passed five native browser smokes and eight spawned supervisor/MCP
checks through the Node 22.23.2 bridge. Verified private versions were Node 24.20.0, agent-browser 0.38.2
and Chrome for Testing 155.0.8059.39 (revision 1697595). Checks covered explicit startup, changing JPEGs,
trusted input, human priority, takeover fences, shared-page MCP navigation and private executable paths.
Owned browser processes, fixture listeners, IPC and marked scratch were cleaned up; the existing Node 22
daemon remained unchanged. This is isolated runtime acceptance, not production deployment acceptance.

Paste and IME insertion/cancellation have adapter tests, not live OS clipboard/IME acceptance. Touch and
native compose have ported policy/input/component tests; physical React Native phone interaction remains
unverified, including native background behavior. Remote Paseo network latency and live OS clipboard/IME
behavior remain unverified.
