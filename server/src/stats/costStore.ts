import type { Db } from '../db/index.js';
import { flagPriceChange, computeCostUsd, type ParsedPrice } from '../core/cost.js';

/** One row of `model_prices`, hydrated. */
export interface ModelPrice {
  modelId: string;
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedPer1m: number | null;
  source: 'auto' | 'manual';
  syncedAt: number | null;
  updatedAt: number;
}

export interface StoredFxRate {
  code: string;
  rate: number;
  name: string | null;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Model prices and FX rates.
 *
 * Prices are read on the proxy's hot path, so the lookup is a single indexed
 * primary-key read with a small in-process cache in front of it. The cache
 * exists because a busy pool asks for the same handful of model ids on every
 * request, and re-reading SQLite for each one would be a pointless cost for a
 * table that changes once a day.
 *
 * The cache is invalidated on write rather than given a TTL: a manual override
 * has to take effect on the very next request, which is the same
 * write-through discipline `SettingsStore` uses.
 */
export class CostStore {
  private priceCache = new Map<string, ModelPrice | null>();
  private lastFetchAt = 0;

  constructor(private readonly db: Db) {}

  /** The stored price for a model id, or null when it has never been priced. */
  getPrice(modelId: string): ModelPrice | null {
    if (this.priceCache.has(modelId)) return this.priceCache.get(modelId) ?? null;
    const row = this.db.prepare('SELECT * FROM model_prices WHERE model_id = ?').get(modelId) as Row | undefined;
    const price = row ? hydrate(row) : null;
    this.priceCache.set(modelId, price);
    return price;
  }

  listPrices(): ModelPrice[] {
    const rows = this.db.prepare('SELECT * FROM model_prices ORDER BY model_id ASC').all() as Row[];
    return rows.map(hydrate);
  }

