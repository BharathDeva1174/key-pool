/**
 * The intelligent-ranking read.
 *
 * The model list is the Models page's list: one entry per distinct model id in
 * the pool, formed from the same (base URL, key, model) triples that page
 * groups. Spoof names deliberately do not appear - a spoof is a client-facing
 * alias, not a model, and ranking it would invent a model nobody serves.
 *
 * Intelligence is a curated prior (see intelligence/knowledge.ts); reliability
 * and efficiency are measured locally from the request log and the price
 * catalogue. The response carries the weights it used, so the page can explain
 * the ranking instead of asserting it.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { rangeStart } from './admin.js';
import { describeModel } from '../intelligence/knowledge.js';
import {
  COMPOSITE_WEIGHTS,
  pickRoles,
  rankModels,
  scoreModel,
  tierCounts,
  type ModelInput,
} from '../intelligence/ranking.js';

export async function registerIntelligenceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { store, queries } = ctx;

  app.get('/api/admin/intelligence', async (request) => {
    const range = (request.query as { range?: string }).range ?? '24h';
    const sinceMs = rangeStart(range);
    const now = Date.now();

    // One group per model id, the same way the Models page collapses its rows,
    // with the same health test its status dots use.
    const groups = new Map<string, { total: number; healthy: number }>();
    for (const row of store.listEntriesWithContext()) {
      const healthy =
        !row.disabled &&
        row.entry.status === 'ok' &&
        row.keyStatus === 'ok' &&
        row.breakerState !== 'open' &&
        !(row.cooldownUntil !== null && now < row.cooldownUntil);
      const agg = groups.get(row.entry.modelId) ?? { total: 0, healthy: 0 };
      agg.total += 1;
      if (healthy) agg.healthy += 1;
      groups.set(row.entry.modelId, agg);
    }

    const stats = new Map(queries.byModel(sinceMs).map((r) => [r.label, r]));

    const models = rankModels(
      [...groups.entries()].map(([modelId, agg]) => {
        const s = stats.get(modelId);
        // `:free` ids are priced at zero by their upstream, not merely
        // unpublished - distinguishing the two matters to efficiency.
        const free = /:free$/i.test(modelId);
        const price = free ? null : ctx.costStore?.resolvePrice(modelId) ?? null;
        const input: ModelInput = {
          modelId,
          requests: s?.requests ?? 0,
          failures: s?.failures ?? 0,
          avgLatencyMs: s?.avgLatencyMs ?? null,
          totalKeys: agg.total,
          healthyKeys: agg.healthy,
          inputPer1m: free ? 0 : price?.inputPer1m ?? null,
          outputPer1m: free ? 0 : price?.outputPer1m ?? null,
          free,
        };
        return scoreModel(input, describeModel(modelId));
      }),
    );

    return {
      range,
      generatedAt: now,
      weights: COMPOSITE_WEIGHTS,
      models,
      roles: pickRoles(models),
      tiers: tierCounts(models),
    };
  });
}
