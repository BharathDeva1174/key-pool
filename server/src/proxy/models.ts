import type { UpstreamStore } from '../upstream/store.js';
import { hostOf } from '../core/url.js';
import { stripContextSuffix } from '../core/modelName.js';

export interface PooledModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Non-standard but harmless extras the dashboard uses. */
  keypool_pool_size: number;
  keypool_healthy: number;
  keypool_kind: 'model' | 'alias' | 'spoof';
}

/**
 * `GET /v1/models`, synthesized entirely from the local pool.
 *
 * We never call upstream for this: a client listing models should get a fast,
 * always-available answer that reflects exactly what this proxy can route, not
 * a union of whatever each remote currently advertises.
 */
export function listPooledModels(store: UpstreamStore, now = Date.now()): { object: 'list'; data: PooledModel[] } {
  const rows = store.listEntriesWithContext();
  const byModel = new Map<string, { total: number; healthy: number; host: string; created: number }>();

  for (const row of rows) {
    if (!row.entry.enabled) continue;
    const bucket = byModel.get(row.entry.modelId) ?? {
      total: 0,
      healthy: 0,
      host: hostOf(row.baseUrl),
      created: row.entry.createdAt,
    };
    bucket.total += 1;
    if (isUsable(row, now)) bucket.healthy += 1;
    byModel.set(row.entry.modelId, bucket);
  }

  const data: PooledModel[] = [...byModel.entries()]
    .filter(([, v]) => v.healthy > 0)
    .map(([id, v]) => ({
      id,
      object: 'model' as const,
      created: Math.floor(v.created / 1000),
      owned_by: v.host,
      keypool_pool_size: v.total,
      keypool_healthy: v.healthy,
      keypool_kind: 'model' as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const alias of store.listAliases()) {
    const targets = alias.targets
      .map((id) => store.getModelEntry(id))
      .filter((e) => e !== null && e.enabled);
    if (targets.length === 0) continue;
    data.push({
      id: alias.name,
      object: 'model' as const,
      created: Math.floor(alias.createdAt / 1000),
      owned_by: 'keypool',
      keypool_pool_size: targets.length,
      keypool_healthy: targets.length,
      keypool_kind: 'alias',
    });
  }

  /*
   * Spoofed names, advertised so a client that enumerates models can actually
   * pick one. The counts are the *target's*, not the spoof's own: a spoof is
   * served by the target's pool, so reporting the pool it redirects to is the
   * only honest thing to put here.
   *
   * A spoof whose target has no usable entry is left out, matching how a real
   * model with nothing healthy is left out - advertising a name that can only
   * 503 is worse than not advertising it.
   */
  for (const spoof of store.listSpoofs()) {
    const target = byModel.get(spoof.targetModel);
    if (!target || target.healthy === 0) continue;
    data.push({
      id: spoof.name,
      object: 'model' as const,
      created: Math.floor(spoof.createdAt / 1000),
      owned_by: 'keypool',
      keypool_pool_size: target.total,
      keypool_healthy: target.healthy,
      keypool_kind: 'spoof',
    });
  }

  return { object: 'list', data };
}

/**
 * One entry from the same synthesised catalogue `listPooledModels` builds.
 *
 * Both dialects' lookup routes go through this rather than searching their own
 * way, so a per-model answer can never disagree with the list a client just
 * enumerated: a client that validates against `/v1/models` and then fetches
 * `/v1/models/{id}` must not be told the name exists and then that it does not.
 */
export function findPooledModel(store: UpstreamStore, id: string): PooledModel | undefined {
  const data = listPooledModels(store).data;
  // Exact first, then the bare name behind a context marker, so
  // `GET /v1/models/model[1m]` answers the same entry the message path would
  // serve. The returned object still carries the canonical `id`, because that is
  // the name the catalogue advertises and the one an agent should send back.
  const exact = data.find((m) => m.id === id);
  if (exact) return exact;
  const stripped = stripContextSuffix(id);
  return stripped === null ? undefined : data.find((m) => m.id === stripped);
}

function isUsable(
  row: ReturnType<UpstreamStore['listEntriesWithContext']>[number],
  now: number,
): boolean {
  if (row.disabled) return false;
  if (row.keyStatus === 'auth_error') return false;
  if (row.entry.status === 'not_found' || row.entry.status === 'unsupported') return false;
  /*
   * `auth_error` on the entry, matching what `eligibility` excludes when
   * routing.
   *
   * These two have to agree, and the catalogue is the one a client trusts: it
   * is what a client reads to decide a model exists at all. Leaving this status
   * out advertised a model whose every key the proxy had already been refusing,
   * with a healthy count to match - so `GET /v1/models` promised a working model
   * and the request that followed it could only fail. Observed live: `fledge-
   * alpha-free` listed at 13 healthy with all 18 of its entries locked out.
   *
   * The lockout is what makes the model unroutable, so it is what decides
   * whether the model is advertised.
   */
  if (row.entry.status === 'auth_error') return false;
  /*
   * `auth_error` on the entry, matching what `eligibility` excludes when
   * routing.
   *
   * These two have to agree, and the catalogue is the one a client trusts: it
   * is what a client reads to decide a model exists at all. Leaving this status
   * out advertised a model whose every key the proxy had already been refusing,
   * with a healthy count to match - so `GET /v1/models` promised a working model
   * and the request that followed it could only fail. Observed live: `fledge-
   * alpha-free` listed at 13 healthy with all 18 of its entries locked out.
   *
   * The lockout is what makes the model unroutable, so it is what decides
   * whether the model is advertised.
   */
  if (row.breakerState === 'open' && row.cooldownUntil === null) {
    // Breakers track their own window via opened_at, which the context query
    // does not carry; fall back to treating a non-zero streak as degraded but
    // still listable, so a recovering key does not vanish from the catalogue.
    return row.failStreak < 5;
  }
  if (row.cooldownUntil !== null && now < row.cooldownUntil) return false;
  return true;
}
