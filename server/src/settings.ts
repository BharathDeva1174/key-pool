import type { Db } from './db/index.js';
import { generateUnifiedKey } from './core/ids.js';
import { readSecretFile, sha256Hex, writeSecretFile } from './core/crypto.js';
import { CLIENT_IDENTITY_MODES, type ClientIdentityMode } from './core/clientIdentity.js';
import { STRATEGY_NAMES, type StrategyName } from './routing/strategies.js';

export interface Settings {
  port: number;
  bindAddress: string;
  requireApiKey: boolean;
  requireApiKeyForAdmin: boolean;
  unifiedKeyHash: string;
  defaultStrategy: StrategyName;
  maxAttempts: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  /**
   * Consecutive upstream refusals (an error envelope behind a 200) after which a
   * credential is treated as failing. Kept separate from `breakerThreshold`
   * because a refusal is much weaker evidence than a dropped connection: one bad
   * request is refused on every key alike and must not retire any of them.
   */
  refusalThreshold: number;
  /**
   * How long an upstream stream may go without producing a byte before it is
   * treated as stalled. Bounds the body read only - the wait for headers is
   * already bounded by `requestTimeoutMs`.
   */
  streamStallTimeoutMs: number;
  logRetentionDays: number;
  logRequests: boolean;
  autoPingOnAdd: boolean;
  bulkPingConcurrency: number;
  /**
   * The ISO code costs are *displayed* in. `cost_usd` on the log stays canonical
   * USD regardless; this only chooses the conversion shown on the Costs page,
   * applied at render time against the synced FX table.
   */
  displayCurrency: string;
  /** Whether the OpenRouter price catalogue is fetched automatically. */
  autoSyncPrices: boolean;
  /**
   * Upstream client-identity normalization: `opencode` sends every pooled
   * request with OpenCode-compatible identity headers (see
   * core/clientIdentity.ts); `off` relays with no proxy-supplied identity,
   * which is the pre-normalization behaviour. Operator `extra_headers` on the
   * endpoint always apply on top of either choice.
   */
  clientIdentityMode: ClientIdentityMode;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'unifiedKeyHash'> & { unifiedKeyHash: string } = {
  port: 20121,
  bindAddress: '127.0.0.1',
  requireApiKey: true,
  requireApiKeyForAdmin: false,
  unifiedKeyHash: '',
  defaultStrategy: 'round-robin',
  /*
   * Ten, not three.
   *
   * This is a retry budget, and it has to be read against the size of the pool
   * it is retrying. A free-tier gateway rate-limits per key, so the keys that
   * answer 429 are the ones that just served - and three attempts against a
   * 65-key pool meant a request gave up after drawing three, all of which could
   * independently be over their burst limit, and handed the client the
   * upstream's own 429. Measured live: 5 of 20 streaming requests failed that
   * way, and at ten attempts the same 20 failed 0 times.
   *
   * It costs nothing when the pool is healthy, because the first key that works
   * ends the loop - a 200 on attempt one is the common case, not a tenth of the
   * latency. The budget is a ceiling for a bad draw, not a floor, and the
   * per-attempt header timeout is drawn from the request's own deadline, so a
   * long retry chain cannot overrun the request either.
   */
  maxAttempts: 10,
  requestTimeoutMs: 120_000,
  connectTimeoutMs: 15_000,
  breakerThreshold: 5,
  breakerCooldownMs: 60_000,
  cooldownBaseMs: 3_000,
  cooldownMaxMs: 300_000,
  // Three, not one: the first refusal is usually the caller's request, and only
  // a repeat on the same key is evidence about the key. Two is the point where
  // "this request is bad" stops explaining it.
  refusalThreshold: 3,
  // Generous, because it measures the gap between chunks rather than the whole
  // turn - a reasoning model can legitimately think for minutes before emitting
  // a token. It exists to catch an upstream that has stopped sending, not to
  // ration a slow but healthy one.
  streamStallTimeoutMs: 300_000,
  logRetentionDays: 30,
  logRequests: true,
  autoPingOnAdd: true,
  bulkPingConcurrency: 5,
  // USD is what every stored figure is denominated in; INR is the display the
  // operator's own currency takes. The dropdown on the Costs page changes this.
  displayCurrency: 'INR',
  autoSyncPrices: true,
  clientIdentityMode: 'opencode',
};

/** Settings that only take effect after a process restart. */
export const RESTART_REQUIRED_KEYS: ReadonlyArray<keyof Settings> = ['port', 'bindAddress'];

const NUMERIC_BOUNDS: Partial<Record<keyof Settings, { min: number; max: number }>> = {
  port: { min: 1, max: 65535 },
  maxAttempts: { min: 1, max: 10 },
  requestTimeoutMs: { min: 1_000, max: 3_600_000 },
  connectTimeoutMs: { min: 1_000, max: 300_000 },
  breakerThreshold: { min: 1, max: 100 },
  refusalThreshold: { min: 1, max: 100 },
  streamStallTimeoutMs: { min: 5_000, max: 3_600_000 },
  breakerCooldownMs: { min: 1_000, max: 3_600_000 },
  cooldownBaseMs: { min: 100, max: 60_000 },
  cooldownMaxMs: { min: 1_000, max: 86_400_000 },
  logRetentionDays: { min: 1, max: 3_650 },
  bulkPingConcurrency: { min: 1, max: 50 },
};

/**
 * Typed key/value settings persisted in SQLite.
 *
 * Values are cached in memory and written through immediately, so a change made
 * in the dashboard affects the very next proxied request without a restart.
 */
export class SettingsStore {
  private cache: Settings;

