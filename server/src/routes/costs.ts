import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { FALLBACK_CURRENCIES_SHARED } from './costs-catalog.js';

/**
 * The Costs API.
 *
 * Registered on the same guarded scope as the rest of the admin API, at the
 * paths the dashboard uses. It lives in its own file rather than inside
 * `admin.ts` because it has a different failure posture: the network-dependent
 * routes here are allowed to be slow and are allowed to fail without taking
 * anything else down, and mixing that into the settings and routing handlers
 * would obscure which is which.
 *
 * Every aggregate is SQL against `request_logs`. The frontend does no summing.
 */
const DAY = 86_400_000;

/**
 * Ranges, plus a custom window.
 *
 * `custom` takes explicit epoch bounds so the page can offer "the 4th to the
 * 9th" without inventing a fixed preset for it.
 */
const RANGES: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  all: 0,
};

function resolveWindow(query: { range?: string; from?: string; to?: string }, now: number): { since: number; until?: number } {
  if (query.range === 'custom') {
    const from = Number(query.from);
    const to = Number(query.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { since: from, until: to };
    }
    // A malformed custom window falls back to the default rather than erroring:
    // an empty graph is a worse answer than the last 24 hours.
    return { since: now - DAY, until: undefined };
  }
  const span = RANGES[String(query.range ?? '24h')] ?? RANGES['24h'] as number;
  return { since: span === 0 ? 0 : now - span, until: undefined };
}

/** Bucket width, coarsening with the window exactly as the stats chart does. */
function bucketFor(sinceMs: number, now: number): number {
  const span = now - sinceMs;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  if (span <= 6 * HOUR) return 5 * MIN;
  if (span <= 3 * DAY) return HOUR;
  if (span <= 90 * DAY) return 6 * HOUR;
  if (span <= 2 * 365 * DAY) return DAY;
  return 7 * DAY;
}

