import type { UpstreamStore, RoutableEntry, Credential } from '../upstream/store.js';
import type { PoolState } from './poolState.js';
import { orderCandidates, type Candidate, type StrategyName } from './strategies.js';
import { eligibility, healthFromRow, type CredentialHealth, type Eligibility } from './health.js';
import { stripContextSuffix } from '../core/modelName.js';

export interface Resolution {
  requestedModel: string;
  aliasId: string | null;
  strategy: StrategyName;
  poolKey: string;
  /** Eligible entries, best first. Index 0 is tried first. */
  ordered: RoutableEntry[];
  totalMatches: number;
  healthyCount: number;
  excluded: Partial<Record<Eligibility, number>>;
}

export interface ResolveOptions {
  now?: number;
  rand?: () => number;
}

/** Rebuilds the health state machine's view of a credential from its row. */
export function healthOf(credential: Credential, cfg: { breakerCooldownMs: number }): CredentialHealth {
  return healthFromRow(
    {
      status: credential.status,
      disabled: credential.disabled,
      fail_streak: credential.failStreak,
      breaker_state: credential.breakerState,
      opened_at: credential.openedAt,
      cooldown_ms: credential.cooldownMs,
      cooldown_until: credential.cooldownUntil,
      cooldown_attempts: credential.cooldownAttempts,
    },
    { breakerThreshold: 1, breakerCooldownMs: cfg.breakerCooldownMs, cooldownBaseMs: 1, cooldownMaxMs: 1 },
  );
}

function toCandidate(entry: RoutableEntry, poolState: PoolState): Candidate {
  return {
    entryId: entry.entryId,
    credentialId: entry.credentialId,
    endpointId: entry.endpointId,
    modelId: entry.entry.modelId,
    weight: entry.entry.weight,
    priority: entry.entry.priority,
    inFlight: poolState.inFlightFor(entry.entryId),
    totalUses: poolState.totalUsesFor(entry.entryId),
    latencyEwma: poolState.latencyFor(entry.entryId),
  };
}

/**
 * Turns the model name in a client request into an ordered failover plan.
 *
 * The model is one of three things: an alias (a named chain across possibly
 * different models), a spoof (a name standing in for a real model id), or a
 * plain model id (a pool of keys serving the same model). In all three cases
 * unhealthy entries are filtered out before the strategy orders what is left,
 * so a strategy never wastes a slot on a key that is known to be down.
 *
 * A spoof redirects to the target's *pool* rather than to a set of entries, so
 * `ai-123:free` -> `minimax:free` is served by every key serving that model,
 * under the target's own round-robin cursor - exactly as if the client had
 * typed `minimax:free`. That is the whole difference from an alias, and the
 * reason the two are separate concepts.
 */
export function resolveRequestedModel(
  store: UpstreamStore,
  poolState: PoolState,
  opts: { defaultStrategy: StrategyName; breakerCooldownMs: number },
  requestedModel: string,
  options: ResolveOptions = {},
): Resolution {
  const now = options.now ?? Date.now();
  const rand = options.rand ?? Math.random;

  /*
   * What one spelling of the name resolves to. Factored out because the name is
   * attempted more than once below, and a second copy of this would be a second
   * place for the alias-before-spoof ordering to drift.
   */
  const attempt = (name: string) => {
    const alias = store.getAliasByName(name);
    // An alias is checked first and wins outright. A spoof only ever applies to a
    // name that is not already an alias, which is also why the two can never
    // fight over a name: the admin API refuses to create a collision.
    const spoof = alias ? null : store.getSpoofByName(name);
    const target = spoof?.targetModel ?? name;
    return {
      alias,
      target,
      matches: alias ? store.listRoutableForAlias(alias.id) : store.listRoutableForModel(target),
    };
  };

  let found = attempt(requestedModel);

  /*
   * `model[1m]` asks for a context variant of `model`, so when the exact name
   * matched nothing, retry without the marker. An agent that appends it to
   * every request would otherwise get "no upstream is configured" for a model
   * sitting in the pool under the bare name - and the catalogue would be
   * simultaneously advertising the model and denying it.
   *
   * Only ever a *fallback*, so a model genuinely registered under a bracketed
   * name keeps winning. An alias is excluded from falling through: it was
   * matched by name, and a stripped variant of it is not what was asked for.
   *
   * `requestedModel` stays the name the client sent, so the log records
   * `model[1m]` as asked and `model` as served.
   */
  const stripped = stripContextSuffix(requestedModel);
  if (found.matches.length === 0 && !found.alias && stripped !== null) {
    found = attempt(stripped);
  }

  const { alias, target, matches } = found;

  // An alias with no strategy of its own inherits the global default, so a
  // strategy chosen in Settings reaches every alias that was not deliberately
  // overridden. `alias.strategy` arrives already normalised by the store, so
  // null is the only thing that falls through here. A spoof has no strategy of
  // its own at all, so it always follows the default.
  const strategy: StrategyName = alias?.strategy ?? opts.defaultStrategy;
  // The pool is keyed on the *target*, so spoofed and direct traffic to the same
  // model share one round-robin cursor and one last-good entry rather than
  // each keeping counters over the same physical keys.
  const poolKey = alias ? `alias:${alias.name}` : `model:${target}`;

  const excluded: Partial<Record<Eligibility, number>> = {};
  const eligible: RoutableEntry[] = [];

  for (const entry of matches) {
    const state = healthOf(entry.credential, { breakerCooldownMs: opts.breakerCooldownMs });
    const verdict = eligibility(state, now, entry.entry.status);
    if (verdict === 'healthy' || verdict === 'probe') {
      eligible.push(entry);
    } else {
      excluded[verdict] = (excluded[verdict] ?? 0) + 1;
    }
  }

  const byId = new Map(eligible.map((e) => [e.entryId, e]));
  const candidates = eligible.map((e) => toCandidate(e, poolState));
  const sequenced = sequenceByDeclaredOrder(
    orderCandidates(candidates, strategy, poolState.pool(poolKey), { poolKey, now, rand }),
    candidates,
    alias !== null,
  );

  return {
    requestedModel,
    aliasId: alias?.id ?? null,
    strategy,
    poolKey,
    ordered: sequenced.map((c) => byId.get(c.entryId)!).filter(Boolean),
    totalMatches: matches.length,
    healthyCount: eligible.length,
    excluded,
  };
}

/**
 * Puts the strategy's result back into an alias's declared target order.
 *
 * An alias is a hand-built chain, so the order the targets were listed in is the
 * failover sequence and the strategy only decides which one is tried first. The
 * strategies that sort - `priority` and `failover` by priority number,
 * `least-used` and `least-latency` by their counters - would otherwise re-rank
 * the chain and drop the order the operator set. Plain model pools have no
 * declared order to preserve, so they pass straight through.
 */
function sequenceByDeclaredOrder(
  ordered: Candidate[],
  declared: Candidate[],
  isAlias: boolean,
): Candidate[] {
  if (!isAlias || ordered.length < 2) return ordered;
  const rank = new Map(declared.map((c, i) => [c.entryId, i]));
  return [...ordered].sort((a, b) => (rank.get(a.entryId) ?? 0) - (rank.get(b.entryId) ?? 0));
}

/** Human summary used in the 503 body and the dashboard. */
export function describeExcluded(excluded: Partial<Record<Eligibility, number>>): string {
  const parts = Object.entries(excluded)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([reason, count]) => `${count} ${reason.replace(/_/g, ' ')}`);
  return parts.length ? parts.join(', ') : 'none';
}
