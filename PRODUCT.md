# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single operator. The user runs this on their own machine and is the only person
who touches the box or the proxy. They are comfortable with a tool that has no
login, because the threat model is "only me" — the loopback bind is the whole
security posture, and the dashboard is expected to speak plainly about the
operator's own keys rather than hedging about other users.

## Product Purpose

Point every OpenAI-compatible client at one base URL and one API key. KeyPool
decides which upstream key serves each request, fails over between them when one
fails, and records usage.

Success means the operator never has to think about which upstream key is live.
The Overview functions as a wall display: it is open all day and read at a glance
between other work, so glanceability outranks depth on that surface.

## Positioning

Deliberately a *pool*, not a gateway platform. The stated non-goals are as much
part of the position as the features: no OAuth, no provider catalogue, no token
compression, no semantic cache, no MCP/A2A, no embeddings, images or audio, no
Responses API, no multi-user accounts.

**One non-goal was withdrawn: no cross-vendor format translation.** KeyPool now
accepts Anthropic Messages requests and answers in the Anthropic wire format,
translated at the edge to and from the OpenAI dialect every upstream speaks.
The reason is narrow and worth stating so it does not become a slippery slope:
the pool is unchanged and no upstream was ever anything but OpenAI-compatible,
so this adds a second front door to the same machine rather than a second kind of
machine. Anthropic-only features with no OpenAI equivalent — thinking, `effort`,
server-side tools, citations, cache breakpoints — are dropped rather than
half-translated. Nothing else about the position moved.

The mechanism a neighbouring product could not truthfully copy is the refusal
itself. Upstreams are plain `(base_url, api_key, model_id)` triples and nothing
else; the differentiator is the discipline of not growing a catalogue.

## Operating Context

- A local process on a single port, `20121`, serving both the dashboard and `/v1`.
  Starts with `run.bat`, which installs, builds and opens the browser.
- The unified client key is kept only as a hash in the database. The plaintext is
  written to `data/unified-key.txt` and printed to the console on every start, so a
  key is never lost to a banner that scrolled past once.
- Upstream keys are sealed with AES-256-GCM under `data/master.key`. Losing that
  file makes every stored key unrecoverable — a deliberate trade-off, not a bug.
- The dashboard can never display a stored key in full. Only the last four
  characters are ever shown. Losing the master key is the only recovery path.
- Every dashboard number is SQL-aggregated from the request log, so the dashboard
  and the log cannot disagree, and the numbers survive a restart.
- Prompt and response bodies are never stored.
- The request log is the record of what actually happened: strategy chosen,
  attempts, TTFB, latency, token counts, error text.

## Capabilities and Constraints

- Chat completions with SSE streaming, and a model catalogue synthesised from the
  local pool rather than proxied upstream — the list (`GET /v1/models`) and a
  single entry (`GET /v1/models/{id}`) on both dialects. Because a model id is
  whatever the upstream calls it and vendor-prefixed ids contain a slash
  (`vendor/model-id`), the per-model lookup addresses the id across
  slashes. Advertising a name a client cannot then fetch is a broken promise: the
  catalogue is what a client trusts when it says a model does not exist.
- Two dialects over that one pool: the OpenAI surface at `/v1`, and the Anthropic
  Messages surface at `/anthropic/v1`. Same key, same pooling, same failover,
  and the same answer for any given model.
- A client may request a model id of the operator's choosing. **Model spoofing**
  redirects such a name to a real model id and is then served by that model's
  whole pool — deliberately distinct from an alias, which targets individual
  pooled keys in a fixed order. Both names are recorded on every request.
- **Adding a model to keys that already exist.** An upstream publishes far more
  models than any single key is configured for, so binding is the other
  direction from adding an upstream: the base URL and the keys are already in the
  pool and the operator names the model that upstream will serve. It is the same
  `(base_url, api_key, model_id)` triple either way, reached by a different
  gesture. Every model id carries a copy button, because it routinely contains a
  slash and is exactly the string a client needs verbatim.
- Eight routing strategies, overridable per alias. A selected strategy stays in
  force until the operator changes it.
- Failover only ever happens before the first byte reaches the client. Once a
  stream starts, the upstream response is the only valid continuation.
- Circuit breaker per key with exponential cooldown, `Retry-After` honoured on
  429, and a single guarded half-open probe slot.