function body(request: FastifyRequest): Record<string, unknown> {
  const raw: unknown = request.body;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

const ManualPrice = z.object({
  modelId: z.string().min(1),
  inputPer1m: z.number().min(0).nullable(),
  outputPer1m: z.number().min(0).nullable(),
  cachedPer1m: z.number().min(0).nullable(),
  /**
   * Also price the logged requests this model's rows cover but could not price
   * at the time - only ever the `cost_usd IS NULL` ones, never a re-pricing of
   * history that already carries a snapshot.
   */
  backfill: z.boolean().optional(),
});

export async function registerCostRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { queries, recorder, settings } = ctx;
  const costStore = ctx.costStore;
  if (!costStore) return;
  // Resolved lazily through a getter so the service is a singleton even though
  // it is attached after the context is built.
  const sync = ctx.priceSync;

  app.get('/api/costs/summary', async (request) => {
    const now = Date.now();
    const q = request.query as { range?: string; from?: string; to?: string };
    const { since, until } = resolveWindow(q, now);
    const status = sync?.getStatus() ?? { lastPriceSyncAt: 0, lastPriceSyncError: null, lastFxSyncAt: 0, lastFxSyncError: null };
    return {
      window: summarizeWindow(since, until, now),
      summary: queries.costSummary(since, until),
      currency: settings.get('displayCurrency'),
      // Today and this month are separate aggregates rather than derived
      // client-side, so the two cards can never disagree with each other.
      today: queries.costSummary(startOfLocalDay(now), undefined),
      thisMonth: queries.costSummary(startOfLocalMonth(now), undefined),
      sync: {
        prices: { at: status.lastPriceSyncAt, error: status.lastPriceSyncError, auto: settings.get('autoSyncPrices') },
        fx: { at: status.lastFxSyncAt, error: status.lastFxSyncError },
      },
    };
  });

  app.get('/api/costs/timeseries', async (request) => {
    const now = Date.now();
    const q = request.query as { range?: string; from?: string; to?: string };
    const { since, until } = resolveWindow(q, now);
    const bucketMs = bucketFor(since, now);
    return { since, until: until ?? null, bucketMs, points: queries.costTimeseries(since, bucketMs, until) };
  });

  app.get('/api/costs/breakdown', async (request) => {
    const now = Date.now();
    const q = request.query as { range?: string; from?: string; to?: string };
    const { since, until } = resolveWindow(q, now);
    return {
      // Grouped by the model that actually served, the same expression the
      // Stats breakdown uses, so a spoof is never billed under its alias.
      byModel: queries.costBreakdown("COALESCE(NULLIF(upstream_model, ''), requested_model)", since, until),
      byProvider: queries.costBreakdown("COALESCE(endpoint_name, 'unrouted')", since, until),
      byKey: queries.costBreakdown("COALESCE(credential_label, 'unknown')", since, until),
      window: { since, until: until ?? null, at: now },
    };
  });

  app.get('/api/costs/requests', async (request) => {
    const q = request.query as { limit?: string; before?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 25) || 25));
    const before = Number(q.before);
    return {
      rows: queries.recentCostRows(limit, Number.isFinite(before) && before > 0 ? before : undefined),
    };
  });

  app.get('/api/costs/fx', async () => {
    const { rates, fetchedAt } = costStore.getFxRates();
    const status = sync?.getStatus();
    return {
      base: 'USD',
      fetchedAt: fetchedAt || status?.lastFxSyncAt || 0,
      error: status?.lastFxSyncError ?? null,
      // The fallback list is merged in so the dropdown is populated on a fresh
      // install before the first fetch has landed, and stays populated if it
      // never does.
      currencies: mergeCurrencies(rates),
      // USD is the base and converts at 1 by definition, so it is present even
      // before the first fetch lands - otherwise every figure would render as
      // a dash on a fresh install instead of in dollars.
      rates: { USD: 1, ...Object.fromEntries(rates.map((r) => [r.code, r.rate])) },
    };
  });

  app.post('/api/costs/fx/sync', async () => {
    if (!sync) return { ok: false, error: 'Sync service unavailable.' };
    return sync.syncFx();
  });

  app.get('/api/costs/prices', async () => ({ prices: costStore.listPrices() }));

  /**
   * The catalogue rows that could price one model id.
   *
   * `exact` is the row the recorder would use right now; `candidates` is every
   * tail match when it would not. A used model whose bare name two vendors
   * share stays unpriced by automatic sync on purpose - this is where the
   * operator picks the right row themselves.
   */
  app.get('/api/costs/prices/match', async (request, reply) => {
    const { model } = request.query as { model?: string };
    const id = (model ?? '').trim();
    if (!id) return reply.code(400).send({ error: 'A model query parameter is required.' });
    return { model: id, ...costStore.matchCandidates(id) };
  });

  app.post('/api/costs/prices/sync', async () => {
    if (!sync) return { ok: false, error: 'Sync service unavailable.' };
    return sync.syncPrices();
  });

  /**
   * Prices every used model the catalogue can name, on demand.
   *
   * The sync path already does this when a catalogue lands; this is the same
   * evaluation for the moments in between - traffic that flew while the
   * catalogue was stale, resolved against prices it now has. Ambiguous and
   * unknown models are deliberately not touched: they wait for the picker.
   */
  app.post('/api/costs/evaluate', async () => ({ evaluated: costStore.evaluateUsedModels() }));

  app.post('/api/costs/prices', async (request, reply) => {
    const parsed = ManualPrice.safeParse(body(request));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A modelId and non-negative prices are required.', issues: parsed.error.issues });
    }
    const { modelId, inputPer1m, outputPer1m, cachedPer1m, backfill } = parsed.data;
    // A row with no input or output price cannot produce a cost, so it is
    // stored as unpriced rather than as a half-price that would bill wrongly.
    const price = costStore.setManualPrice(modelId, inputPer1m, outputPer1m, cachedPer1m === null ? null : cachedPer1m);
    let backfilled = 0;
    if (backfill && price) {
      backfilled = costStore.backfillUnpriced(modelId, price);
    }
    return { price, backfilled };
  });

  app.post('/api/costs/prices/:id/reset', async (request) => {
    const { id } = request.params as { id: string };
    return { price: costStore.resetToAuto(decodeURIComponent(id)) };
  });

  app.post('/api/costs/currency', async (request, reply) => {
    const parsed = z.object({ code: z.string().min(3).max(3) }).safeParse(body(request));
    if (!parsed.success) return reply.code(400).send({ error: 'A three-letter currency code is required.' });
    const result = settings.update({ displayCurrency: parsed.data.code });
    return { currency: result.settings.displayCurrency };
  });

  app.post('/api/costs/autosync', async (request, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(body(request));
    if (!parsed.success) return reply.code(400).send({ error: 'enabled must be a boolean.' });
    const result = settings.update({ autoSyncPrices: parsed.data.enabled });
    sync?.setAutoSync(result.settings.autoSyncPrices);
    return { autoSync: result.settings.autoSyncPrices };
  });

  /**
   * The live feed.
   *
   * A Server-Sent Event on every batch of logged requests. SSE rather than a
   * WebSocket because the traffic is one-directional and SSE reconnects on its
   * own - a dropped connection recovers without the page reimplementing
   * backoff, which the frontend's polling fallback then covers anyway.
   */
  app.get('/api/costs/stream', (_request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Without this a proxy in between will happily buffer the whole stream and
      // the page will see nothing until it closes.
      'x-accel-buffering': 'no',
    });
    // A short line to open the connection immediately, so the browser's
    // `onopen` fires without waiting for the first real request.
    reply.raw.write(':ok\n\n');
    const unsubscribe = recorder.subscribe(() => {
      try {
        // A count rather than a payload: the page refetches, which keeps the
        // event cheap and means the numbers always come from the same SQL the
        // initial load used rather than from a parallel code path.
        reply.raw.write(`event: requests\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
      } catch {
        /* client gone */
      }
    });
    // Keeps intermediaries from reaping an idle connection, and doubles as the
    // client's "still connected" signal.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`:ping ${Date.now()}\n\n`);
      } catch {
        /* client gone */
      }
    }, 25_000);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    _request.raw.on('close', cleanup);
    _request.raw.on('error', cleanup);
  });
}

function mergeCurrencies(rates: Array<{ code: string; name: string | null }>): Array<{ code: string; name: string }> {
  const seen = new Map<string, { code: string; name: string }>();
  for (const c of FALLBACK_CURRENCIES_SHARED) seen.set(c.code, { ...c });
  for (const r of rates) {
    if (!seen.has(r.code)) seen.set(r.code, { code: r.code, name: r.name ?? r.code });
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function summarizeWindow(since: number, until: number | undefined, now: number): { since: number; until: number | null; bucketMs: number } {
  return { since, until: until ?? null, bucketMs: bucketFor(since, now) };
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalMonth(now: number): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
