# v0.8 preview types

The npm `@getpaseo/plugin` package currently publishes 0.7.2. Its UI tokens and RPC contracts remain
usable for development, but it lacks the runtime-entry context declarations documented for v0.8.

`paseo-v08.d.ts` adds only the entry methods this plugin uses, based on the upstream declarations at
commit `f4b209be4d81d25a6143d12d374d797d485e8faa`:

[Upstream contracts.ts](https://github.com/getpaseo/paseo/blob/f4b209be4d81d25a6143d12d374d797d485e8faa/packages/plugin/src/contracts.ts)

This is a development declaration augmentation, not runtime compatibility. Remove it and upgrade
the SDK dependency when v0.8 is published. Typechecking against it cannot replace loading the
plugin in a real v0.8 daemon/client and exercising its contributions.

The server-only relay library is pinned separately. It uses Paseo's existing E2EE implementation
and v2 relay wire format, with a distinct plugin identity and scoped service pairing.

This repository intentionally supports both loaders, rather than performing a one-way migration.
`index.ts` is the 0.7 adapter. The 0.8 loader ignores it when runtime entries exist, and those entries
never import it. `npm run test:compatibility` tests both pinned compiler implementations, matching
RPC registrations, client/server separation, cleanup, and conditional composer shortcuts. This
exception to the migration guide is required for a single install URL across mixed-version hosts.