  /**
   * Writes prices from a sync.
   *
   * Only `price_source = 'auto'` rows are touched. A manual override is the
   * operator saying "this number is wrong, use mine", and a catalogue refresh
   * silently reverting it would be the tool arguing with the person who owns
   * the bill.
   */
  applySyncedPrices(
    parsed: ParsedPrice[],
    fetchedAt: number,
  ): { updated: number; skippedManual: number; flagged: Array<{ modelId: string; flag: string; from: number | null; to: number | null }>; fetchedAt: number } {
    const select = this.db.prepare('SELECT * FROM model_prices WHERE model_id = ?');
    const insert = this.db.prepare(
      `INSERT INTO model_prices (model_id, input_per_1m, output_per_1m, cached_per_1m, price_source, price_synced_at, updated_at)
       VALUES (?, ?, ?, ?, 'auto', ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         input_per_1m = excluded.input_per_1m,
         output_per_1m = excluded.output_per_1m,
         cached_per_1m = excluded.cached_per_1m,
         price_synced_at = excluded.price_synced_at,
         updated_at = excluded.updated_at`,
    );
    const flagged: Array<{ modelId: string; flag: string; from: number | null; to: number | null }> = [];
    let updated = 0;
    let skippedManual = 0;
    this.db.exec('BEGIN');
    try {
      for (const next of parsed) {
        const existing = select.get(next.modelId) as Row | undefined;
        if (existing && existing.price_source === 'manual') {
          skippedManual += 1;
          continue;
        }
        const previous = existing ? hydrate(existing) : null;
        const flag = flagPriceChange(previous, next);
        if (flag !== 'none') {
          flagged.push({ modelId: next.modelId, flag, from: previous?.inputPer1m ?? null, to: next.inputPer1m });
        }
        insert.run(next.modelId, next.inputPer1m, next.outputPer1m, next.cachedPer1m, fetchedAt, Date.now());
        this.priceCache.set(next.modelId, {
          modelId: next.modelId,
          inputPer1m: next.inputPer1m,
          outputPer1m: next.outputPer1m,
          cachedPer1m: next.cachedPer1m,
          source: 'auto',
          syncedAt: fetchedAt,
          updatedAt: Date.now(),
        });
        updated += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.lastFetchAt = fetchedAt;
    return { updated, skippedManual, flagged, fetchedAt };
  }

  /**
   * An operator-set price. Flips the row to `manual` so the next sync leaves
   * it alone.
   */
  setManualPrice(modelId: string, inputPer1m: number | null, outputPer1m: number | null, cachedPer1m: number | null): ModelPrice | null {
    this.db
      .prepare(
        `INSERT INTO model_prices (model_id, input_per_1m, output_per_1m, cached_per_1m, price_source, price_synced_at, updated_at)
         VALUES (?, ?, ?, ?, 'manual', NULL, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           input_per_1m = excluded.input_per_1m,
           output_per_1m = excluded.output_per_1m,
           cached_per_1m = excluded.cached_per_1m,
           price_source = 'manual',
           updated_at = excluded.updated_at`,
      )
      .run(modelId, inputPer1m, outputPer1m, cachedPer1m, Date.now());
    /* Cleared whole rather than by key: the slash fallback caches its hit under
       the *full* routed id, so editing a bare name can invalidate an entry that
       was filed under some vendor/model spelling of it. */
    this.priceCache.clear();
    return this.getPrice(modelId);
  }

  /** Hands a row back to the automatic sync. */
  resetToAuto(modelId: string): ModelPrice | null {
    this.db
      .prepare("UPDATE model_prices SET price_source = 'auto', updated_at = ? WHERE model_id = ?")
      .run(Date.now(), modelId);
    this.priceCache.clear();
    return this.getPrice(modelId);
  }

  /**
   * Resolves a routed model id to a price, falling back to the bare name after
   * the last slash when the exact id is unknown.
   *
   * The tail fallback is what lets "minimax/minimax-m3" find "minimax-m3" in a
   * table full of OpenRouter ids - and, working in the other direction, lets a
   * gateway's bare "minimax-m3" find the prefixed catalogue row. It only
   * applies to *stored* rows, and only when exactly one row's tail matches, so
   * an ambiguous name stays unpriced rather than being guessed at. (This used
   * to refuse the fallback for ids carrying no slash at all, which silently
   * excluded every bare-id model from automatic pricing - the pure `matchPrice`
   * has always handled both directions, and so does the store now.)
   */
  resolvePrice(modelId: string): ModelPrice | null {
    const exact = this.getPrice(modelId);
    if (exact) return exact;
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1);
    if (!tail) return null;
    const rows = this.db
      .prepare('SELECT * FROM model_prices WHERE model_id = ? OR model_id LIKE ?')
      .all(tail, `%/${tail}`) as Row[];
    const priced = rows
      .map(hydrate)
      // A null input price is not a price, so it cannot disambiguate a match
      // either; it is only useful as a stored "we looked and found nothing".
      .filter((p) => p.inputPer1m !== null);
    const hit = priced.length === 1 ? (priced[0] ?? null) : null;
    this.priceCache.set(modelId, hit);
    return hit;
  }

  /**
   * Every catalogue row that could price `modelId`, for the operator to pick
   * from.
   *
   * The recorder's `resolvePrice` refuses to guess between two rows sharing a
   * bare name - the right call for automatic pricing, but it leaves a used
   * model unpriced when only a human can say which vendor's row is the real
   * one. This returns the exact hit when there is one and every tail match
   * otherwise, so the dashboard can offer the choice this class will not make
   * on its own.
   */
  matchCandidates(modelId: string): { exact: ModelPrice | null; candidates: ModelPrice[] } {
    const exact = this.getPrice(modelId);
    if (exact) return { exact, candidates: [exact] };
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1);
    const rows = this.db
      .prepare('SELECT * FROM model_prices WHERE model_id = ? OR model_id LIKE ?')
      .all(tail, `%/${tail}`) as Row[];
    const candidates = rows
      .map(hydrate)
      // A row with no rates at all cannot price anything, so it is not a
      // candidate - it would only teach the operator to click through dialogs
      // that do nothing.
      .filter((p) => p.inputPer1m !== null || p.outputPer1m !== null)
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    return { exact: null, candidates };
  }

