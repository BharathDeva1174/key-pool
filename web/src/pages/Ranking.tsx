import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type RankingResponse, type RoleName } from '../lib/api';
import { Card, Empty, ErrorNote, Spinner } from '../components/ui';
import { formatNumber, formatPercent, formatPricePer1m, TIME_RANGES } from '../lib/format';
import { t } from '../lib/i18n';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { useInk } from '../lib/theme';

/**
 * The intelligent ranking.
 *
 * One job: answer "which model should do which part of the work" from the
 * models this pool actually serves. The list comes from the pool's model ids
 * (the Models page's grouping), never from spoof names - those are client
 * aliases, not models.
 *
 * Everything here is derived from three axes the server scores and returns
 * with its weights attached: intelligence (a curated prior per family),
 * reliability (success rate blended with key health) and efficiency (price and
 * latency on log scales). The page explains the method rather than asserting
 * the scores, because an unexplained "87" is decoration.
 */

const TIERS = ['S', 'A', 'B', 'C'] as const;
const TIER_CLASS: Record<(typeof TIERS)[number], string> = {
  S: 'bg-accent/15 text-accent border-accent/40',
  A: 'bg-ok/15 text-ok border-ok/40',
  B: 'bg-warn/15 text-warn border-warn/40',
  C: 'bg-bad/15 text-bad border-bad/40',
};

const short = (id: string) => (id.length > 26 ? id.slice(0, 25) + '…' : id);

/** The bare model name after the vendor prefix - axis labels have little room. */
const bare = (id: string) => {
  const tail = id.slice(id.lastIndexOf('/') + 1);
  return tail.length > 20 ? tail.slice(0, 19) + '…' : tail;
};

