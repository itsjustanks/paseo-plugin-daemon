# Headless Paseo and recovery from your phone

Run the development runtime on a machine that stays on. Your phone is a client; closing your laptop should not
remove the runtime or its recovery credentials. Prepare recovery before the target stops.

## Choose a runtime

| Choice | Good fit | What you maintain |
| --- | --- | --- |
| Paseo Dev Stack | Container with agent and browser tools | Docker, mounts, image and tool updates |
| Standard Paseo daemon | Existing Linux development host | Paseo, tools and service manager |

[Paseo Dev Stack](https://github.com/itsjustanks/paseo-dev-stack) is a community project.
Follow its README and run `make doctor` after setup. It runs agents as
`paseo`; its default main container is `paseo-dev-stack-paseo`. Keep its persistent home, workspace and global
packages mounts. In particular, `/opt/npm-global` is persistent in the current stack. Installing tools only in a
container's writable layer can lose them when that container is recreated. Back up your data before upgrades.

For a standard installation, the [official getting-started guide](https://paseo.sh/docs) starts with:

```sh
npm install -g @getpaseo/cli
paseo
```

Install and authenticate the agent CLIs as the same runtime user. Keep its Paseo home and workspaces on persistent
storage. For unattended Linux startup, configure your own systemd service for that user and the correct absolute
Paseo executable, working directory and environment. `paseo daemon run` is the foreground command for a supervisor.
A unit named `paseo.service` is a recovery form default, not a promise that Paseo installed that unit. Validate your
actual unit and its startup behaviour yourself. The systemd recovery preset supports system services, not user units,
launchd or arbitrary supervisor commands. See [configuration](https://paseo.sh/docs/configuration).

## Connect the phone and keep the network reachable

Pair the phone with the runtime using Paseo's **Pair Device** flow. Choose the relay, a private network such as
Tailscale, or another supported connection method from the [connectivity guide](https://paseo.sh/docs/connectivity).
Review authentication and network exposure in the [security guide](https://paseo.sh/docs/security). Do not expose an
unauthenticated daemon or browser stream to the public internet.

Pair the phone with your recovery helper too. The helper must reach the target's SSH port over its own network;
a phone-to-Paseo relay connection does not supply a helper-to-target SSH route. Test this with the laptop off.

## Browser tools live with the agent runtime

Install [agent-browser](https://github.com/vercel-labs/agent-browser) on the machine or inside the container where
the agents run, with its browser dependencies there. Installing it on your laptop does not equip a remote agent.
Dev Stack already includes it; check its current README for supported browser and streaming setup. For another
runtime, follow agent-browser's own installation instructions as that runtime user.

The upcoming Hosts browser workspace panel is the in-Paseo entry point for observing that runtime's browser.
Treat its roughly one-frame-per-second view as an observer: the agent retains browser control. Availability depends
on the browser panel being integrated and supported on that host. It is separate from Paseo's desktop browser tools.
Keep browser state and any additional tools in the runtime's persistent storage. Do not open a public stream port.

## Prepare a separate, always-on recovery helper

A recovery runner is another online Paseo daemon with Hosts installed. It can be a small always-on helper on your
private network. Run it outside the target's failure domain if you need to recover the target host itself.

**An offline Hosts installation cannot recover itself.** Paseo's selected host supplies the plugin bundle and RPC
transport. Calls do not fall through to another host. An offline restored panel can remain unavailable. Switch the
Hosts host picker to a reachable helper, then open its recovery section and settings. Save profiles independently
on each helper. See [Hosts and lifecycle](https://paseo.sh/docs/plugins/reference#hosts-and-lifecycle).

On that helper, prepare SSH as the daemon's operating-system user:

1. Choose a target hostname or an SSH config alias, optional user and port, and the correct existing container or unit.
2. Put a usable SSH key on the helper, or configure an agent that remains available there. A laptop's 1Password SSH
   agent will not be available when the laptop is off. An encrypted key needs an already unlocked agent; Hosts cannot
   unlock it or prompt for a passphrase.
3. Obtain the target's host-key fingerprint through a trusted channel, such as its provider console. Verify it before
   adding the key to the helper user's `known_hosts`. `ssh-keyscan` output alone does not authenticate a host. Resolve
   changed fingerprints deliberately; never bypass verification or automatically accept an unknown key.
4. In **Recovery connections**, save the connection on the helper. Use **SSH config / agent**, or **Key file reference**
   with an absolute path on the helper. This saves connection details and a file reference, never a copy of a key.
   Never paste passwords, key contents or tokens into profile fields.
5. Use **Test SSH + status**. Saving and listing profiles work while the target is offline and never connect to it.

The helper keeps at most 20 profiles under `$PASEO_HOME/daemon-link/recovery/profiles.json` (normally under `~/.paseo`).
The recovery directory is owner-only `0700`; the file is `0600`. Symlink paths and unsafe ownership or permissions are
refused. Protect and back up this configuration as part of the helper. It is not shared between daemons.

## Choose the smallest recovery action

- **Test SSH + status** reads the configured service state. Docker reports running only when the local daemon status
  JSON identifies a reachable worker; malformed or unreachable status stays unknown. Full status JSON is discarded.
  A stopped worker inside a running container is reported separately; Start container cannot restart that worker.
  It does not prove the phone can reconnect to Paseo.
- **Start container**, with Docker / Dev Stack, starts the named existing container. It never runs Compose or creates,
  recreates, updates or replaces containers. A missing container requires normal setup outside Hosts.
- **Restart Paseo worker**, with Docker / Dev Stack, restarts only its Paseo worker as user `paseo`. It prefers
  an executable
  `/opt/npm-global/bin/paseo`, otherwise resolves `paseo` inside the container, then runs `paseo daemon restart`.
  Worker restart needs a reachable daemon RPC and an existing supervisor; it cannot fix a dead worker by itself.
- **Restart existing container** is the separately confirmed fallback when the worker RPC is dead. It runs a fixed
  Docker restart and interrupts every agent, terminal and service inside that container. It never recreates it.
- With the **Systemd service** preset, status/start/restart operate only on the validated configured system unit.
- **Reboot host** is separate and interrupts all work on the target, including other daemons and services. It requires
  a warning and the exact saved connection name. Recovery reboot uses `systemctl reboot`, so it needs a systemd host.

SSH is non-interactive, with strict host-key checking, no agent forwarding or terminal, a connection deadline and a
bounded command deadline. Hosts does not retry recovery actions automatically. A timeout or closed connection can
leave the outcome uncertain. A reboot reply means a request was sent or a connection closed, **not that recovery
succeeded**. Wait, then run a separate check and reconnect to the target in Paseo.

Enable **Use sudo -n** only if the target account has deliberately scoped non-interactive permissions for the selected
commands. Explicit `root` connections run directly. `sudo -n` fails instead of asking for a password. Review the exact
fixed commands in the integration guide before granting access. Docker access is already powerful; never mount its
socket into the recovery helper or grant broad passwordless sudo merely to make the test pass.

If every helper is offline, use the provider console or another independent administration path. SSH cannot recover a
powered-off host, an unreachable SSH service, a broken network, or a disk that prevents the host from booting. Hosts
has no provider power-control API in this phase.

Recovery does not migrate agents or their state. Continuity and any cross-daemon sharing are separate, opt-in features.