  /**
   * Prices the logged requests this price row covers but could not price at
   * the time - the rows sitting at `cost_usd IS NULL` because the model was
   * unknown to the catalogue when they ran.
   *
   * Only unpriced rows are touched, and the row selection mirrors
   * `resolvePrice` exactly (the id, plus every id whose bare tail matches), so
   * a backfill never disagrees with what the recorder would have done had the
   * price existed. Requests already carrying a cost are left alone: this
   * prices the unknowns, it does not relitigate the knowns.
   */
  backfillUnpriced(modelId: string, price: ModelPrice): number {
    if (price.inputPer1m === null && price.outputPer1m === null) return 0;
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1);
    const rows = this.db
      .prepare(
        `SELECT id, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens
           FROM request_logs
          WHERE cost_usd IS NULL AND (upstream_model = ? OR upstream_model LIKE ?)`,
      )
      .all(modelId, `%/${tail}`) as Row[];
    if (rows.length === 0) return 0;
    const update = this.db.prepare('UPDATE request_logs SET cost_usd = ?, price_source = ? WHERE id = ?');
    let applied = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const usage = {
          promptTokens: r.prompt_tokens === null || r.prompt_tokens === undefined ? null : Number(r.prompt_tokens),
          completionTokens: r.completion_tokens === null || r.completion_tokens === undefined ? null : Number(r.completion_tokens),
          totalTokens: null,
          cachedTokens: r.cached_tokens === null || r.cached_tokens === undefined ? null : Number(r.cached_tokens),
          reasoningTokens: r.reasoning_tokens === null || r.reasoning_tokens === undefined ? null : Number(r.reasoning_tokens),
          // The rows predate the flag, and the recorder's own default applies:
          // reasoning counts as already included, so a backfill can only
          // under-count an edge provider, never double-bill.
          completionIncludesReasoning: true,
        };
        const usd = computeCostUsd(usage, price);
        if (usd === null) continue;
        update.run(usd, price.source, Number(r.id));
        applied += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return applied;
  }

  /**
   * Prices every used model the catalogue can name unambiguously.
   *
   * Walks the distinct models that still have unpriced rows, resolves each
   * against the price table (exact id first, then an unambiguous bare-name
   * tail - the same resolution the recorder applies to new traffic), and
   * backfills what resolves. Models the catalogue cannot name, or whose bare
   * name two vendors share, are left for the operator's picker: automatic
   * means "no manual work for the models we know", never "guess".
   *
   * Runs after every catalogue sync and on demand, so a model that was unpriced
   * when its traffic flew becomes priced the moment the catalogue can price it
   * - without anyone visiting this page per model.
   */
  evaluateUsedModels(): Array<{ modelId: string; backfilled: number; source: string }> {
    const used = this.db
      .prepare(
        `SELECT upstream_model AS model, COUNT(*) AS n
           FROM request_logs
          WHERE cost_usd IS NULL AND upstream_model IS NOT NULL
          GROUP BY upstream_model
          ORDER BY n DESC`,
      )
      .all() as Row[];
    const out: Array<{ modelId: string; backfilled: number; source: string }> = [];
    for (const u of used) {
      const modelId = String(u.model);
      const price = this.resolvePrice(modelId);
      if (!price) continue;
      const backfilled = this.backfillUnpriced(modelId, price);
      if (backfilled > 0) out.push({ modelId, backfilled, source: price.source });
    }
    return out;
  }

  // -------------------------------------------------------------------- FX

  getFxRates(): { rates: StoredFxRate[]; fetchedAt: number } {
    const rows = this.db.prepare('SELECT code, rate, name, fetched_at FROM fx_rates ORDER BY code ASC').all() as Row[];
    const rates = rows.map((r) => ({
      code: String(r.code),
      rate: Number(r.rate),
      name: r.name === null || r.name === undefined ? null : String(r.name),
    }));
    return { rates, fetchedAt: rates.length > 0 ? Number(rows[0]?.fetched_at ?? 0) : 0 };
  }

  /**
   * Replaces the whole rate set.
   *
   * Replace rather than merge, so a currency the source has dropped does not
   * linger at a stale rate forever. On an empty parse nothing is written and
   * the previous set survives, which is what makes a failed fetch harmless.
   */
  replaceFxRates(rates: StoredFxRate[], fetchedAt: number): number {
    if (rates.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM fx_rates');
    const ins = this.db.prepare('INSERT INTO fx_rates (code, rate, name, fetched_at) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      del.run();
      for (const r of rates) ins.run(r.code, r.rate, r.name, fetchedAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rates.length;
  }

  get lastSyncAt(): number {
    return this.lastFetchAt;
  }
}

function hydrate(r: Row): ModelPrice {
  return {
    modelId: String(r.model_id),
    inputPer1m: num(r.input_per_1m),
    outputPer1m: num(r.output_per_1m),
    cachedPer1m: num(r.cached_per_1m),
    source: r.price_source === 'manual' ? 'manual' : 'auto',
    syncedAt: r.price_synced_at === null || r.price_synced_at === undefined ? null : Number(r.price_synced_at),
    updatedAt: Number(r.updated_at ?? 0),
  };
}