  /**
   * @param unifiedKeyFile where the plaintext unified key is kept. The database
   *   only ever holds its hash; this is what lets the key outlive the process.
   */
  constructor(
    private readonly db: Db,
    private readonly unifiedKeyFile: string,
  ) {
    this.cache = this.load();
  }

  private load(): Settings {
    const merged: Settings = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    for (const row of rows as Array<{ key: string; value: string }>) {
      const key = row.key as keyof Settings;
      if (!(key in DEFAULT_SETTINGS)) continue;
      try {
        (merged as unknown as Record<string, unknown>)[key] = JSON.parse(row.value);
      } catch {
        // A corrupt value falls back to the default rather than breaking boot.
      }
    }
    return merged;
  }

  get all(): Settings {
    return { ...this.cache };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.cache[key];
  }

  /** Merges a partial update, validating and clamping each value. */
  update(patch: Partial<Settings>): { settings: Settings; changed: (keyof Settings)[] } {
    const changed: (keyof Settings)[] = [];
    for (const [rawKey, rawValue] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
      if (!(rawKey in DEFAULT_SETTINGS)) continue;
      const coerced = coerce(rawKey, rawValue);
      if (coerced === undefined) continue;
      if (this.cache[rawKey] === coerced) continue;
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(rawKey, JSON.stringify(coerced));
      (this.cache as unknown as Record<string, unknown>)[rawKey] = coerced;
      changed.push(rawKey);
    }
    return { settings: this.all, changed };
  }

  /**
   * Ensures a unified client key exists and returns the plaintext.
   *
   * The database only ever stores the hash. The plaintext goes to a key file
   * beside it, which is what lets the console print the key on every start
   * rather than only on the one boot that generated it - a key announced
   * exactly once is a key most operators never see, because the banner they
   * needed scrolled past while the dashboard was opening.
   *
   * `created` still means "minted just now", so the first-run reveal in the
   * dashboard is unchanged; only the console banner is now unconditional.
   */
  ensureUnifiedKey(): { key: string; created: boolean } {
    if (this.cache.unifiedKeyHash) {
      // Empty when the key predates the key file, which is the one case the
      // banner has to stay quiet about rather than print an empty line.
      return { key: readSecretFile(this.unifiedKeyFile), created: false };
    }
    const key = generateUnifiedKey();
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('unifiedKeyHash', JSON.stringify(sha256Hex(key)));
    this.cache.unifiedKeyHash = sha256Hex(key);
    writeSecretFile(this.unifiedKeyFile, `${key}\n`);
    return { key, created: true };
  }

  rotateUnifiedKey(): string {
    const key = generateUnifiedKey();
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('unifiedKeyHash', JSON.stringify(sha256Hex(key)));
    this.cache.unifiedKeyHash = sha256Hex(key);
    writeSecretFile(this.unifiedKeyFile, `${key}\n`);
    return key;
  }

  /**
   * The plaintext unified key, or '' when none is recoverable.
   *
   * A pure read, deliberately not `ensureUnifiedKey()`: that mints a key when
   * the database holds no hash, and a read must never have that side effect.
   */
  revealUnifiedKey(): string {
    return readSecretFile(this.unifiedKeyFile);
  }
}

function coerce(key: keyof Settings, value: unknown): Settings[keyof Settings] | undefined {
  const fallback = DEFAULT_SETTINGS[key];
  if (key === 'defaultStrategy') {
    return typeof value === 'string' && STRATEGY_NAMES.includes(value as StrategyName)
      ? (value as StrategyName)
      : undefined;
  }
  if (key === 'clientIdentityMode') {
    return typeof value === 'string' && (CLIENT_IDENTITY_MODES as readonly string[]).includes(value)
      ? (value as ClientIdentityMode as never)
      : undefined;
  }
  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return value as never;
    if (value === 'true') return true as never;
    if (value === 'false') return false as never;
    return undefined;
  }
  if (typeof fallback === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    const bounds = NUMERIC_BOUNDS[key];
    if (bounds) return Math.min(bounds.max, Math.max(bounds.min, Math.round(n))) as never;
    return Math.round(n) as never;
  }
  if (typeof fallback === 'string') {
    return typeof value === 'string' ? (value as never) : undefined;
  }
  return undefined;
}

/**
 * Applies stored port/bindAddress on top of the process config, so a change
 * made in Settings takes effect on the next start.
 *
 * Precedence is CLI/env > Settings > built-in default. An explicit `--port` or
 * `PORT` is the operator overriding this launch, so it must not be shadowed by
 * a stored (or merely pre-seeded) setting.
 */
export function resolveBootSettings(
  settings: Settings,
  config: { host: string; port: number; hostExplicit?: boolean; portExplicit?: boolean },
): { host: string; port: number } {
  return {
    host: config.hostExplicit || !settings.bindAddress ? config.host : settings.bindAddress,
    port: config.portExplicit || !settings.port ? config.port : settings.port,
  };
}
