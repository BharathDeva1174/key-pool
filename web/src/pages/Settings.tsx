import { useCallback, useEffect, useState } from 'react';
import { adminKey, ApiError, api, setAdminKey, type Settings, type SettingsResponse } from '../lib/api';
import { Card, ErrorNote, Spinner, Toggle, useToast } from '../components/ui';
import { classNames } from '../lib/format';
import { LANGUAGES, setLanguage, t, useLanguage } from '../lib/i18n';

export default function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * The strategy the server last confirmed is in force, kept apart from the
   * draft so the "Active" badge always describes what is really routing
   * traffic. A half-saved draft must never be shown as active, and a saved
   * choice must not be lost when an unrelated edit is thrown away.
   */
  const [activeStrategy, setActiveStrategy] = useState('');
  /** Name of the strategy whose save is in flight, or null. */
  const [pickingStrategy, setPickingStrategy] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  /** A rotation in flight, so the button cannot be pressed twice. */
  const [rotating, setRotating] = useState(false);
  const [needsRestart, setNeedsRestart] = useState<string[]>([]);
  /**
   * Whether this tab already holds a dashboard key, and the one being typed.
   *
   * Read from storage on mount rather than tracked, so a reload does not leave
   * the page claiming the admin API is locked when it is not.
   */
  const [hasAdminKey, setHasAdminKey] = useState(() => adminKey() !== '');
  const [adminKeyDraft, setAdminKeyDraft] = useState('');
  /**
   * The admin API answered 401, so the page is locked out rather than broken.
   *
   * This has to be its own state: rendering the ordinary error would leave no
   * way back in, because the very settings read that reports the lock is the
   * request being refused.
   */
  const [locked, setLocked] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.settings();
      setData(res);
      setDraft(res.settings);
      setActiveStrategy(res.settings.defaultStrategy);
      if (res.bootstrapUnifiedKey) setRevealedKey(res.bootstrapUnifiedKey);
      // Fetched on its own rather than read out of the settings payload, and a
      // failure is swallowed: the key is one field on a page full of settings,
      // and losing it must not blank the page.
      //
      // A failure must also not *clear* a key that is already on screen. Setting
      // state to null here made a key the operator had just rotated disappear
      // whenever the route was unreachable - a server still on an older build,
      // say - which reads as the key being lost rather than a request failing.
      const keyRes = await api.unifiedKey().catch(() => null);
      if (keyRes) setRevealedKey(keyRes.key);
      setError(null);
      setLocked(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setLocked(true);
        setAdminKeyDraft('');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label={t('Loading settings…')} />;
  if (locked) {
    return (
      <div className="mx-auto max-w-md space-y-4 pt-16">
        <h1 className="text-xl font-semibold text-fg">{t('Dashboard is locked')}</h1>
        <p className="text-sm text-muted">
          {t('The admin API requires the unified API key. Enter the same key your clients use to get back in.')}
        </p>
        <div className="flex gap-2">
          <input
            className="input flex-1 font-mono"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder="sk-keypool-..."
            value={adminKeyDraft}
            onChange={(e) => setAdminKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !adminKeyDraft.trim()) return;
              setAdminKey(adminKeyDraft.trim());
              setAdminKeyDraft('');
              setHasAdminKey(true);
              setLoading(true);
              void load();
            }}
          />
          <button
            className="btn-primary"
            disabled={!adminKeyDraft.trim()}
            onClick={() => {
              setAdminKey(adminKeyDraft.trim());
              setAdminKeyDraft('');
              setHasAdminKey(true);
              setLoading(true);
              void load();
            }}
          >
            {t('Unlock')}
          </button>
        </div>
        <p className="text-xs text-faint">
          {t('The key is kept in this tab only. If you have lost it, rotate it from the client you still hold, or set')}{' '}
          <span className="font-mono">requireApiKeyForAdmin</span> {t('back to false in the database to recover access.')}
        </p>
      </div>
    );
  }
  if (error) return <ErrorNote message={error} />;
  if (!draft || !data) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  /**
   * Picks the routing strategy and stores it on the spot.
   *
   * Sending only this one setting means choosing a strategy never quietly
   * saves the other half-finished edits in the draft, and the choice is in
   * force for the very next request instead of waiting for a Save click.
   */
  const pickStrategy = async (name: string) => {
    if (name === activeStrategy) return;
    setDraft((d) => (d ? { ...d, defaultStrategy: name } : d));
    setPickingStrategy(name);
    try {
      const res = await api.saveSettings({ defaultStrategy: name });
      // The server validates the name and keeps the old one if it refuses, so
      // its answer wins over the optimistic guess. Only this one field is
      // reconciled - the rest of the draft is the operator's unsaved work.
      const confirmed = res.settings.defaultStrategy;
      setDraft((d) => (d ? { ...d, defaultStrategy: confirmed } : d));
      setActiveStrategy(confirmed);
      setNeedsRestart(res.restartRequired);
      if (confirmed === name) {
        toast.push('ok', t('{name} is now the active strategy. It stays until you pick another.', { name }));
      } else {
        toast.push('bad', t('The server would not accept "{name}". Still on {confirmed}.', { name, confirmed }));
      }
    } catch (err) {
      toast.push('bad', (err as Error).message);
      // Put the previous choice back without discarding the rest of the draft.
      setDraft((d) => (d ? { ...d, defaultStrategy: activeStrategy } : d));
    } finally {
      setPickingStrategy(null);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.saveSettings(draft);
      setNeedsRestart(res.restartRequired);
      toast.push(
        'ok',
        res.restartRequired.length
          ? t('Saved. Restart KeyPool to apply: {list}.', { list: res.restartRequired.join(', ') })
          : t('Settings saved. Effective on the next request.'),
      );
      await load();
    } catch (err) {
      toast.push('bad', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const snippet = `${window.location.origin}/v1`;
  // The same pool, spoken the other dialect. An agent whose SDK only speaks
  // Anthropic is pointed here; it authenticates with the same unified key.
  const anthropicSnippet = `${window.location.origin}/anthropic`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('Settings')}</h1>
          <p className="mt-1.5 text-sm text-muted">{t('Changes apply to the next request unless marked as needing a restart.')}</p>
        </div>
        <button className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('Saving…') : t('Save settings')}
        </button>
      </header>

      {needsRestart.length > 0 && (
        <div className="rounded-[var(--radius-control)] border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t('Restart KeyPool for: {list}. Stop run.bat and start it again.', { list: needsRestart.join(', ') })}
        </div>
      )}

      <LanguageCard />

      <Card title={t('Client connection')} subtitle={t('The only thing a client needs to know. Both dialects reach the same pool.')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="label">{t('OpenAI base URL')}</p>
            <div className="flex gap-2">
              <code className="input flex-1 font-mono">{snippet}</code>
              <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(snippet)}>
                {t('Copy')}
              </button>
            </div>
          </div>
          <div>
            <p className="label">{t('Anthropic base URL')}</p>
            <div className="flex gap-2">
              <code className="input flex-1 font-mono">{anthropicSnippet}</code>
              <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(anthropicSnippet)}>
                {t('Copy')}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">
              {t('For clients that speak Anthropic, such as Claude Code. Same key, same pool, same failover. Do not add')}
              <span className="font-mono"> /v1</span> {t('— the client appends its own path to this.')}
            </p>
          </div>
          <div>
            <p className="label">{t('Unified API key')}</p>
            {revealedKey ? (
              <div className="flex gap-2">
                <code className="input flex-1 font-mono text-accent">{revealedKey}</code>
                <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(revealedKey)}>
                  {t('Copy')}
                </button>
              </div>
            ) : (
              <p className="rounded-[var(--radius-control)] border border-line bg-inset px-3 py-2 text-sm text-muted">
                {t('This key predates')} <span className="font-mono text-subtle">data/unified-key.txt</span>{t(', so the plaintext was never written down and cannot be read back. Rotate to mint one you can see.')}
              </p>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <p className="text-xs text-muted">{t('Rotating stops every client on the old key.')}</p>
              <button
                className="btn-ghost"
                aria-busy={rotating}
                disabled={rotating}
                onClick={async () => {
                  if (!confirm(t('Rotate the unified API key? Every client using the old key will start getting 401s.'))) return;
                  setRotating(true);
                  try {
                    const res = await api.rotateKey();
                    setRevealedKey(res.key);
                    toast.push('ok', t('New key generated. Update your clients.'));
                  } catch (err) {
                    toast.push('bad', (err as Error).message);
                  } finally {
                    setRotating(false);
                  }
                }}
              >
                {rotating ? t('Rotating…') : t('Rotate')}
              </button>
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-[var(--radius-control)] border border-line bg-inset p-3">
            <p className="label">{t('OpenAI')}</p>
            <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-subtle">{`curl ${snippet}/chat/completions \\
  -H "Authorization: Bearer ${revealedKey ?? 'sk-keypool-...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"your-model","messages":[{"role":"user","content":"hello"}]}'`}</pre>
          </div>
          <div className="rounded-[var(--radius-control)] border border-line bg-inset p-3">
            <p className="label">{t('Anthropic')}</p>
            <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-subtle">{`curl ${anthropicSnippet}/v1/messages \\
  -H "x-api-key: ${revealedKey ?? 'sk-keypool-...'}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"your-model","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}'`}</pre>
          </div>
        </div>
      </Card>

      <Card title={t('Access control')} subtitle={t('KeyPool binds to loopback by default so nothing else on the network can reach it.')}>
        <Toggle
          checked={draft.requireApiKey}
          onChange={(v) => set('requireApiKey', v)}
          label={t('Require the unified API key on /v1')}
          hint={t('Strongly recommended. Turn this off only if something else already guards the port.')}
        />
        <Toggle
          checked={draft.requireApiKeyForAdmin}
          onChange={(v) => set('requireApiKeyForAdmin', v)}
          label={t('Require the key on the dashboard API too')}
          hint={t('Off by default, which means any local process can read your config, trigger pings and export every stored key.')}
        />

        {draft.requireApiKeyForAdmin && (
          <div className="mt-4 rounded-[var(--radius-control)] border border-line bg-inset p-3">
            <label className="label" htmlFor="st-admin-key">{t('Dashboard key')}</label>
            <p className="mb-2 text-xs text-muted">
              {t('The dashboard has no login, so once this switch is on it needs the same unified key your clients use. It is kept in this tab only and forgotten when the tab closes. Enter it')} <em>{t('before')}</em> {t('saving, or the next request comes back 401 and the page goes quiet.')}
            </p>
            <div className="flex gap-2">
              <input
                id="st-admin-key"
                className="input flex-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder={hasAdminKey ? t('•••••••• stored for this tab') : 'sk-keypool-...'}
                value={adminKeyDraft}
                onChange={(e) => setAdminKeyDraft(e.target.value)}
              />
              <button
                className="btn-ghost"
                disabled={!adminKeyDraft.trim()}
                onClick={() => {
                  setAdminKey(adminKeyDraft.trim());
                  setAdminKeyDraft('');
                  setHasAdminKey(true);
                  toast.push('ok', t('Dashboard key stored for this tab.'));
                }}
              >
                {t('Use this key')}
              </button>
              {hasAdminKey && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setAdminKey('');
                    setHasAdminKey(false);
                    toast.push('info', t('Dashboard key cleared.'));
                  }}
                >
                  {t('Clear')}
                </button>
              )}
            </div>
            {!hasAdminKey && (
              <p className="mt-2 text-xs text-warn">
                {t('No dashboard key stored yet. Save will lock this page out until you come back with the key.')}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title={t('Routing')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <p className="label" id="st-strategy-label">{t('Routing strategy')}</p>
            <p className="mb-2 text-xs text-muted">
              {t('How a request picks between the keys serving the same model. The chosen strategy is saved the moment you pick it and stays in force until you choose a different one — across page reloads and restarts. An alias can override it for its own chain.')}
            </p>
            <div
              id="st-strategy"
              role="radiogroup"
              aria-labelledby="st-strategy-label"
              className="grid gap-2 sm:grid-cols-2"
            >
              {data.strategies.map((s) => {
                const active = s.name === activeStrategy;
                const pending = pickingStrategy === s.name;
                return (
                  <button
                    key={s.name}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-busy={pending}
                    data-strategy={s.name}
                    disabled={pickingStrategy !== null || active}
                    onClick={() => void pickStrategy(s.name)}
                    className={classNames(
                      'rounded-[var(--radius-control)] border px-3 py-2.5 text-left transition-colors',
                      active
                        ? 'border-accent/50 bg-accent/10'
                        : 'border-line bg-canvas/40 hover:border-faint hover:bg-inset/60',
                      pickingStrategy !== null && !active && 'opacity-60',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={active ? 'font-mono text-sm text-accent' : 'font-mono text-sm text-fg'}>
                        {s.name}
                      </span>
                      {active && (
                        <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          {t('Active')}
                        </span>
                      )}
                      {pending && (
                        <span className="rounded bg-line-strong/60 px-1.5 py-0.5 text-[10px] font-medium text-subtle">
                          {t('Saving…')}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-muted">{t(s.description)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="st-attempts">{t('Max attempts per request')}</label>
            <input
              id="st-attempts"
              className="input"
              type="number"
              min={1}
              max={10}
              value={draft.maxAttempts}
              onChange={(e) => set('maxAttempts', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">{t('How many different upstreams to try before giving up.')}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="st-threshold">{t('Breaker threshold')}</label>
            <input
              id="st-threshold"
              className="input"
              type="number"
              min={1}
              value={draft.breakerThreshold}
              onChange={(e) => set('breakerThreshold', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">{t('Consecutive failures before a key is taken out of rotation.')}</p>
          </div>
          <div>
            <label className="label" htmlFor="st-breaker-cool">{t('Breaker cooldown (ms)')}</label>
            <input
              id="st-breaker-cool"
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={draft.breakerCooldownMs}
              onChange={(e) => set('breakerCooldownMs', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">{t('Doubles on each failed probe, capped at the max cooldown below.')}</p>
          </div>
          <div>
            <label className="label" htmlFor="st-cool-base">{t('Rate-limit backoff base (ms)')}</label>
            <input
              id="st-cool-base"
              className="input"
              type="number"
              min={100}
              step={100}
              value={draft.cooldownBaseMs}
              onChange={(e) => set('cooldownBaseMs', Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="st-cool-max">{t('Rate-limit backoff max (ms)')}</label>
            <input
              id="st-cool-max"
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={draft.cooldownMaxMs}
              onChange={(e) => set('cooldownMaxMs', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">{t('A 429 with a Retry-After header always wins over this.')}</p>
          </div>
          <div>
            <label className="label" htmlFor="st-refusal">{t('Refusal threshold')}</label>
            <input
              id="st-refusal"
              className="input"
              type="number"
              min={1}
              value={draft.refusalThreshold}
              onChange={(e) => set('refusalThreshold', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">
              {t('Consecutive upstream refusals behind a 200 before a key counts as failing. Kept apart from the breaker threshold because one refusal is usually a bad request, refused alike on every key.')}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="st-stall">{t('Stream stall timeout (ms)')}</label>
            <input
              id="st-stall"
              className="input"
              type="number"
              min={5000}
              step={1000}
              value={draft.streamStallTimeoutMs}
              onChange={(e) => set('streamStallTimeoutMs', Number(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted">
              {t('How long a stream may go without a byte before it is treated as stalled. Measured between chunks, so it never cuts off a slow but healthy answer.')}
            </p>
          </div>
        </div>
      </Card>

      <Card title={t('Network')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="st-host">{t('Bind address (restart)')}</label>
            <input id="st-host" className="input font-mono" value={draft.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} />
            <p className="mt-1 text-xs text-muted">{t('Keep 127.0.0.1 unless you are deliberately exposing the proxy.')}</p>
          </div>
          <div>
            <label className="label" htmlFor="st-port">{t('Port (restart)')}</label>
            <input
              id="st-port"
              className="input font-mono"
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(e) => set('port', Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="st-req-timeout">{t('Request timeout (ms)')}</label>
            <input
              id="st-req-timeout"
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={draft.requestTimeoutMs}
              onChange={(e) => set('requestTimeoutMs', Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="st-connect-timeout">{t('Connect timeout (ms)')}</label>
            <input
              id="st-connect-timeout"
              className="input"
              type="number"
              min={1000}
              step={1000}
              value={draft.connectTimeoutMs}
              onChange={(e) => set('connectTimeoutMs', Number(e.target.value))}
            />
          </div>
        </div>
      </Card>

      <Card title={t('Data and diagnostics')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="st-retention">{t('Log retention (days)')}</label>
            <input
              id="st-retention"
              className="input"
              type="number"
              min={1}
              value={draft.logRetentionDays}
              onChange={(e) => set('logRetentionDays', Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="st-ping-conc">{t('Bulk ping concurrency')}</label>
            <input
              id="st-ping-conc"
              className="input"
              type="number"
              min={1}
              max={50}
              value={draft.bulkPingConcurrency}
              onChange={(e) => set('bulkPingConcurrency', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="mt-3 divide-y divide-line">
          <Toggle checked={draft.logRequests} onChange={(v) => set('logRequests', v)} label={t('Record request stats')} hint={t('Turning this off disables the Stats and Log pages.')} />
          <Toggle checked={draft.autoPingOnAdd} onChange={(v) => set('autoPingOnAdd', v)} label={t('Ping new keys automatically')} />
        </div>
        <button
          className="btn-ghost mt-3"
          onClick={async () => {
            if (!confirm(t('Reset all health state? Keys and models are kept; every key returns to untested.'))) return;
            const res = await api.resetHealth();
            toast.push('ok', t('Reset health for {n} entries.', { n: res.reset }));
            await load();
          }}
        >
          {t('Reset all health state')}
        </button>
      </Card>

      <Card title={t('Strategy notes')} subtitle={t('What the active choice means for the pool right now.')}>
        <ul className="divide-y divide-line">
          <li className="py-2 text-sm text-subtle">
            <span className="font-mono text-accent">{activeStrategy}</span> {t('is active for every model. It is stored with your settings the moment you pick it, so it survives a reload and a restart and keeps applying until you pick another one here.')}
          </li>
          <li className="py-2 text-sm text-subtle">
            {t('An alias follows this strategy unless you give it one of its own — set that under')}{' '}
            <span className="font-mono text-subtle">Models → Aliases</span>.
          </li>
          <li className="py-2 text-sm text-subtle">
            <span className="font-mono text-subtle">failover</span> {t('always starts from the first key you added, while')}{' '}
            <span className="font-mono text-subtle">priority</span> {t('starts from the lowest priority number. They differ once a model entry has a priority other than the default.')}
          </li>
          <li className="py-2 text-sm text-subtle">
            {t('Whatever the strategy, an unhealthy key is filtered out before it is ordered, so no strategy will spend an attempt on a key that is known to be down.')}
          </li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * The dashboard language, kept in this browser.
 *
 * A client-side preference rather than a server setting: it must apply before
 * the first fetch resolves, follow the operator across every screen including
 * the locked one, and never need a restart. The names are shown in their own
 * script on purpose - a user who cannot read the current language cannot read
 * a description of their language, but they can recognise its name.
 */
function LanguageCard() {
  const language = useLanguage();
  return (
    <Card title={t('Language')} subtitle={t('The dashboard language is saved in this browser and applies immediately.')}>
      <div role="radiogroup" aria-label={t('Language')} className="grid gap-2 sm:grid-cols-4">
        {LANGUAGES.map((l) => {
          const active = l.code === language.code;
          return (
            <button
              key={l.code}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setLanguage(l.code)}
              className={classNames(
                'rounded-[var(--radius-control)] border px-3 py-2 text-left text-sm transition-colors',
                active
                  ? 'border-accent/50 bg-accent/10 font-medium text-fg'
                  : 'border-line bg-canvas/40 text-muted hover:border-faint hover:bg-inset/60 hover:text-fg',
              )}
            >
              {l.name}
              {active && (
                <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  {t('Active')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