- A **streak** on the Stats page: consecutive days with recorded traffic, with a
  personal best, milestone tiers and a twelve-week activity map. The current run
  is aggregated from the request log like every other figure; the all-time best
  is a high-water mark in its own single-row table, because pruning would
  otherwise delete the days that produced it. Its ceiling is the log retention
  window — a run longer than `logRetentionDays` reads as "at least N" rather than
  claiming a precision the log cannot support.
- A **Costs** page: per-model spend priced in USD per million tokens against the
  model that actually served. Prices come from the OpenRouter catalogue, fetched
  at boot and daily, with manual overrides that a sync never overwrites; the
  cost is snapshotted onto each log row at request time, so a later price change
  cannot rewrite history. A request whose model has no known price is counted
  and excluded from the totals — never reported as free. Used models are priced
  automatically: after every catalogue sync, each used model the catalogue names
  unambiguously is priced and its already-logged requests backfilled from their
  recorded token counts; only ambiguous or unknown models wait for the
  operator's picker. Display currency is selectable, converted at render time
  from synced USD rates.
- An **Intelligent ranking** page: every model the pool serves, scored on three
  axes the server returns with its weights attached — intelligence (a curated
  prior per model family), reliability (measured success rate blended with the
  health of the keys behind the model) and efficiency (price and latency on log
  scales) — into a composite with S/A/B/C tiers, plus a best fit per role
  (plan, build, test, review, docs, agent) and the fallback for when that model
  is down. Spoof names are deliberately excluded: they are client aliases, not
  models. The page explains the method rather than asserting the scores.
- Bulk key import, health pings, a request log, and SQL-aggregated stats. The
  request log records which client each request came from (Claude Code, Codex,
  OpenCode, unknown) and offers a live **console** view — one terminal line per
  request naming model, provider, key and client — beside the table.
- Storage is SQLite through Node's built-in `node:sqlite` — no ORM, no native
  module to compile.
- Keys can be exported per provider as plaintext `.txt`, gated behind the admin
  API key requirement.

## Brand Commitments

- Name: **KeyPool**. MIT licensed.
- Voice: plain, technical, unhedged. Copy is documentation-grade — it states what
  the software does and nothing about what it might do.
- **Pinned by the user: a visual redesign must not change any wording or
  behaviour.** No copy is rewritten, no control moved or removed, and no displayed
  data changes. The work is confined to visual design and motion.

## Evidence on Hand

- A substantial README documenting setup, strategies, failure handling and security.
- A reset database: in November 2026 the operator backed up every key and wiped
  `data/` — database, master key and unified key included — so the pool ships
  empty and the first `run.bat` mints a fresh master key, a fresh unified key
  and an empty schema. Every count this document once cited from that database
  is void; read figures from the database as traffic accumulates.
- `scripts/smoke.mjs`, an end-to-end check that boots the built server and
  exercises the full flow against a real fake upstream. It is the only
  automated verification gate: the live-surface probes and the 700-test vitest
  suite were removed in November 2026 and have not been replaced.
- No customers, testimonials, pricing, benchmarks or press exist. Future work
  must not fabricate them.

## Product Principles

1. **The pool is the product; the dashboard is instrumentation for one operator.**
   Nothing in the interface should imply a team, a tenant, or a role. The streak
   is the one place this is easy to get wrong, and it stays inside the line: the
   operator is racing themselves and a number they set out to beat, never
   another person, and there is no rank, no comparison and no shared board.
2. **Numbers come from the log.** Prefer an aggregate the operator can trace back
   over a counter that could disagree with it. There are exactly two recorded
   exceptions, both deliberate: `PoolState` (round-robin cursors and latency,
   which are meaningless once persisted) and the streak's all-time best, kept as
   one monotonic row because pruning deletes the days that produced it.
3. **Say what it does.** Every claim in the interface is backed by behaviour that
   exists today. A streak bounded by retention says "at least N" rather than
   inventing a precision it does not have.
4. **Health is visible before it becomes a problem.** Broken keys, open breakers
   and cooldowns are on the surface, not buried in a detail view.
5. **Local-first is a posture, not a limitation.** The absence of a login is a
   decision; the interface does not apologise for it or imply a missing feature.
6. **A broken streak is recoverable, never a scolding.** Badges and the personal
   best are earned against the best run and are never revoked, and the element
   always shows a next milestone to reach. Streak mechanics fail when a missed
   day produces shame, and shame ends the habit rather than restarting it.
