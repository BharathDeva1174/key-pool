import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Card } from './ui';
import { formatNumber } from '../lib/format';
import { t } from '../lib/i18n';
import type { Streak as StreakData } from '../lib/api';

/**
 * The streak, as a panel on the Stats page.
 *
 * It lives here rather than in the margin because it is a statistic, and the
 * Stats page is where statistics are read. It was in the sidebar first, which
 * put it in front of the operator all day and meant the element had to earn a
 * fixed height to keep the nav's travelling bar honest - a cost the page layout
 * does not have.
 *
 * Two things it deliberately does not do: it is not affected by the window
 * selector above, because a streak is a measure over days and not over the
 * selected range, and the subtitle says so rather than leaving the operator to
 * discover it by switching to "Last hour" and watching the number not move.
 */

const HEAT_CELL = 10;
const HEAT_WEEKS = 12;

/** Five inks from empty to busy. Volume buckets, so a quiet week is not a wash. */
const HEAT = ['bg-line/70', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent'] as const;

/** The flame grows with the run, so the shape carries the number too. */
function flameSize(days: number): number {
  if (days >= 100) return 28;
  if (days >= 30) return 24;
  if (days >= 7) return 20;
  return 18;
}

export function StreakCard({ data }: { data: StreakData | null }) {
  const days = data?.current ?? 0;
  const best = data?.best ?? 0;
  const atRecord = days > 0 && days >= best;
  const earned = data?.earned ?? [];
  const next = data?.tier ?? null;

  return (
    <Card
      title={t('Streak')}
      subtitle={
        data?.truncated
          ? t('Consecutive days with recorded traffic. At least {days} — the log only holds {retention} days, so this is a floor, not an exact count.', { days, retention: data.retentionDays })
          : t('Consecutive days with recorded traffic. Not affected by the window above.')
      }
    >
      <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
        {/* The figure. Accent while the run is alive, foreground at zero, so
            the colour reports the state rather than decorating the panel. */}
        <div className="flex items-baseline gap-2.5">
          <Icon name="flame" size={flameSize(days)} className={days > 0 ? 'text-accent' : 'text-faint'} />
          <div>
            <SettlingFigure value={data ? (data.truncated ? `${days}+` : days) : null} alive={days > 0} />
            <p className="text-[11px] text-muted">{days === 1 ? t('day') : t('days')}</p>
          </div>
        </div>

        {/* Effort beyond the run: the number that survives a broken streak, and
            the goal that survives it. */}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Personal best')}</p>
          <p className="tnum mt-1 font-mono text-xl leading-none font-semibold text-fg">
            {data ? formatNumber(best) : '—'}
          </p>
          <p className="mt-1.5 text-xs text-muted">
            {data ? t("{requests} requests · {activeDays} active days", { requests: formatNumber(data.totalRequests), activeDays: data.totalActiveDays }) : " "}
          </p>
        </div>

        {/* The goal gradient: distance to the next milestone, which is the part
            that pulls. Shown even at zero, so a broken run is a number to beat
            rather than a reason to stop opening the page. */}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Next milestone')}</p>
          <p className="mt-1 text-sm text-fg">
            {next ? (
              <>
                <span className="tnum font-mono text-xl leading-none font-semibold text-accent">
                  {next.days - days}
                </span>
                <span className="ml-1.5 text-muted">{t('to {tier}', { tier: t(next.label).toLowerCase() })}</span>
              </>
            ) : (
              <span className="text-muted">{t('every milestone reached')}</span>
            )}
          </p>
          {atRecord && days > 0 && <p className="mt-1.5 text-xs text-accent">{t('At your best.')}</p>}
        </div>

        {/* Two weeks, newest last. Today is a ring rather than a fill so "not
            yet" never reads as "missed". */}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Last 14 days')}</p>
          <div className="mt-2 flex gap-1" role="img" aria-label={t('Active on {days} of the last 14 days', { days })}>
            {data?.days.map((d) => (
              <span
                key={d.day}
                title={d.requests === 1 ? t('{day} · {n} request', { day: d.day, n: d.requests }) : t('{day} · {n} requests', { day: d.day, n: d.requests })}
                className={[
                  'h-3 w-3 rounded-full',
                  d.active ? 'bg-accent' : 'bg-line-strong/30',
                  d.isToday ? 'ring-1 ring-accent ring-offset-1 ring-offset-surface' : '',
                ].join(' ')}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-2">
        {/*
          Twelve weeks as a calendar, weeks running across and days down -
          the GitHub orientation, because a habit has a shape in time and this
          is the one that makes it visible. Seven rows, so the server's
          week-by-week ordering is transposed here rather than reshaped there.
        */}
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Last 12 weeks')}</p>
          <div
            className="mt-2 grid gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${HEAT_WEEKS}, ${HEAT_CELL}px)` }}
            role="img"
            aria-label={t('Daily activity over the last twelve weeks')}
          >
            {transposeWeeks(data?.heatmap ?? []).map((cell) => (
              <span
                key={cell.day}
                title={cell.requests === 1 ? t('{day} · {n} request', { day: cell.day, n: cell.requests }) : t('{day} · {n} requests', { day: cell.day, n: cell.requests })}
                style={{ width: HEAT_CELL, height: HEAT_CELL }}
                className={`rounded-[2px] ${HEAT[cell.level]}`}
              />
            ))}
          </div>
        </div>

        {/* Earned badges are never revoked. A badge that vanishes the moment a
            day is missed is a punishment wearing a reward's clothes. */}
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('Milestones')}</p>
          {earned.length === 0 && next && (
            <p className="mt-2 text-sm text-muted">
              {t('None yet — {n} more {unit} to the first.', { n: next.days - days, unit: next.days - days === 1 ? t('day') : t('days') })}
            </p>
          )}
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {allTiers(data).map((tier) => {
              const has = earned.some((e) => e.days === tier.days);
              return (
                <li
                  key={tier.days}
                  title={has ? t(tier.blurb) : t('{days} days — {blurb}', { days: tier.days, blurb: t(tier.blurb) })}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border px-2 py-1 text-xs',
                    has
                      ? 'border-accent/45 text-accent'
                      : 'border-line text-faint',
                  ].join(' ')}
                >
                  {has ? <Icon name="check" size={11} /> : <span className="tnum font-mono text-[10px]">{tier.days}</span>}
                  {t(tier.label)}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** The server sends weeks in order, seven days each; lay them out as rows. */
function transposeWeeks(heatmap: Array<{ day: string; requests: number; level: 0 | 1 | 2 | 3 | 4 }>) {
  const rows: Array<{ day: string; requests: number; level: 0 | 1 | 2 | 3 | 4 }> = [];
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    for (let week = 0; week * 7 + dayOfWeek < heatmap.length; week++) {
      const cell = heatmap[week * 7 + dayOfWeek];
      if (cell) rows.push(cell);
    }
  }
  return rows;
}

/** Every tier, so locked ones are visible as a goal rather than absent. */
function allTiers(data: StreakData | null): Array<{ days: number; label: string; blurb: string }> {
  const known = data?.earned ?? [];
  const next = data?.tier ?? null;
  const out = [...known];
  if (next && !out.some((t) => t.days === next.days)) out.push(next);
  return out;
}

/**
 * The figure, settling into place when it genuinely changes.
 *
 * The margin had to carry its own copy of this because `Stat` is page furniture
 * with a caption under it; here the layout is bespoke, so the behaviour is
 * reproduced rather than the component bent. Same rule as everywhere else: the
 * animation fires on a real change and never while idle.
 */
function SettlingFigure({ value, alive }: { value: number | string | null; alive: boolean }) {
  const [tick, setTick] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value) {
      previous.current = value;
      setTick((t) => t + 1);
    }
  }, [value]);

  if (value === null) {
    return <p className="tnum font-mono text-3xl leading-none font-semibold text-faint">—</p>;
  }
  return (
    <p
      key={tick}
      className={`readout tnum relative font-mono text-3xl leading-none font-semibold ${alive ? 'text-accent' : 'text-fg'}`}
    >
      {value}
    </p>
  );
}
