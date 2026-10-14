# Managed browser source

The workspace browser adapts Omer Cohen's MIT-licensed paseo-shared-browser at
`daed6eb12f4156ca392f71c48e7a9ccca231ae8c`, with video, display controls and protocol-3
updates checked against `504b5907a3b44d72c0a15757a9a9f6e7ca03dd29`.

Source: https://github.com/omercnet/paseo-plugins/tree/504b5907a3b44d72c0a15757a9a9f6e7ca03dd29/paseo-shared-browser

Full notices are retained in `server/managed-browser/LICENSE.txt`,
`client/managed-browser/LICENSE.txt` and `shared/managed-browser/LICENSE.txt`.

Local adaptations isolate namespaces, bound video and JPEG IPC replies, sanitize failures,
manage native viewer visibility and stage browser-only Node privately. Composer browser presence
adapts the upstream shortcut with bounded reads and host-scoped agent observation. Historical chat
cards and exact-tab navigation are Hosts additions. Existing external browser observation and Hosts
process policies retain their separate implementation.

Shared Browser is an alternative plugin, not a required dependency. Installing both does not merge
their profiles, MCP tools or control leases. Hosts does not silently import an independently launched
Dev Stack Agent Browser into its managed runtime.
