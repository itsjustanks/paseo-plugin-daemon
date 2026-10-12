# Hosts cross-daemon integration

The client and server entries register cross-daemon coordination once per installation. The dedicated
**Hosts → Connections** tab shows configured computers, their connection and agent-access state, and the
next action. Setup instructions fold away when at least two computers are configured. Restricted app/file
grants, SSH forwards and SSH recovery have separate disclosures below it. Old Workspaces connection deep
links redirect to their new location.

Paseo's public plugin API exposes `useHosts()` and `getPaseoClient(serverId)`, but no pairing-link import
or app add-host navigation API. The guide therefore uses Paseo's existing app pairing flow, without a
fake Paste control or a credential field. On the other computer, open Settings → host → Pair a device,
enable relay and copy its pairing link (or run `paseo daemon pair`). Paste the link in the app's supported
pairing flow and review the host. Naming and configuring computers remains owned by Paseo.

Adding a computer is separate from enabling agent access, sending a prompt or migrating a chat. The
page never reads credential offers into its query cache. Enabling names currently opted-in recipients
and explains that later opt-ins also receive access. It uses the existing default-Cancel, single-use
full-authority confirmation. The transport and security contracts below are unchanged.

Client cleanup stops the shared scheduler first. Server cleanup calls the cross-daemon cleanup first,
before awaiting other Hosts cleanup. The scheduler combines installation-scoped RPC connections,
debounces changes, allows one sync at a time, and syncs once per minute while the app is open.

