import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Breakdown, type Overview as OverviewData, type PoolSnapshot, type TimeseriesPoint } from '../lib/api';
import { Card, ErrorNote, Spinner, Stat, StatusBadge } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatMs, formatNumber, formatPercent, formatRelative, entryHealthLevel, maskKey, rangeLabel as rangeLabelFor, TIME_RANGES } from '../lib/format';
import { groupEntriesByModel } from '../lib/models';
import { t } from '../lib/i18n';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { useInk } from '../lib/theme';

export default function Overview() {
  const [range, setRange] = useState('24h');
  const [pool, setPool] = useState<PoolSnapshot | null>(null);
  const [stats, setStats] = useState<OverviewData | null>(null);
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [byModel, setByModel] = useState<Breakdown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ink = useInk();

  // The trace is worth watching exactly once per deliberate act: on the first
  // load, and when the operator picks a different window. A poll redraws the
  // chart whether or not a single sample moved, so an unattended wall display
  // would rehearse the same 420ms draw every few seconds, forever - which is
  // the opposite of an instrument that is still when nothing is happening.
  const drawOnLoad = useRef(true);
  const [draw, setDraw] = useState(true);

  const load = useCallback(async () => {
    const shouldDraw = drawOnLoad.current;
    drawOnLoad.current = false;
    setDraw(shouldDraw);
    setError(null);
    try {
      const [p, s, ts, m] = await Promise.all([
        api.pool(),
        api.overview(range),
        api.timeseries(range),
        api.byModel(range),
      ]);
      setPool(p);
      setStats(s);
      setSeries(ts.points);
      setByModel(m);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  // Runs before the load effect below, so the very first fetch - and every
  // fetch the operator caused by changing the window - is flagged as worth
  // animating.
  useEffect(() => {
    drawOnLoad.current = true;
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keeps the dashboard current while it sits open, on the same cadence as Stats.
  useAutoRefresh(load);

  if (loading) return <Spinner label={t('Loading pool…')} />;
  if (error) return <ErrorNote message={error} />;

  const summary = pool?.summary;
  const clientSnippet = `${window.location.origin}/v1`;
  const rangeLabel = rangeLabelFor(range).toLowerCase();

  /*
    One number per distinct model id, not per entry.
    `summary.entries` counts the (base URL, key, model) triples the router works
    with, so a model served by 139 keys reported 139 pooled models. Grouped the
    same way the Models page groups them, the two surfaces cannot disagree, and
    the count matches what a client can actually ask for.
  */
  const pooledModels = groupEntriesByModel(pool?.entries ?? []).length;

  /*
    Plural per segment, not a stitched `s`: which words inflect is a property
    of the language, not of the number.
  */
  const keys = summary?.credentials ?? 0;
  const masthead =
    pooledModels === 1
      ? keys === 1
        ? t('{pooled} pooled model across {keys} key', { pooled: pooledModels, keys })
        : t('{pooled} pooled model across {keys} keys', { pooled: pooledModels, keys })
      : keys === 1
        ? t('{pooled} pooled models across {keys} key', { pooled: pooledModels, keys })
        : t('{pooled} pooled models across {keys} keys', { pooled: pooledModels, keys });

  // One hairline above every figure, the way a data sheet rules its columns.
  // At two-up on a phone the same rule separates figure rows, so the band
  // still reads as a ruled register rather than a stack of cards.
  const rule = 'border-t border-line';

  return (
    <div className="space-y-6">
      {/*
        The masthead. A datasheet names the sheet, states the window it covers
        and carries the two controls that change it, ruled off from the register
        below - so the title has to carry the page on its own, and the controls
        sit on the same baseline as the figures they will change.
      */}
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Overview')}</h1>
          <p className="tnum mt-1.5 text-sm text-muted">
            {masthead} · {rangeLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The window selector is the same object as the theme control one
              page over: an inset track with a single papered chip standing on
              the active position. Two controls that pick one thing out of a set
              should not be built two different ways. */}
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
                {t(r.label)}
              </button>
            ))}
          </div>
          <Link to="/upstreams" className="btn-primary">
            {/* The drawn plus rather than a typed one: a `+` in the text is a
                character the OS sets, and it sits on the baseline like one. */}
            <Icon name="plus" size={14} />
            {t('Add upstream')}
          </Link>
        </div>
      </header>

      {/* Vitals and throughput are one ruled band each, not eight equal cards.
          Equal cards make every number the same size, which is the same as
          making every number the same importance. */}
      <div className="card overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <Stat className={rule} label={t('Requests')} value={formatNumber(stats?.requests)} hint={rangeLabel} />
          <Stat
            className={rule}
            label={t('Success rate')}
            value={formatPercent(stats?.successRate)}
            tone={!stats ? 'default' : stats.successRate >= 0.99 ? 'ok' : stats.successRate >= 0.9 ? 'warn' : 'bad'}
            hint={t('{n} failed', { n: stats?.failures ?? 0 })}
          />
          <Stat
            className={rule}
            label={t('Avg latency')}
            value={formatMs(stats?.avgLatencyMs)}
            hint={t('p95 {ms}', { ms: formatMs(stats?.p95LatencyMs) })}
          />
          <Stat className={rule} label={t('Streamed')} value={formatNumber(stats?.streamingRequests)} hint={t('responses')} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3">
          <Stat
            className={rule}
            label={t('Input tokens (in)')}
            value={formatNumber(stats?.promptTokens)}
            hint={t('sent upstream · {range}', { range: rangeLabel })}
          />
          <Stat
            className={rule}
            label={t('Output tokens (out)')}
            value={formatNumber(stats?.completionTokens)}
            hint={t('generated · {range}', { range: rangeLabel })}
          />
          <Stat
            className={rule}
            label={t('Total tokens')}
            value={formatNumber(stats?.totalTokens)}
            hint={t('in + out · {range}', { range: rangeLabel })}
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <Stat className={rule} label={t('Healthy')} value={summary?.healthy ?? 0} tone="ok" />
          <Stat
            className={rule}
            label={t('Cooling (429)')}
            value={summary?.cooling ?? 0}
            tone={summary?.cooling ? 'warn' : 'default'}
          />
          <Stat
            className={rule}
            label={t('Breaker open')}
            value={summary?.breakerOpen ?? 0}
            tone={summary?.breakerOpen ? 'bad' : 'default'}
          />
          <Stat
            className={rule}
            label={t('Auth errors')}
            value={summary?.authErrors ?? 0}
            tone={summary?.authErrors ? 'bad' : 'default'}
          />
        </div>
      </div>

      <Card
        title={t('Requests over time')}
        subtitle={t('Healthy traffic above, failures below · {range}.', { range: rangeLabel })}
        actions={
          <div className="flex items-center gap-3 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: ink.ok }} /> {t('requests')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: ink.bad }} /> {t('failures')}
            </span>
          </div>
        }
      >
        {series.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t('No traffic yet. Point a client at the pool to see it here.')}</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gOk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ink.ok} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={ink.ok} stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="gBad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ink.bad} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={ink.bad} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={ink.line} strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v: number) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  stroke={ink.line}
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis stroke={ink.line} fontSize={11} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
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
                  labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                />
                {/* The trace is drawn, briefly, when new samples land for a
                    window the operator chose - the one place on the page where
                    motion is the content. See `draw` above for why an automatic
                    refresh does not count as a reason to redraw.

                    `dot` is load-bearing, not decoration: a quiet pool can put
                    every request of the day in a single bucket, and a one-point
                    line has no path to draw, so the figure would read as broken.
                    A mark at each sample is what a pen would have left anyway. */}
                <Area
                  type="monotone"
                  dataKey="requests"
                  stroke={ink.ok}
                  fill="url(#gOk)"
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: ink.ok, strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                  name={t('requests')}
                  animationDuration={420}
                  isAnimationActive={draw}
                />
                <Area
                  type="monotone"
                  dataKey="failures"
                  stroke={ink.bad}
                  fill="url(#gBad)"
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: ink.bad, strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                  name={t('failures')}
                  animationDuration={420}
                  isAnimationActive={draw}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* items-start: these two panels hold different amounts of data, and
          letting the shorter one stretch leaves a large empty ruled box that
          reads as something failed to load. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card
          title={t('Pool health')}
          subtitle={t('Every (base URL, key, model) triple and its last known state.')}
          actions={
            <Link to="/models" className="btn-ghost">
              {t('Manage')}
            </Link>
          }
        >
          {(pool?.entries.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              {t('Nothing configured yet. Add a base URL, API key and model id to get started.')}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {pool?.entries.slice(0, 12).map((row) => {
                const level = entryHealthLevel(row);
                return (
                  <li key={row.entry.id} className="flex items-center gap-3 py-2.5">
                    <StatusBadge level={level} />
                    <div className="min-w-0 flex-1">
                      <p className="tnum truncate font-mono text-sm text-fg">{row.entry.modelId}</p>
                      <p className="truncate text-xs text-muted">
                        {row.endpointName} · {maskKey(row.keyHint)}
                      </p>
                    </div>
                    <p className="tnum shrink-0 text-right text-[11px] text-faint">
                      {formatRelative(row.entry.lastPingAt)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={t('Traffic by model')} subtitle={t('Selected window: {range}.', { range: rangeLabel })}>
          {byModel.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t('No requests in this window.')}</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">{t('Model')}</th>
                  <th className="th text-right">{t('Requests')}</th>
                  <th className="th text-right">{t('Errors')}</th>
                  <th className="th text-right">{t('Tokens')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byModel.map((row) => (
                  <tr key={row.label} className="row-hover">
                    <td className="td max-w-[220px] truncate font-mono">{row.label}</td>
                    <td className="td tnum text-right font-mono">{formatNumber(row.requests)}</td>
                    <td className="td tnum text-right font-mono text-bad">{row.failures}</td>
                    <td className="td tnum text-right font-mono">{formatNumber(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title={t('Point your client here')} subtitle={t('This is the only configuration a client needs.')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="label">{t('Base URL')}</p>
            <code className="tnum block rounded-[var(--radius-control)] border border-line bg-inset px-3 py-2 font-mono text-sm text-accent">
              {clientSnippet}
            </code>
          </div>
          <div>
            <p className="label">{t('API key')}</p>
            <code className="tnum block rounded-[var(--radius-control)] border border-line bg-inset px-3 py-2 font-mono text-sm text-muted">
              {t('sk-keypool-…')}
            </code>
            <p className="mt-1 text-xs text-muted">{t('Printed once on first run — find or rotate it in Settings.')}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
