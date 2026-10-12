# Recovery integration

This change adds independent recovery modules only. The parent owns entry wiring, placement, README and version.
There is no startup SSH activity, lifecycle hook, new sidebar item or second Hosts page.

## Server entry

Import and register alongside the existing server contribution:

```ts
import { contributeRecovery } from "./server/recovery";

// Inside the existing contribute(server):
const closeRecovery = contributeRecovery(server);

// Inside that contribution's existing async cleanup:
await closeRecovery();
```

Invoke cleanup promptly so queued recovery work is cancelled before other slow teardown. It is idempotent and waits
at most 1.5 seconds; the SSH runner sends SIGTERM to its exact child and SIGKILL after 500 ms if needed. RPC
registrations belong to the plugin lifecycle and are removed by Paseo, as for existing Hosts handlers.

## Existing Hosts UI

```tsx
import { RecoverySection } from "./client/recovery";

// Within the existing Hosts page or its existing settings surface:
<RecoverySection {...props} />
```

`props` must be the selected runner's real `PluginSurfaceProps`, with `host.id`, `host.label`, `theme` and `layout`.
Do not substitute a recovery target as `host`. The section resets on host changes, reads the saved local inventory on
mount and makes no target connection until **Test SSH + status** or a confirmed action. It uses native components and
the existing Hosts theme, Sheet and default-focused CancelButton. There is no React Query cache for credentials,
confirmation tokens or recovery results. Only non-secret profile details and file references are accepted.

Keep this section reachable on the online helper's normal Hosts page/settings. When a selected target is offline,
Paseo cannot obtain its bundle or run its RPCs. The person must use the existing host picker to select a reachable
helper installation. Do not add silent fallback routing. If all helpers are down, point to provider-console recovery.

Publish `docs/headless-setup.md` with the parent integration; the section links to its public main-branch location.
That link will not resolve before the documentation is published. No entry or version changes were made here.

## Contracts and persistence

`shared/recovery/index.ts` exports the schemas, types and six RPC contracts:

| Contract | Behaviour |
| --- | --- |
| `recoveryList` | Local inventory and in-memory last results; never probes targets |
| `recoverySave` | Schema version 1, optimistic profile revision; no SSH |
| `recoveryTest` | Exact profile revision, SSH and status only |
| `recoveryPreview` | Captures action, complete profile revision and 60-second expiry; never executes |
| `recoveryConfirm` | Consumes token before validation/effect; reboot requires the exact saved name |
| `recoveryCancel` | Invalidates a pending preview; idempotent, no execution |

The store is `$PASEO_HOME/daemon-link/recovery`, using `~/.paseo` when unset. The directory must be owned by the daemon
user with mode `0700`, and `profiles.json` must be a regular, single-link file with mode `0600`. Existing symlinks
anywhere in the path are refused. Writes use an exclusive no-follow temporary file and atomic rename. Documents are
bounded to 64 KiB and 20 profiles, reject unknown schema versions and duplicate IDs, and validate all fields. Unsafe
storage fails closed with a generic error. No key is opened, copied, stored or returned by the recovery store.

A blank user/port preserves SSH configuration; an explicit user/port overrides it. Target names allow hostnames,
IPv4 addresses and SSH aliases, not URLs, `user@host`, IPv6 literals or command text. Identity references must be
absolute paths on the runner. Key contents, passwords and extra fields are rejected by strict schemas. Existing SSH
configuration is trusted local administrator configuration; its proxy commands and agents remain that user's choice.
Do not put secrets in profile names or references. Profiles are available to clients authorised to use that daemon.

Edits increment the profile revision and invalidate all of its pending previews. Editing/removing an active or queued
profile is refused. Each profile has one operation at a time; at most two SSH children run globally, with a bounded
20-item queue. Confirmation expiry and profile revision are checked again after queue admission. Cleanup rejects
queued work and cancels active work. Last results are in memory only and reset on plugin restart or profile edit.

## Fixed commands and permissions

Every remote word is shell-quoted because SSH joins remote command arguments before a remote shell executes them.
The executor uses Node spawn without a local shell, ignores stdin, bounds captured output, never logs it and never
returns it over RPC. It runs `ssh -T -a -x` with:

```text
BatchMode=yes StrictHostKeyChecking=yes ConnectTimeout=8 ConnectionAttempts=1
ControlMaster=no ControlPath=none ControlPersist=no ForwardAgent=no
ClearAllForwardings=yes RequestTTY=no PermitLocalCommand=no
NumberOfPasswordPrompts=0 PasswordAuthentication=no KbdInteractiveAuthentication=no
```

The deadline is 25 seconds plus at most 500 ms termination grace. There are no automatic retries. SSH host-key,
authentication and reachability failures are classified into fixed messages. Mutation timeout/cancellation/disconnect
can be uncertain; request success never claims end-to-end Paseo recovery. Raw stderr and stdout never reach the UI.

The preset emits only these operations (arguments shown without quoting for readability):

- Docker status: `docker inspect --format {{.State.Status}} -- CONTAINER`, followed, only when running, by a worker
  status check inside that container. Worker status output is discarded.
- Docker start: `docker start -- CONTAINER`.
- Existing-container restart: `docker restart -- CONTAINER`, separately confirmed with an all-work warning.
- Docker worker status/restart: `docker exec --user paseo -- CONTAINER sh -c FIXED_SCRIPT`. The fixed script checks
  whether `/opt/npm-global/bin/paseo` is executable, otherwise uses `command -v paseo`, then executes the CLI with
  `daemon status --json --home HOME` or `daemon restart --timeout 20 --home HOME`. Explicit home prevents a remote
  `PASEO_HOST` variable from redirecting the action. The fixed JSON parser requires localDaemon=running,
  connectedDaemon=reachable and a positive workerPid for running. Internal markers are `container_stopped` for an
  exited/created container, `worker_stopped` for a stopped/not_probed worker inside a running container, and
  `worker_unknown` when that worker cannot be verified. UI state stays stopped or unknown respectively, preserving
  the running-container context and recommending a separately reviewed container restart when its RPC is unavailable.
  The status child has a 15-second deadline and 64 KiB output cap. Full JSON stays in the container.
  Worker restart needs a reachable RPC and supervisor; existing-container restart is the fallback for a dead worker.
  No saved command text enters either script.
- Systemd: `systemctl is-active|start|restart -- UNIT`, with a validated `.service` name.
- Reboot: `systemctl reboot` for either preset; requires a systemd target host.

When the profile explicitly enables sudo, commands are prefixed `sudo -n --`, except for explicit `user=root`.
Grant only deliberate permissions for the chosen target and commands. Recovery does not manage sudoers, keys,
host fingerprints, container creation, Compose, provider APIs, service-unit installation or Docker socket mounts.

## Validation boundary

Tests use temporary owner-only stores and injected fake SSH children/runners. They must never contact production SSH,
restart a live worker or reboot a host. Browser fixtures, when used, must implement these RPCs locally. The ordinary
entry compatibility script cannot include these exports until parent entry wiring; scoped tests bundle the exports
without wiring and check server/client boundaries. Parent review should check wide/narrow and light/dark placement,
keyboard Cancel focus and the host-picker explanation after integrating the section.
