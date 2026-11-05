# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Commands

- `pnpm typecheck` — the only static gate (strict + `noUncheckedIndexedAccess`). No linter, no formatter.
- `pnpm verify` — build + `scripts/smoke.mjs`, which boots the **built** server on port 21999 against a fake upstream and exercises proxy, admin API, keys, stats, costs and settings.
- Everything else (`dev`, `build`, `start`) is standard pnpm; `run.bat` stops the old instance, rebuilds unconditionally, serves on 20121 and opens the browser.

**There is no unit test suite.** It was removed on request (Nov 2026), along with the live-check probes in `scripts/` (only `smoke.mjs` and `stop-keypool.ps1` remain); do not add or assume `vitest` / `pnpm test`. `pnpm verify` is the only automated gate.

**Restart before claiming a fix.** The server loads code at boot and serves `web/dist` from disk: after a `server/src` change restart the running instance; after a `web/src` change run `pnpm build`. A stale process will make a correct change look broken.

## Protect `data/`

`data/` holds the live SQLite DB, `master.key` and `unified-key.txt`. Never delete it or point destructive checks at it. For mutation testing, boot a scratch instance and use its key:

```bash
PORT=21191 KEYPOOL_DATA_DIR=/tmp/kp node server/dist/index.js
```

## Wiring

- New routes go in `server/src/routes/*.ts` and must be registered in `app.ts` **inside the existing guarded `app.register` scope** — that is where `requireApiKeyForAdmin` is enforced.
- Models are the pool's `(base URL, key, model)` triples grouped by `entry.modelId` (same grouping as `web/src/lib/models.ts`). Spoof names are client-facing aliases, never models.
- Ranking is read-only arithmetic in `server/src/intelligence/` — intelligence is a curated prior (`knowledge.ts`), reliability and efficiency are measured from the request log and the price table. Never add a second source for those numbers.
- Every dashboard number is a SQL aggregate over `request_logs`; prompt/response bodies are never stored.

## i18n

- English text is the dictionary key: `t('Some text', { n })`; `{n}` placeholders must survive translation.
- Every new UI string needs entries in **all six** locales under `web/src/lib/locales/` (es, fr, de, hi, ja, zh). The coverage test that enforced this was removed — nothing else catches drift.
- Never `t(\`template\`)`; keys must be string literals.
- The language switch remounts the tree (`Fragment key` in `I18nProvider`) on purpose.

## Gotchas

- **Not a git repository** — no history or diff to fall back on. Back up anything before deleting it.
- Polling only through `useAutoRefresh`; no hand-rolled `setInterval`. Chart colors come from `useInk()`.
- `CLAUDE.md` documents proxy, routing, breaker and Anthropic-dialect invariants in detail — read it before touching those paths.
