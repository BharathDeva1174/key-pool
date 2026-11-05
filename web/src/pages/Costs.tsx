import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  api,
  type CostBreakdownRow,
  type CostRequestRow,
  type CostsFxResponse,
  type CostsSummaryResponse,
  type CostTimeseriesPoint,
  type ModelPrice,
  type PriceMatch,
} from '../lib/api';
import { Card, Empty, ErrorNote, Modal, Spinner, Stat, Toggle, useToast } from '../components/ui';
import {
  formatCost,
  formatCostCompact,
  formatNumber,
  formatPricePer1m,
  formatRelative,
  rangeLabel as rangeLabelFor,
  TIME_RANGES,
} from '../lib/format';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { useInk } from '../lib/theme';

/** How many rows of the live tail the page fetches per refresh. */
const FEED_LIMIT = 50;
/** How many catalogue rows render before the filter has to narrow it. */
const PRICE_TABLE_CAP = 50;

export default function Costs() {
  const [range, setRange] = useState('24h');
  const [summary, setSummary] = useState<CostsSummaryResponse | null>(null);
  const [series, setSeries] = useState<CostTimeseriesPoint[]>([]);
  const [byModel, setByModel] = useState<CostBreakdownRow[]>([]);
  const [byProvider, setByProvider] = useState<CostBreakdownRow[]>([]);
  const [byKey, setByKey] = useState<CostBreakdownRow[]>([]);
  const [feed, setFeed] = useState<CostRequestRow[]>([]);
  const [fx, setFx] = useState<CostsFxResponse | null>(null);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [priceFilter, setPriceFilter] = useState('');
  const [editing, setEditing] = useState<ModelPrice | 'new' | null>(null);
  /** The used-model row being priced from the catalogue, in the By model table. */
  const [pricingRow, setPricingRow] = useState<CostBreakdownRow | null>(null);
  const [syncing, setSyncing] = useState<'prices' | 'fx' | null>(null);
  const ink = useInk();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // See the note on Stats: the draw belongs to the act of picking a window,
  // not to every poll.
  const drawOnLoad = useRef(true);
  const [draw, setDraw] = useState(true);

  const load = useCallback(async () => {
    const shouldDraw = drawOnLoad.current;
    drawOnLoad.current = false;
    setDraw(shouldDraw);
    try {
      const [s, ts, b, r, f] = await Promise.all([
        api.costsSummary(range),
        api.costsTimeseries(range),
        api.costsBreakdown(range),
        api.costsRequests(FEED_LIMIT),
        api.costsFx(),
      ]);
      setSummary(s);
      setSeries(ts.points);
      setByModel(b.byModel);
      setByProvider(b.byProvider);
      setByKey(b.byKey);
      setFeed(r.rows);
      setFx(f);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Only the first load blanks the page; a refresh updates in place.
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    drawOnLoad.current = true;
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // The one polling mechanism, shared with Overview and Stats.
  useAutoRefresh(load);

  /*
   * The live feed. The server emits a count-only event per recorder flush;
   * the page answers it by refetching, so every figure arrives through the
   * same SQL the initial load used. The drain is 2s (300ms while this page is
   * open), so a finished request is on screen in about a second - faster than
   * the 3s poll alone would manage, and the poll below it stays as the
   * fallback for a dropped or locked stream.
   */
  useEffect(() => {
    const es = new EventSource('/api/costs/stream');
    const onRequests = () => void load();
    es.addEventListener('requests', onRequests);
    return () => {
      es.removeEventListener('requests', onRequests);
      es.close();
    };
  }, [load]);

  // Prices change rarely - a separate fetch on mount and after an edit, not
  // on every poll.
  const loadPrices = useCallback(async () => {
    try {
      const p = await api.costsPrices();
      setPrices(p.prices);
    } catch {
      /* the table is secondary; the summary surfaces API-level failures */
    }
  }, []);

  useEffect(() => {
    void loadPrices();
  }, [loadPrices]);

  const currency = summary?.currency ?? 'USD';
  // A currency with no synced rate converts at 1 - the USD reading - rather
  // than disappearing; the FX card says the rate set is stale.
  const rate = fx?.rates[currency] ?? 1;
  const conv = (usd: number | null): number | null => (usd === null ? null : usd * rate);

  const setCurrency = async (code: string) => {
    try {
      const res = await api.costsSetCurrency(code);
      setSummary((s) => (s ? { ...s, currency: res.currency } : s));
    } catch (err) {
      toast.push('bad', (err as Error).message);
    }
  };

  const syncPrices = async () => {
    setSyncing('prices');
    try {
      const res = await api.costsPricesSync();
      if (res.ok) {
        const flagged = res.flagged.length;
        const backfilled = res.evaluated.reduce((s, e) => s + e.backfilled, 0);
        toast.push(
          'ok',
          t('Synced {n} prices from OpenRouter', { n: res.updated }) +
            (res.skippedManual ? t(', kept {n} manual', { n: res.skippedManual }) : '') +
            (backfilled ? ' · ' + (backfilled === 1 ? t('priced {n} backlogged request', { n: backfilled }) : t('priced {n} backlogged requests', { n: backfilled })) : '') +
            (flagged ? ' · ' + t('{n} changed >3x, worth a look', { n: flagged }) : ''),
        );
        void loadPrices();
        void load();
      } else {
        toast.push('bad', res.error ?? 'Price sync failed.');
      }
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setSyncing(null);
    }
  };

  /**
   * One click, no per-model work: prices every used model the synced catalogue
   * can name and backfills its logged tokens. Ambiguous and unknown models are
   * left for the By model table's picker, on purpose.
   */
  const evaluateUsed = async () => {
    setSyncing('prices');
    try {
      const res = await api.costsEvaluate();
      const models = res.evaluated.length;
      const backfilled = res.evaluated.reduce((s, e) => s + e.backfilled, 0);
      if (models === 0) {
        toast.push('info', t('Nothing to auto-price - every used model the catalogue names is already priced.'));
      } else {
        const named = res.evaluated
          .slice(0, 3)
          .map((e) => `${e.modelId} (${e.backfilled})`)
          .join(', ');
        toast.push('ok', (models === 1 ? t('Auto-priced {n} model', { n: models }) : t('Auto-priced {n} models', { n: models })) + ', ' + (backfilled === 1 ? t('{n} request backfilled', { n: backfilled }) : t('{n} requests backfilled', { n: backfilled })) + ': ' + named + (models > 3 ? t(' (+{n} more)', { n: models - 3 }) : ''));
      }
      void loadPrices();
      void load();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setSyncing(null);
    }
  };

  const syncFx = async () => {
    setSyncing('fx');
    try {
      const res = await api.costsFxSync();
      if (res.ok) {
        toast.push('ok', t('Fetched {n} exchange rates.', { n: res.count }));
        void load();
      } else {
        toast.push('bad', res.error ?? 'FX sync failed.');
      }
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setSyncing(null);
    }
  };

  const setAutoSync = async (enabled: boolean) => {
    try {
      const res = await api.costsSetAutoSync(enabled);
      setSummary((s) => (s ? { ...s, sync: { ...s.sync, prices: { ...s.sync.prices, auto: res.autoSync } } } : s));
      toast.push('ok', enabled ? t('Auto-sync on - the catalogue refreshes daily.') : t('Auto-sync off.'));
    } catch (err) {
      toast.push('bad', (err as Error).message);
    }
  };

  const rangeLabel = rangeLabelFor(range);
  const chartPoints = series.map((p) => ({
    bucket: p.bucket,
    requests: p.requests,
    cost: (p.costUsd ?? 0) * rate,
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Costs')}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {t('Spend is priced per model at request time and stored on the log; this page sums it in SQL.')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('Display currency')}
            value={currency}
            onChange={(e) => void setCurrency(e.target.value)}
            className="rounded-[var(--radius-control)] border border-line bg-inset px-2 py-1.5 text-xs text-fg"
          >
            {(fx?.currencies ?? [{ code: 'USD', name: 'US Dollar' }, { code: 'INR', name: 'Indian Rupee' }]).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap rounded-[var(--radius-control)] border border-line bg-inset p-0.5">
            {TIME_RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`rounded-[4px] border px-2.5 py-1 text-xs font-medium transition-[background-color,border-color,color] duration-150 ${
                  range === r.key
                    ? 'border-line bg-surface text-accent'
                    : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && <ErrorNote message={error} />}
      {loading && <Spinner label={t('Counting…')} />}

      {!loading && summary && (
        <>
          <div className="card overflow-hidden">
            <div className="grid grid-cols-2 lg:grid-cols-4">
              <Stat
                className="border-t border-line"
                label={t('Spend')}
                value={formatCost(conv(summary.summary.costUsd), currency)}
                hint={range === 'all' ? 'everything still retained' : rangeLabel}
              />
              <Stat
                className="border-t border-line"
                label={t('Today')}
                value={formatCost(conv(summary.today.costUsd), currency)}
                hint="since local midnight"
              />
              <Stat
                className="border-t border-line"
                label={t('This month')}
                value={formatCost(conv(summary.thisMonth.costUsd), currency)}
                hint="since the 1st"
              />
              <Stat
                className="border-t border-line"
                label={t('Avg / request')}
                value={formatCost(conv(summary.summary.avgCostPerRequestUsd), currency)}
                hint={t('{n} priced', { n: formatNumber(summary.summary.pricedRequests) })}
              />
            </div>
            {summary.summary.unpricedRequests > 0 && (
              <p className="border-t border-line px-4 py-2.5 text-xs text-warn">
                {t('{unpriced} of {total} requests in this window have no known price and are excluded from the totals above - they are counted, never reported as free. Set a price on the model in the By model table below; its already-logged requests are priced from their recorded tokens.', { unpriced: formatNumber(summary.summary.unpricedRequests), total: formatNumber(summary.summary.requests) })}
              </p>
            )}
          </div>

          <Card
            title={t('Spend over time')}
            subtitle={t('Priced spend per bucket, in {currency}. Unpriced requests contribute no point.', { currency })}
          >
            {chartPoints.length === 0 ? (
              <Empty
                title={t('No traffic in this window.')}
                hint={t('Cost appears here the moment a priced request is logged.')}
              />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartPoints} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke={ink.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v: number) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })}
                      stroke={ink.line}
                      fontSize={11}
                      tickLine={false}
                    />
                    <YAxis
                      stroke={ink.line}
                      fontSize={11}
                      tickLine={false}
                      tickFormatter={(v: number) => formatCostCompact(v, currency)}
                    />
                    <Tooltip
                      cursor={{ stroke: ink['line-strong'], strokeWidth: 1 }}
                      contentStyle={{
                        background: ink.surface,
                        border: `1px solid ${ink.line}`,
                        borderRadius: 8,
                        fontSize: 12,
                        color: ink.fg,
                      }}
                      labelStyle={{ color: ink.muted }}
                      labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                      formatter={(value) => [formatCost(Number(value), currency), 'spend']}
                    />
                    <Area
                      type="monotone"
                      dataKey="cost"
                      stroke={ink.accent}
                      fill={ink.accent}
                      fillOpacity={0.12}
                      strokeWidth={2}
                      animationDuration={420}
                      isAnimationActive={draw}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <CostTable
            title={t('By model')}
            subtitle={t('Grouped by the model that actually served, not the name the client asked for. A model with unpriced requests can be priced straight from its row.')}
            rows={byModel}
            currency={currency}
            rate={rate}
            onPrice={(row) => setPricingRow(row)}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <CostTable title={t('By provider')} rows={byProvider} currency={currency} rate={rate} />
            <CostTable title={t('By key')} rows={byKey} currency={currency} rate={rate} />
          </div>

          <Card title={t('Recent requests')} subtitle={t('Newest first - refetches as the log drains, live.')}>
            {feed.length === 0 ? (
              <Empty title={t('Nothing logged in this window.')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="th">{t('When')}</th>
                      <th className="th">{t('Model')}</th>
                      <th className="th text-right">In</th>
                      <th className="th text-right">{t('Out')}</th>
                      <th className="th text-right">{t('Cost')}</th>
                      <th className="th text-right">{t('Status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {feed.map((row) => (
                      <tr key={row.id} className="row-hover">
                        <td className="td whitespace-nowrap text-subtle" title={new Date(row.ts).toLocaleString()}>
                          {formatRelative(row.ts)}
                        </td>
                        <td className="td max-w-[240px] truncate font-mono text-xs" title={row.model}>
                          {row.model}
                          {row.streaming && <span className="ml-1.5 text-[10px] text-faint">stream</span>}
                        </td>
                        <td className="td tnum text-right font-mono">
                          {formatNumber(row.promptTokens)}
                          {row.cachedTokens ? <span className="text-subtle"> · {formatNumber(row.cachedTokens)} cached</span> : null}
                        </td>
                        <td className="td tnum text-right font-mono">{formatNumber(row.completionTokens)}</td>
                        <td className="td tnum text-right font-mono">
                          {row.costUsd === null ? <span className="text-warn">unpriced</span> : formatCost(row.costUsd * rate, currency)}
                        </td>
                        <td className="td text-right text-xs">
                          {row.success ? (
                            <span className="text-subtle">{row.priceSource ?? 'unpriced'}</span>
                          ) : (
                            <span className="text-bad">{row.errorKind ?? 'failed'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title={t('Model prices')}
            subtitle={t('USD per million tokens. Auto-synced from OpenRouter; a manual price is never overwritten.')}
            actions={
              <>
                <input
                  value={priceFilter}
                  onChange={(e) => setPriceFilter(e.target.value)}
                  placeholder={t('Filter models…')}
                  aria-label={t('Filter price rows')}
                  className="w-40 rounded-[var(--radius-control)] border border-line bg-inset px-2 py-1.5 text-xs text-fg placeholder:text-faint"
                />
                <button className="btn" onClick={() => void syncPrices()} disabled={syncing !== null}>
                  {syncing === 'prices' ? t('Syncing…') : t('Sync now')}
                </button>
                <button
                  className="btn"
                  onClick={() => void evaluateUsed()}
                  disabled={syncing !== null}
                  title={t('Price every used model the catalogue can name, from its logged tokens')}
                >
                  {t('Auto-price used')}
                </button>
                <button className="btn" onClick={() => void syncFx()} disabled={syncing !== null}>
                  {syncing === 'fx' ? t('Fetching…') : t('Sync rates')}
                </button>
                <button className="btn btn-primary" onClick={() => setEditing('new')}>
                  + Add price
                </button>
              </>
            }
          >
            <Toggle
              checked={summary.sync.prices.auto ?? true}
              onChange={(v) => void setAutoSync(v)}
              label={t('Auto-sync prices')}
              hint={t('Fetches the OpenRouter catalogue at boot and every 24h, and USD exchange rates every 12h.')}
            />

            <div className="mt-3 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line">
                    <th className="th">{t('Model')}</th>
                    <th className="th text-right">Input / 1M</th>
                    <th className="th text-right">Output / 1M</th>
                    <th className="th text-right">Cached / 1M</th>
                    <th className="th text-right">{t('Source')}</th>
                    <th className="th text-right">{t('Synced')}</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {priceRows(prices, priceFilter).map((p) => (
                    <tr key={p.modelId} className="row-hover">
                      <td className="td max-w-[280px] truncate font-mono text-xs" title={p.modelId}>
                        {p.modelId}
                      </td>
                      <td className="td tnum text-right font-mono">${formatPricePer1m(p.inputPer1m)}</td>
                      <td className="td tnum text-right font-mono">${formatPricePer1m(p.outputPer1m)}</td>
                      <td className="td tnum text-right font-mono text-subtle">${formatPricePer1m(p.cachedPer1m)}</td>
                      <td className="td text-right text-xs">
                        {p.source === 'manual' ? <span className="text-accent">manual</span> : <span className="text-subtle">auto</span>}
                      </td>
                      <td className="td text-right text-xs text-subtle">{formatRelative(p.syncedAt)}</td>
                      <td className="td text-right whitespace-nowrap">
                        <button className="text-xs text-muted transition-colors hover:text-fg" onClick={() => setEditing(p)}>
                          {t('Edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {prices.length === 0 ? (
              <p className="mt-3 text-xs text-muted">
                {t('No prices yet. Run a sync - or add a price by hand if this pool serves models OpenRouter does not list.')}
              </p>
            ) : (
              priceRows(prices, priceFilter).length === 0 && <p className="mt-3 text-xs text-muted">{t('No model matches that filter.')}</p>
            )}
            <p className="mt-3 text-xs text-muted">
              Prices {summary.sync.prices.error ? <span className="text-bad">{summary.sync.prices.error}</span> : `synced ${formatRelative(summary.sync.prices.at)}`}
              {' · '}
              rates {summary.sync.fx.error ? <span className="text-bad">{summary.sync.fx.error}</span> : `fetched ${formatRelative(summary.sync.fx.at)}`}
            </p>
          </Card>
        </>
      )}

      {editing && summary && (
        <PriceModal
          price={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            if (message) toast.push('ok', message);
            void loadPrices();
            void load();
          }}
        />
      )}

      {pricingRow && (
        <PriceUsedModelModal
          row={pricingRow}
          onClose={() => setPricingRow(null)}
          onSaved={(message) => {
            setPricingRow(null);
            if (message) toast.push('ok', message);
            void loadPrices();
            void load();
          }}
        />
      )}
    </div>
  );
}

/** The filtered, capped catalogue rows for the table. */
function priceRows(prices: ModelPrice[], filter: string): ModelPrice[] {
  const needle = filter.trim().toLowerCase();
  const rows = needle ? prices.filter((p) => p.modelId.toLowerCase().includes(needle)) : prices;
  return rows.slice(0, PRICE_TABLE_CAP);
}

function CostTable({
  title,
  subtitle,
  rows,
  currency,
  rate,
  onPrice,
}: {
  title: string;
  subtitle?: string;
  rows: CostBreakdownRow[];
  currency: string;
  rate: number;
  /** Present only on the By model table: prices a used model from its row. */
  onPrice?: (row: CostBreakdownRow) => void;
}) {
  return (
    <Card title={title} subtitle={subtitle}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('No data in this window.')}</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-line">
              <th className="th">{t('Label')}</th>
              <th className="th text-right">{t('Requests')}</th>
              <th className="th text-right">{t('Tokens')}</th>
              <th className="th text-right">{t('Spend')}</th>
              <th className="th text-right">Avg / request</th>
              {onPrice && <th className="th" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 12).map((row) => (
              <tr key={row.label} className="row-hover">
                <td className="td max-w-[220px] truncate font-mono text-xs" title={row.label}>
                  {row.label}
                  {row.unpricedRequests > 0 && <span className="ml-1.5 text-[10px] text-warn">{row.unpricedRequests} unpriced</span>}
                </td>
                <td className="td tnum text-right font-mono">{formatNumber(row.requests)}</td>
                {/* In + out combined - the tokens a price is applied to. */}
                <td className="td tnum text-right font-mono text-subtle">{formatNumber(row.combinedTokens)}</td>
                <td className="td tnum text-right font-mono">{formatCost(row.costUsd === null ? null : row.costUsd * rate, currency)}</td>
                <td className="td tnum text-right font-mono text-subtle">
                  {formatCost(row.avgCostPerRequestUsd === null ? null : row.avgCostPerRequestUsd * rate, currency)}
                </td>
                {onPrice && (
                  <td className="td text-right whitespace-nowrap">
                    {row.unpricedRequests > 0 && (
                      <button className="text-xs text-accent transition-colors hover:text-fg" onClick={() => onPrice(row)}>
                        {t('Set price')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Price one used model, straight from its row in the By model table.
 *
 * The model id is fixed (it is the id the traffic actually used) and the
 * synced catalogue is consulted first: an exact row, or - when the automatic
 * matcher refused to guess between vendors sharing a bare name - every
 * candidate, with the operator picking. Rates arrive prefilled and stay
 * editable; a model the catalogue has never heard of is priced by hand.
 *
 * The backfill is the "based on combined tokens" half: the requests already
 * logged for this id carry their in/out token counts, so once a price exists
 * they can be priced from what they actually used - only the rows sitting at
 * NULL, never a re-pricing of history that already carries a snapshot.
 */
function PriceUsedModelModal({
  row,
  onClose,
  onSaved,
}: {
  row: CostBreakdownRow;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [match, setMatch] = useState<PriceMatch | null>(null);
  const [picked, setPicked] = useState<string>('');
  // Rates are held as raw text for the same reason as in PriceModal: a number
  // binding swallows the keystrokes that make a decimal.
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cached, setCached] = useState('');
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const m = await api.costsMatchPrice(row.label);
        if (cancelled) return;
        setMatch(m);
        const first = m.exact ?? m.candidates[0] ?? null;
        if (first) {
          setPicked(first.modelId);
          prefill(first, setInput, setOutput, setCached);
        }
      } catch {
        /* the catalogue lookup is an affordance, not a requirement - the
           manual fields work with no network at all */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.label]);

  const pick = (modelId: string) => {
    setPicked(modelId);
    const candidate = match?.candidates.find((c) => c.modelId === modelId);
    if (candidate) prefill(candidate, setInput, setOutput, setCached);
  };

  /** Empty reads as unknown; anything else must parse to a non-negative number. */
  const parseRate = (raw: string): number | null | string => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return 'Enter a non-negative number, or leave the field empty.';
    return n;
  };

  const save = async () => {
    const inR = parseRate(input);
    const outR = parseRate(output);
    const cachedR = parseRate(cached);
    for (const r of [inR, outR, cachedR]) {
      if (typeof r === 'string') {
        setError(r);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.costsSetPrice({
        modelId: row.label,
        inputPer1m: inR as number | null,
        outputPer1m: outR as number | null,
        cachedPer1m: cachedR as number | null,
        backfill,
      });
      onSaved(
        res.backfilled > 0
          ? (res.backfilled === 1 ? t('Priced {model} - {n} logged request priced from their tokens.', { model: row.label, n: res.backfilled }) : t('Priced {model} - {n} logged requests priced from their tokens.', { model: row.label, n: res.backfilled }))
          : t('Price for {model} saved as manual.', { model: row.label }),
      );
    } catch (err) {
      toast.push('bad', (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Price this model')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="label">{t('Model id')}</p>
          <p className="mt-1 truncate font-mono text-sm text-fg" title={row.label}>
            {row.label}
          </p>
          <p className="mt-1 text-xs text-muted">
            {t('{combined} combined tokens (in + out) across {requests} requests ·', { combined: formatNumber(row.combinedTokens), requests: formatNumber(row.requests) })}{' '}
            <span className="text-warn">{t('{n} unpriced', { n: row.unpricedRequests })}</span>
          </p>
        </div>

        {match && match.candidates.length > 0 && (
          <div>
            <p className="label">{t('From the price catalogue')}</p>
            <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
              {match.candidates.slice(0, 12).map((c) => (
                <button
                  key={c.modelId}
                  type="button"
                  onClick={() => pick(c.modelId)}
                  aria-pressed={picked === c.modelId}
                  className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    picked === c.modelId ? 'border-accent bg-raised text-fg' : 'border-line text-muted hover:text-fg'
                  }`}
                >
                  <span className="min-w-0 truncate font-mono" title={c.modelId}>
                    {c.modelId}
                  </span>
                  <span className="tnum shrink-0 font-mono text-subtle">
                    ${formatPricePer1m(c.inputPer1m)} / ${formatPricePer1m(c.outputPer1m)} per 1M
                  </span>
                </button>
              ))}
            </div>
            {match.candidates.length > 12 && (
              <p className="mt-1 text-xs text-faint">{t('Showing the first 12 of {n} catalogue matches.', { n: match.candidates.length })}</p>
            )}
          </div>
        )}
        {match && match.candidates.length === 0 && (
          <p className="text-xs text-muted">
            {t('Not in the synced catalogue by this id or its bare name - enter the rates by hand.')}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="used-price-input">
              {t('Input $ / 1M')}
            </label>
            <input id="used-price-input" className="input" value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <div>
            <label className="label" htmlFor="used-price-output">
              {t('Output $ / 1M')}
            </label>
            <input id="used-price-output" className="input" value={output} onChange={(e) => setOutput(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <div>
            <label className="label" htmlFor="used-price-cached">
              {t('Cached $ / 1M')}
            </label>
            <input id="used-price-cached" className="input" value={cached} onChange={(e) => setCached(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
        </div>
        <p className="text-xs text-muted">{t('Rates are editable - picking a catalogue row only prefills it.')}</p>

        <Toggle
          checked={backfill}
          onChange={setBackfill}
          label={t('Price the {n} requests already logged', { n: formatNumber(row.unpricedRequests) })}
          hint={t('Computes each one from its recorded token counts. Requests that already carry a cost are left alone.')}
        />

        {error && <ErrorNote message={error} />}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? t('Saving…') : t('Save price')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Fills the three rate fields from a catalogue row, blank where it has none. */
function prefill(
  price: ModelPrice,
  setInput: (v: string) => void,
  setOutput: (v: string) => void,
  setCached: (v: string) => void,
): void {
  setInput(price.inputPer1m == null ? '' : String(price.inputPer1m));
  setOutput(price.outputPer1m == null ? '' : String(price.outputPer1m));
  setCached(price.cachedPer1m == null ? '' : String(price.cachedPer1m));
}

/**
 * Add or override one model's price.
 *
 * A blank rate means "unknown" and is stored as NULL - never as zero, which
 * would report the model as free. Saving flips the row to manual, so the next
 * catalogue sync leaves it exactly as set here.
 */
function PriceModal({
  price,
  onClose,
  onSaved,
}: {
  price: ModelPrice | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [modelId, setModelId] = useState(price?.modelId ?? '');
  // Rates are held as the raw text the operator typed. Binding a number to the
  // field would swallow the keystrokes that make one - "0." collapses to "0" -
  // and a price field is the last place to fight the operator over decimals.
  const [input, setInput] = useState(price?.inputPer1m == null ? '' : String(price.inputPer1m));
  const [output, setOutput] = useState(price?.outputPer1m == null ? '' : String(price.outputPer1m));
  const [cached, setCached] = useState(price?.cachedPer1m == null ? '' : String(price.cachedPer1m));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  /** Empty reads as unknown; anything else must parse to a non-negative number. */
  const parseRate = (raw: string): number | null | string => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return 'Enter a non-negative number, or leave the field empty.';
    return n;
  };

  const save = async () => {
    if (!modelId.trim()) {
      setError(t('A model id is required.'));
      return;
    }
    const inR = parseRate(input);
    const outR = parseRate(output);
    const cachedR = parseRate(cached);
    for (const r of [inR, outR, cachedR]) {
      if (typeof r === 'string') {
        setError(r);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await api.costsSetPrice({
        modelId: modelId.trim(),
        inputPer1m: inR as number | null,
        outputPer1m: outR as number | null,
        cachedPer1m: cachedR as number | null,
      });
      onSaved(t('Price for {model} saved as manual.', { model: modelId.trim() }));
    } catch (err) {
      toast.push('bad', (err as Error).message);
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!price) return;
    setBusy(true);
    try {
      await api.costsResetPrice(price.modelId);
      onSaved(t('{model} handed back to the automatic sync.', { model: price.modelId }));
    } catch (err) {
      toast.push('bad', (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={price ? t('Edit price') : t('Add a price')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="price-model">
            {t('Model id')}
          </label>
          <input
            id="price-model"
            className="input"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={price !== null}
            placeholder="model-id"
          />
          <p className="mt-1 text-xs text-muted">
            {price ? 'The routed model id this row prices.' : 'The id as the pool routes it - a vendor prefix is matched loosely, by its tail.'}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="price-input">
              {t('Input $ / 1M')}
            </label>
            <input id="price-input" className="input" value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <div>
            <label className="label" htmlFor="price-output">
              {t('Output $ / 1M')}
            </label>
            <input id="price-output" className="input" value={output} onChange={(e) => setOutput(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <div>
            <label className="label" htmlFor="price-cached">
              {t('Cached $ / 1M')}
            </label>
            <input id="price-cached" className="input" value={cached} onChange={(e) => setCached(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </div>
        </div>
        <p className="text-xs text-muted">{t('Leave a rate empty when it is unknown - an empty field prices nothing, a zero claims the model is free.')}</p>
        {error && <ErrorNote message={error} />}
        <div className="flex items-center justify-between gap-3 pt-1">
          {price && price.source === 'manual' ? (
            <button className="text-xs text-muted transition-colors hover:text-fg" onClick={() => void reset()} disabled={busy}>
              {t('Reset to auto')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button className="btn" onClick={onClose} disabled={busy}>
              {t('Cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? t('Saving…') : t('Save price')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
