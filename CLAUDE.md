# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

KeyPool — a local, single-operator OpenAI-compatible **key pooling proxy** with a React dashboard. You add upstreams as `(base_url, api_key, model_id)` triples; every OpenAI-compatible client points at one base URL and one unified key, and KeyPool picks which upstream key serves each request, fails over, and logs usage.

`PRODUCT.md` and `DESIGN.md` are governing documents, not changelogs. Read them before changing product surface or visual design. Notably, `PRODUCT.md` pins: **a visual redesign must not change any wording, behaviour, or displayed data** — work is confined to visual design and motion.

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`; no native modules, no ORM). pnpm workspace with `server` and `web`.

**There is no linter and no formatter.** No ESLint, Prettier, or Biome config, and no `lint` script in any `package.json`. `pnpm typecheck` (tsc `--noEmit`, `strict` + `noUncheckedIndexedAccess`) is the only static gate — style is enforced by review, not by tooling. This directory is also **not a git repository**, so there is no history to consult and no diff to fall back on.

## Commands

```bash
pnpm install          # pnpm >=10 blocks postinstall by default; pnpm-workspace.yaml allowBuilds esbuild
pnpm build            # tsc -> server/dist, then vite build -> web/dist
pnpm verify           # build + smoke. The gate to run before claiming done.
pnpm smoke            # end-to-end: boots the BUILT server on port 21999 against a fake upstream
pnpm typecheck        # tsc --noEmit both packages
pnpm dev              # tsx watch (server) + vite on 5173 proxying /api, /v1 and /anthropic to :20121
run.bat              # one-command start: stop old, always build, serve, open browser. Honours PORT.
```

The vitest suite was removed from this repo on request (November 2026), and the live-check probes in `scripts/` were removed with it — only `smoke.mjs` and `stop-keypool.ps1` remain. `pnpm smoke` is the only automated verification gate. References to old `server/test/**` paths elsewhere in this document are historical.

`pnpm smoke` runs the **built** server, so run `pnpm build` first or it checks stale output.

## Architecture

### One process, three surfaces

`server/src/index.ts` assembles an `AppContext` (`db`, `store`, `settings`, `poolState`, `recorder`, `queries`, `dataDir`) once at boot and hands it to `buildApp`. A single Fastify instance on port 20121 serves all three surfaces:

- `/v1/*` and `/anthropic/v1/*` — the proxy
- `/api/admin/*` — the dashboard's REST API
- everything else — the built SPA from `web/dist` (`@fastify/static` + an SPA fallback in the not-found handler)

Two details in `app.ts` that are load-bearing:

- **All content-type parsers are removed** and bodies are captured as raw strings, so the proxy forwards upstream JSON with minimal re-serialisation. Parse explicitly where you need structure.
- **Auth runs at `preHandler`, not `onRequest`**, deliberately: a rejected request is still recorded in the request log with the model it asked for, rather than vanishing from the dashboard. `/v1/api/hello` is exempt because clients probe base-URL reachability before doing anything.

**The per-model lookup is addressed with `*`, not `:id`, and that is not cosmetic.** A model id is whatever the upstream calls it, and vendor-prefixed ids contain a slash — `vendor/model-id`, `minimax/minimax-m3:free`. A `:id` param matches exactly one path segment, so `GET /v1/models/vendor/model-id` fell through to the not-found handler and answered `{"code":"not_found"}` — a *route* miss — while the identical name sat in `GET /v1/models`. Every coding agent that resolves its model before dispatching read that as "no model with that name". It survived a 686-test suite because every fixture was called `fake-model` — and that suite, along with the live-surface probes that covered for it, is gone; this class of routing bug has no automated net now. find-my-way decodes the wildcard, so `vendor%2Fmodel-id` resolves to the same entry rather than becoming a second spelling only that one can find — keep it that way. Both dialects share one `modelLookup(dialect)` handler so a lookup can never disagree with the list; an empty remainder (`/v1/models/`) returns the list rather than looking up `""`.

**A trailing `[1m]` is a variant selector, not part of a model id.** Claude Code appends one to request the 1M-context variant, so the name on the wire is `vendor/model-id[1m]`, which no gateway has ever heard of. `core/modelName.ts` strips it, and `resolveRequestedModel` retries the stripped name **only** when the exact one matched nothing and is not an alias — a fallback, so a model genuinely registered under a bracketed name keeps winning rather than being redirected. Three things to preserve if you touch it: the pattern stays narrow (`[<number><k|m>]` only, so `model[nonsense]` still 404s instead of being silently served as `model`); `requestedModel` keeps the marked spelling so the log records asked-vs-served; and `findPooledModel` in `proxy/models.ts` applies the same fallback but returns the **canonical** id, because that is the name the catalogue advertises.

### Data model

Eleven domain tables, joined into a `RoutableEntry` (endpoint + credential + model entry) — that triple is the thing that gets pinged, health-checked and routed to:

`endpoints` (a base URL) → `credentials` (sealed keys) → `model_entries` (the triple; carries weight, priority, status). Plus `aliases` + `alias_targets` (a named chain of entries, ordered by `position`), `model_spoofs` (a name → real model id), `settings` (key/value), and `request_logs` (the log every dashboard number aggregates from). Migration 6 adds `stats_best_streak`; migration 7 added the cost-accounting tables and columns, migration 10 removed them, and migration 11 restored them (same shapes — migrations are append-only, so the restore is a new migration, never a resurrection of 7); migration 8 adds `credentials.refusal_streak`; migration 9 adds `endpoints.compat_profile`; migration 12 adds `request_logs.client_category` (the incoming client the identity classifier named — claude-code, codex, opencode, unknown — recorded on every row, rejected requests included). `schema_migrations` tracks applied versions.

`request_logs` deliberately declares **no foreign keys** — `entry_id`, `alias_id` and `endpoint_name` are plain columns and the endpoint name is a denormalised snapshot. That is what lets history survive an upstream or key being deleted, and it means orphaned log rows are normal rather than a defect.

**`model_entries.seq` is load-bearing.** It is a monotonic insertion order added by migration 4, and `listRoutableForModel` orders by it because entry ids tie on the same millisecond during a bulk import. It is what makes `failover`'s promise — "always the first healthy key" — mean *the first key the operator added*. Don't replace that `ORDER BY me.seq` with `created_at` or the id; `priority` re-ranks on top of it, so the two strategies would otherwise be indistinguishable.

Schema changes are append-only migrations in `db/migrations.ts`, each in its own transaction, tracked in `schema_migrations`. Never edit an applied migration. Migration 3 is the one to read before touching aliases: it rebuilds the table to make `strategy` nullable, and the copy-aside dance is load-bearing because `alias_targets` cascades on `DROP TABLE` — `defer_foreign_keys` defers the check, not the cascade.

**Never put a backtick inside a migration's SQL.** The `sql` field is a template literal, so a comment that quotes an identifier in backticks terminates the string and the file stops parsing. Write `prune()` or StatsRecorder.prune() instead. The house style is long explanatory comments, so this is an easy trap to fall into.

### The proxy path

`proxy/chatCompletions.ts` is the one endpoint that does real work, and it serves **both dialects through a single handler** (`{ dialect: 'openai' | 'anthropic' }`). The attempt loop between the edges is shared and deliberately untouched — resolution, per-attempt re-read, probe claim, breaker, pool state, recorder — so both dialects pool, fail over and record identically. Only the request it builds, the bytes it writes back, and the error envelope differ. When adding a capability, decide which of those three it belongs to rather than forking the loop.

The Anthropic dialect is **inbound.ts** (Anthropic → OpenAI request), **outbound.ts** (OpenAI response → Anthropic envelope), **stream.ts** (OpenAI chunks → `message_start` / `content_block_*` / `message_delta` / `message_stop`). Anthropic-only features with no OpenAI equivalent — `thinking`, `effort`, `top_k`, server-side tools, citations, cache breakpoints — are **dropped, not half-translated**. Keep it that way; a partial translation is worse than an omission.

### Compat profiles

Some upstreams serve certain models only to their own agent client, decided from the request's *shape*. `core/compat.ts` holds the profiles; `endpoints.compat_profile` (migration 9) opts one endpoint in; `applyCompatProfile` is applied in the attempt loop **after** the client's wishes are encoded and again to the probe's ping body — a ping that fails the gate would mark healthy entries `auth_error`. The `opencode-zen` profile forces `stream: true` + `include_usage` (a client that asked not to stream still gets a whole completion — `collectCompletionFromSse` reassembles the frames it now receives) and appends two alias tools (`bash`, `read`) when the client's own tool names don't satisfy the gate. Identity headers (user-agent, vendor session ids) are deliberately **not** part of a profile — they live in the endpoint's `extra_headers` where the operator controls them. A ping that streams is only a success once its frames say so: a reassembled completion, or a finish reason — a reasoning model given the probe's 1-token budget finishes with an empty turn, and that certifies the key fine.

### Routing

`routing/selector.ts` turns a model name into an ordered failover plan. A name is one of three things:

1. an **alias** — checked first, wins outright, targets entries in a declared order
2. a **spoof** — redirects to the target's whole *pool* (this is the entire difference from an alias: an alias targets entries, a spoof targets a model)
3. a plain model id

Two things that are easy to break:

- **Health filtering happens before strategy ordering**, so a strategy never wastes a slot on a key known to be down.
- **`poolKey` is `alias:<name>` or `model:<target>`** — keyed on the *target*, so spoofed and direct traffic to the same model share one round-robin cursor and one last-good entry rather than each keeping counters over the same physical keys.
- `sequenceByDeclaredOrder` re-sorts an alias back into its declared order after the strategy runs: for an alias the strategy only decides which target is tried *first*, never the chain.

Eight strategies in `routing/strategies.ts` (`round-robin`, `random`, `weighted`, `least-used`, `least-latency`, `priority`, `lkgp`, `failover`). A per-alias strategy overrides the global default; `null` means inherit.

### Health and failure handling

`routing/health.ts` is a **pure state machine** — `applyOutcome` returns the next `CredentialHealth`, persistence is the caller's job. Test it without a database.

| Upstream | Effect |
|---|---|
| 401/403 | `auth_error` — taken out of rotation, **never auto-recovered by traffic**, only by a re-ping. A wrong key is a config problem. |
| 429 | cooldown; `Retry-After` honoured, else exponential backoff with ±20% jitter |
| 404 / model not found | locks out that one `(key, model)` pair only; sibling keys unaffected |
| 5xx, timeout, DNS, TLS, network | `retryable` — increments the fail streak; at threshold the breaker opens, and a failed half-open probe re-opens it with a doubled window |
| other 4xx | `client_error` — returned to the client immediately, never retried |

`claimProbe` is a guarded `UPDATE ... WHERE breaker_state = 'open'`, so exactly one in-flight request wins the half-open slot and the rest fail fast rather than stampeding a down upstream. Preserve that atomicity if you touch it.

**A refusal behind a 200 is a second, weaker signal, and it is deliberately not a `fail_streak`.** An upstream can accept a request and then answer with an error envelope — as the whole body, or as a `data:` frame inside a stream. That used to reach `request_logs` and nowhere else: no fail streak moved, no breaker opened, so with more healthy keys than the retry budget every request drew fresh unmarked keys and an upstream refusing everything produced the same 502 indefinitely. Migration 8 added `credentials.refusal_streak` for it, counted per credential by `recordRefusal` as a single `UPDATE … RETURNING` so two concurrent requests cannot lose an increment. A single refusal is weak evidence — a bad tool schema or a context overflow is refused identically on every key, and counting that would retire healthy keys over the caller's mistake — so the streak only reaches the breaker past `refusalThreshold` (default 3), and **any success clears it**, never at the 2xx but where success is actually established. One thing to know if you touch the admin surface: `reset-entry-health` resets the breaker and fail streak but **does not clear `refusal_streak`**, so a key one refusal short of tripping re-trips on its next refused request after a reset.

**Failover only happens before the first byte reaches the client.** Once a stream has started, the upstream response is the only valid continuation. The one exception worth knowing: if a stream dies before delivering *any* content, the reply was never hijacked, so it is indistinguishable from a connection that never opened and is failed like a network error — the next key is tried. See the comment at `chatCompletions.ts:235`.

Streaming differs per dialect on purpose: the OpenAI path relays upstream frames byte-for-byte, the Anthropic path re-emits them as a different event sequence.

**On the relay path, "the client is committed" and "the turn produced something" are two different questions, and only one of them is about size.** `pipeSseToReply` relays bytes without parsing them, so the same scan does double duty: it extracts usage for the log, and it decides whether the attempt delivered anything at all. That second decision is what fails over — an uncommitted attempt is abandonable, so every key in the pool is spent re-sending a request the upstream already answered. The temptation is to test `outputChars > 0`, and it is wrong twice over:

- **Output is not a character count.** A turn can produce plenty and still count zero. A tool call that takes no arguments streams a name and an empty string — nothing to add — and a reasoning turn under `thinking` counted zero while `reasoning_content` and `reasoning` counted. What the committer needs is substance, so it reads a separate `sawOutput` flag: reasoning is read through one list of all three names, and a tool call counts on the strength of the call *existing*, not on its arguments being non-empty. That is already how the other two content readers in the file decide — `parseWholeCompletion` above and `collectCompletionFromSse` below both treat `tool_calls.length > 0` as content — so the streaming scan was the outlier. (`charsOfCompletion` is the one deliberate exception: it measures size for the token estimate, where size *is* the right question, so a no-argument call correctly contributes nothing to it.)
- **An empty answer is still an answer.** The committed-but-empty case (a `finish_reason` with no content) is why the test is `sawOutput || sawFinishReason` and never content alone — a preamble-only stream must stay abandonable.

The failure mode of getting this wrong is consistent and expensive: a fresh 502 naming a network fault that never happened, after every key in the pool was spent on a request that succeeded. `server/test/integration/openai-reasoning-and-tools.test.ts` pins it on the OpenAI side; `anthropic/stream.ts` handles the same two cases through `firstNonEmptyString` and its `tool_calls` loop, and `anthropic-stream.test.ts` covers them there.

### Stats

`StatsRecorder.record()` buffers rows in memory, flushing every 2s or at 100 rows, whichever comes first; a separate hourly timer flushes then prunes by `logRetentionDays`. Writes are wrapped in a transaction whose failure is swallowed — usage telemetry is never worth failing a request over, which also means **a log row can be silently lost**; don't assume every request is in there. `StatsQueries` does every aggregate in SQL against `request_logs`.

**Every dashboard number is a SQL aggregate over the request log** — never a counter kept alongside it. That is the invariant that lets the dashboard and the log never disagree and survive a restart. Prompt and response bodies are never stored.

There is exactly **one recorded exception**, and it is deliberate:

- `PoolState` — round-robin cursors, in-flight counts, latency EWMA and last-good are **in-memory only** and reset on restart. Health/breaker state, by contrast, is persisted per credential.

(`stats_best_streak`, migration 6, is a second: a single monotonic row holding the longest streak ever, because `prune()` deletes the days that produced it and a "best" that silently drops is worse than none.)

### Costs

`cost_usd` is a **snapshot written by the recorder at log time** against the resolved upstream model's row in `model_prices` — never recomputed at read time, so a price edited tomorrow cannot silently reprice yesterday's spend. NULL means *unpriced* and is excluded from totals while counted separately; a true 0 means no tokens were served. Prices come from the OpenRouter catalogue (`stats/priceSync.ts`, fetched fire-and-forget at boot and every 24h; manual rows are skipped by every sync) and match by exact id, then by unambiguous bare name after the last slash — an ambiguous tail stays unpriced. The Costs page rides `useAutoRefresh` plus an SSE feed (`/api/costs/stream`): the event carries only a count, the page refetches through the same SQL, and the recorder drains on a ~300ms fast path while subscribers exist so a finished request is on screen in about a second. `StatsRecorder.subscribe()` is the only notification mechanism — the event payload must not grow.

A used model is priced from its row in the By model table: `GET /api/costs/prices/match` returns every catalogue row that could price the id (the exact hit, or all tail candidates when the bare name is ambiguous — the picker is where the operator makes the choice `resolvePrice` refuses to make), and `POST /api/costs/prices` accepts `backfill: true` to price the already-logged rows the new price covers. The backfill touches **only** `cost_usd IS NULL` rows, selects them with the same exact-or-bare-tail rule `resolvePrice` applies, and treats reasoning as already included — it prices the unknowns, it never relitigates a snapshot.

Evaluation of used models is **automatic**: every successful catalogue sync runs `CostStore.evaluateUsedModels()` (also exposed as `POST /api/costs/evaluate` and a button on the page), which walks the distinct models still carrying unpriced rows and prices each one the catalogue can name unambiguously — backfill included. Ambiguous and unknown models are deliberately left for the picker: automation never guesses.

### The ranking

`intelligence/ranking.ts` and `intelligence/knowledge.ts` are **pure** — the composite is arithmetic over numbers the route assembles from the request log (success, latency), key health and the price table. The intelligence axis is a **curated prior per model family** in `knowledge.ts`, not a measured figure, and the route (`GET /api/admin/intelligence`) returns the weights it used so the page can explain the ranking rather than assert it. Spoof names never appear: a spoof is a client-facing alias, not a model, and ranking one would invent a model nobody serves. If you touch the weights, touch them in one place — `COMPOSITE_WEIGHTS` and `ROLE_WEIGHTS` are exported constants the page echoes, not values it re-derives.

### The streak

`stats/streak.ts` is **pure** — no I/O — so the day arithmetic is unit-testable without a database, the same split as `routing/health.ts`. Two rules are load-bearing and easy to get wrong:

- **Days are local, not UTC.** `localDayKey` in TS and `date(ts/1000,'unixepoch','localtime')` in SQL are two implementations of the same boundary and *must* agree; a UTC bucket files evening traffic under tomorrow on a positive offset. `test/integration/streak-endpoint.test.ts` asserts they agree.
- **Today is pending, not broken.** The walk starts at yesterday when today has no success yet, so opening the dashboard in the morning does not cost a streak. A gap anywhere *else* ends the run.

A day with no traffic is **absent** from the input, not present-and-zero — the aggregate groups over rows that exist. And `truncated` distinguishes a real gap from the edge of the retained log; when set, the UI shows "at least N" rather than a number it cannot support.

Badges and the best are earned against `best`, never the current run, and are never revoked. That is a product decision, not an oversight: see `PRODUCT.md` principle 6.

The card is rendered by `Stats.tsx` from the page's existing `load()` — **it has no timer of its own**. Stats already polls every 3s, so a second interval would be a second thing to clean up, and `web-surface.test.ts` enforces that. The milestone toast is guarded by a ref for the same reason: at a 3s cadence an unguarded toast repeats forever. The first load adopts what is already earned *without* announcing it.



### Settings and keys

`SettingsStore` caches in memory and writes through to SQLite immediately, so a dashboard change affects the very next proxied request without a restart — except `port` and `bindAddress`, which are in `RESTART_REQUIRED_KEYS`.

Precedence is **CLI flag > env var > Settings > built-in default**. The `portExplicit`/`hostExplicit` flags in `env.ts` exist because settings are *pre-seeded with defaults*, and without them a stored default would silently beat an explicit `--port`. Don't remove them.

Only four env vars are actually read: `PORT`, `KEYPOOL_HOST`, `KEYPOOL_DATA_DIR`, `KEYPOOL_LOG_LEVEL` (plus `--open`, `--port`, `--host` as CLI flags). `KEYPOOL_REQUIRE_API_KEY` is **not** an env var — `requireApiKey` is a database-backed setting toggled from the dashboard (`.env.example` says so). The server does not read `.env` at all.

The unified client key is stored **only as a SHA-256 hash** and compared in constant time; the plaintext lives in `data/unified-key.txt` and is printed on **every** start, not just the one that generated it. Upstream keys are sealed with AES-256-GCM under `data/master.key`; losing that file makes every stored key unrecoverable, by design. No route, log line, or error may ever return a key in plaintext — the dashboard shows the last four characters only.

## Frontend

React 19 + Vite 8 + Tailwind 4 (`@tailwindcss/vite`), react-router-dom 7, Recharts 3. `web/src/lib/api.ts` is a thin typed wrapper over the admin API — add endpoint calls there, not ad-hoc `fetch`.

**Tokens are semantic, never literal.** There is no `slate-500` in this codebase. `index.css` defines ink values in `:root` and `.dark` and registers them via `@theme inline` as `--color-*`, so one class name resolves to different ink per theme. Reference colour by role (`canvas`, `surface`, `raised`, `inset`, `line`, `line-strong`, `fg`, `subtle`, `muted`, `faint`, `accent`, `ok`, `warn`, `bad`). Adding a colour means adding a role, not a value.

The house rules from `DESIGN.md` that code review will catch you on: exactly two radii (`--radius-panel` 12px, `--radius-control` 6px — the theme toggle is the one recorded exception), no shadow on a panel, panels never nest, `line` is decorative only and never identifies a control (`line-strong` is for control boundaries), and no page assembled out of equal stat cards.

Charts cannot read a Tailwind class, so they go through `useInk()` in `lib/theme.ts`, which re-reads computed token values on theme change. Don't hardcode a hex in a chart.

`StreakCard` renders on the **Stats** page, not in the margin. It was in the sidebar first and was moved: a statistic belongs on the page that reports statistics, and in the margin it had to pin a fixed height to keep the nav's travelling bar honest — a cost the page layout does not have. `NAV` in `App.tsx` is a single list of destinations again; `web-surface.test.ts` asserts the streak is absent from `App.tsx` so it cannot creep back in.

**Any block inserted into the margin must pin its height** (`height:`, never `minHeight:`). The nav measures the active row's offset in a `ResizeObserver` on the `<nav>`, which is `flex-1` — so a block that grows after first paint moves every row below it *without resizing the observed element*, the observer never fires, and the travelling selection bar lands on the wrong row. Invisible in a screenshot; only shows on navigation. `minHeight` does not fix it: it reserves space for the loading state and the content then grows past it.

`useAutoRefresh` (`lib/useAutoRefresh.ts`) is the one polling mechanism — 3s, shared by Overview, Stats and Costs, and a refresh still running when the next tick lands is skipped rather than stacked. All three live surfaces must use it; `server/test/unit/web-surface.test.ts` asserts they do.

## Testing

- `smoke.mjs` builds nothing; it boots `server/dist` on port 21999 with a fake upstream and exercises dashboard, admin API, bulk import and a real proxied request. It is the only automated check in the tree — the live probes that drove both dialects against real upstreams were removed in November 2026.
- The vitest suite (unit, integration, web-surface, i18n coverage) was removed from this repo on request; it survives only in a backup archive outside the tree. Restore it before relying on structural contracts again.

## Gotchas

- The server logs the unified key to stdout on every start. Don't paste that output into a committed file or an issue.
- `KEYPOOL_LOG_LEVEL=debug` re-enables Fastify's per-request logging, which is off by default — the request log is the record, stdout is for what the process has to say. The proxy's own diagnostics line (`proxyRequest: true` — client identity, provider, status, duration) is also debug-level for the same reason: at the default `info` a busy pool prints one JSON line per request to the terminal forever.
- `request_logs` is the table name, not `request_log`. Two tables recording one event would break the log-is-the-source-of-truth rule. `PRODUCT.md`'s "Evidence on Hand" figures drift as the pool is used — read counts from the database, not from prose.
- **`/models` is a dashboard page, not a proxy route.** `web/src/App.tsx` declares `<Route path="/models">`, so a `GET /models` with no `/v1` falls through to the SPA fallback and answers **`200` with `text/html`** — a 2xx that is not an API response. Don't "fix" it by registering `/models`; an agent configured with the base URL missing `/v1` fails to parse HTML as a catalogue, which is why that misconfiguration is worth naming in `README.md` rather than papering over at the routing layer.
- The dashboard is served from `web/dist`, which the running server only picks up at boot. After `pnpm build`, restart the process or the browser keeps the old bundle. `run.bat` is the reliable way to do that: it stops the prior instance **before** building and builds unconditionally, so the process serving requests is always the one built from the sources on disk. Two facts make a hand-rolled restart unreliable — Node loads code once at boot, so a server started earlier keeps serving its old build while looking freshly launched; and the effective port can come from the database rather than `PORT` (`resolveBootSettings`), so "whatever is on 20121" is not always "the old KeyPool". `scripts/stop-keypool.ps1` matches on the **absolute** server path for that reason: a bare `server\dist\index.js` is identical in every Node project and WMI exposes no working directory to tell them apart, so a relative match would terminate an unrelated project's server. It did, once, on this machine — which is why `run.bat` launches by absolute path and the relative form is refused.
- **OpenCode Zen gates its free-tier models on client identity** — `fledge-alpha-free`, `longcat-2.5-preview-free` and friends return 403 "OpenCode's free tier can only be used from within OpenCode" to any request that does not look like the opencode client. Verified empirically against the live gateway (2026-10-07): the gate is per-model (a sibling free model on the same key was open), reads the **request body** (`stream: true` plus at least two opencode tool names required; system prompt, token budget and tool definitions irrelevant), and validates the **`x-opencode-session` id** against sessions a real opencode client created. A correct user-agent alone unlocks nothing, and the error is a 403, not a 401 — which is why the proxy path marks only the *entry*, never the credential, on this message. The working setup on the "Open Code" endpoint: `compat_profile = 'opencode-zen'` **plus** identity headers in `extra_headers` (`user-agent: opencode/<ver> ai-sdk/… runtime/bun/…`, `x-opencode-client: cli`, `x-opencode-project: global`, and a session id minted by a real client run). The session id is the fragile part — if the gate starts refusing again, re-run any `opencode` command under the capture listener to mint and capture a fresh one.
