import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type LogRow } from '../lib/api';
import { Card, Empty, ErrorNote, Spinner } from '../components/ui';
import { formatMs, formatNumber, formatRelative, TIME_RANGES } from '../lib/format';
import { t } from '../lib/i18n';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { Icon } from '../components/Icon';

const PAGE = 50;

type ViewMode = 'table' | 'console';

export default function Logs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [range, setRange] = useState('24h');
  const [outcome, setOutcome] = useState<'' | 'true' | 'false'>('');
  const [model, setModel] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('table');
  /** Freezes the console for reading; a paused view is a snapshot, not a lie. */
  const [paused, setPaused] = useState(false);
  /** The console follows the newest line until the operator scrolls back. */
  const [pinned, setPinned] = useState(true);
  const consoleRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    // A paused console is reading material, not a live feed: polls arrive and
    // are deliberately ignored until resumed.
    if (pausedRef.current) return;
    try {
      // Drain the server's write buffer before reading, so the page cannot
      // miss a request that has already finished but not yet landed. The
      // server also drains on its own two-second timer, so this only closes
      // the gap - and unlike a timer, a failure here surfaces instead of
      // being swallowed.
      await api.flushLogs();
      const res = await api.logs({
        range,
        success: outcome === '' ? undefined : outcome,
        model: model.trim() || undefined,
        limit: PAGE,
        offset: view === 'console' ? 0 : offset,
      });
      setRows(res.rows);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, outcome, model, offset, view]);

  useEffect(() => {
    void load();
  }, [load]);

  // The shared polling mechanism, so the console is live and the table
  // keeps itself current. No hand-rolled interval anywhere on this page.
  useAutoRefresh(load);

  // Follow the newest line while the operator is parked at the bottom.
  useEffect(() => {
    if (view !== 'console' || paused || !pinned) return;
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, view, paused, pinned]);

  const [deleting, setDeleting] = useState(false);

  // Removes the logged requests the console is showing - same filters, same
  // range - from the server's store, not just from this view.
  const deleteEntries = async () => {
    setDeleting(true);
    try {
      await api.deleteLogs({ range, model: model.trim() || undefined, success: outcome || undefined });
      setRows([]);
      setTotal(0);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Request log')}</h1>
          <p className="tnum mt-1.5 text-sm text-muted">
            {t('{total} requests. Prompt and response bodies are never stored.', { total: formatNumber(total) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view === 'console' && (
            <>
              <button className="btn" onClick={() => setPaused((p) => !p)}>
                {paused ? t('Resume') : t('Pause')}
              </button>
              <button
                className="btn text-bad"
                disabled={deleting || rows.length === 0}
                title={t('Delete every logged request matching the current filters, from the log itself')}
                onClick={() => {
                  const question = total === 1
                    ? t('Delete {total} logged request matching the current filters? It is removed from the log, not just from this view.', { total: formatNumber(total) })
                    : t('Delete {total} logged requests matching the current filters? They are removed from the log, not just from this view.', { total: formatNumber(total) });
                  if (!confirm(question)) return;
                  void deleteEntries();
                }}
              >
                <Icon name="trash" size={13} />
                {deleting ? t('Deleting…') : t('Delete')}
              </button>
            </>
          )}
          <div className="flex rounded-[var(--radius-control)] border border-line bg-inset p-0.5">
            {(
              [
                ['table', 'Table'],
                ['console', 'Console'],
              ] as Array<[ViewMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => {
                  setView(mode);
                  setOffset(0);
                  if (mode === 'console') setPaused(false);
                }}
                className={`rounded-[4px] border px-2.5 py-1 text-xs font-medium transition-[background-color,border-color,color] duration-150 ${
                  view === mode
                    ? 'border-line bg-surface text-accent'
                    : 'border-transparent text-muted hover:text-fg'
                }`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && <ErrorNote message={error} />}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="lg-range">{t('Range')}</label>
          <select id="lg-range" className="input" value={range} onChange={(e) => { setRange(e.target.value); setOffset(0); }}>
            {TIME_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {t(r.label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lg-outcome">{t('Outcome')}</label>
          <select
            id="lg-outcome"
            className="input"
            value={outcome}
            onChange={(e) => { setOutcome(e.target.value as '' | 'true' | 'false'); setOffset(0); }}
          >
            <option value="">{t('All')}</option>
            <option value="true">{t('Successes')}</option>
            <option value="false">{t('Failures')}</option>
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="label" htmlFor="lg-model">{t('Model')}</label>
          <input
            id="lg-model"
            className="input font-mono"
            placeholder={t('exact model name')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setOffset(0)}
          />
        </div>
      </div>

      {view === 'table' ? (
        <Card>
          {loading && rows.length === 0 ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <Empty title={t('No requests match these filters')} hint={t('Try widening the range or clearing the model filter.')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className="th">{t('When')}</th>
                    <th className="th">{t('Model')}</th>
                    <th className="th">{t('Upstream')}</th>
                    <th className="th">{t('Client')}</th>
                    <th className="th">{t('Result')}</th>
                    <th className="th text-right">{t('Attempts')}</th>
                    <th className="th text-right">{t('Latency')}</th>
                    <th className="th text-right">{t('TTFB')}</th>
                    <th className="th text-right">{t('Tokens')}</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((row) => (
                    // The key has to sit on the Fragment, not on a child <tr>:
                    // keys on children of a keyless fragment are ignored, which
                    // warns on every render and lets the detail row reconcile
                    // against the wrong one.
                    <Fragment key={row.id}>
                      <tr
                        className="row-hover cursor-pointer"
                        onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                      >
                        <td className="td text-xs whitespace-nowrap text-muted" title={new Date(row.ts).toLocaleString()}>
                          {formatRelative(row.ts)}
                        </td>
                        <td className="td font-mono text-xs">
                          {row.requested_model}
                          {row.streaming === 1 && <span className="ml-1.5 rounded bg-accent/15 px-1 text-[10px] text-accent">{t('stream')}</span>}
                        </td>
                        <td className="td max-w-[160px] truncate text-xs text-subtle">
                          {row.endpoint_name ?? <span className="text-faint">—</span>}
                        </td>
                        <td className="td text-xs text-subtle">
                          {row.client_category ?? <span className="text-faint">—</span>}
                        </td>
                        <td className="td">
                          {row.success === 1 ? (
                            <span className="text-xs text-ok">{row.status_code ?? 'ok'}</span>
                          ) : (
                            <span className="text-xs text-bad">
                              {row.status_code ?? row.error_kind}
                            </span>
                          )}
                        </td>
                        <td className="td text-right font-mono text-xs tabular-nums">{row.attempts}</td>
                        <td className="td text-right font-mono text-xs tabular-nums text-subtle">{formatMs(row.latency_ms)}</td>
                        <td className="td text-right font-mono text-xs tabular-nums text-muted">{formatMs(row.ttfb_ms)}</td>
                        <td className="td text-right font-mono text-xs tabular-nums text-subtle">
                          {row.total_tokens === null ? '—' : formatNumber(row.total_tokens)}
                        </td>
                        <td className="td text-right text-faint">
                          <span className="inline-flex justify-end">
                            <Icon
                              name="chevron"
                              size={12}
                              className={'transition-transform duration-200 ease-out ' + (expanded === row.id ? 'rotate-0' : '-rotate-90')}
                            />
                          </span>
                        </td>
                      </tr>
                      {expanded === row.id && (
                        <tr className="bg-canvas/50">
                          <td colSpan={10} className="px-4 py-3">
                            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
                              <Detail label={t('Strategy')} value={row.strategy ?? '—'} />
                              <Detail label={t('Upstream model')} value={row.upstream_model ?? '—'} />
                              <Detail label={t('Key label')} value={row.credential_label ?? '—'} />
                              <Detail label={t('Client')} value={row.client_category ?? '—'} />
                              <Detail label={t('Entry')} value={row.entry_id ?? '—'} />
                              <Detail label={t('Alias')} value={row.alias_id ?? '—'} />
                              <Detail label={t('Prompt tokens')} value={row.prompt_tokens === null ? t('not reported') : String(row.prompt_tokens)} />
                              <Detail label={t('Completion tokens')} value={row.completion_tokens === null ? t('not reported') : String(row.completion_tokens)} />
                              <Detail label={t('Timestamp')} value={new Date(row.ts).toLocaleString()} />
                              {row.error_message && (
                                <div className="col-span-2 sm:col-span-4">
                                  <Detail label={t('Error')} value={row.error_message} tone="bad" />
                                </div>
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between text-xs text-muted">
            <span>
              {t('Showing {from}–{to} of {total}', { from: offset + 1, to: Math.min(offset + PAGE, total), total: formatNumber(total) })}
            </span>
            <div className="flex gap-2">
              <button className="btn-ghost px-2.5 py-1" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <Icon name="arrowLeft" size={13} />
                {t('Newer')}
              </button>
              <button className="btn-ghost px-2.5 py-1" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                {t('Older')}
                <Icon name="arrowRight" size={13} />
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <Card
          title={t('Console')}
          subtitle={
            paused
              ? t('Paused - showing the snapshot from when you paused.')
              : t('Live. Each line is one request: time, model (as asked, then as served), provider, key, client, outcome.')
          }
        >
          {loading && rows.length === 0 ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <Empty title={t('No requests match these filters')} hint={t('Traffic through the pool appears here the moment it is logged.')} />
          ) : (
            <div
              ref={consoleRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
              }}
              className="max-h-[520px] overflow-y-auto rounded-[var(--radius-control)] bg-inset font-mono text-xs leading-relaxed"
            >
              {[...rows].reverse().map((row) => (
                <ConsoleLine key={row.id} row={row} />
              ))}
              {rows.length >= PAGE && (
                <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
                  {total > PAGE
                    ? t('Newest {page} in this window of {total} - narrow the range or filter to see more.', { page: PAGE, total: formatNumber(total) })
                    : t('Newest {page} in this window - narrow the range or filter to see more.', { page: PAGE })}
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/**
 * One console line: the whole request, the way a terminal would say it.
 *
 * `asked → served` because the difference is the interesting part - a spoof or
 * alias is named by the client and served by something else. Colour reports
 * state only: ok in the ok ink, failures in the bad ink, metadata in the quiet
 * inks - never decoration.
 */
function ConsoleLine({ row }: { row: LogRow }) {
  const ok = row.success === 1;
  const served = row.upstream_model && row.upstream_model !== row.requested_model ? ` → ${row.upstream_model}` : '';
  return (
    <div className="border-b border-line/50 px-4 py-1.5">
      <div className="whitespace-pre-wrap break-all">
        <span className="tnum text-faint">[{new Date(row.ts).toLocaleTimeString([], { hour12: false })}]</span>{' '}
        <span className={ok ? 'text-ok' : 'text-bad'}>{ok ? '▶' : '✗'}</span>{' '}
        <span className="text-fg">
          {row.requested_model}
          {served && <span className="text-subtle">{served}</span>}
        </span>
        {row.endpoint_name && <span className="text-subtle"> · {row.endpoint_name}</span>}
        {row.credential_label && <span className="text-subtle"> · {row.credential_label}</span>}
        <span className="text-accent"> · {row.client_category ?? t('unknown')}</span>
        {row.streaming === 1 && <span className="text-accent"> · {t('STREAM')}</span>}
        <span className={ok ? 'text-ok' : 'text-bad'}>
          {' '}
          · {ok ? (row.status_code ?? 200) : `${row.status_code ?? row.error_kind ?? t('failed')}`}
        </span>
        {(row.prompt_tokens !== null || row.completion_tokens !== null) && (
          <span className="text-subtle">
            {' '}
            · {t('IN {n}', { n: formatNumber(row.prompt_tokens) })} · {t('OUT {n}', { n: formatNumber(row.completion_tokens) })}
          </span>
        )}
        <span className="text-faint"> · {formatMs(row.latency_ms)}</span>
      </div>
      {!ok && row.error_message && <p className="pl-6 text-bad/80">{row.error_message}</p>}
    </div>
  );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-wider text-muted uppercase">{label}</dt>
      <dd className={`mt-0.5 font-mono break-all ${tone === 'bad' ? 'text-bad' : 'text-subtle'}`}>{value}</dd>
    </div>
  );
}