Official references checked for this UI:
[plugin reference](https://paseo.sh/docs/plugins/reference.md) and
[connectivity](https://paseo.sh/docs/connectivity.md).

## Authority and data contracts

- Settings ID: `hosts-cross-daemon`, host scope, version 1. Defaults are
  `{ enabled: false, fullAuthorityConfirmed: false }`. Enabling without the explicit acknowledgement
  fails schema validation. No reads or migrations from Hosts settings or existing pairing grants.
- UI status RPC: `hosts-cross-daemon.describe`. Contains ID, enabled state, and availability only.
- Peer display RPC: `hosts-cross-daemon.list-peers`. Contains names and IDs only.
- Credential sync RPC: `hosts-cross-daemon.sync-offer`. Returns this daemon's offer only after opt-in
  and with relay enabled. Only the scheduler calls it; never put its result in query caches, tables,
  normal status, diagnostics, or logs.
- Credential recipient RPC: `hosts-cross-daemon.set-peers`. The client checks opt-in, safe status, and
  generation before credential dispatch. Off or unavailable recipients receive only an empty list. The
  server checks fresh opt-in again before writing.
- Tools: `list_daemons`, `list_workspaces`, `list_agents`, `get_agent_activity`, `send_agent_prompt`.
  MCP server ID: `hosts-cross-daemon`; exact tool preapprovals are separate from existing grants.

Enabling shares a **full-control pairing link**, including authority over agents and files beyond
Hosts grants. The confirmation names that authority. Cancel acts without saving. Confirm uses Hosts'
existing single-use guard. A failed settings acknowledgement closes the spent confirmation, shows an
error, and refreshes the real host state; it never optimistically reports success.

State is stored in `$PASEO_HOME/plugin-data/hosts-cross-daemon/`: directory mode 0700 and JSON, proxy,
and socket mode 0600. Reads harden existing modes and reject symlink files. Atomic JSON writes use
exclusive private staging files. Agents running as the daemon owner can read this storage; this is
explicit in the confirmation. CLI errors use fixed classifications instead of raw stderr or
`error.message`. Remote CLI targets use child-only `PASEO_HOST`; links never appear in argv, and
inherited `PASEO_HOME` is removed for that child. Local calls use explicit `--home` and remove
inherited `PASEO_HOST`. This matches the authoritative cached `@getpaseo/cli` 0.11.1 target parser and verified official
0.9.2/0.10.3/0.11.1 release source.
Tool output also applies Hosts' redactor and explicit pairing-offer redaction.

Turning off clears local peers, queued prompts, and finish watches and aborts pending CLI work.
Unloading stops future effects before cleanup awaits anything. A CLI send already accepted remotely
cannot be recalled; its result is uncertain and it is never automatically retried. Turning off does
**not** revoke a previously shared pairing link or force sleeping peers to sync. Rotate credentials
separately if revocation is required. Silent hosts retain their last shared record until they answer.

## Compatibility and boundaries

Hosts' current manifest remains `>=0.9.0`. The pinned upstream reference declares `>=0.9.2`; its
private daemon pairing/CLI adapter is retained behind runtime export checks, not replaced with guessed
SDK pairing methods. The supplied official reference and SDK 0.10.3/0.11.1 declarations document the
settings `read`/`subscribe` handle, `before("agent.create")`, and `useHosts` contracts used here.

Missing settings handles or `before` leaves the feature unavailable, registers only safe fallback
RPCs, and does not load adapters or start a socket. Missing `useHosts` shows an update message.
Therefore this optional feature need not raise Hosts' existing minimum. If the parent chooses to
require coordination on every supported runtime, review a minimum bump separately; do not claim
full cross-daemon functionality on 0.9.0. The fleet target is 0.11.1.

New Claude and Codex agents receive this stdio MCP server and exact tool approvals only while opted
in. OpenCode receives MCP without adding a tool policy, matching the reference's auto-accept rule.
Configured aliases of these roots follow the bounded `extends` chain. Other providers are untouched; an
existing MCP server with the same ID is not replaced. Existing
agents retain their saved MCP configuration, but calls are denied while off. No existing sandbox,
application, file, or provider grant is broadened. Caller IDs are best effort; providers that omit
`PASEO_AGENT_ID` get an unidentified-caller envelope with no reply or finish-notice promise.

## Delivery guarantees and limits

Prompts are limited to 50,000 characters, 20 pending messages per target agent, and 1,000 total queue
entries. Messages and finish watches expire after 24 hours. Only an explicit `idle` status can send;
unknown states wait. Prefixes resolve to full IDs, and sends serialize per daemon and agent. The
queue persists an in-flight marker **before** immediate and delayed sends. Unacknowledged sends,
restart-interrupted sends, aborts, disconnects, and output-buffer failures are never replayed.
Inspection failures can wait for another round because no send has started. Concurrent delivery
rounds share one promise. One FIFO transport limiter permits at most four active CLI calls across
all tools, deliveries, and notices; queued work is cancelled on disable/unload. Each round visits at
most 32 watches and 32 pending-agent messages, rotating so busy early entries cannot starve later
ones. This limits transport resources independently from Hosts heavy-job policy. Remote activity is
limited to 1–500 entries and 64,000 display characters;
CLI output is bounded at 1 MiB. Finish notices use bounded text and wait for the sender to be idle.

A turn can start between the idle check and CLI send; the upstream CLI offers no atomic idle-only
send. The UI puts this limitation under Details. Each outbound prompt keeps the reference's random
provenance marker and begin/end payload boundaries. Provenance is a display aid, not an identity
security boundary against processes running as the same daemon owner.

## Review and verification

```sh
npm run typecheck
npm test -- tests/cross-daemon
node scripts/cross-daemon/verify-compatibility.mjs
npm run test:coverage
npm run check:hygiene
npm run test:compatibility
```

The feature compatibility script copies sources to a temporary directory, uses the same real pinned
0.9.0 and 0.11.1 upstream compilers as Hosts, and evaluates only fake daemon adapters. Missing-API
cases contain no invented `before` hook. Supported-API fixtures exercise both off and enabled settings/hook
contracts, including MCP injection, five exact Claude/Codex preapprovals, OpenCode without new policy,
and configured aliases. Temporary files are removed in `finally`. It never pairs, installs, enables,
or sends a production prompt. Run both compatibility scripts when reviewing integration.

Reference: maxwell-01/maxs-paseo-plugins `cross-daemon`, pinned revision
`975f8c4c062cb78ca82b203c8952e6c31621a9e6`. See `cross-daemon-LICENSE.txt` for the full retained MIT notice.

Runtime isolation: the SDK contracts checked here do not expose a plugin instance ID. Each compatible runtime
must first acquire the atomic owner-only `runtime.lock` directory in its private state folder. A second
instance reports unavailable and never reads, clears, or writes peers, queue, watches, proxy, or socket. The
lock lasts through socket shutdown. No automatic stale-lock takeover occurs. After a crash, stop all instances
using that home and remove the stale `runtime.lock` and `tools.sock` alias before restarting; never remove
them while an owner may be running. Socket binding uses a unique private `.ipc-*` folder and an inode-checked
published alias because Node automatically unlinks its bind path on close. Old crash binding folders may be
removed only while all instances are stopped.

Configured provider aliases resolve through `context.paseo.config.get().config.providers[id].extends`,
verified against the cached official `@getpaseo/server` 0.11.1 `daemon-config-store.js` and
`agent/provider-registry.js`, and the SDK hook context/PaseoConfigActions contracts. The opted-in hook follows
at most 16 entries, rejects cycles/unknown roots, and keeps the original provider ID and provider command.
Claude/Codex roots receive the same five exact tool approvals; OpenCode receives no new policy. No provider
environment or credentials are copied into MCP configuration or output.
