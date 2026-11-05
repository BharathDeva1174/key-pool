import { parseFxRates, parseOpenRouterModels } from '../core/cost.js';
import type { CostStore } from './costStore.js';

/*
 * Two external catalogues, fetched on a slow cadence and treated as optional.
 *
 * The governing rule is that neither of these can take the proxy down or lose
 * data. A price catalogue is a convenience - a missing price means a request is
 * labelled unpriced, which is honest - and an FX rate is needed only to *show* a
 * number in the operator's currency, with USD always available as the fallback.
 * So every failure path here keeps the previous values and reports the reason.
 */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const PRICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FX_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** A hung socket should not hold the startup sequence open. */
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'keypool/1.0 (local dashboard)' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncStatus {
  lastPriceSyncAt: number;
  lastPriceSyncError: string | null;
  lastFxSyncAt: number;
  lastFxSyncError: string | null;
}

export interface SyncResult {
  ok: boolean;
  updated: number;
  skippedManual: number;
  flagged: Array<{ modelId: string; flag: string; from: number | null; to: number | null }>;
  /**
   * Used models the fresh catalogue could price that were flying unpriced
   * before it landed - each already backfilled from its logged tokens. Empty
   * on a failed sync: old prices stand, and nothing new is applied.
   */
  evaluated: Array<{ modelId: string; backfilled: number }>;
  fetchedAt: number;
  error?: string;
}

export interface FxSyncResult {
  ok: boolean;
  count: number;
  fetchedAt: number;
  error?: string;
}

export class PriceSyncService {
  private status: SyncStatus = {
    lastPriceSyncAt: 0,
    lastPriceSyncError: null,
    lastFxSyncAt: 0,
    lastFxSyncError: null,
  };
  private priceTimer: NodeJS.Timeout | null = null;
  private fxTimer: NodeJS.Timeout | null = null;
  /**
   * Serialises syncs.
   *
   * Without it, the startup sync and a "Sync now" press can overlap, and the
   * slower one's `applySyncedPrices` would land on top of the faster one's with
   * a staler payload - so the newer fetch would be overwritten by the older.
   */
  private inFlight: Promise<SyncResult> | null = null;

  constructor(
    private readonly store: CostStore,
    private readonly now: () => number = Date.now,
  ) {}

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /**
   * Fetches the model catalogue and writes it.
   *
   * Every previously stored price is replaced except manual overrides, so a
   * provider that was repriced is corrected rather than kept. Nothing is deleted
   * for models missing from the new response: a catalogue that has quietly
   * dropped a model is not evidence the model stopped existing.
   */
  async syncPrices(): Promise<SyncResult> {
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
    const run = (async (): Promise<SyncResult> => {
      const fetchedAt = this.now();
      try {
        const payload = await fetchJson(OPENROUTER_MODELS_URL);
        const parsed = parseOpenRouterModels(payload);
        if (parsed.length === 0) throw new Error('Catalogue returned no usable models.');
        const result = this.store.applySyncedPrices(parsed, fetchedAt);
        this.status.lastPriceSyncAt = fetchedAt;
        this.status.lastPriceSyncError = null;
        // The catalogue just changed shape: what was unmatchable a moment ago
        // may resolve now. Evaluate before returning, so a sync that lands at
        // boot prices the backlog without anyone asking it to.
        const evaluated = this.store.evaluateUsedModels().map((e) => ({ modelId: e.modelId, backfilled: e.backfilled }));
        return { ok: true, ...result, evaluated };
      } catch (err) {
        // Old prices stand. A dashboard that lost its prices because a
        // catalogue blipped would be worse than a stale one.
        const message = (err as Error)?.message ?? String(err);
        this.status.lastPriceSyncError = message;
        return { ok: false, updated: 0, skippedManual: 0, flagged: [], evaluated: [], fetchedAt, error: message };
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }

  /**
   * Fetches USD-based rates.
   *
   * An empty parse is treated as a failure so the previous set is never wiped by
   * a response that parsed but contained nothing usable.
   */
  async syncFx(): Promise<FxSyncResult> {
    const fetchedAt = this.now();
    try {
      const payload = await fetchJson(FX_URL);
      const rates = parseFxRates(payload);
      if (rates.length < 2) throw new Error('Rate list came back empty.');
      const count = this.store.replaceFxRates(rates, fetchedAt);
      this.status.lastFxSyncAt = fetchedAt;
      this.status.lastFxSyncError = null;
      return { ok: true, count, fetchedAt };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.status.lastFxSyncError = message;
      return { ok: false, count: 0, fetchedAt, error: message };
    }
  }

  /** Seeds the cached rates from the DB so the page has something on first paint. */
  primeFromCache(): void {
    const { fetchedAt } = this.store.getFxRates();
    if (fetchedAt > 0) this.status.lastFxSyncAt = fetchedAt;
  }

  start(autoSyncPrices: boolean): void {
    this.primeFromCache();
    // Startup: fire and forget. Nothing here is awaited, because a slow
    // catalogue must not delay the proxy coming up - the page renders and the
    // numbers fill in when the fetch lands.
    void this.syncFx();
    if (autoSyncPrices) void this.syncPrices();
    this.fxTimer = setInterval(() => void this.syncFx(), FX_INTERVAL_MS);
    this.fxTimer.unref?.();
    if (autoSyncPrices) {
      this.priceTimer = setInterval(() => void this.syncPrices(), PRICE_INTERVAL_MS);
      this.priceTimer.unref?.();
    }
  }

  stop(): void {
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this.fxTimer) clearInterval(this.fxTimer);
    this.priceTimer = null;
    this.fxTimer = null;
  }

  /** Restarts the price interval after the auto-sync toggle changes. */
  setAutoSync(enabled: boolean): void {
    if (this.priceTimer) {
      clearInterval(this.priceTimer);
      this.priceTimer = null;
    }
    if (enabled) {
      this.priceTimer = setInterval(() => void this.syncPrices(), PRICE_INTERVAL_MS);
      this.priceTimer.unref?.();
    }
  }
}
