/**
 * Versioned, ordered, transactional schema migrations.
 *
 * Kept inline rather than in a loose .sql file so the compiled `dist/` output
 * stays self-contained and needs no asset copying at install time.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      -- One row per distinct base URL + auth style.
      CREATE TABLE endpoints (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        base_url      TEXT NOT NULL,
        api_style     TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'v1' | 'root'
        auth_type     TEXT NOT NULL DEFAULT 'bearer', -- 'bearer' | 'none' | 'header' | 'query'
        auth_header   TEXT,                           -- e.g. 'x-api-key' when auth_type='header'
        auth_prefix   TEXT,                           -- e.g. 'Bearer ' ; default derived from auth_type
        extra_headers TEXT NOT NULL DEFAULT '{}',     -- JSON object, for org/project headers
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX idx_endpoints_enabled ON endpoints(enabled);

      -- One row per API key. Ciphertext only.
      CREATE TABLE credentials (
        id              TEXT PRIMARY KEY,
        endpoint_id     TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        label           TEXT,
        key_cipher      TEXT NOT NULL,     -- AES-256-GCM sealed; never stored in plaintext
        key_hint        TEXT NOT NULL,     -- last 4 chars, for display
        key_fingerprint TEXT NOT NULL,     -- SHA-256 hex, for dedupe within an endpoint
        status          TEXT NOT NULL DEFAULT 'unknown', -- unknown|ok|auth_error|disabled
        last_error      TEXT,
        fail_streak     INTEGER NOT NULL DEFAULT 0,
        breaker_state   TEXT NOT NULL DEFAULT 'closed',  -- closed|open|half_open
        opened_at       INTEGER,
        cooldown_until  INTEGER,
        disabled        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE (endpoint_id, key_fingerprint)
      );

      CREATE INDEX idx_credentials_endpoint ON credentials(endpoint_id);

      -- The operator's unit of work: a concrete (base_url, api_key, model_id) triple.
      CREATE TABLE model_entries (
        id             TEXT PRIMARY KEY,
        credential_id  TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        model_id       TEXT NOT NULL,   -- what we send upstream
        enabled        INTEGER NOT NULL DEFAULT 1,
        status         TEXT NOT NULL DEFAULT 'unknown', -- unknown|ok|auth_error|not_found|unsupported|disabled
        weight         INTEGER NOT NULL DEFAULT 1,
        priority       INTEGER NOT NULL DEFAULT 100,    -- lower preferred, used by 'priority'
        last_ping_at   INTEGER,
        last_ping_ok   INTEGER,
        last_ping_ms   INTEGER,
        last_error     TEXT,
        last_used_at   INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE (credential_id, model_id)
      );

      CREATE INDEX idx_entries_model   ON model_entries(model_id);
      CREATE INDEX idx_entries_enabled ON model_entries(enabled);
      CREATE INDEX idx_entries_cred   ON model_entries(credential_id);

      -- A named fallback chain across different model_ids.
      CREATE TABLE aliases (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        strategy   TEXT NOT NULL DEFAULT 'round-robin',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE alias_targets (
        id             TEXT PRIMARY KEY,
        alias_id       TEXT NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
        model_entry_id TEXT NOT NULL REFERENCES model_entries(id) ON DELETE CASCADE,
        position       INTEGER NOT NULL,  -- failover order
        weight         INTEGER NOT NULL DEFAULT 1,
        UNIQUE (alias_id, model_entry_id)
      );

      CREATE INDEX idx_alias_targets_alias ON alias_targets(alias_id);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL   -- JSON
      );

      CREATE TABLE request_logs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                INTEGER NOT NULL,
        requested_model   TEXT NOT NULL,
        alias_id          TEXT,
        entry_id          TEXT,
        endpoint_name     TEXT,
        credential_label  TEXT,
        upstream_model    TEXT,
        success           INTEGER NOT NULL,
        status_code       INTEGER,
        error_kind        TEXT,
        error_message     TEXT,
        attempts          INTEGER NOT NULL DEFAULT 1,
        strategy          TEXT,
        streaming         INTEGER NOT NULL DEFAULT 0,
        latency_ms        INTEGER,
        ttfb_ms           INTEGER,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        total_tokens      INTEGER
      );

      CREATE INDEX idx_logs_ts         ON request_logs(ts);
      CREATE INDEX idx_logs_model_ts   ON request_logs(requested_model, ts);
      CREATE INDEX idx_logs_entry_ts   ON request_logs(entry_id, ts);
      CREATE INDEX idx_logs_success_ts ON request_logs(success, ts);
      CREATE INDEX idx_logs_error_ts   ON request_logs(error_kind, ts);
    `,
  },
  {
    version: 2,
    name: 'cooldown_bookkeeping',
    sql: /* sql */ `
      -- Current circuit-breaker window, doubled on every failed half-open probe.
      ALTER TABLE credentials ADD COLUMN cooldown_ms INTEGER NOT NULL DEFAULT 60000;
      -- Exponent for the 429 backoff, reset on any success.
      ALTER TABLE credentials ADD COLUMN cooldown_attempts INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: 'alias_strategy_inherits_default',
    sql: /* sql */ `
      -- An alias used to carry its own strategy behind a hard DEFAULT of
      -- 'round-robin'. Because that default is itself a valid strategy name,
      -- the selector's "is this a real strategy?" guard could never fail, so
      -- the operator's global default could never reach an alias: every alias
      -- silently forced round-robin no matter what was chosen in Settings.
      --
      -- NULL now means "inherit the global default", which is what the README
      -- already promised ("set a default in Settings, and override it per
      -- alias"). Existing aliases become inheriting rather than being pinned to
      -- the old default, so a strategy chosen in Settings applies everywhere
      -- until an alias is deliberately given its own.
      --
      -- SQLite cannot drop a NOT NULL constraint in place, so the table is
      -- rebuilt. Two things make that non-obvious:
      --
      -- 1. alias_targets has ON DELETE CASCADE into this table. Dropping the
      --    old table deletes every target row the instant it happens, so the
      --    chain is copied aside and put back afterwards. Deferring the
      --    constraint is not enough on its own - defer_foreign_keys defers the
      --    check, not the cascade action.
      -- 2. The rebuild is wrapped in deferred foreign key enforcement so the
      --    DROP and the RENAME are resolved together at COMMIT, when the
      --    constraint is re-checked against the finished table.
      PRAGMA defer_foreign_keys = ON;

      CREATE TABLE alias_targets_backup_v3 AS SELECT * FROM alias_targets;
      DELETE FROM alias_targets;

      CREATE TABLE aliases_new (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        strategy   TEXT,                     -- NULL = inherit the global default
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO aliases_new (id, name, strategy, created_at, updated_at)
        SELECT id, name, NULL, created_at, updated_at FROM aliases;

      DROP TABLE aliases;
      ALTER TABLE aliases_new RENAME TO aliases;

      INSERT INTO alias_targets SELECT * FROM alias_targets_backup_v3;
      DROP TABLE alias_targets_backup_v3;
    `,
  },
  {
    version: 4,
    name: 'model_entry_insertion_order',
    sql: /* sql */ `
      -- A stable, monotonic insertion order for model_entries.
      --
      -- Entry ids carry a millisecond timestamp, so entries created in the
      -- same millisecond tie-break on a random suffix - and a bulk import
      -- writes hundreds inside one millisecond. created_at is no better, being
      -- the same clock reading. Without a monotonic column there is no way to
      -- express "the first key the operator added", which is exactly what the
      -- failover strategy promises: always the first healthy key. SQLite keeps
      -- an implicit monotonic rowid per row, so it seeds the new column.
      ALTER TABLE model_entries ADD COLUMN seq INTEGER;
      UPDATE model_entries SET seq = rowid;
      CREATE INDEX idx_entries_seq ON model_entries(seq);
    `,
  },
  {
    version: 5,
    name: 'model_spoofs',
    sql: /* sql */ `
      -- A name a client may request that stands in for a real model id.
      --
      -- An alias already does something close, but its targets are individual
      -- model_entries - concrete (base_url, api_key, model_id) triples. An alias
      -- pointing at one entry of "minimax:free" would collapse that model onto
      -- a single key and throw away the pool, the breaker and the round-robin
      -- cursor that every other request to the model gets. A spoof points at
      -- the *model*, so resolution redirects and then takes the ordinary
      -- model-pool path: the spoof behaves exactly as if the client had typed
      -- the target id.
      --
      -- name is the lookup key and the constraint in one; the id alongside it
      -- matches the alias tables and keeps a rename possible.
      CREATE TABLE model_spoofs (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        target_model TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: 'stats_best_streak',
    sql: /* sql */ `
      -- The longest run of consecutive active days this install has ever seen.
      --
      -- The one place KeyPool keeps a number that is not an aggregate of the
      -- request log, and deliberately so. StatsRecorder.prune() hard-deletes rows
      -- past logRetentionDays on a rolling instant, so the all-time best is
      -- deleted along with the days that produced it - and a "best" that quietly
      -- drops when the log rolls over is worse than showing none at all, because
      -- it is precisely the figure a person would notice falling.
      --
      -- The current streak is still computed from the log; this only remembers
      -- the high-water mark. One row, one number, and the CHECK keeps it to one
      -- row so it cannot drift into a per-day table that would have to be
      -- maintained forever.
      --
      -- Monotonic by contract: raised when a run beats it, never lowered. That
      -- is what makes a broken streak recoverable rather than punishing - see
      -- earnedTiers in stats/streak.ts for why the badges work the same way.
      CREATE TABLE stats_best_streak (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        best_days  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- Seeded rather than left absent so the read path never has to distinguish
      -- "no row yet" from "a best of zero".
      INSERT INTO stats_best_streak (id, best_days, updated_at) VALUES (1, 0, 0);
    `,
  },
  {
    version: 7,
    name: 'cost_accounting',
    sql: /* sql */ `
      -- Per-model prices, in USD per million tokens.
      --
      -- Prices are stored per million because that is the unit every provider
      -- quotes in, and dividing per-token prices by 1e6 on every request would
      -- be a float operation in the hot path for no benefit.
      --
      -- NULL price means "unknown", which is NOT the same as zero: a self-hosted
      -- model genuinely costs nothing, and reporting it as unpriced would put a
      -- badge on a row whose cost is known exactly. price_source records whether
      -- a row came from the OpenRouter sync or from the operator, so a manual
      -- override survives the next automatic refresh.
      CREATE TABLE model_prices (
        model_id       TEXT PRIMARY KEY,  -- the resolved upstream model id
        input_per_1m   REAL,              -- NULL = unpriced
        output_per_1m  REAL,
        cached_per_1m  REAL,              -- discount rate for cached input
        price_source   TEXT NOT NULL DEFAULT 'auto',  -- 'auto' or 'manual'
        price_synced_at INTEGER,
        updated_at     INTEGER NOT NULL
      );

      -- The same distinction applied to each logged request: a NULL cost_usd is
      -- a request we could not price, and it is excluded from spend rather than
      -- counted as zero, so the totals never quietly understate a bill.
      --
      -- Recorded as a snapshot at write time. Repricing history on every read
      -- would mean yesterday's spend changes because a provider published a new
      -- price today, which is not a number anyone can reconcile against a
      -- statement.
      ALTER TABLE request_logs ADD COLUMN cost_usd REAL;
      ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER;
      ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER;
      -- Cache reads change what a request cost, and a provider that suddenly
      -- started reporting them would otherwise be invisible in a per-model view.
      ALTER TABLE request_logs ADD COLUMN price_source TEXT;

      CREATE INDEX idx_logs_cost_ts  ON request_logs(ts);
      CREATE INDEX idx_logs_model   ON request_logs(upstream_model);
      CREATE INDEX idx_logs_cred_ts ON request_logs(credential_label, ts);

      -- USD-based FX rates, so cost_usd stays canonical and conversion happens
      -- only at display time. One row per code, replaced wholesale on each
      -- successful fetch: rates are small and the previous set is the fallback
      -- when a fetch fails.
      CREATE TABLE fx_rates (
        code       TEXT PRIMARY KEY,
        rate       REAL NOT NULL,        -- units of this currency per 1 USD
        name       TEXT,
        fetched_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'credential_refusal_streak',
    sql: /* sql */ `
      -- How many times in a row this credential was handed an upstream refusal
      -- behind a 200 - an error envelope delivered as the whole body, or as a
      -- data: frame inside a stream, on a request the upstream had already
      -- accepted.
      --
      -- It exists because that failure was, until now, written to request_logs
      -- and nowhere else. The attempt was correctly abandoned and the next key
      -- tried, but no fail streak moved and no breaker opened, so the pool could
      -- not learn from it. With more healthy keys than the retry budget - 65 keys
      -- against three attempts is not unusual - every request drew fresh keys
      -- that had never been marked, and an upstream refusing every request
      -- produced the same 502 indefinitely.
      --
      -- Deliberately NOT a fail_streak. A single refusal is weak evidence: a bad
      -- tool schema, a context overflow or a malformed request is refused
      -- identically on every key, and counting that against the credential would
      -- retire healthy keys over the caller's mistake. Repetition is the signal
      -- that separates the two - one bad request refuses once, a gateway in a bad
      -- state refuses everything, every time. So this counter only reaches the
      -- breaker after a threshold, and any success clears it.
      --
      -- A credential-level counter rather than an endpoint-level one because the
      -- decision it feeds - try this key or the next - is per key, and the health
      -- state that consumes it (fail_streak, breaker_state) is already per key.
      ALTER TABLE credentials ADD COLUMN refusal_streak INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 9,
    name: 'endpoint_compat_profile',
    sql: /* sql */ `
      -- Per-endpoint upstream client-emulation profile (see core/compat.ts).
      --
      -- Some upstreams serve certain models only to their own agent client,
      -- decided from the shape of the request itself: opencode's Zen gateway
      -- serves its free-tier models only to requests that stream and carry at
      -- least two of its own tool names. A pooled request from any other
      -- client is refused with 403 "OpenCode's free tier can only be used
      -- from within OpenCode" - the credential is valid, the request shape is
      -- not.
      --
      -- A profile set on the endpoint makes the proxy build the upstream
      -- request the way that vendor's client would (forced streaming, alias
      -- tools), for proxied traffic and health pings alike. NULL keeps the
      -- relay verbatim, which is the default for every endpoint that has no
      -- such gate. Identity headers are deliberately NOT part of this column:
      -- they stay in extra_headers, where the operator already controls them.
      ALTER TABLE endpoints ADD COLUMN compat_profile TEXT;
    `,
  },
  {
    version: 10,
    name: 'drop_cost_accounting',
    sql: /* sql */ `
      -- Cost accounting was removed from the product. The tables and the two
      -- columns that only served it go with it; token counts stay, because the
      -- request log reports them on their own.
      DROP TABLE IF EXISTS model_prices;
      DROP TABLE IF EXISTS fx_rates;
      ALTER TABLE request_logs DROP COLUMN cost_usd;
      ALTER TABLE request_logs DROP COLUMN price_source;
    `,
  },
  {
    version: 11,
    name: 'restore_cost_accounting',
    sql: /* sql */ `
      -- Cost accounting is back, restored by operator request after migration 10
      -- removed it. Migrations are append-only, so this re-creates what that one
      -- dropped rather than resurrecting version 7; the shapes are identical so
      -- history from the first run of the feature would have rejoined seamlessly.
      --
      -- Prices in USD per million tokens, because that is the unit every provider
      -- quotes in. NULL means unknown, which is NOT the same as zero: a
      -- self-hosted model genuinely costs nothing, and reporting it as unpriced
      -- would put a badge on a row whose cost is known exactly. price_source
      -- records whether a row came from the OpenRouter sync or from the operator,
      -- so a manual override survives the next automatic refresh.
      CREATE TABLE model_prices (
        model_id       TEXT PRIMARY KEY,  -- the resolved upstream model id
        input_per_1m   REAL,              -- NULL = unpriced
        output_per_1m  REAL,
        cached_per_1m  REAL,              -- discount rate for cached input
        price_source   TEXT NOT NULL DEFAULT 'auto',  -- 'auto' or 'manual'
        price_synced_at INTEGER,
        updated_at     INTEGER NOT NULL
      );

      -- The same distinction applied to each logged request: a NULL cost_usd is
      -- a request we could not price, and it is excluded from spend rather than
      -- counted as zero, so the totals never quietly understate a bill.
      --
      -- Recorded as a snapshot at write time. Repricing history on every read
      -- would mean yesterday's spend changes because a provider published a new
      -- price today, which is not a number anyone can reconcile against a
      -- statement.
      ALTER TABLE request_logs ADD COLUMN cost_usd REAL;
      ALTER TABLE request_logs ADD COLUMN price_source TEXT;

      -- USD-based FX rates, so cost_usd stays canonical and conversion happens
      -- only at display time. One row per code, replaced wholesale on each
      -- successful fetch: rates are small and the previous set is the fallback
      -- when a fetch fails.
      CREATE TABLE fx_rates (
        code       TEXT PRIMARY KEY,
        rate       REAL NOT NULL,        -- units of this currency per 1 USD
        name       TEXT,
        fetched_at INTEGER NOT NULL
      );

      -- Migration 7 created these and migration 10 left them standing, so on
      -- every database that has run both they already exist and these are
      -- no-ops. Stated anyway so the index contract does not depend on the
      -- history of another migration staying exactly as it is.
      CREATE INDEX IF NOT EXISTS idx_logs_cost_ts  ON request_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_logs_model    ON request_logs(upstream_model);
      CREATE INDEX IF NOT EXISTS idx_logs_cred_ts  ON request_logs(credential_label, ts);
    `,
  },
  {
    version: 12,
    name: 'request_client_category',
    sql: /* sql */ `
      -- Which client sent each request, as the proxy classified it.
      --
      -- The classifier (core/clientIdentity.ts) has always run - it fed the
      -- debug-level diagnostics line and the upstream identity normalization -
      -- but its verdict died with the request. Recording it on the log row is
      -- what lets the Request log answer "who is sending this": claude-code,
      -- codex, opencode, or unknown. Best-effort by design; NULL is a row from
      -- before the column existed, and 'unknown' is an honest classification,
      -- not a failure.
      ALTER TABLE request_logs ADD COLUMN client_category TEXT;
    `,
  },
];
