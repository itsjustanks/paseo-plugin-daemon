# Hosts

See CPU, memory, disk use and dev servers on the selected Paseo host. Processes offers All processes,
Heavy jobs, Browsers and Housekeeping views. Review a process tree before stopping it; protected agents
and daemon processes explain why they cannot be stopped here. Existing settings and defaults are preserved.

Workspaces lists the current snapshot of up to 50 running listeners with workspace/project association,
CPU, memory, ports, Open and reviewed Stop. Memory sorts highest first. Ownership stays unknown when
it cannot be identified. Disk measurements are separate and run only when requested.
Same-user apps can appear outside registered projects and without an active chat. Manual Stop reviews
ownership and the process tree with Cancel selected by default. Open and sharing still require verified
project and port scope; inventory alone does not authorise automatic stops.

## Work with an always-on remote host

- Open the workspace Browser to share tabs, navigation and input with new workspace agents. Human control
  takes priority. Supported web clients use video with JPEG fallback; hiding the panel detaches its viewer.
  The browser keeps running on the selected host. Browser cards and a shortcut connect this view to chats.
- Watch external Agent Browser sessions separately. This observer checks process and endpoint ownership
  and does not control, navigate or close an independently launched browser.
- Connections guides optional agent access across computers, off by default. Explicit confirmation shares
  full daemon authority between opted-in hosts, separately from restricted app and file access.
  Turning it off does not revoke pairing links already shared.
- Recover another host from Overview or Command Center → Connections. Select an online helper, save a
  hostname/SSH alias and local SSH config/key reference, then test or review a fixed recovery action.
  Remove deletes only the saved connection. No startup SSH, automatic recovery or credential setup.

## Setup and limits

The managed workspace browser requires Paseo 0.11.1 or newer and prepared private assets. Connected-host
coordination requires connected-host APIs; unavailable runtimes show an update explanation.
External Agent Browser 0.27.0 local Chromium TCP sessions are supported when fresh same-user IPC, process
and exact loopback listener ownership can be proven. Pipe-only, external or ambiguous sessions explain
why attach is unavailable. External observation is bounded to roughly one frame per second; the agent
keeps control. It is distinct from the managed browser's video and human-control path.

For laptop-off use, run the agent and browser on an always-on remote host. A sleeping laptop cannot keep
its own local host running. Paseo's desktop browser navigation opens a local tab and is separate from
this remote viewer. An offline target needs a reachable recovery helper; if all helpers are down, use
the provider console. Housekeeping retains its existing preview/live confirmation and Linux limits.

Read the [headless setup guide](docs/headless-setup.md), [browser support details](docs/browser-viewing.md)
and [full README](README.md). This trusted plugin runs with the selected daemon user's privileges.
