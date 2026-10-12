# Feature sources and integration status

Hosts 0.19.0 uses these supplied references. A link does not mean the upstream plugin or runtime is
installed, bundled, or fully reproduced.

- **[Shared browser][shared-browser]** — adapted
  minimal IPC/CDP/capture patterns into a read-only observer for existing Agent Browser sessions. The
  controlled-browser runtime, navigation, tab activation, viewport changes and browser auto-install are
  excluded. Source revision `daed6eb12f4156ca392f71c48e7a9ccca231ae8c`;
  [retained MIT notice](../server/browser-LICENSE.txt). See [support and limits](browser-viewing.md).
- **[Top][top]** — resource-monitoring design reference.
  Hosts implements its own resource summaries and process/workspace tables using its existing telemetry,
  filtering, sorting and actions. No Top code or plugin-helper runtime was copied into this integration.
- **[Continuity][continuity]** — **not integrated**. Hosts does not perform
  context compaction, session handoff, automatic agent continuation or provider transition. Existing custom
  provider support is separate from Continuity and does not implement those features.
  [Continuity cafe catalog](https://paseo.cafe/plugins/paseo-continuity/).
- **[Cross-daemon][cross-daemon]** — adapted code
  integrated into Hosts' existing Workspaces connections. Opt-in shares full daemon authority, separately
  from restricted app/file grants. Source revision `975f8c4c062cb78ca82b203c8952e6c31621a9e6`;
  [retained MIT notice](cross-daemon-LICENSE.txt). See [integration boundaries](cross-daemon-integration.md)
  and the [Cross-daemon cafe catalog](https://paseo.cafe/plugins/cross-daemon/).
- **[Paseo Dev Stack](https://github.com/itsjustanks/paseo-dev-stack)** — external runtime/setup reference.
  The [headless guide](headless-setup.md) explains persistent runtime/browser dependencies and a separate
  recovery helper. Hosts adds reviewed fixed recovery operations for an existing Docker container or
  systemd service; it does not bundle Dev Stack, create containers or provision credentials.
- **[devbox-fleet](https://github.com/omrihaviv/devbox-fleet)** — external fleet/runtime reference;
  **not integrated**. Hosts does not bundle its fleet tooling, provision development boxes or implement its
  orchestration. Hosts' saved SSH recovery operations and optional cross-daemon coordination are separate
  features, not a devbox-fleet integration.

[shared-browser]:
  https://github.com/omercnet/paseo-plugins/tree/daed6eb12f4156ca392f71c48e7a9ccca231ae8c/paseo-shared-browser
[top]:
  https://github.com/xpufx/paseo/tree/db0d84781271d655afb025d0e4d217cb2c6c288b/plugins/top
[continuity]:
  https://github.com/keefeere/paseo-continuity/tree/063b7e272ee1946f05e9a4845d239821aa02a049
[cross-daemon]:
  https://github.com/maxwell-01/maxs-paseo-plugins/tree/975f8c4c062cb78ca82b203c8952e6c31621a9e6/cross-daemon
