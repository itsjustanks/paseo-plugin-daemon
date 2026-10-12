# Hosts

See CPU, memory, disk use and dev servers on the selected Paseo host. Processes offers All processes,
Heavy jobs, Browsers and Housekeeping views. Review a process tree before stopping it; protected agents
and daemon processes explain why they cannot be stopped here. Existing settings and defaults are preserved.

## Work with an always-on remote host

- Watch existing Agent Browser sessions through authenticated Paseo RPC inside a native workspace panel.
  Workspace actions show verified attribution. Closing or hiding the viewer releases capture and preserves
  the browser. Hosts does not install or start browsers, navigate, activate tabs or change their viewport.
- Workspaces includes optional cross-daemon coordination, off by default. Explicit confirmation shares
  full daemon authority between opted-in hosts, separately from restricted app and file access.
  Turning it off does not revoke pairing links already shared.
- Recover another host from Overview or Command Center → Workspaces. Select an online helper, save a
  hostname/SSH alias and local SSH config/key reference, then test or review a fixed recovery action.
  Remove deletes only the saved connection. No startup SSH, automatic recovery or credential setup.

## Setup and limits

Use Paseo 0.9 or newer. Connected-host coordination requires newer connected-host APIs; unavailable
runtimes show an update explanation. Install browser dependencies deliberately on the host running the
agent. Agent Browser 0.27.0 local Chromium TCP sessions are supported when fresh same-user IPC, process
and exact loopback listener ownership can be proven. Pipe-only, external or ambiguous sessions explain
why attach is unavailable. Capture is bounded to roughly one frame per second; the agent keeps control.

For laptop-off use, run the agent and browser on an always-on remote host. A sleeping laptop cannot keep
its own local host running. Paseo's desktop browser navigation opens a local tab and is separate from
this remote viewer. An offline target needs a reachable recovery helper; if all helpers are down, use
the provider console. Housekeeping retains its existing preview/live confirmation and Linux limits.

Read the [headless setup guide](docs/headless-setup.md), [browser support details](docs/browser-viewing.md)
and [full README](README.md). This trusted plugin runs with the selected daemon user's privileges.
