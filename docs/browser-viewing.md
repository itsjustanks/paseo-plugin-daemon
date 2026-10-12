# Watching existing Agent Browser sessions

Choose the host where the agent runs, then Hosts → Processes → Browsers. Select a session, press Watch, and
select a tab. A workspace's Agent browsers panel and Watch browser table actions list only sessions whose
workspace attribution was verified. Unattributed sessions remain available in the host-wide list. Chat
attribution requires verified live daemon ancestry.

Hosts observes the existing browser. It never navigates, activates a tab, sets a viewport, evaluates page
scripts or closes agent tabs. Closing/changing/hiding the viewer detaches capture; the browser stays running
on the selected host. Lease expiry also releases abandoned viewers. A sleeping local laptop cannot host a
running browser; use an always-on remote host for laptop-off work.

## Supported attach boundary

Agent Browser **0.27.0** native executable layouts are recognized, including Linux x64. Its help supports `get
cdp-url`, `session list`, `tab list` and stream status/enable/disable. Hosts does **not** invoke those CLI
commands or send IPC commands during discovery, so missing or stale sessions cannot autostart. No version-only
rejection and no automatic upgrade/install occurs.

A supported session has same-user regular PID metadata and an owned Unix IPC socket in an owned directory that
other UIDs cannot write (0755 can be valid). The verified Agent Browser daemon must own a Chromium/Chrome or
chrome-headless-shell descendant with one unambiguous loopback TCP debugging endpoint. Fresh OS identity and
exact address/family/listener ownership are checked for attach and each capture. macOS uses uncached lsof;
Linux uses complete process FDs and both TCP tables. Incomplete, wildcard, conflicting or ambiguous endpoint
evidence fails closed. Ownership can change in the small interval after the final syscall check.

Pipe-only, externally attached, foreign-user or unprovable listeners are listed with a precise limitation. Use
an owned local TCP-debugging Chromium session in that remote runtime, or update Agent Browser/runtime
configuration deliberately using its own documentation. Enabling a public stream or opening a client-chosen
remote URL is not an alternative.

## Capture and privacy

Only fixed discovery and observer CDP methods are allowed. Clients send bounded session/tab/viewer identities,
never CDP methods, endpoints or arbitrary commands. HTTP and WebSocket endpoints must match the verified
loopback literal, family and port; redirects are refused. Timeouts and payload caps bound attach and capture.
At most four viewers use one frame per second, JPEG quality 55, a 1280 × 900 maximum and a 15-second renewal
lease. Selection follows session and target IDs, never tab indices; a removed tab requires a new explicit
selection.

URL userinfo, query and fragments are removed, and title/URL secret patterns are redacted. Screenshots show
page content and can contain sensitive information; they are neither logged nor persisted by Hosts. Capture
uses the selected daemon's authenticated Paseo RPC, with no public listening port. Native panels handle
light/dark themes. Hidden/unmounted or changed host/workspace viewers stop polling and capture. A native
caller retaining an offscreen component must pass `visible={false}`.

## Verification and source

An isolated macOS Agent Browser 0.27.0 / Google Chrome smoke test, with stream disabled and a 0755 IPC
directory, verified fresh workspace cwd attribution, changing background-tab screenshots, preserved active
tab, and a usable browser after viewer detach. Unit fixtures cover Linux and Darwin endpoint parsing,
freshness, timeout cleanup, redaction and lifetime.

An isolated Linux smoke with synthetic Agent Browser 0.27.0 sessions also verified changing capture,
preserved active tab, a usable browser after detach and owned-resource cleanup. Physical mobile and actual
remote Paseo RPC viewing remain separate validation boundaries.

Browser transport patterns use the pinned MIT [shared browser
source](https://github.com/omercnet/paseo-plugins/tree/daed6eb12f4156ca392f71c48e7a9ccca231ae8c/paseo-shared-browser),
with [the retained Omer Cohen notice](../server/browser-LICENSE.txt). Hosts does not import its
controlled-browser runtime or installation behavior.
