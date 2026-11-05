import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type Breakdown, type Overview, type Streak, type TimeseriesPoint } from '../lib/api';
import { Card, ErrorNote, Spinner, Stat, useToast } from '../components/ui';
import { StreakCard } from '../components/StreakCard';
import { formatMs, formatNumber, formatPercent, rangeLabel as rangeLabelFor, TIME_RANGES } from '../lib/format';
import { t } from '../lib/i18n';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { useInk } from '../lib/theme';

// Errors are ranked, not categorical - a rainbow here would imply a
// relationship between error kinds that does not exist. One ink, ranked by length.

export default function Stats() {
  const [range, setRange] = useState('24h');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [byModel, setByModel] = useState<Breakdown[]>([]);
  const [byUpstream, setByUpstream] = useState<Breakdown[]>([]);
  const [byKey, setByKey] = useState<Breakdown[]>([]);
  const [byError, setByError] = useState<Breakdown[]>([]);
  const [streak, setStreak] = useState<Streak | null>(null);
  const ink = useInk();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /*
   * Milestone tiers already announced, so the three-second poll cannot toast the
   * same badge repeatedly. The first load records what is already earned without
   * announcing it - a toast for a milestone reached while the page was closed
   * would be announcing something the operator already knows.
   */
  const announced = useRef<Set<number> | null>(null);

  // See the note on Overview. Recharts draws a line over 1500ms by default, and
  // a poll redraws the chart whether or not anything moved - which would put
  // three seconds of animation on the page every five, for as long as the
  // dashboard was left open. The draw belongs to the act of picking a window.
  const drawOnLoad = useRef(true);
  const [draw, setDraw] = useState(true);

  const load = useCallback(async () => {
    const shouldDraw = drawOnLoad.current;
    drawOnLoad.current = false;
    setDraw(shouldDraw);
    try {
      const [o, ts, m, u, k, e, s] = await Promise.all([
        api.overview(range),
        api.timeseries(range),
        api.byModel(range),
        api.byUpstream(range),
        api.byCredential(range),
        api.byError(range),
        // Streak comes along on the same poll rather than carrying its own
        // timer: this page already refreshes every three seconds, and a second
        // interval for one card is a second thing to clean up.
        api.streak(),
      ]);
      setOverview(o);
      setSeries(ts.points);
      setByModel(m);
      setByUpstream(u);
      setByKey(k);
      setByError(e);
      setStreak(s);
      setError(null);

      const top = s.earned[s.earned.length - 1];
      if (top) {
        if (announced.current === null) {
          // First load: adopt what is already earned, quietly.
          announced.current = new Set(s.earned.map((x) => x.days));
        } else if (!announced.current.has(top.days)) {
          announced.current.add(top.days);
          toast.push('ok', t('{label} — {days} days. {blurb}', { label: t(top.label), days: top.days, blurb: t(top.blurb) }));
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Only the first load blanks the page; a refresh leaves the current
      // range on screen so live numbers update in place.
      setLoading(false);
    }
  }, [range, toast]);

  useEffect(() => {
    drawOnLoad.current = true;
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  useAutoRefresh(load);

  const rangeLabel = rangeLabelFor(range);

  return (
    <div className="space-y-6">
      {/*
        The same masthead the Overview carries. It used to be a plainer heading
        with no rule under it, and a differently built window selector, so two
        adjacent pages introduced themselves differently and set the same control
        in two shapes.
      */}
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Stats')}</h1>
          <p className="mt-1.5 text-sm text-muted">{t('Every number is aggregated from the request log in SQL.')}</p>
        </div>
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
      </header>

      {error && <ErrorNote message={error} />}
      {loading && <Spinner label={t('Crunching…')} />}

      {!loading && overview && (
        <>
          {/* Vitals are one ruled band, the way they are on the Overview, rather
              than a scatter of unboxed figures in a grid with gaps between them.
              The same numbers, printed the same way, on the next page over. */}
          <div className="card overflow-hidden">
            <div className="grid grid-cols-2 lg:grid-cols-5">
              <Stat className="border-t border-line" label={t('Requests')} value={formatNumber(overview.requests)} />
              <Stat className="border-t border-line" label={t('Success')} value={formatPercent(overview.successRate)} tone={overview.successRate >= 0.99 ? 'ok' : 'warn'} />
              <Stat className="border-t border-line" label={t('Failed')} value={formatNumber(overview.failures)} tone={overview.failures ? 'bad' : 'default'} />
              <Stat className="border-t border-line" label={t('Avg latency')} value={formatMs(overview.avgLatencyMs)} hint={t('p95 {ms}', { ms: formatMs(overview.p95LatencyMs) })} />
              <Stat className="border-t border-line" label={t('Streamed')} value={formatNumber(overview.streamingRequests)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3">
              <Stat className="border-t border-line" label={t('Input tokens (in)')} value={formatNumber(overview.promptTokens)} hint={rangeLabel} />
              <Stat className="border-t border-line" label={t('Output tokens (out)')} value={formatNumber(overview.completionTokens)} hint={rangeLabel} />
              <Stat className="border-t border-line" label={t('Total tokens')} value={formatNumber(overview.totalTokens)} hint={t('in + out · {range}', { range: rangeLabel })} />
            </div>
          </div>

          {/*
            The streak sits above the range-scoped figures because it is the one
            thing on this page that is not scoped to the window. Reading it
            first means the rest of the page is context for it rather than the
            other way round.
          */}
          <StreakCard data={streak} />

          {/*
            The headline the range spent on, read before the tables: the most
            requested model and the upstream that served it. Both figures are the
            top row of the breakdowns this page already loads - the same SQL
            aggregate rendered twice would be two numbers waiting to disagree,
            so the section derives from the rows the tables below print.
          */}
          <Card
            title={t('Your top model and provider')}
            subtitle={t('Ranked by requests {scope}.', { scope: range === 'all' ? t('across everything still retained in the request log') : t('in {range}', { range: rangeLabel.toLowerCase() }) })}
          >
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <TopUsage label={t('Top model')} row={byModel[0]} totalRequests={overview.requests} />
              <TopUsage label={t('Top provider')} row={byUpstream[0]} totalRequests={overview.requests} />
            </div>
          </Card>

          <Card
            title={t('Token totals')}
            subtitle={
              range === 'all'
                ? t('Lifetime totals across everything still retained in the request log.')
                : t('Totals for {range}. Switch to All time for lifetime numbers.', { range: rangeLabel.toLowerCase() })
            }
          >
            <div className="grid grid-cols-3">
              {/*
                `In` was sky-400, a literal Tailwind colour, while its two
                neighbours used the ok and foreground inks. It was the one place
                on the page where the palette leaked, and it read as a different
                kind of figure from the two figures beside it.
              */}
              <div>
                <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('In')}</p>
                <p className="tnum mt-1 font-mono text-xl font-semibold text-accent">{formatNumber(overview.promptTokens)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Out')}</p>
                <p className="tnum mt-1 font-mono text-xl font-semibold text-ok">{formatNumber(overview.completionTokens)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Total')}</p>
                <p className="tnum mt-1 font-mono text-xl font-semibold text-fg">{formatNumber(overview.totalTokens)}</p>
              </div>
            </div>
          </Card>

          <Card title={t('Volume and latency')} subtitle={t('Requests per bucket, with average latency overlaid.')}>
            {series.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">{t('No traffic in this window.')}</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
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
                    <YAxis yAxisId="l" stroke={ink.line} fontSize={11} tickLine={false} tickFormatter={formatNumber} />
                    <YAxis yAxisId="r" orientation="right" stroke={ink.line} fontSize={11} tickLine={false} tickFormatter={formatMs} />
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
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line yAxisId="l" type="monotone" dataKey="requests" stroke={ink.accent} strokeWidth={2} dot={false} name={t('requests')} animationDuration={420} isAnimationActive={draw} />
                    <Line yAxisId="l" type="monotone" dataKey="failures" stroke={ink.bad} strokeWidth={2} dot={false} name={t('failures')} animationDuration={420} isAnimationActive={draw} />
                    <Line
                      yAxisId="r"
                      type="monotone"
                      dataKey="avgLatencyMs"
                      stroke={ink.ok}
                      strokeWidth={2}
                      dot={false}
                      name={t('avg latency (ms)')}
                      animationDuration={420}
                      isAnimationActive={draw}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title={t('Token flow')} subtitle={t('Prompt vs completion tokens per bucket.')}>
            {series.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">{t('No tokens recorded in this window.')}</p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke={ink.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(v: number) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })}
                      stroke={ink.line}
                      fontSize={11}
                      tickLine={false}
                      padding="gap"
                    />
                    <YAxis stroke={ink.line} fontSize={11} tickLine={false} tickFormatter={formatNumber} />
                    <Tooltip
                      cursor={{ fill: ink.inset }}
                      contentStyle={{
                        background: ink.surface,
                        border: `1px solid ${ink.line}`,
                        borderRadius: 8,
                        fontSize: 12,
                        color: ink.fg,
                      }}
                      labelStyle={{ color: ink.muted }}
                      labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="promptTokens" stackId="t" fill={ink.accent} name={t('prompt')} maxBarSize={48} animationDuration={420} isAnimationActive={draw} />
                    <Bar dataKey="completionTokens" stackId="t" fill={ink.ok} name={t('completion')} maxBarSize={48} animationDuration={420} isAnimationActive={draw} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownTable title={t('By model')} rows={byModel} />
            <BreakdownTable title={t('By upstream')} rows={byUpstream} />
            <BreakdownTable title={t('By key')} rows={byKey} />
            <Card title={t('Errors by kind')} subtitle={t('What actually went wrong.')}>
              {byError.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">{t('No failures in this window. 🎉')}</p>
              ) : (
                <>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byError} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                        <CartesianGrid stroke={ink.line} strokeDasharray="3 3" horizontal={false} />
                        <XAxis type="number" stroke={ink.line} fontSize={11} tickLine={false} />
                        <YAxis type="category" dataKey="label" stroke={ink.line} fontSize={11} tickLine={false} width={110} />
                        <Tooltip
                          cursor={{ fill: ink.inset }}
                          contentStyle={{
                        background: ink.surface,
                        border: `1px solid ${ink.line}`,
                        borderRadius: 8,
                        fontSize: 12,
                        color: ink.fg,
                      }}
                      labelStyle={{ color: ink.muted }}
                        />
                        <Bar dataKey="requests" radius={[0, 4, 4, 0]} fill={ink.bad} animationDuration={420} isAnimationActive={draw} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-3 space-y-1">
                    {byError.map((row) => (
                      <li key={row.label} className="flex justify-between text-xs">
                        <span className="font-mono text-subtle">{row.label}</span>
                        <span className="font-mono text-muted">{row.requests}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/*
 * One half of the "Your top model and provider" card: the name the range spent
 * on, with the tokens it used beneath it. `row` is the top of a breakdown the
 * page already holds - requests rank it, tokens are what it cost.
 */
function TopUsage({ label, row, totalRequests }: { label: string; row: Breakdown | undefined; totalRequests: number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</p>
      {row ? (
        <>
          <p className="mt-1.5 truncate font-mono text-xl font-semibold text-fg">{row.label}</p>
          <p className="mt-1.5 text-sm text-muted">
            <span className="tnum font-mono font-semibold text-fg">{formatNumber(row.totalTokens)}</span> {t('tokens')} ·{' '}
            <span className="tnum font-mono">{formatNumber(row.requests)}</span> {t('requests')}
            {totalRequests > 0 && <> · {formatPercent(row.requests / totalRequests)} {t('of traffic')}</>}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">{t('No traffic in this window.')}</p>
      )}
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('No data in this window.')}</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-line">
              <th className="th">{t('Label')}</th>
              <th className="th text-right">{t('Requests')}</th>
              <th className="th text-right">{t('Errors')}</th>
              <th className="th text-right">{t('Avg latency')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.slice(0, 12).map((row) => (
              <tr key={row.label} className="row-hover">
                <td className="td max-w-[200px] truncate font-mono text-xs">{row.label}</td>
                <td className="td tnum text-right font-mono">{formatNumber(row.requests)}</td>
                <td className="td tnum text-right font-mono text-bad">{row.failures}</td>
                <td className="td tnum text-right font-mono text-subtle">{formatMs(row.avgLatencyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
