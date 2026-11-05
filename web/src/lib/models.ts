/**
 * Pool entries grouped by model id.
 *
 * The pool stores one row per (base URL, key, model) triple, which is what
 * routing needs but reads as a wall of duplicates in the dashboard: a model
 * served by 100 keys produced 100 identical model rows. This collapses the
 * entries into one group per distinct model id and keeps the underlying rows
 * for the per-key detail behind the expand control.
 */
import type { EntryRow } from './api';
import { entryHealthLevel, type HealthLevel } from './format';

export interface ModelGroup {
  modelId: string;
  /** The (base URL, key, model) triples backing this model id. */
  entries: EntryRow[];
  entryCount: number;
  /** Distinct API keys serving this model. */
  keyCount: number;
  /** Distinct upstreams (base URLs) serving this model. */
  upstreamCount: number;
  healthyCount: number;
  /** Worst health across the group, so one bad key is never hidden. */
  level: HealthLevel;
  enabledCount: number;
  totalWeight: number;
  /** Highest (lowest number) priority in the group; lower wins. */
  bestPriority: number;
  lastUsedAt: number | null;
  averagePingMs: number | null;
}

const LEVEL_RANK: Record<HealthLevel, number> = { bad: 3, warn: 2, idle: 1, ok: 0 };

function worst(levels: HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'ok');
}

/**
 * One group per distinct model id, in first-seen order so the list does not
 * reshuffle between refreshes.
 */
export function groupEntriesByModel(entries: EntryRow[]): ModelGroup[] {
  const byModel = new Map<string, EntryRow[]>();
  for (const row of entries) {
    const existing = byModel.get(row.entry.modelId);
    if (existing) existing.push(row);
    else byModel.set(row.entry.modelId, [row]);
  }

  return [...byModel.entries()].map(([modelId, rows]) => {
    const levels = rows.map(entryHealthLevel);
    // Credential id, not keyHint: two keys can share their last four characters.
    const keys = new Set(rows.map((r) => r.entry.credentialId));
    const upstreams = new Set(rows.map((r) => r.endpointName));
    const pings = rows.map((r) => r.entry.lastPingMs).filter((ms): ms is number => ms !== null && ms !== undefined);

    return {
      modelId,
      entries: rows,
      entryCount: rows.length,
      keyCount: keys.size,
      upstreamCount: upstreams.size,
      healthyCount: rows.filter((r) => entryHealthLevel(r) === 'ok').length,
      level: worst(levels),
      enabledCount: rows.filter((r) => r.entry.enabled).length,
      totalWeight: rows.reduce((sum, r) => sum + (r.entry.weight || 1), 0),
      bestPriority: rows.reduce((min, r) => Math.min(min, r.entry.priority), Number.MAX_SAFE_INTEGER),
      lastUsedAt: rows.reduce<number | null>((latest, r) => (r.entry.lastUsedAt && (!latest || r.entry.lastUsedAt > latest) ? r.entry.lastUsedAt : latest), null),
      averagePingMs: pings.length === 0 ? null : Math.round(pings.reduce((a, b) => a + b, 0) / pings.length),
    };
  });
}
