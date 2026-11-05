/** Display helpers shared across the dashboard. */
import { t } from './i18n';

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(ratio >= 0.999 || ratio === 0 ? 0 : 1)}%`;
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return t('never');
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  // Literal keys only - the i18n coverage test reads them off the source, and
  // a composed key would hide half of them from it.
  if (abs < 5_000) return t('just now');
  const n = (divisor: number) => Math.round(abs / divisor);
  if (diff >= 0) {
    if (abs < 60_000) return t('{n}s ago', { n: n(1000) });
    if (abs < 3_600_000) return t('{n}m ago', { n: n(60_000) });
    if (abs < 86_400_000) return t('{n}h ago', { n: n(3_600_000) });
    return t('{n}d ago', { n: n(86_400_000) });
  }
  if (abs < 60_000) return t('{n}s from now', { n: n(1000) });
  if (abs < 3_600_000) return t('{n}m from now', { n: n(60_000) });
  if (abs < 86_400_000) return t('{n}h from now', { n: n(3_600_000) });
  return t('{n}d from now', { n: n(86_400_000) });
}

export function maskKey(hint: string): string {
  return `••••${hint}`;
}

/** Overall health of one pool row, for the coloured dot. */
export type HealthLevel = 'ok' | 'warn' | 'bad' | 'idle';

export function healthLevel(row: {
  disabled: boolean;
  keyStatus: string;
  entryStatus: string;
  breakerState: string;
  cooldownUntil: number | null;
}): HealthLevel {
  if (row.disabled) return 'idle';
  if (row.keyStatus === 'auth_error' || row.entryStatus === 'auth_error') return 'bad';
  if (row.entryStatus === 'not_found' || row.entryStatus === 'unsupported') return 'bad';
  if (row.breakerState === 'open') return 'bad';
  if (row.cooldownUntil && row.cooldownUntil > Date.now()) return 'warn';
  if (row.entryStatus === 'ok' && row.keyStatus === 'ok') return 'ok';
  return 'idle';
}

export const HEALTH_STYLES: Record<HealthLevel, { dot: string; text: string; label: string }> = {
  ok: { dot: 'bg-ok', text: 'text-ok', label: 'healthy' },
  warn: { dot: 'bg-warn', text: 'text-warn', label: 'cooling' },
  bad: { dot: 'bg-bad', text: 'text-bad', label: 'failing' },
  idle: { dot: 'bg-faint', text: 'text-subtle', label: 'untested' },
};

/** Convenience wrapper for the dashboard's entry rows. */
export function entryHealthLevel(row: {
  disabled: boolean;
  keyStatus: string;
  entry: { status: string };
  breakerState: string;
  cooldownUntil: number | null;
}): HealthLevel {
  return healthLevel({
    disabled: row.disabled,
    keyStatus: row.keyStatus,
    entryStatus: row.entry.status,
    breakerState: row.breakerState,
    cooldownUntil: row.cooldownUntil,
  });
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Time windows offered by every stats surface.
 *
 * The dashboard and the Stats page both render this list, so their selectors
 * and their stat hints can never drift apart. `all` is the whole retained log
 * and is what users reach for when they want lifetime token totals, so it sits
 * last in the selector.
 */
export const TIME_RANGES = [
  { key: '1h', label: 'Last hour' },
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
] as const;

/** Human label for a range key, for hints that are not the selector itself. */
export function rangeLabel(key: string): string {
  return t(TIME_RANGES.find((r) => r.key === key)?.label ?? 'Last 24h');
}

// --------------------------------------------------------------------- costs

/** The symbol one currency renders with, read from the runtime's own formatting. */
export function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(1);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    // An unknown code makes Intl throw; the code itself is the honest fallback.
    return currency;
  }
}

/**
 * A money figure in the display currency.
 *
 * Precision is the whole problem here: a typical request costs a fraction of a
 * cent, and the two-decimal format every currency printer defaults to would
 * render a whole window of real spend as "0.00". Small figures therefore keep
 * more digits - four down to a cent, six below that - while anything at or
 * above a unit prints the way money normally prints.
 */
export function formatCost(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  const abs = Math.abs(amount);
  const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(digits)}`;
  }
}

/** A cost for a chart axis, where the magnitude matters and the decimals do not. */
export function formatCostCompact(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return `${currencySymbol(currency)}${formatNumber(amount)}`;
}

/**
 * A per-million token price, as it is quoted. Rates like 0.6 and 15 need no
 * forced decimals; trailing zeros are trimmed rather than printed.
 */
export function formatPricePer1m(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return String(parseFloat(value.toFixed(6)));
}
