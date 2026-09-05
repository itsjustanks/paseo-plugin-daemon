# Validation — 2026-09-05

Daemon Link supports Paseo **0.7.2 and the 0.8 preview API** from the same checkout.
The 0.2 release was activated on Paseo 0.7.2 and its live status/monitor RPCs verified.
The 0.3 update adds project scope and the guided interface described below.

Verified locally:

- TypeScript check, repository hygiene, and `git diff --check` pass.
- 147 automated tests pass with the existing coverage thresholds unchanged. The optional network
  test is skipped in the default suite; it was run separately and passed.
- Coverage: statements 88.68%, branches 82.22%, functions 86.69%, lines 95.32%.
- Full dependency audit reports no known vulnerabilities.
- The installed 0.7.2 compiler and pinned upstream 0.8 compiler both build this exact checkout.
  Both server bundles register the same 20 RPCs, return schema-valid status, reject an invalid
  pairing code, and clean up twice safely. Client bundles load only permitted UI dependencies.
- Client contribution checks cover the sidebar, workspace panel, Command Center, and the 0.8
  composer shortcut. The shortcut and its Setup indicator are hidden when the capability is absent.
- Historical credential-shaped literals were reviewed before publication: only synthetic redaction
  fixtures were found; current tracked files pass the repository hygiene check.
- Two isolated plugin backends paired and forwarded a disposable synthetic HTTP service through
  `wss://relay.paseo.sh`. No project, daemon endpoint, or browser-control port was exposed.
- Local relay integration covers encrypted HTTP and WebSocket traffic, multi-megabyte responses,
  TCP half-close, an occupied local port, reconnect, persistent pairing, and live revocation.
- Temporary-gate tests cover authentication, Host/Origin rejection, cookie filtering, HMR-style
  WebSocket upgrades, expiry, and shutdown. Helper lifecycle tests use a fake executable.
- Browser previews were checked at desktop and 390-pixel mobile widths, in dark and light themes.
  Checks include project grouping, the guided setup, connection methods, both sort directions,
  pagination, search, and an expanded agent row with no stop action.
- New tests verify project/worktree membership, path-boundary lookalikes, broad-root exclusions,
  custom managed-service ports, registry failures, filtered pagination, revoked scope with old action
  tokens, and exclusion of an agent's descendant subtree. Service leases reject unverified ports
  and close when project authorization changes.

The UI preview uses deterministic fixtures and React Native Web. It is not proof of activation in
the Paseo app. The temporary Cloudflare gate was tested locally; a live Quick Tunnel was not opened.
The checksum installer was tested with offline fixtures, not a system-wide installation.

## Reproduce

```sh
npm ci
npm run typecheck
npm run test:coverage
npm run test:compatibility
npm run check:hygiene
npm audit --omit=dev
npm run preview:ui
```

The preview listens on `127.0.0.1:43197`. Use `?light`, `?empty`, or `?error` for fixture states.
For the explicit network test, which exposes only a synthetic fixture:

```sh
DAEMON_LINK_TEST_RELAY=wss://relay.paseo.sh npx vitest run tests/hosted-relay.test.ts
```

## Remaining release checks

Complete native mobile and two-physical-machine verification. Exercise the final 0.8 release when
it becomes available. The current
published SDK remains 0.7.2; the source-derived development augmentation is explained in
[types/README.md](types/README.md). Remove it after the v0.8 SDK ships.

Use an isolated v0.8 instance for activation testing. No running daemon, agent provider configuration,
or existing SSH connection needs to be restarted or changed by this plugin.
