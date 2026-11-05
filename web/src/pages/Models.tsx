import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { api, type Alias, type Endpoint, type EntryRow, type PoolSnapshot } from '../lib/api';
import { Card, Empty, ErrorNote, Modal, Spinner, StatusBadge, useToast } from '../components/ui';
import { formatMs, formatRelative, entryHealthLevel, maskKey, classNames } from '../lib/format';
import { groupEntriesByModel, type ModelGroup } from '../lib/models';
import { Icon } from '../components/Icon';

export default function Models() {
  const [pool, setPool] = useState<PoolSnapshot | null>(null);
  const [strategies, setStrategies] = useState<{ name: string; description: string }[]>([]);
  const [defaultStrategy, setDefaultStrategy] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [aliasModal, setAliasModal] = useState<Alias | 'new' | null>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [p, s, settings] = await Promise.all([api.pool(), api.strategies(), api.settings()]);
      setPool(p);
      setStrategies(s.strategies);
      // Shown in the alias editor so "inherits the default" can name the
      // strategy it is actually inheriting right now.
      setDefaultStrategy(settings.settings.defaultStrategy);
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

  if (loading) return <Spinner label={t('Loading models…')} />;

  const pingAll = async () => {
    setBusy(true);
    try {
      const r = await api.pingAll();
      const ok = r.results.filter((x) => x.ok).length;
      toast.push(ok === r.results.length ? 'ok' : 'bad', `Pinged ${r.results.length} entries — ${ok} healthy.`);
      await load();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = groupEntriesByModel(pool?.entries ?? []);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Models')}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {t('One row per model id. Expand one to see the keys and upstreams serving it — traffic is spread across all of them.')}
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void pingAll()} disabled={busy}>
          {busy ? t('Pinging…') : t('Ping all')}
        </button>
      </header>

      {error && <ErrorNote message={error} />}

      <Card
        title={t('Pooled models')}
        subtitle={(groups.length === 1 ? t('{n} model', { n: groups.length }) : t('{n} models', { n: groups.length })) + ' · ' + t('{n} entries', { n: pool?.entries.length ?? 0 })}
        actions={
          <button className="btn-primary" onClick={() => setAddModelOpen(true)}>
            + Add model
          </button>
        }
      >
        {groups.length === 0 ? (
          <Empty title={t('No models yet')} hint={t('Add an upstream with a base URL, key and model id first.')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">{t('Model')}</th>
                  <th className="th text-right">{t('Keys')}</th>
                  <th className="th text-right">{t('Upstreams')}</th>
                  <th className="th">{t('Status')}</th>
                  <th className="th text-right">{t('Ping')}</th>
                  <th className="th">{t('Last used')}</th>
                  <th className="th text-right">{t('Weight')}</th>
                  <th className="th text-right">{t('Priority')}</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {groups.map((group) => (
                  <ModelGroupRows key={group.modelId} group={group} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={t('Aliases (fallback chains)')}
        subtitle={t('Expose one name that fails over across several models, in order.')}
        actions={
          <button className="btn-primary" onClick={() => setAliasModal('new')}>
            + New alias
          </button>
        }
      >
        {pool?.aliases.length === 0 ? (
          <Empty
            title={t('No aliases')}
            hint={t('An alias lets a client ask for one model name and have KeyPool walk a chain of upstreams until one answers.')}
          />
        ) : (
          <ul className="divide-y divide-line">
            {pool?.aliases.map((alias) => {
              const targets = alias.targets
                .map((id) => pool.entries.find((e) => e.entry.id === id))
                .filter((x): x is EntryRow => Boolean(x));
              return (
                <li key={alias.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="font-mono text-sm text-accent">{alias.name}</span>
                  {/* An alias with no strategy of its own shows the one it is
                      actually following, so the badge never reads "null". */}
                  <span
                    className={classNames(
                      'rounded-md px-2 py-0.5 text-xs',
                      alias.strategy ? 'bg-line-strong/40 text-subtle' : 'bg-accent/15 text-accent',
                    )}
                    title={alias.strategy ? t('This alias has its own strategy') : t('Following the default from Settings')}
                  >
                    {alias.strategy ?? `${defaultStrategy} (from Settings)`}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {targets.length === 0 ? (
                      <em>{t('no targets')}</em>
                    ) : (
                      targets.map((t, i) => (
                        <span key={t.entry.id} className="flex items-center gap-1.5">
                          {i > 0 && <span className="text-faint">→</span>}
                          <span className="rounded bg-raised/70 px-1.5 py-0.5 font-mono">
                            {t.entry.modelId}
                            <span className="ml-1 text-faint">@{t.endpointName}</span>
                          </span>
                        </span>
                      ))
                    )}
                  </div>
                  <div className="ml-auto flex gap-2">
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAliasModal(alias)}>
                      {t('Edit')}
                    </button>
                    <button
                      className="btn-danger px-2 py-1 text-xs"
                      onClick={async () => {
                        if (!confirm(t('Delete alias "{name}"?', { name: alias.name }))) return;
                        await api.deleteAlias(alias.id);
                        await load();
                      }}
                    >
                      {t('Delete')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {addModelOpen && pool && (
        <AddModelModal
          pool={pool}
          onClose={() => setAddModelOpen(false)}
          onDone={async () => {
            setAddModelOpen(false);
            await load();
          }}
        />
      )}

      {aliasModal && (
        <AliasModal
          alias={aliasModal === 'new' ? null : aliasModal}
          entries={pool?.entries ?? []}
          strategies={strategies}
          defaultStrategy={defaultStrategy}
          onClose={() => setAliasModal(null)}
          onDone={async () => {
            setAliasModal(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * One row per model id, with the per-key rows behind the expand control.
 *
 * The group row carries the roll-up an operator scans for (how many keys serve
 * it, worst-case health) plus group-wide ping/toggle/remove; the per-entry rows
 * keep the original per-key actions, weight and priority inputs.
 */
function ModelGroupRows({ group, onChanged }: { group: ModelGroup; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const pingGroup = async () => {
    setBusy(true);
    try {
      let ok = 0;
      for (const row of group.entries) {
        const r = await api.pingEntry(row.entry.id);
        if (r.ok) ok += 1;
      }
      toast.push(ok === group.entryCount ? 'ok' : 'bad', `Pinged ${group.entryCount} keys — ${ok} healthy.`);
      await onChanged();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleGroup = async () => {
    setBusy(true);
    try {
      const enable = group.enabledCount < group.entryCount;
      for (const row of group.entries) await api.updateEntry(row.entry.id, { enabled: enable });
      toast.push('info', enable ? t('{n} keys enabled.', { n: group.entryCount }) : t('{n} keys disabled.', { n: group.entryCount }));
      await onChanged();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async () => {
    if (!confirm(t('Remove {model} from the pool on all {n} keys?', { model: group.modelId, n: group.entryCount }))) return;
    setBusy(true);
    try {
      for (const row of group.entries) await api.deleteEntry(row.entry.id);
      toast.push('info', t('{model} removed from the pool.', { model: group.modelId }));
      await onChanged();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const allEnabled = group.enabledCount === group.entryCount;

  return (
    <>
      <tr className={classNames('align-top', 'row-hover', allEnabled ? '' : 'opacity-50')}>
        <td className="td">
          <div className="flex items-center gap-1.5">
            <button
              className="flex min-w-0 items-center gap-1.5 font-mono text-fg"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              title={open ? t('Hide the keys serving this model') : t('Show the keys serving this model')}
            >
              <span className="text-muted">
                <Icon
                  name="chevron"
                  size={12}
                  className={'transition-transform duration-200 ease-out ' + (open ? 'rotate-0' : '-rotate-90')}
                />
              </span>
              <span className="truncate">{group.modelId}</span>
            </button>
            <CopyModelId value={group.modelId} />
          </div>
        </td>
        <td className="td text-right font-mono tabular-nums">{group.keyCount}</td>
        <td className="td text-right font-mono tabular-nums">{group.upstreamCount}</td>
        <td className="td">
          <StatusBadge level={group.level} />
          <p className="mt-0.5 text-[10px] text-faint">
            {group.healthyCount}/{group.entryCount} healthy
          </p>
        </td>
        <td className="td text-right font-mono text-xs text-subtle">{formatMs(group.averagePingMs)}</td>
        <td className="td text-xs text-muted">{formatRelative(group.lastUsedAt)}</td>
        <td className="td text-right font-mono tabular-nums text-subtle">{group.totalWeight}</td>
        <td className="td text-right font-mono tabular-nums text-subtle">
          {group.bestPriority === Number.MAX_SAFE_INTEGER ? 0 : group.bestPriority}
        </td>
        <td className="td">
          <div className="flex justify-end gap-1.5">
            <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void pingGroup()}>
              {t('Ping')}
            </button>
            <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void toggleGroup()}>
              {allEnabled ? t('Off') : t('On')}
            </button>
            <button
              className="btn-danger flex h-6 w-6 items-center justify-center"
              aria-label={t('Remove every key for {model}', { model: group.modelId })}
              disabled={busy}
              onClick={() => void removeGroup()}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </td>
      </tr>

      {open &&
        group.entries.map((row) => (
          <EntryLine key={row.entry.id} row={row} detail onChanged={onChanged} />
        ))}
    </>
  );
}

function EntryLine({
  row,
  detail = false,
  onChanged,
}: {
  row: EntryRow;
  /** Nested under its model row, so the model column is left to the parent. */
  detail?: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const level = entryHealthLevel(row);

  return (
    <tr className={classNames(detail && 'bg-canvas/40', row.entry.enabled ? '' : 'opacity-50')}>
      <td className="td pl-8 font-mono text-xs text-muted">{detail ? 'key' : row.entry.modelId}</td>
      <td className="td">
        <span className="block truncate max-w-[180px] text-subtle">{row.endpointName}</span>
        <span className="block truncate font-mono text-xs text-faint">{row.baseUrl}</span>
      </td>
      <td className="td font-mono text-xs text-muted">{maskKey(row.keyHint)}</td>
      <td className="td">
        <StatusBadge level={level} />
        {row.entry.lastError && (
          <p className="mt-1 max-w-[220px] truncate text-xs text-bad/70" title={row.entry.lastError}>
            {row.entry.lastError}
          </p>
        )}
      </td>
      <td className="td text-right font-mono text-xs text-subtle">{formatMs(row.entry.lastPingMs)}</td>
      <td className="td text-xs text-muted">{formatRelative(row.entry.lastUsedAt)}</td>
      <td className="td text-right">
        <input
          className="input w-16 px-2 py-1 text-right font-mono text-xs"
          type="number"
          min={1}
          defaultValue={row.entry.weight}
          onBlur={async (e) => {
            const v = Number(e.target.value);
            if (v !== row.entry.weight) await api.updateEntry(row.entry.id, { weight: v });
          }}
        />
      </td>
      <td className="td text-right">
        <input
          className="input w-16 px-2 py-1 text-right font-mono text-xs"
          type="number"
          min={0}
          defaultValue={row.entry.priority}
          onBlur={async (e) => {
            const v = Number(e.target.value);
            if (v !== row.entry.priority) await api.updateEntry(row.entry.id, { priority: v });
          }}
        />
      </td>
      <td className="td">
        <div className="flex justify-end gap-1.5">
          <button
            className="btn-ghost px-2 py-1 text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.pingEntry(row.entry.id);
                await onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('Ping')}
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs"
            onClick={async () => {
              await api.updateEntry(row.entry.id, { enabled: !row.entry.enabled });
              await onChanged();
            }}
          >
            {row.entry.enabled ? t('Off') : t('On')}
          </button>
          <button
            className="btn-danger px-2 py-1 text-xs"
            aria-label={t('Remove {model} from the pool', { model: row.entry.modelId })}
            onClick={async () => {
              if (!confirm(t('Remove this model from the pool?'))) return;
              await api.deleteEntry(row.entry.id);
              await onChanged();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function AliasModal({
  alias,
  entries,
  strategies,
  defaultStrategy,
  onClose,
  onDone,
}: {
  alias: Alias | null;
  entries: EntryRow[];
  strategies: { name: string; description: string }[];
  defaultStrategy: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(alias?.name ?? '');
  // Empty string means "inherit", which is null on the wire. A new alias starts
  // inheriting so a strategy chosen in Settings reaches it too.
  const [strategy, setStrategy] = useState(alias?.strategy ?? '');
  const [targets, setTargets] = useState<string[]>(alias?.targets ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const move = (index: number, dir: -1 | 1) => {
    const next = [...targets];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j] as string, next[index] as string];
    setTargets(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = strategy === '' ? null : strategy;
      if (alias) await api.updateAlias(alias.id, { name: name.trim(), strategy: chosen, targets });
      else await api.createAlias({ name: name.trim(), strategy: chosen, targets });
      toast.push('ok', t('Alias "{name}" saved.', { name: name.trim() }));
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={alias ? `Edit alias ${alias.name}` : 'New alias'} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="al-name">{t('Name clients will request')}</label>
            <input id="al-name" className="input font-mono" placeholder="my-coding-stack" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="al-strategy">{t('Strategy within a step')}</label>
            <select id="al-strategy" className="input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="">{t('Use the default from Settings')}</option>
              {strategies.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              {strategy === ''
                ? `Following Settings, so this alias currently routes as ${defaultStrategy || 'the default'}. Change the default and it follows.`
                : `${strategies.find((s) => s.name === strategy)?.description} This alias uses its own strategy instead of the default in Settings, and it stays until you change it here.`}
            </p>
          </div>
        </div>

        <div>
          <p className="label">{t('Failover order')}</p>
          <p className="mb-2 text-xs text-muted">
            {t('Step 1 is tried first. If it errors, KeyPool moves to step 2, and so on. Order is what defines the chain.')}
          </p>
          {entries.length === 0 ? (
            <p className="text-sm text-muted">{t('No pooled entries to choose from yet.')}</p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {entries.map((row) => {
                const idx = targets.indexOf(row.entry.id);
                const checked = idx !== -1;
                return (
                  <li
                    key={row.entry.id}
                    className={`flex items-center gap-2 rounded-[var(--radius-control)] border px-2.5 py-2 ${
                      checked ? 'border-accent/40 bg-accent/5' : 'border-line'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={checked}
                      onChange={() => setTargets(checked ? targets.filter((t) => t !== row.entry.id) : [...targets, row.entry.id])}
                    />
                    <span className="font-mono text-sm text-fg">{row.entry.modelId}</span>
                    <span className="truncate text-xs text-muted">{row.endpointName}</span>
                    {checked && (
                      <span className="ml-auto flex items-center gap-1">
                        <span className="mr-1 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-xs text-accent">#{idx + 1}</span>
                        <button
                          className="btn-ghost flex h-6 w-6 items-center justify-center"
                          aria-label={t('Move {model} up', { model: row.entry.modelId })}
                          onClick={() => move(idx, -1)}
                        >
                          <Icon name="arrowUp" size={12} />
                        </button>
                        <button
                          className="btn-ghost flex h-6 w-6 items-center justify-center"
                          aria-label={t('Move {model} down', { model: row.entry.modelId })}
                          onClick={() => move(idx, 1)}
                        >
                          <Icon name="arrowDown" size={12} />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? t('Saving…') : t('Save alias')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Copies a model id verbatim.
 *
 * The id is what a client puts in its `model` field, and it routinely carries
 * a slash, so transcribing one by hand is exactly where a character gets lost
 * and the client is told the pool does not know a model it is advertising.
 *
 * The confirmation is a toast plus a brief tick in the button itself, not a
 * "Copied!" label: a label swap would reflow the column, and this button sits
 * once per model row in a table that can hold a hundred of them.
 */
function CopyModelId({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const resetTimer = useRef<number | null>(null);

  // The tick is cosmetic, so the timer is cleared on unmount rather than left
  // to fire into a component that is no longer there.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <button
      className="btn-ghost flex h-6 w-6 shrink-0 items-center justify-center text-muted hover:text-fg"
      aria-label={'Copy the model id ' + value}
      title={t('Copy this model id')}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.push('ok', t('Copied {value}', { value }));
          if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
          resetTimer.current = window.setTimeout(() => setDone(false), 1400);
        } catch {
          // A clipboard write fails outside a secure context. The id is still
          // on screen and selectable, so this is a note rather than an alarm.
          toast.push('bad', t('Clipboard unavailable - select the id and copy it manually.'));
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={12} />
    </button>
  );
}

/**
 * Binds a model id to keys that already exist on an upstream.
 *
 * This is the other direction from adding an upstream: the base URL and the
 * key are already in the pool, and what is missing is a name that upstream
 * will actually serve. So the operator names the model, picks the upstream
 * that has it, and the id is bound to that upstream's keys - after which
 * GET /v1/models advertises it and the router treats it like any other.
 *
 * Weight and priority are asked for here rather than left to defaults because
 * a name bound to fifty keys with the wrong weight is a routing problem the
 * operator will not discover until traffic looks wrong.
 */
function AddModelModal({
  pool,
  onClose,
  onDone,
}: {
  pool: PoolSnapshot;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [modelId, setModelId] = useState('');
  const [endpointId, setEndpointId] = useState(pool.endpoints[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [weight, setWeight] = useState('1');
  const [priority, setPriority] = useState('100');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // An entry names a credential and only a credential names its upstream, so
  // "which models does this upstream already serve" is answered through that
  // hop rather than by a second copy of it on the row.
  const endpointOfCredential = useMemo(
    () => new Map(pool.credentials.map((c) => [c.credential.id, c.credential.endpointId])),
    [pool.credentials],
  );

  const keys = useMemo(
    () => pool.credentials.filter((c) => c.credential.endpointId === endpointId && !c.credential.disabled),
    [pool.credentials, endpointId],
  );

  const boundHere = useMemo(
    () =>
      new Set(
        pool.entries
          .filter((e) => endpointOfCredential.get(e.entry.credentialId) === endpointId)
          .map((e) => e.entry.modelId),
      ),
    [pool.entries, endpointOfCredential, endpointId],
  );

  // Picking an upstream pre-selects all of its keys, because binding a model
  // to one key of a fifty-key upstream is the exception, not the intent.
  useEffect(() => {
    setPicked(
      pool.credentials
        .filter((c) => c.credential.endpointId === endpointId && !c.credential.disabled)
        .map((c) => c.credential.id),
    );
  }, [endpointId, pool.credentials]);

  const toggleKey = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    const id = modelId.trim();
    if (!id) {
      setError(t('A model id is required.'));
      return;
    }
    if (picked.length === 0) {
      setError(t('Choose at least one key to bind the model to.'));
      return;
    }
    setBusy(true);
    setError(null);

    let created = 0;
    let already = 0;
    let pinged = 0;
    const failures: string[] = [];
    try {
      for (const credentialId of picked) {
        try {
          const r = await api.addEntry({
            credentialId,
            modelId: id,
            weight: Number(weight) || 1,
            priority: Number(priority) || 100,
          });
          if (r.created) created += 1;
          else already += 1;
          if (r.ping?.ok) pinged += 1;
        } catch (err) {
          // One key refusing the binding must not abandon the other 49, so
          // each failure is collected and the run continues.
          failures.push((err as Error).message);
        }
      }
    } finally {
      setBusy(false);
    }

    if (created === 0 && already === 0) {
      setError(failures[0] ?? t('Nothing was bound.'));
      return;
    }

    const parts = [t('{n} bound', { n: created }), t('{n} already present', { n: already })];
    if (pinged > 0) parts.push(t('{n} answered the ping', { n: pinged }));
    toast.push(failures.length > 0 ? 'info' : 'ok', id + ': ' + parts.join(' · ') + '.');
    if (failures.length > 0) toast.push('bad', failures[0] as string);
    await onDone();
  };

  const selected = pool.endpoints.find((e) => e.id === endpointId);
  const keyCount = (id: string) =>
    pool.credentials.filter((c) => c.credential.endpointId === id && !c.credential.disabled).length;

  return (
    <Modal title={t('Add a model')} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}

        <p className="text-sm text-muted">
          {t('Name a model the chosen upstream will serve, and bind it to that upstream\'s existing keys. It appears in the model catalogue as soon as it is bound.')}
        </p>

        <div>
          <label className="label" htmlFor="am-model">
            {t('Model id')}
          </label>
          <input
            id="am-model"
            className="input font-mono"
            placeholder="model-id"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            autoFocus
          />
          <p className="mt-1 text-xs text-muted">
            {t('Spelled exactly as the upstream knows it. A slash is part of the name, not a separator.')}
          </p>
        </div>

        <div>
          <span className="label">{t('Upstream to bind it to')}</span>
          {pool.endpoints.length === 0 ? (
            <p className="text-sm text-muted">
              {t('No upstreams yet. Add a base URL and key on the Upstreams page first.')}
            </p>
          ) : (
            <div className="space-y-1.5" role="radiogroup" aria-label={t('Upstream to bind the model to')}>
              {pool.endpoints.map((e: Endpoint) => (
                <label
                  key={e.id}
                  className={classNames(
                    'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border px-3 py-2 transition-colors duration-150',
                    endpointId === e.id ? 'border-line-strong bg-raised' : 'border-line bg-inset hover:bg-raised',
                  )}
                >
                  <input
                    type="radio"
                    name="am-endpoint"
                    className="accent-[var(--ink-accent)]"
                    checked={endpointId === e.id}
                    onChange={() => setEndpointId(e.id)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-fg">{e.name}</span>
                    <span className="block truncate font-mono text-xs text-faint">{e.baseUrl}</span>
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{keyCount(e.id)} keys</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {keys.length > 0 && (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">{t('Keys to bind')}</span>
              <button
                className="text-xs text-muted hover:text-fg"
                onClick={() => setPicked(picked.length === keys.length ? [] : keys.map((k) => k.credential.id))}
              >
                {picked.length === keys.length ? t('Clear all') : t('Select all')}
              </button>
            </div>
            <div className="mt-1.5 max-h-52 space-y-1 overflow-y-auto">
              {keys.map((k) => {
                const on = picked.includes(k.credential.id);
                return (
                  <label
                    key={k.credential.id}
                    className={classNames(
                      'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border px-3 py-1.5 transition-colors duration-150',
                      on ? 'border-line-strong bg-raised' : 'border-line bg-inset hover:bg-raised',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--ink-accent)]"
                      checked={on}
                      onChange={() => toggleKey(k.credential.id)}
                    />
                    <span className="font-mono text-xs text-fg">{maskKey(k.credential.keyHint)}</span>
                    <span className="truncate text-xs text-muted">{k.credential.label ?? 'key'}</span>
                    <span className="ml-auto shrink-0 text-xs text-faint">
                      {k.entryCount} model{k.entryCount === 1 ? '' : 's'}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="am-weight">
              {t('Weight')}
            </label>
            <input
              id="am-weight"
              className="input"
              type="number"
              min={1}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">{t('Relative share under the weighted strategy.')}</p>
          </div>
          <div>
            <label className="label" htmlFor="am-priority">
              {t('Priority')}
            </label>
            <input
              id="am-priority"
              className="input"
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">{t('Lower drains first under the priority strategy.')}</p>
          </div>
        </div>

        {boundHere.size > 0 && (
          <p className="text-xs text-muted">
            {selected?.name ?? 'This upstream'} already serves <span className="font-mono text-subtle">{boundHere.size}</span>{' '}
            model{boundHere.size === 1 ? '' : 's'}
            <span className="ml-1 font-mono text-faint">
              {[...boundHere].slice(0, 3).join(', ')}
              {boundHere.size > 3 ? '…' : ''}
            </span>
          </p>
        )}

        {picked.length > 10 && (
          <p className="text-xs text-warn">
            {t('Binding to {n} keys spreads each request across {n} accounts. If the upstream enforces per-account limits, a smaller set keeps the traffic concentrated and the accounts alive.', { n: picked.length })}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || pool.endpoints.length === 0}>
            {busy ? t('Binding…') : t('Bind to ') + picked.length + ' key' + (picked.length === 1 ? '' : 's')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
