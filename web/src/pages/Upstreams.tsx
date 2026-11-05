import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import {
  api,
  exportEndpointKeys,
  saveTextFile,
  type BulkParseResult,
  type CredentialRow,
  type Endpoint,
  type EntryRow,
  type PingResult,
  type PoolSnapshot,
} from '../lib/api';
import { Card, Empty, ErrorNote, Modal, Spinner, StatusBadge, Toggle, useToast } from '../components/ui';
import { classNames, maskKey } from '../lib/format';

type AddMode = 'single' | 'bulk';

/** Gap between files in an "Export all" run, so browsers do not drop all but one. */
const EXPORT_STAGGER_MS = 250;

export default function Upstreams() {
  const [pool, setPool] = useState<PoolSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const [keysFor, setKeysFor] = useState<Endpoint | null>(null);
  const [bulkFor, setBulkFor] = useState<Endpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  /**
   * One file per provider, saved in turn.
   *
   * Browsers treat a burst of downloads from one click as a popup and will
   * quietly keep only the first, so they are spaced out. One failure does not
   * stop the rest - a locked admin API would otherwise report once and skip
   * every remaining provider.
   */
  const exportAll = async () => {
    const endpoints = pool?.endpoints ?? [];
    if (endpoints.length === 0) return;
    setExporting(true);
    let exported = 0;
    let skipped = 0;
    let failure: string | null = null;
    try {
      for (const endpoint of endpoints) {
        try {
          const r = await exportEndpointKeys(endpoint.id);
          saveTextFile(r.filename, r.text);
          exported += 1;
          skipped += r.skipped;
        } catch (err) {
          failure = (err as Error).message;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, EXPORT_STAGGER_MS));
      }      if (failure) {
        toast.push('bad', t('Exported {n} provider(s), then stopped: {failure}', { n: exported, failure }));
      } else if (skipped) {
        toast.push('bad', t('Exported {n} provider(s), but {skipped} key(s) could not be decrypted.', { n: exported, skipped }));
      } else {
        toast.push('ok', exported === 1 ? t('Exported {n} provider file.', { n: exported }) : t('Exported {n} provider files.', { n: exported }));
      }
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setPool(await api.pool());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label={t('Loading upstreams…')} />;

  const refresh = async () => {
    await load();
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Upstreams')}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {t('A base URL plus as many API keys as you like. No provider setup, no OAuth.')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => void exportAll()}
            disabled={exporting || (pool?.endpoints.length ?? 0) === 0}
            title={t('Download one .txt per provider, containing every key it holds')}
          >
            {exporting ? t('Exporting…') : t('Export all keys')}
          </button>
          <button className="btn-primary" onClick={() => setShowAdd(true)}>
            + Add upstream
          </button>
        </div>
      </header>

      {error && <ErrorNote message={error} />}

      {pool && pool.endpoints.length === 0 ? (
        <Card>
          <Empty
            title={t('No upstreams yet')}
            hint={t('Add a base URL, an API key and a model id — one key at a time, or paste a whole list in bulk. KeyPool pings each model to confirm it answers before putting it in rotation.')}
            action={
              <button className="btn-primary" onClick={() => setShowAdd(true)}>
                {t('Add your first upstream')}
              </button>
            }
          />
        </Card>
      ) : (
        pool?.endpoints.map((endpoint) => {
          const creds = pool.credentials.filter((c) => c.credential.endpointId === endpoint.id);
          const endpointEntries = pool.entries.filter((e) => e.baseUrl === endpoint.baseUrl);
          const healthy = endpointEntries.filter((e) => e.entry.status === 'ok' && !e.disabled).length;

          return (
            <Card
              key={endpoint.id}
              title={
                <span className="flex items-center gap-2">
                  {endpoint.name}
                  {!endpoint.enabled && <span className="rounded bg-line-strong/60 px-1.5 py-0.5 text-[10px] text-subtle">disabled</span>}
                </span>
              }
              subtitle={`${endpoint.baseUrl} · ${endpoint.apiStyle === 'auto' ? t('path auto-detect') : t('{style} path', { style: endpoint.apiStyle })} · ${endpoint.authType} auth · ${creds.length === 1 ? t('{n} key', { n: creds.length }) : t('{n} keys', { n: creds.length })} · ${t('{healthy}/{total} healthy', { healthy, total: endpointEntries.length })}`}
              actions={
                <>
                  <button className="btn-ghost" onClick={() => setEditing(endpoint)}>
                    {t('Edit')}
                  </button>
                  <button className="btn-ghost" onClick={() => setKeysFor(endpoint)}>
                    View keys ({creds.length})
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await api.pingAll(endpoint.id);
                        const ok = r.results.filter((x) => x.ok).length;
                        toast.push(ok === r.results.length ? 'ok' : 'bad', `Pinged ${r.results.length} entries — ${ok} healthy.`);
                        await refresh();
                      } catch (err) {
                        toast.push('bad', (err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    {t('Ping all')}
                  </button>
                  <button className="btn-ghost" onClick={() => setBulkFor(endpoint)}>
                    {t('Add keys')}
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={busy || creds.length === 0}
                    title={
                      creds.length === 0
                        ? 'This provider has no keys to export'
                        : 'Download every key on this provider as a .txt file'
                    }
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await exportEndpointKeys(endpoint.id);
                        saveTextFile(r.filename, r.text);
                        toast.push(
                          r.skipped ? 'bad' : 'ok',
                          r.skipped
                            ? `Exported ${r.filename}, but ${r.skipped} key(s) could not be decrypted and were left out.`
                            : `Exported ${r.filename}.`,
                        );
                      } catch (err) {
                        toast.push('bad', (err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t('Export keys')}
                  </button>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      if (!confirm(t('Delete "{name}" and all of its keys and models?', { name: endpoint.name }))) return;
                      try {
                        await api.deleteEndpoint(endpoint.id);
                        toast.push('info', t('Upstream deleted.'));
                        await refresh();
                      } catch (err) {
                        toast.push('bad', (err as Error).message);
                      }
                    }}
                  >
                    {t('Delete')}
                  </button>
                </>
              }
            >
              {creds.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted">
                  {t('No keys yet.')}{' '}
                  <button className="text-accent underline underline-offset-2" onClick={() => setBulkFor(endpoint)}>
                    {t('Add some')}
                  </button>
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {creds.slice(0, 6).map((row) => (
                    <CredentialLine key={row.credential.id} row={row} onChanged={refresh} />
                  ))}
                  {creds.length > 6 && (
                    <li className="pt-2">
                      <button className="text-xs text-accent underline underline-offset-2" onClick={() => setKeysFor(endpoint)}>
                        View all {creds.length} keys
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </Card>
          );
        })
      )}

      {showAdd && (
        <AddUpstreamModal
          onClose={() => setShowAdd(false)}
          onDone={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}

      {editing && (
        <EditEndpointModal
          endpoint={editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}

      {keysFor && pool && (
        <ManageKeysModal
          endpoint={keysFor}
          entries={pool.entries}
          onClose={() => setKeysFor(null)}
          onChanged={refresh}
          onAddMore={() => {
            setKeysFor(null);
            setBulkFor(keysFor);
          }}
        />
      )}

      {bulkFor && (
        <BulkKeysModal
          endpoint={bulkFor}
          onClose={() => setBulkFor(null)}
          onDone={async () => {
            setBulkFor(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one key

function CredentialLine({ row, onChanged }: { row: CredentialRow; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const c = row.credential;

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="font-mono text-sm text-subtle">{maskKey(c.keyHint)}</span>
      {c.label && <span className="text-xs text-muted">{c.label}</span>}
      <span className="text-xs text-faint">{row.entryCount} model{row.entryCount === 1 ? '' : 's'}</span>
      <StatusBadge level={c.disabled ? 'idle' : c.status === 'auth_error' ? 'bad' : c.breakerState === 'open' ? 'bad' : 'ok'}>
        {c.disabled ? 'disabled' : c.status === 'auth_error' ? 'auth error' : c.breakerState === 'open' ? 'breaker open' : undefined}
      </StatusBadge>
      <div className="ml-auto flex items-center gap-2">
        <button
          className="btn-ghost px-2 py-1 text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.updateCredential(c.id, { disabled: !c.disabled });
              await onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          {c.disabled ? t('Enable') : t('Disable')}
        </button>
        <button
          className="btn-danger px-2 py-1 text-xs"
          onClick={async () => {
            if (!confirm(t('Delete this key and all of its models?'))) return;
            await api.deleteCredential(c.id);
            await onChanged();
          }}
        >
          {t('Delete')}
        </button>
      </div>
      {c.lastError && <p className="w-full truncate text-xs text-bad/80">{c.lastError}</p>}
    </li>
  );
}

// ------------------------------------------------------------- edit endpoint

function EditEndpointModal({ endpoint, onClose, onDone }: { endpoint: Endpoint; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(endpoint.name);
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl);
  const [apiStyle, setApiStyle] = useState(endpoint.apiStyle);
  const [authType, setAuthType] = useState(endpoint.authType);
  const [authHeader, setAuthHeader] = useState(endpoint.authHeader ?? '');
  const [authPrefix, setAuthPrefix] = useState(endpoint.authPrefix ?? '');
  const [extraHeaders, setExtraHeaders] = useState(() => JSON.stringify(endpoint.extraHeaders, null, 2));
  const [compatProfile, setCompatProfile] = useState(endpoint.compatProfile ?? '');
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    setBusy(true);
    setError(null);
    let headers: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(extraHeaders.trim() || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Extra headers must be a JSON object like {"org-id": "abc"}.');
      }
      headers = parsed as Record<string, string>;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }

    try {
      const updated = await api.updateEndpoint(endpoint.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiStyle,
        authType,
        authHeader: authHeader.trim() || null,
        authPrefix: authType === 'bearer' ? (authPrefix || 'Bearer ') : authPrefix.trim() || null,
        extraHeaders: headers,
        compatProfile: compatProfile === '' ? null : compatProfile,
        enabled,
      });
      toast.push('ok', updated.baseUrl === baseUrl.trim() ? t('Saved.') : t('Saved. Base URL is now {url}', { url: updated.baseUrl }));
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Edit {name}', { name: endpoint.name })} onClose={onClose}>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}

        <div>
          <label className="label" htmlFor="ed-name">{t('Name')}</label>
          <input id="ed-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="label" htmlFor="ed-url">{t('Base URL')}</label>
          <input id="ed-url" className="input font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoFocus />
          <p className="mt-1 text-xs text-muted">
            Paste the host, the host with <span className="font-mono">/v1</span>, or a full endpoint URL — all are normalised. A full URL
            is trimmed to its <span className="font-mono">/v1</span> {t('base.')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ed-style">{t('Path style')}</label>
            <select id="ed-style" className="input" value={apiStyle} onChange={(e) => setApiStyle(e.target.value as Endpoint['apiStyle'])}>
              <option value="auto">{t('Auto-detect')}</option>
              <option value="v1">Always /v1</option>
              <option value="root">{t('Always root')}</option>
            </select>
            <p className="mt-1 text-xs text-muted">Auto probes /v1 first and remembers what worked.</p>
          </div>
          <div>
            <label className="label" htmlFor="ed-auth">{t('Authentication')}</label>
            <select id="ed-auth" className="input" value={authType} onChange={(e) => setAuthType(e.target.value as Endpoint['authType'])}>
              <option value="bearer">Authorization: Bearer &lt;key&gt;</option>
              <option value="header">{t('Custom header')}</option>
              <option value="query">{t('Query parameter')}</option>
              <option value="none">{t('No auth header')}</option>
            </select>
          </div>
        </div>

        {(authType === 'header' || authType === 'query') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="ed-authheader">
                {authType === 'header' ? t('Header name') : t('Query parameter name')}
              </label>
              <input
                id="ed-authheader"
                className="input font-mono"
                placeholder={authType === 'header' ? 'x-api-key' : 'key'}
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ed-authprefix">{t('Value prefix')}</label>
              <input
                id="ed-authprefix"
                className="input font-mono"
                placeholder={authType === 'header' ? t('leave empty') : t('leave empty')}
                value={authPrefix}
                onChange={(e) => setAuthPrefix(e.target.value)}
              />
            </div>
          </div>
        )}

        <div>
          <label className="label" htmlFor="ed-headers">{t('Extra headers (JSON)')}</label>
          <textarea
            id="ed-headers"
            className="input h-20 resize-y font-mono text-xs"
            placeholder='{"openai-organization": "org-123"}'
            value={extraHeaders}
            onChange={(e) => setExtraHeaders(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">{t('For gateways that need org, project or team headers alongside the key.')}</p>
        </div>

        <div>
          <label className="label" htmlFor="ed-compat">{t('Compatibility profile')}</label>
          <select id="ed-compat" className="input" value={compatProfile} onChange={(e) => setCompatProfile(e.target.value)}>
            <option value="">{t('None — relay requests verbatim')}</option>
            <option value="opencode-zen">opencode-zen — OpenCode Zen free-tier gate</option>
          </select>
          <p className="mt-1 text-xs text-muted">
            {t('For upstreams that serve some models only to their own agent client. The proxy streams and carries the vendor\'s tool names so pooled requests (and pings) are accepted. Pair with the client identity headers in Extra headers — see the README\'s OpenCode Zen section.')}
          </p>
        </div>

        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label={t('Enabled')}
          hint={t('A disabled upstream keeps its keys but takes no traffic.')}
        />

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !name.trim() || !baseUrl.trim()}>
            {busy ? t('Saving…') : t('Save changes')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ manage keys

function ManageKeysModal({
  endpoint,
  entries,
  onClose,
  onChanged,
  onAddMore,
}: {
  endpoint: Endpoint;
  entries: EntryRow[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAddMore: () => void;
}) {
  const [creds, setCreds] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCreds(await api.credentials(endpoint.id));
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [endpoint.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = creds.filter((c) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return (
      (c.credential.label ?? '').toLowerCase().includes(q) ||
      c.credential.keyHint.toLowerCase().includes(q) ||
      c.credential.status.toLowerCase().includes(q)
    );
  });

  return (
    <Modal title={t('API keys — {name}', { name: endpoint.name })} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="rounded-[var(--radius-control)] border border-line bg-inset px-3 py-2 text-xs text-subtle">
          <p>
            <span className="font-medium text-subtle">{endpoint.baseUrl}</span> · {creds.length} key
            {creds.length === 1 ? '' : 's'} · {endpoint.authType} auth
            {endpoint.authType === 'header' && endpoint.authHeader ? ` (${endpoint.authHeader})` : ''}
          </p>
          <p className="mt-1 text-muted">
            {t('Keys are encrypted with AES-256-GCM before they touch disk, so only the last 4 characters are ever available to display.')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-xs"
            placeholder={t('Filter by label, ending or status')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="btn-ghost" onClick={() => void load()}>
            {t('Refresh')}
          </button>
          <button className="btn-primary" onClick={onAddMore}>
            + Add keys
          </button>
        </div>

        {loading ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            {creds.length === 0 ? t('No keys on this upstream yet.') : t('No keys match that filter.')}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((row) => (
              <KeyRow
                key={row.credential.id}
                row={row}
                entries={entries.filter((e) => e.entry.credentialId === row.credential.id)}
                onChanged={async () => {
                  await load();
                  await onChanged();
                }}
                onToast={toast.push}
              />
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <button className="btn-ghost" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function KeyRow({
  row,
  entries,
  onChanged,
  onToast,
}: {
  row: CredentialRow;
  entries: EntryRow[];
  onChanged: () => Promise<void>;
  onToast: (kind: 'ok' | 'bad' | 'info', text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(row.credential.label ?? '');
  const c = row.credential;

  const level = c.disabled
    ? 'idle'
    : c.status === 'auth_error' || c.breakerState === 'open'
      ? 'bad'
      : c.cooldownUntil && c.cooldownUntil > Date.now()
        ? 'warn'
        : 'ok';

  const saveLabel = async () => {
    if (label === (c.label ?? '')) return;
    await api.updateCredential(c.id, { label: label.trim() || null });
    await onChanged();
  };

  const addModel = async (modelId: string) => {
    const value = modelId.trim();
    if (!value) return;
    setBusy(true);
    try {
      const res = await api.addEntry({ credentialId: c.id, modelId: value });
      onToast('ok', res.entry.status === 'ok' ? `${value} answered and is live.` : `${value} added; ping reported: ${res.entry.status}.`);
      await onChanged();
    } catch (err) {
      onToast('bad', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <code className="rounded bg-raised/70 px-2 py-1 font-mono text-sm text-fg">{maskKey(c.keyHint)}</code>
        <input
          className="input max-w-[180px] px-2 py-1 text-xs"
          placeholder="label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => void saveLabel()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <StatusBadge level={level}>
          {c.disabled
            ? 'disabled'
            : c.status === 'auth_error'
              ? 'auth error'
              : c.breakerState === 'open'
                ? 'breaker open'
                : c.cooldownUntil && c.cooldownUntil > Date.now()
                  ? 'cooling'
                  : undefined}
        </StatusBadge>
        {c.failStreak > 0 && <span className="text-xs text-muted">{c.failStreak === 1 ? t('{n} recent failure', { n: c.failStreak }) : t('{n} recent failures', { n: c.failStreak })}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={async () => {
              await api.updateCredential(c.id, { disabled: !c.disabled });
              await onChanged();
            }}
          >
            {c.disabled ? t('Enable') : t('Disable')}
          </button>
          <button
            className="btn-danger px-2 py-1 text-xs"
            onClick={async () => {
              if (!confirm(t('Delete this key and every model bound to it?'))) return;
              await api.deleteCredential(c.id);
              onToast('info', 'Key deleted.');
              await onChanged();
            }}
          >
            {t('Delete')}
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">{t('Models:')}</span>
        {entries.length === 0 ? (
          <span className="text-faint">none bound</span>
        ) : (
          entries.map((e) => (
            <span
              key={e.entry.id}
              className={classNames(
                'rounded px-1.5 py-0.5 font-mono',
                e.entry.status === 'ok' ? 'bg-ok/10 text-ok' : e.entry.status === 'unknown' ? 'bg-line-strong/50 text-subtle' : 'bg-bad/10 text-bad',
              )}
              title={e.entry.lastError ?? undefined}
            >
              {e.entry.modelId}
            </span>
          ))
        )}
        <input
          className="input w-40 px-2 py-0.5 font-mono text-xs"
          placeholder="+ bind a model"
          disabled={busy}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter') return;
            const input = e.currentTarget;
            const value = input.value;
            input.value = '';
            await addModel(value);
          }}
        />
      </div>

      {c.lastError && <p className="mt-1.5 truncate text-xs text-bad/80" title={c.lastError}>{c.lastError}</p>}
    </li>
  );
}

// -------------------------------------------------------------- add upstream

function AddUpstreamModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<AddMode>('single');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [autoPing, setAutoPing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Bulk state
  const [payload, setPayload] = useState('');
  const [format, setFormat] = useState('auto');
  const [preview, setPreview] = useState<BulkParseResult | null>(null);
  const [pings, setPings] = useState<PingResult[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runPreview = useCallback(async () => {
    if (!payload.trim()) {
      setPreview(null);
      return;
    }
    try {
      setPreview(await api.parseBulk(payload, format));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    }
  }, [payload, format]);

  useEffect(() => {
    const t = setTimeout(() => void runPreview(), 350);
    return () => clearTimeout(t);
  }, [runPreview]);

  const submitSingle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.quickAdd({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelId: modelId.trim(),
        name: name.trim() || undefined,
        autoPing,
      });
      if (res.ping?.ok) toast.push('ok', t('"{model}" answered in {ms}ms — it is live.', { model: res.entry.modelId, ms: res.ping.ms ?? '?' }));
      else if (res.ping) toast.push('bad', t('Added, but the ping failed: {reason}', { reason: res.ping.error ?? t('unknown reason') }));
      else toast.push('ok', t('Upstream added (ping skipped).'));
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitBulk = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.addKeysByBaseUrl({
        baseUrl: baseUrl.trim(),
        name: name.trim() || undefined,
        payload,
        format,
        modelIds: modelId.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean),
        autoPing,
      });
      setPings(res.pings);
      const healthy = res.pings.filter((p) => p.ok).length;
      toast.push(
        res.pings.length > 0 && healthy === res.pings.length ? 'ok' : 'bad',
        (res.added === 1 ? t('Imported {n} key — {healthy}/{total} answered the ping.', { n: res.added, healthy, total: res.pings.length }) : t('Imported {n} keys — {healthy}/{total} answered the ping.', { n: res.added, healthy, total: res.pings.length })),
      );
      if (res.pings.length === 0) await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bindingModels = modelId.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
  const canSubmit =
    baseUrl.trim() !== '' &&
    (mode === 'single' ? apiKey.trim() !== '' && modelId.trim() !== '' : preview !== null && preview.summary.ok > 0 && bindingModels.length > 0);

  return (
    <Modal title={t('Add an upstream')} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}

        <div className="flex rounded-[var(--radius-control)] border border-line bg-inset p-0.5">
          {(
            [
              ['single', 'Single key'],
              ['bulk', 'Bulk import'],
            ] as Array<[AddMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={classNames(
                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                mode === value ? 'bg-accent/15 text-accent' : 'text-subtle hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <div>
            <label className="label" htmlFor="au-url">{t('Base URL')}</label>
            <input
              id="au-url"
              className="input font-mono"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="au-name">{t('Label (optional)')}</label>
            <input id="au-name" className="input" placeholder={t('OpenAI #1')} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted">
          {t('Paste the host, the host with')} <span className="font-mono">/v1</span>, {t('or a full endpoint URL — all are normalised, and the')}{' '}
          <span className="font-mono">/v1</span> {t('prefix is detected on first contact.')}</p>

        {mode === 'single' ? (
          <>
            <div>
              <label className="label" htmlFor="au-key">{t('API key')}</label>
              <input
                id="au-key"
                className="input font-mono"
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted">{t('Encrypted with AES-256-GCM before it touches disk. Never shown again.')}</p>
            </div>
            <div>
              <label className="label" htmlFor="au-model">{t('Model id')}</label>
              <input
                id="au-model"
                className="input font-mono"
                placeholder="gpt-4o-mini"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <BulkKeysPanel
              payload={payload}
              onPayload={setPayload}
              format={format}
              onFormat={setFormat}
              onFile={async (f) => {
                if (f.size > 2 * 1024 * 1024) {
                  setError(t('That file is larger than 2 MB.'));
                  return;
                }
                setPayload(await f.text());
                setFormat(f.name.toLowerCase().endsWith('.json') ? 'json' : f.name.toLowerCase().endsWith('.csv') ? 'csv' : 'auto');
              }}
              fileRef={fileRef}
              preview={preview}
            />
            <div>
              <label className="label" htmlFor="au-bulk-models">{t('Model id(s) to bind to every key')}</label>
              <input
                id="au-bulk-models"
                className="input font-mono"
                placeholder="gpt-4o-mini  (space or comma separated)"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
          </>
        )}

        <Toggle checked={autoPing} onChange={setAutoPing} label={t('Ping after adding')} hint={t('Sends a one-token request to confirm each model answers.')} />

        {pings && pings.length > 0 && (
          <div className="rounded-[var(--radius-control)] border border-line bg-inset">
            <p className="border-b border-line px-3 py-2 text-xs text-subtle">
              Ping results — {pings.filter((r) => r.ok).length} of {pings.length} answered
            </p>
            <ul className="max-h-40 divide-y divide-line overflow-y-auto">
              {pings.map((r) => (
                <li key={r.entryId} className="row-hover flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className={r.ok ? 'bg-ok' : 'border border-bad'} aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0 }} />
                  <span className="font-mono text-subtle">{r.entryId.slice(0, 14)}</span>
                  {r.ok ? <span className="text-muted">{r.ms}ms</span> : <span className="truncate text-bad/80">{r.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {mode === 'bulk' && bindingModels.length === 0 ? (
              <span className="text-warn">Each key needs a model. Fill in the model box, or include a model_id column.</span>
            ) : (
              'The upstream is created automatically if the base URL is new.'
            )}
          </p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
            {pings && pings.length > 0 ? (
              <button className="btn-primary" onClick={() => void onDone()}>{t('Done')}</button>
            ) : (
              <button
                className="btn-primary"
                onClick={() => void (mode === 'single' ? submitSingle() : submitBulk())}
                disabled={busy || !canSubmit}
              >
                {busy ? 'Working…' : mode === 'single' ? 'Add and ping' : `Import ${preview?.summary.ok ?? 0} key${preview?.summary.ok === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------- bulk import

function BulkKeysPanel({
  payload,
  onPayload,
  format,
  onFormat,
  onFile,
  fileRef,
  preview,
}: {
  payload: string;
  onPayload: (v: string) => void;
  format: string;
  onFormat: (v: string) => void;
  onFile: (f: File) => Promise<void>;
  fileRef: React.RefObject<HTMLInputElement | null>;
  preview: BulkParseResult | null;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="bk-format">{t('Input format')}</label>
          <select id="bk-format" className="input" value={format} onChange={(e) => onFormat(e.target.value)}>
            <option value="auto">{t('Auto-detect')}</option>
            <option value="text">{t('Plain text (one per line)')}</option>
            <option value="csv">{t('CSV')}</option>
            <option value="json">{t('JSON')}</option>
          </select>
        </div>
        <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
          {t('Upload file…')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <label className="label" htmlFor="bk-payload">{t('Keys')}</label>
        <textarea
          id="bk-payload"
          className="input h-36 resize-y font-mono text-xs"
          placeholder={'sk-key-1\nsk-key-2\n# comments and blank lines are ignored\nBearer sk-key-3'}
          value={payload}
          onChange={(e) => onPayload(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted">
          Accepts a pasted list, a CSV with a header, or a JSON array. A <span className="font-mono">{t('Bearer ')}</span> {t('prefix and surrounding quotes are stripped, and duplicates are collapsed.')}</p>
      </div>

      {preview && (
        <div className="rounded-[var(--radius-control)] border border-line bg-inset">
          <div className="flex flex-wrap items-center gap-4 border-b border-line px-3 py-2 text-xs">
            <span className="text-subtle">{t('Detected ')}<span className="font-mono text-fg">{preview.format}</span></span>
            <span className="text-ok">{preview.summary.ok} ready</span>
            <span className="text-warn">{preview.summary.duplicates} duplicate</span>
            <span className="text-bad">{preview.summary.invalid} invalid</span>
            {preview.rows.some((r) => r.modelId) && <span className="text-muted">rows carry their own model column</span>}
          </div>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full">
              <tbody className="divide-y divide-line">
                {preview.rows.slice(0, 100).map((row) => (
                  <tr
                    key={row.index}
                    className={classNames(row.status !== 'ok' ? 'opacity-70' : '', 'row-hover')}
                  >
                    <td className="td w-10 font-mono text-xs text-faint">{row.index}</td>
                    <td className="td font-mono text-xs">{row.key ? maskKey(row.key.slice(-4)) : '—'}</td>
                    <td className="td">
                      {row.status === 'ok' ? (
                        <span className="text-ok">ready</span>
                      ) : (
                        <span className={row.status === 'duplicate' ? 'text-warn' : 'text-bad'}>
                          {row.status}
                          {row.reason ? ` — ${row.reason}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 100 && (
            <p className="border-t border-line px-3 py-1.5 text-xs text-muted">Showing the first 100 of {preview.rows.length} rows.</p>
          )}
        </div>
      )}
    </>
  );
}

function BulkKeysModal({ endpoint, onClose, onDone }: { endpoint: Endpoint; onClose: () => void; onDone: () => Promise<void> }) {
  const [payload, setPayload] = useState('');
  const [format, setFormat] = useState('auto');
  const [modelIds, setModelIds] = useState('');
  const [autoPing, setAutoPing] = useState(true);
  const [preview, setPreview] = useState<BulkParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PingResult[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const runPreview = useCallback(async () => {
    if (!payload.trim()) {
      setPreview(null);
      return;
    }
    try {
      setPreview(await api.parseBulk(payload, format));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    }
  }, [payload, format]);

  useEffect(() => {
    const t = setTimeout(() => void runPreview(), 350);
    return () => clearTimeout(t);
  }, [runPreview]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.addKeys(endpoint.id, {
        payload,
        format,
        modelIds: modelIds.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean),
        autoPing,
      });
      setResults(res.pings);
      const healthy = res.pings.filter((p) => p.ok).length;
      if (res.pings.length > 0) {
        toast.push(healthy === res.pings.length ? 'ok' : 'bad', t('Imported {n} keys — {healthy}/{total} answered the ping.', { n: res.added, healthy, total: res.pings.length }));
      } else {
        toast.push('ok', t('Imported {n} keys.', { n: res.added }));
      }
      if (res.pings.length === 0) await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bindingModels = modelIds.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);

  return (
    <Modal title={t('Add keys to {name}', { name: endpoint.name })} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}
        <p className="rounded-[var(--radius-control)] border border-line bg-inset px-3 py-2 font-mono text-xs text-subtle">{endpoint.baseUrl}</p>

        <BulkKeysPanel
          payload={payload}
          onPayload={setPayload}
          format={format}
          onFormat={setFormat}
          onFile={async (f) => {
            if (f.size > 2 * 1024 * 1024) {
              setError(t('That file is larger than 2 MB.'));
              return;
            }
            setPayload(await f.text());
            setFormat(f.name.toLowerCase().endsWith('.json') ? 'json' : f.name.toLowerCase().endsWith('.csv') ? 'csv' : 'auto');
          }}
          fileRef={fileRef}
          preview={preview}
        />

        <div>
          <label className="label" htmlFor="bk-models">{t('Models to bind to every key (optional)')}</label>
          <input
            id="bk-models"
            className="input font-mono"
            placeholder="gpt-4o-mini  (leave blank if rows carry their own model column)"
            value={modelIds}
            onChange={(e) => setModelIds(e.target.value)}
          />
        </div>

        <Toggle checked={autoPing} onChange={setAutoPing} label={t('Ping every key after import')} hint={t('Runs with bounded concurrency.')} />

        {results && results.length > 0 && (
          <div className="rounded-[var(--radius-control)] border border-line bg-inset">
            <p className="border-b border-line px-3 py-2 text-xs text-subtle">
              Ping results — {results.filter((r) => r.ok).length} of {results.length} answered
            </p>
            <ul className="max-h-40 divide-y divide-line overflow-y-auto">
              {results.map((r) => (
                <li key={r.entryId} className="row-hover flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className={r.ok ? 'bg-ok' : 'border border-bad'} aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0 }} />
                  <span className="font-mono text-subtle">{r.entryId.slice(0, 14)}</span>
                  {r.ok ? <span className="text-muted">{r.ms}ms</span> : <span className="truncate text-bad/80">{r.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {bindingModels.length === 0 && !preview?.rows.some((r) => r.modelId) ? (
              <span className="text-warn">Each key needs a model. Fill in the models box, or include a model_id column.</span>
            ) : (
              'Keys already on this upstream are skipped, so re-running is safe.'
            )}
          </p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>{t('Close')}</button>
            {results && results.length > 0 ? (
              <button className="btn-primary" onClick={() => void onDone()}>{t('Done')}</button>
            ) : (
              <button className="btn-primary" onClick={() => void submit()} disabled={busy || (preview?.summary.ok ?? 0) === 0}>
                {busy ? 'Importing…' : `Import ${preview?.summary.ok ?? 0} key${preview?.summary.ok === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
