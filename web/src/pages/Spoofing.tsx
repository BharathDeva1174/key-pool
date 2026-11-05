import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import { api, type Spoof } from '../lib/api';
import { Card, Empty, ErrorNote, Modal, Spinner, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatNumber } from '../lib/format';

type Draft = Spoof | 'new';

/**
 * Names clients may ask for, and the real model each one stands in for.
 *
 * This is deliberately not the alias editor. An alias targets individual pooled
 * entries - a hand-built failover chain across whatever entries were ticked -
 * which is the right tool for "try these in order". A spoof points at a *model*
 * and is served by that model's whole pool, so the operator can hand a coding
 * agent a name of their own choosing and still get the pooling, the breaker and
 * the round-robin cursor that naming the model directly would give them.
 *
 * Both names of every request are recorded either way, so the traffic a spoof
 * carries shows up in the log under the name the client used, with the real
 * model alongside it.
 */
export default function Spoofing() {
  const [spoofs, setSpoofs] = useState<Spoof[]>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [aliasNames, setAliasNames] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [list, pool, traffic] = await Promise.all([api.listSpoofs(), api.pool(), api.byModel('all')]);
      setSpoofs(list);
      // The pickers are driven by what the pool actually serves, so a spoof
      // cannot be pointed at a model that does not exist.
      setModelIds([...new Set(pool.entries.map((e) => e.entry.modelId))].sort((a, b) => a.localeCompare(b)));
      setAliasNames(pool.aliases.map((a) => a.name));
      // Counted from the same log every other number comes from, keyed on the
      // requested name - which for a spoof is the spoof itself.
      setCounts(Object.fromEntries(traffic.map((t) => [t.label, t.requests])));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label={t('Loading model spoofing…')} />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Model spoofing')}</h1>
            {/*
              The button is beside the title, not in the corner above it. A
              control parked in the opposite corner of a header reads as
              belonging to the panel below it, and this one explains the page
              rather than adding a row to it.
            */}
            <button
              onClick={() => setShowGuide(true)}
              aria-label={t('What is model spoofing?')}
              className="-mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)]
                         text-muted transition-colors hover:bg-raised hover:text-accent
                         focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Icon name="info" size={15} />
            </button>
          </div>
          <p className="mt-1.5 text-sm text-muted">
            {t('Give a client a model id of your own choosing. Every request for it is served by the whole pool behind the target model, so naming it directly would change nothing except the name.')}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setDraft('new')} disabled={busy}>
          + New spoof
        </button>
      </header>

      {error && <ErrorNote message={error} />}

      <Card
        title={t('Spoofed model ids')}
        subtitle={t('A name a client can request, and the real model it stands for.')}
        actions={
          <button className="btn-ghost" onClick={() => void load()} disabled={busy}>
            <span className={busy ? 'opacity-60' : undefined}>{t('Refresh')}</span>
          </button>
        }
      >
        {spoofs.length === 0 ? (
          <Empty
            title={t('No spoofed model ids')}
            hint={t('Add one to hand a coding agent a stable name of your own, without giving up the pool behind the model it points at.')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">{t('Spoofed model id')}</th>
                  <th className="th">{t('Routes to')}</th>
                  <th className="th text-right">{t('Requests')}</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {spoofs.map((s) => {
                  const known = modelIds.includes(s.targetModel);
                  return (
                    <tr key={s.id}>
                      <td className="td font-mono text-sm text-accent">{s.name}</td>
                      <td className="td font-mono text-sm">
                        {s.targetModel}
                        {/* A target whose entries are all gone is the one state
                            worth flagging: requests for this name will 503. */}
                        {!known && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">not in the pool</span>}
                      </td>
                      <td className="td text-right font-mono text-xs tabular-nums text-muted">
                        {counts[s.name] ? formatNumber(counts[s.name]) : '—'}
                      </td>
                      <td className="td text-right">
                        <div className="flex justify-end gap-2">
                          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDraft(s)}>
                            {t('Edit')}
                          </button>
                          <button
                            className="btn-danger px-2 py-1 text-xs"
                            onClick={async () => {
                              if (!confirm(t('Delete the spoof "{name}"? Clients asking for it will start getting 503s.', { name: s.name })))
                                return;
                              try {
                                await api.deleteSpoof(s.id);
                                toast.push('ok', t('"{name}" removed.', { name: s.name }));
                                await load();
                              } catch (err) {
                                toast.push('bad', (err as Error).message);
                              }
                            }}
                          >
                            {t('Delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}

      {draft && (
        <SpoofModal
          spoof={draft === 'new' ? null : draft}
          modelIds={modelIds}
          aliasNames={aliasNames}
          onClose={() => setDraft(null)}
          onDone={async () => {
            setDraft(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * What a spoof is, and how to make one.
 *
 * The page's own subtitle says what a spoof does but not what it is for, and the
 * one concept that trips people up - that a spoof is not an alias - cannot be
 * said in a line or two beside a table. So it is said here, once, in full,
 * rather than scattered as caveats across the form.
 */
function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('Model spoofing')} onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <section>
          <h4 className="text-sm font-semibold text-fg">{t('What it does')}</h4>
          <p className="mt-1.5 text-muted">
            {t('A spoof gives a client a model id of your choosing, and points that name at a real model you already serve. When a client asks for the name, KeyPool answers as though it had asked for the target.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-inset px-3 py-2.5 text-xs">
            <span className="font-mono text-accent">claude-opus-4</span>
            <Icon name="arrowRight" size={13} className="text-muted" />
            <span className="font-mono">your-model-id</span>
            <span className="text-muted">— served by every key behind that model</span>
          </div>
        </section>

        <section className="border-t border-line pt-5">
          <h4 className="text-sm font-semibold text-fg">{t('What it is for')}</h4>
          <ul className="mt-1.5 space-y-1.5 text-muted">
            <li>
              <strong className="font-medium text-subtle">{t('Change what a client asks for without editing its config.')}</strong>{' '}
              Point a tool that insists on a particular name at a different model.
            </li>
            <li>
              <strong className="font-medium text-subtle">{t('Keep the pool.')}</strong> {t('A spoof is served by the target\'s whole pool, under that model\'s own round-robin cursor, breaker and health filtering — every key behind it stays in rotation.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Change your mind later.')}</strong> {t('Repoint the name at a different model and every client already using it follows, with nothing to reconfigure.')}</li>
          </ul>
        </section>

        <section className="border-t border-line pt-5">
          <h4 className="text-sm font-semibold text-fg">{t('A spoof is not an alias')}</h4>
          <p className="mt-1.5 text-muted">
            {t('This is the distinction that matters most, and it is the one that decides which tool you reach for.')}
          </p>
          <div className="mt-3 overflow-hidden rounded-[var(--radius-control)] border border-line">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">If you want to…</th>
                  <th className="th">{t('Use a spoof')}</th>
                  <th className="th">{t('Use an alias')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="td">…stand in for one model under another name</td>
                  <td className="td text-accent">{t('Yes')}</td>
                  <td className="td text-muted">No</td>
                </tr>
                <tr>
                  <td className="td">…fall back across <em>different</em> models in order</td>
                  <td className="td text-muted">No</td>
                  <td className="td text-accent">{t('Yes')}</td>
                </tr>
                <tr>
                  <td className="td">…keep every key behind the model in rotation</td>
                  <td className="td text-accent">{t('Yes')}</td>
                  <td className="td text-muted">No</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2.5 text-xs text-muted">
            {t('An alias targets individual keys in a fixed order — “try these, then these”. A spoof targets the')}{' '}
            <em>{t('model')}</em>, {t('so naming the model directly would behave identically; only the name differs. Aliases live under')} <span className="font-medium text-subtle">{t('Models')}</span>.
          </p>
        </section>

        <section className="border-t border-line pt-5">
          <h4 className="text-sm font-semibold text-fg">{t('Working instructions')}</h4>
          <ol className="mt-1.5 space-y-1.5 text-muted">
            <li>
              <span className="font-medium text-subtle">1.</span> {t('Add the model you want to redirect to on')}{' '}
              <span className="font-medium text-subtle">{t('Upstreams')}</span>, {t('so there is something to point at. The')}{' '}
              <em>{t('Routes to')}</em> {t('list here is built from the pool, so it only offers models you actually serve.')}</li>
            <li>
              <span className="font-medium text-subtle">2.</span> {t('Choose')} <span className="font-medium text-subtle">+ New spoof</span>.
            </li>
            <li>
              <span className="font-medium text-subtle">3.</span> {t('Under')} <span className="font-medium text-subtle">{t('Clients will request')}</span>, {t('enter the name the client should ask for. It cannot be a real model id or an alias — both must keep working.')}
            </li>
            <li>
              <span className="font-medium text-subtle">4.</span> {t('Under')} <span className="font-medium text-subtle">{t('Routes to')}</span>, {t('pick the target model.')}
            </li>
            <li>
              <span className="font-medium text-subtle">5.</span> {t('Save, then point the client at the new name. It appears in')} <span className="font-mono">GET /v1/models</span>, {t('so a client that enumerates models will find it.')}
            </li>
          </ol>
        </section>

        <section className="border-t border-line pt-5">
          <h4 className="text-sm font-semibold text-fg">{t('Good to know')}</h4>
          <ul className="mt-1.5 space-y-1.5 text-muted">
            <li>
              <strong className="font-medium text-subtle">{t('Both names are recorded.')}</strong> {t('Requests appear in the request log under the name the client asked for, with the real model beside it.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('A target with no healthy keys will 503.')}</strong> {t('Those rows are')}
              flagged <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">not in the pool</span> {t('below.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('A spoof cannot point at another spoof.')}</strong> {t('One hop only, which keeps resolution a single lookup.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Deleting one breaks the clients using it')}</strong> {t('— they will start getting 503s until you point them somewhere else.')}
            </li>
          </ul>
        </section>

        <div className="flex justify-end border-t border-line pt-4">
          <button className="btn-primary" onClick={onClose}>
            {t('Got it')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SpoofModal({
  spoof,
  modelIds,
  aliasNames,
  onClose,
  onDone,
}: {
  spoof: Spoof | null;
  modelIds: string[];
  aliasNames: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(spoof?.name ?? '');
  const [targetModel, setTargetModel] = useState(spoof?.targetModel ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const trimmed = name.trim();

  /*
   * The same three collisions the server refuses, surfaced here so the operator
   * finds out before a round trip. An alias wins over a spoof at resolution
   * time, and a real model id must keep working, so neither name is available.
   */
  const nameProblem = useMemo(() => {
    if (!trimmed) return null;
    if (trimmed === spoof?.name) return null;
    if (modelIds.includes(trimmed)) return 'That is already a real model id. It must keep working.';
    if (aliasNames.includes(trimmed)) return 'That is already an alias, and an alias wins over a spoof.';
    return null;
  }, [trimmed, spoof, modelIds, aliasNames]);

  const targetProblem =
    modelIds.length > 0 && targetModel && !modelIds.includes(targetModel)
      ? 'That model is not in the pool. Requests for this name will 503 until it is.'
      : null;

  const canSave = Boolean(trimmed) && Boolean(targetModel) && !nameProblem && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (spoof) await api.updateSpoof(spoof.id, { name: trimmed, targetModel });
      else await api.createSpoof({ name: trimmed, targetModel });
      toast.push('ok', t('"{name}" now routes to {target}.', { name: trimmed, target: targetModel }));
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={spoof ? `Edit ${spoof.name}` : 'New spoofed model id'} onClose={onClose}>
      <div className="space-y-4">
        {error && <ErrorNote message={error} />}

        <div>
          <label className="label" htmlFor="sp-name">
            {t('Clients will request')}
          </label>
          <input
            id="sp-name"
            className="input font-mono"
            placeholder="ai-123:free"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {nameProblem && <p className="mt-1 text-xs text-bad">{nameProblem}</p>}
        </div>

        <div>
          <label className="label" htmlFor="sp-target">
            {t('Routes to')}
          </label>
          {modelIds.length === 0 ? (
            <p className="text-sm text-muted">
              No pooled models yet. Add an upstream with a model id on the <strong>{t('Upstreams')}</strong> {t('page first.')}</p>
          ) : (
            <>
              <select
                id="sp-target"
                className="input"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
              >
                <option value="">{t('Choose a model…')}</option>
                {modelIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">
                {t('Served by every key serving that model, under the same round-robin cursor. This is what separates a spoof from an alias, which points at individual keys in a fixed order.')}
              </p>
            </>
          )}
          {targetProblem && <p className="mt-1 text-xs text-warn">{targetProblem}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={!canSave}>
            {busy ? t('Saving…') : t('Save spoof')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
