import type { Db } from '../db/index.js';
import type { UpstreamErrorKind } from '../core/errors.js';

export type CredentialStatus = 'unknown' | 'ok' | 'auth_error';
export type BreakerState = 'closed' | 'open' | 'half_open';

export type Eligibility =
  | 'healthy'
  | 'probe' // breaker open but the cooldown elapsed: may try one probe request
  | 'circuit_open'
  | 'cooling' // 429 backoff still running
  | 'auth_error'
  | 'disabled'
  | 'model_unavailable'; // this (base_url, key, model) triple was rejected upstream

export interface CredentialHealth {
  status: CredentialStatus;
  disabled: boolean;
  failStreak: number;
  breakerState: BreakerState;
  openedAt: number | null;
  cooldownMs: number;
  cooldownUntil: number | null;
  cooldownAttempts: number;
}

export interface HealthConfig {
  breakerThreshold: number;
  breakerCooldownMs: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
}

export type Outcome =
  | { kind: 'ok' }
  | { kind: 'auth_error' }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'retryable' }
  | { kind: 'client_error' }
  | { kind: 'model_unavailable' };

/** Outcomes that must not count against a key. */
const NON_HEALTH_AFFECTING = new Set<Outcome['kind']>(['ok', 'client_error', 'model_unavailable']);

export function freshHealth(cfg: HealthConfig): CredentialHealth {
  return {
    status: 'unknown',
    disabled: false,
    failStreak: 0,
    breakerState: 'closed',
    openedAt: null,
    cooldownMs: cfg.breakerCooldownMs,
    cooldownUntil: null,
    cooldownAttempts: 0,
  };
}

export function healthFromRow(row: Record<string, unknown>, cfg: HealthConfig): CredentialHealth {
  return {
    status: (row.status as CredentialStatus) ?? 'unknown',
    disabled: Number(row.disabled ?? 0) === 1,
    failStreak: Number(row.fail_streak ?? 0),
    breakerState: (row.breaker_state as BreakerState) ?? 'closed',
    openedAt: row.opened_at === null || row.opened_at === undefined ? null : Number(row.opened_at),
    cooldownMs: Number(row.cooldown_ms ?? cfg.breakerCooldownMs),
    cooldownUntil: row.cooldown_until === null || row.cooldown_until === undefined ? null : Number(row.cooldown_until),
    cooldownAttempts: Number(row.cooldown_attempts ?? 0),
  };
}

/** Classifies a credential without mutating anything. */
export function eligibility(h: CredentialHealth, now: number, entryStatus: string): Eligibility {
  /*
   * `auth_error` belongs here alongside `not_found`, and its absence was the
   * defect this line covers.
   *
   * Every failure path marks the *entry* when an upstream answers 401 or 403,
   * so `model_entries.status = 'auth_error'` is a state the database really
   * reaches. Only the two entry statuses below were treated as grounds for
   * exclusion, which left this one marked, reported as broken on the Models
   * page, and then routed to anyway - the one thing the mark was supposed to
   * prevent. Observed live: eight Open Code keys marked `auth_error`, each
   * still drawn for `fledge-alpha-free` on every request.
   *
   * Entry-scoped is the correct granularity for the exclusion. A provider's 403
   * says "this key may not use this model" at least as often as it says "this
   * key is dead", and the same key routinely serves another model fine - which
   * is why the credential is not marked from a single request, and why excluding
   * the entry is what keeps one model's restriction from costing the pool a key.
   * A key that really is revoked is retired at the credential level by the ping
   * probe, which is the one check allowed to speak for the key rather than for
   * one request against one model.
   */
  if (entryStatus === 'not_found' || entryStatus === 'unsupported') return 'model_unavailable';
  if (entryStatus === 'auth_error') return 'model_unavailable';
  if (h.disabled) return 'disabled';
  if (h.status === 'auth_error') return 'auth_error';
  if (h.breakerState === 'open') {
    const openedAt = h.openedAt ?? 0;
    return now - openedAt >= h.cooldownMs ? 'probe' : 'circuit_open';
  }
  if (h.cooldownUntil !== null && now < h.cooldownUntil) return 'cooling';
  return 'healthy';
}

/** Exponential backoff for 429s, with +/-20% jitter. */
export function backoffMs(attempts: number, cfg: HealthConfig, retryAfterMs: number | null, rand: () => number = Math.random): number {
  if (retryAfterMs !== null) return Math.max(0, retryAfterMs);
  const exponential = cfg.cooldownBaseMs * Math.pow(2, Math.max(0, attempts));
  const capped = Math.min(cfg.cooldownMaxMs, exponential);
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(capped * jitter);
}

/**
 * The health state machine. Returns the next state; persistence is the
 * caller's job.
 */
export function applyOutcome(h: CredentialHealth, outcome: Outcome, cfg: HealthConfig, now: number, rand: () => number = Math.random): CredentialHealth {
  if (NON_HEALTH_AFFECTING.has(outcome.kind)) {
    return { ...h, status: 'ok', failStreak: 0, breakerState: 'closed', openedAt: null, cooldownUntil: null, cooldownAttempts: 0, cooldownMs: cfg.breakerCooldownMs };
  }

  switch (outcome.kind) {
    case 'auth_error':
      // A configuration problem: never auto-recovered by traffic, only by a re-ping.
      return { ...h, status: 'auth_error' };

    case 'rate_limited': {
      const wait = backoffMs(h.cooldownAttempts, cfg, outcome.retryAfterMs, rand);
      return { ...h, cooldownUntil: now + wait, cooldownAttempts: h.cooldownAttempts + 1 };
    }

    case 'retryable': {
      // A failed half-open probe re-opens the breaker with a doubled window.
      if (h.breakerState === 'half_open') {
        return {
          ...h,
          breakerState: 'open',
          openedAt: now,
          cooldownMs: Math.min(cfg.cooldownMaxMs, Math.max(h.cooldownMs, cfg.breakerCooldownMs) * 2),
        };
      }
      const streak = h.failStreak + 1;
      if (streak >= cfg.breakerThreshold) {
        return { ...h, failStreak: streak, breakerState: 'open', openedAt: now };
      }
      return { ...h, failStreak: streak };
    }

    default:
      return h;
  }
}

/**
 * Atomically claims the single half-open probe slot for a credential.
 *
 * The guarded UPDATE means only one in-flight request can move the breaker out
 * of `open`; everyone else keeps failing fast instead of stampeding an upstream
 * that is probably still down.
 */
export function claimProbe(db: Db, credentialId: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE credentials
          SET breaker_state = 'half_open', updated_at = ?
        WHERE id = ?
          AND breaker_state = 'open'
          AND opened_at IS NOT NULL
          AND ? - opened_at >= cooldown_ms`,
    )
    .run(now, credentialId, now);
  return Number(result.changes) === 1;
}

export function outcomeForErrorKind(kind: UpstreamErrorKind, retryAfterMs: number | null): Outcome {
  switch (kind) {
    case 'auth_error':
      return { kind: 'auth_error' };
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterMs };
    case 'client_error':
      return { kind: 'client_error' };
    case 'not_found':
      return { kind: 'model_unavailable' };
    case 'upstream_error':
    case 'timeout':
    case 'dns_error':
    case 'tls_error':
    case 'network_error':
      return { kind: 'retryable' };
    default:
      return { kind: 'ok' };
  }
}
