# Changelog

## 0.5.0 — 2026-09-09

Requires Paseo 0.8 or newer.

- Migrated to the Paseo 0.8 runtime layout: `index.client.tsx` and `index.server.ts` entries, code under `client/`, `server/`, and `shared/`, and `requirements.paseo` set to `>=0.8.0`.
- Client hooks and contexts now import from `@getpaseo/plugin/client`, server contexts from `@getpaseo/plugin/server`, against SDK `0.8.0-beta.1`.
- Removed the legacy `index.ts` bridge, the `legacy.client` and `legacy.server` shims, and the local 0.8 type stub.

## 0.4.0

- Simplified Hosts and added reviewed project transfers over the encrypted relay.
- Illustrated setup guide.