export default function Ranking() {
  const [range, setRange] = useState('24h');
  const [data, setData] = useState<RankingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ink = useInk();
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.ranking(range);
      setData(res);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (firstLoad.current) {
        firstLoad.current = false;
        setLoading(false);
      }
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(load);

  const models = data?.models ?? [];
  const roles = data?.roles ?? [];
  const byId = new Map(models.map((m) => [m.modelId, m]));

  // Built per render so the copy follows the language selector; the literals
  // stay visible to the i18n coverage scan because they are t() call sites.
  const roleCopy: Record<RoleName, { title: string; advice: string; hint: string }> = {
    plan: {
      title: t('Plan'),
      advice: t('Architecture, task breakdown and design reviews. Reasoning depth first - a wrong plan is the most expensive thing to unwind.'),
      hint: t('Weighted: intelligence 70%, reliability 20%, efficiency 10%.'),
    },
    build: {
      title: t('Build'),
      advice: t('Implementation and refactors. The balance point: capable enough to hold the context, reliable enough to finish.'),
      hint: t('Weighted: intelligence 45%, reliability 35%, efficiency 20%.'),
    },
    test: {
      title: t('Test'),
      advice: t('Running tests, reading failures and writing regression coverage. Trust the keys that keep answering.'),
      hint: t('Weighted: reliability 55%, intelligence 25%, efficiency 20%.'),
    },
    review: {
      title: t('Review'),
      advice: t('Code review and diff feedback. Reasoning depth, with enough uptime to review when you do.'),
      hint: t('Weighted: intelligence 55%, reliability 30%, efficiency 15%.'),
    },
    docs: {
      title: t('Docs'),
      advice: t('READMEs, changelogs and commit messages. The cheapest model that still reads like it understood the code.'),
      hint: t('Weighted: efficiency 50%, intelligence 35%, reliability 15%.'),
    },
    agent: {
      title: t('Long agent runs'),
      advice: t('Long autonomous runs and subagents. Cheapest usable tokens, because the work is mostly looping.'),
      hint: t('Weighted: efficiency 45%, reliability 35%, intelligence 20%.'),
    },
  };

  // Chart data, capped so a 200-model pool still reads on one screen.
  const top = models.slice(0, 10);
  const compositeData = top.map((m) => ({ name: short(m.modelId), score: m.composite, tier: m.tier }));
  const axisData = models.slice(0, 6).map((m) => ({
    name: bare(m.modelId),
    [t('Intelligence')]: m.intelligence,
    [t('Reliability')]: m.reliability,
    [t('Efficiency')]: m.efficiency,
  }));
  const tierData = TIERS.map((tier) => ({ name: t('Tier {tier}', { tier }), value: data?.tiers[tier] ?? 0, tier })).filter(
    (d) => d.value > 0,
  );
  const tierColor = { S: ink.accent, A: ink.ok, B: ink.warn, C: ink.bad } as Record<string, string>;
  const roleOwnership = new Map<string, number>();
  for (const pick of roles) roleOwnership.set(pick.modelId, (roleOwnership.get(pick.modelId) ?? 0) + 1);
  const ownershipData = [...roleOwnership.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([modelId, count]) => ({ name: short(modelId), value: count }));
  const ownerColors = [ink.accent, ink.ok, ink.warn, ink.bad, ink.muted, ink.subtle, ink.faint];

  if (loading) return <Spinner label={t('Scoring models…')} />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Intelligent ranking')}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {t('Every pooled model, scored on intelligence, reliability and efficiency - with the model to use for each step of a coding agent’s work.')}
          </p>
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

      {models.length === 0 ? (
        <Card>
          <Empty title={t('No pooled models to rank yet')} hint={t('Add a model on the Models page and it will appear here with a score.')} />
        </Card>
      ) : (
        <>
          {/* The playbook. Advice before charts: the operator came to know what to run, not to read a dashboard. */}
          <Card
            title={t('Which model for which step')}
            subtitle={t('The best fit per role from the models this pool serves, and the fallback when it is down.')}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {roles.map((pick) => {
                const role = pick.role;
                const winner = byId.get(pick.modelId);
                return (
                  <div key={role} className="rounded-[var(--radius-control)] border border-line bg-canvas/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{roleCopy[role].title}</p>
                      {winner && (
                        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${TIER_CLASS[winner.tier]}`}>
                          {pick.score}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 truncate font-mono text-sm text-fg" title={winner?.modelId}>
                      {winner?.modelId ?? '—'}
                    </p>
                    <p className="mt-0.5 text-xs text-subtle">
                      {winner ? `${winner.family} · ${t('{n} intelligence', { n: winner.intelligence })}` : ''}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">{roleCopy[role].advice}</p>
                    <p className="mt-1.5 text-[10px] text-faint">{roleCopy[role].hint}</p>
                    {pick.runnerUpId && (
                      <p className="mt-1 truncate text-[10px] text-faint" title={pick.runnerUpId}>
                        {t('Fallback: {model}', { model: pick.runnerUpId })}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('Composite score')} subtitle={t('Intelligence 50% · reliability 30% · efficiency 20%. Top 10 shown.')}>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={compositeData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid stroke={ink.line} strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} stroke={ink.line} tick={{ fill: ink.muted, fontSize: 11 }} tickLine={false} />
                    <YAxis type="category" dataKey="name" stroke={ink.line} tick={{ fill: ink.subtle, fontSize: 11 }} tickLine={false} width={180} />
                    <Tooltip
                      cursor={{ fill: ink.inset }}
                      contentStyle={{ background: ink.surface, border: `1px solid ${ink.line}`, borderRadius: 8, fontSize: 12, color: ink.fg }}
                      labelStyle={{ color: ink.muted }}
                    />
                    <Bar dataKey="score" name={t('Composite')} radius={[0, 4, 4, 0]}>
                      {compositeData.map((d) => (
                        <Cell key={d.name} fill={tierColor[d.tier]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title={t('Tier mix')} subtitle={t('How the pool spreads across the tiers.')}>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={tierData} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="75%" paddingAngle={2}>
                      {tierData.map((d) => (
                        <Cell key={d.tier} fill={tierColor[d.tier]} stroke={ink.surface} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: ink.surface, border: `1px solid ${ink.line}`, borderRadius: 8, fontSize: 12, color: ink.fg }}
                      labelStyle={{ color: ink.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: ink.muted }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title={t('The three axes')} subtitle={t('Capability mix for the top 6 models, each axis scored 0-100.')}>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={axisData} margin={{ top: 4, right: 8, left: -18, bottom: 20 }}>
                    <CartesianGrid stroke={ink.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" stroke={ink.line} tick={{ fill: ink.subtle, fontSize: 10 }} tickLine={false} interval={0} angle={-20} textAnchor="end" height={64} />
                    <YAxis domain={[0, 100]} stroke={ink.line} tick={{ fill: ink.muted, fontSize: 11 }} tickLine={false} />
                    <Tooltip
                      cursor={{ fill: ink.inset }}
                      contentStyle={{ background: ink.surface, border: `1px solid ${ink.line}`, borderRadius: 8, fontSize: 12, color: ink.fg }}
                      labelStyle={{ color: ink.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: ink.muted }} />
                    <Bar dataKey={t('Intelligence')} fill={ink.accent} radius={[3, 3, 0, 0]} />
                    <Bar dataKey={t('Reliability')} fill={ink.ok} radius={[3, 3, 0, 0]} />
                    <Bar dataKey={t('Efficiency')} fill={ink.warn} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title={t('Who owns each step')} subtitle={t('How many of the six roles each model wins - the workhorse, at a glance.')}>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={ownershipData} dataKey="value" nameKey="name" innerRadius="40%" outerRadius="72%" paddingAngle={2}>
                      {ownershipData.map((d, i) => (
                        <Cell key={d.name} fill={ownerColors[i % ownerColors.length]} stroke={ink.surface} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: ink.surface, border: `1px solid ${ink.line}`, borderRadius: 8, fontSize: 12, color: ink.fg }}
                      labelStyle={{ color: ink.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: ink.muted }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card title={t('Full ranking')} subtitle={t('Ordered by composite score. Bars compare each axis within its own 0-100 scale.')}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className="th w-10">#</th>
                    <th className="th">{t('Model')}</th>
                    <th className="th w-36">{t('Intelligence')}</th>
                    <th className="th w-36">{t('Reliability')}</th>
                    <th className="th w-36">{t('Efficiency')}</th>
                    <th className="th w-16 text-right">{t('Score')}</th>
                    <th className="th w-14 text-center">{t('Tier')}</th>
                    <th className="th text-right">{t('Keys')}</th>
                    <th className="th text-right">{t('Price / 1M')}</th>
                    <th className="th text-right">{t('Requests')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {models.map((m, i) => (
                    <tr key={m.modelId} className="row-hover">
                      <td className="td tnum text-xs text-faint">{i + 1}</td>
                      <td className="td">
                        <p className="max-w-[280px] truncate font-mono text-xs text-fg" title={m.modelId}>{m.modelId}</p>
                        <p className="text-[10px] text-muted">
                          {m.family}
                          {m.measured === 'untested' && <span className="text-faint"> · {t('untested')}</span>}
                          {!m.priced && <span className="text-faint"> · {t('unpriced')}</span>}
                        </p>
                      </td>
                      <td className="td"><ScoreBar value={m.intelligence} /></td>
                      <td className="td"><ScoreBar value={m.reliability} /></td>
                      <td className="td"><ScoreBar value={m.efficiency} /></td>
                      <td className="td tnum text-right font-mono text-sm text-fg">{m.composite}</td>
                      <td className="td text-center">
                        <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${TIER_CLASS[m.tier]}`}>
                          {m.tier}
                        </span>
                      </td>
                      <td className="td tnum text-right font-mono text-xs text-subtle">
                        {m.healthyKeys}/{m.totalKeys}
                      </td>
                      <td className="td tnum text-right font-mono text-xs text-subtle">
                        {m.free ? t('Free') : m.blendedPricePer1m === null ? '—' : `$${formatPricePer1m(m.blendedPricePer1m)}`}
                      </td>
                      <td className="td tnum text-right font-mono text-xs text-muted">
                        {formatNumber(m.requests)}
                        {m.successRate !== null && (
                          <span className="ml-1 text-[10px] text-faint">{formatPercent(m.successRate)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={t('How the score is built')} subtitle={t('So the number can be argued with, not just trusted.')}>
            <ul className="space-y-2 text-sm text-subtle">
              <li>
                <strong className="font-medium text-fg">{t('Intelligence')}</strong> —{' '}
                {t('a curated prior per model family (public benchmarks and known capability), not a benchmark run here. Unknown families start neutral rather than high.')}
              </li>
              <li>
                <strong className="font-medium text-fg">{t('Reliability')}</strong> —{' '}
                {t('this pool’s success rate in the selected window, blended with the health of the keys behind the model. A model with no traffic is scored on health alone and marked untested.')}
              </li>
              <li>
                <strong className="font-medium text-fg">{t('Efficiency')}</strong> —{' '}
                {t('blended price per million tokens and observed latency, both on log scales. Free models and fast models rise; a model with no price is scored neutrally and marked unpriced.')}
              </li>
              <li>
                <strong className="font-medium text-fg">{t('Composite')}</strong> —{' '}
                {t('intelligence 50%, reliability 30%, efficiency 20%. Tiers: S ≥ 85, A ≥ 75, B ≥ 65, C below.')}
              </li>
              <li className="text-xs text-muted">
                {t('Scores move with traffic; the playbook uses role-specific weights rather than the composite.')}
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function ScoreBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full max-w-[110px] overflow-hidden rounded-full bg-line/60">
        <div
          className={`h-full rounded-full ${value >= 85 ? 'bg-accent' : value >= 70 ? 'bg-ok' : value >= 50 ? 'bg-warn' : 'bg-bad'}`}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      </div>
      <span className="tnum w-6 text-right font-mono text-[10px] text-subtle">{value}</span>
    </div>
  );
}
