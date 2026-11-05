import { Card } from '../components/ui';
import { t } from '../lib/i18n';
import { Icon } from '../components/Icon';
import { Mermaid } from '../components/Mermaid';

const REQUEST_PATH = `flowchart TD
    C["Client<br/>OpenAI or Anthropic dialect"] --> P["KeyPool<br/>one local process, one unified key"]
    P --> R{"Resolve the name"}
    R -->|alias| AL["Specific keys<br/>in a declared order"]
    R -->|spoof| SP["Target model's whole pool"]
    R -->|model id| MD["That model's pool"]
    AL --> HF["Health filter<br/>drop keys known to be down"]
    SP --> HF
    MD --> HF
    HF --> SO["Strategy orders the keys<br/>round-robin, weighted, priority and friends"]
    SO --> LP["Attempt loop<br/>fail over until the first byte"]
    LP -->|"attempt fails"| SO
    LP -->|"first byte arrives"| RL["Relay the response"]
    LP --> LG["Record every attempt"]
    RL --> LG`;

const SPOOF_PATH = `flowchart LR
    CD["Claude desktop app<br/>asks for claude-opus-4"] --> KP["KeyPool<br/>Anthropic dialect at /anthropic/v1"]
    KP --> SP["Spoof maps the name<br/>claude-opus-4 → your-model-id"]
    SP --> PL["The target model's pool<br/>every bound key"]
    PL --> K1["Key 1"]
    PL --> K2["Key 2"]
    PL --> K3["Key 3"]
    K1 --> U["Upstream"]
    K2 --> U
    K3 --> U`;

const HEALTH_STATES = `stateDiagram-v2
    direction LR
    [*] --> untested: a key begins untested
    untested --> healthy: a ping or request succeeds
    healthy --> cooldown: a 429, honours Retry-After
    cooldown --> healthy: the cooldown expires
    healthy --> auth_error: a 401 or 403
    auth_error --> healthy: only a re-ping recovers it
    healthy --> breaker_open: the fail streak crosses the threshold
    breaker_open --> probing: the guarded half-open probe
    probing --> healthy: the probe succeeds
    probing --> breaker_open: the probe fails, the window doubles`;

export default function About() {
  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('About')}</h1>
        <p className="mt-1.5 text-sm text-muted">
          {t('What KeyPool is, how it works, what makes it different, and where everything lives.')}
        </p>
      </header>

      <Card
        title={t('What is KeyPool?')}
        subtitle={t('The instrument this dashboard operates, end to end.')}
      >
        <div className="text-sm">
          <p className="text-muted">
            {t('KeyPool is a local key-pooling proxy. You register each upstream as a base URL, an API key, and the model ids that key serves; every client then points at one address and one key — KeyPool\'s unified key — and the pool decides which upstream key actually serves each request, fails over when one fails, and records what happened.')}
          </p>
          <p className="mt-1.5 text-muted">
            {t('It runs as one process on this machine: the proxy, the admin API behind this dashboard, and the dashboard itself. There is no account, no cloud component, and nothing to deploy.')}
          </p>

          <h3 className="mt-5 text-sm font-semibold text-fg">{t('How it works')}</h3>
          <p className="mt-1.5 text-muted">{t('Every request walks the same path:')}</p>
          <ul className="mt-1.5 space-y-1.5 text-muted">
            <li>
              <strong className="font-medium text-subtle">{t('Resolve the name.')}</strong> {t('An alias wins outright and targets specific keys in a declared order; a spoof redirects to a real model\'s whole pool; anything else is a model id the pool serves directly.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Filter out the unhealthy.')}</strong> {t('Keys with auth errors, open breakers, or active cooldowns never make the list, so no attempt is wasted on a key known to be down.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Order what remains.')}</strong> {t('One of eight strategies — round-robin, weighted, priority, least-used, and so on — decides which key is tried first.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Try, and fail over.')}</strong> {t('A failed attempt moves down the list. Failover only ever happens before the first byte reaches the client; once a stream starts, the upstream response is the only valid continuation.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Record it.')}</strong> {t('Every request — strategy chosen, attempts, tokens, latency, errors — lands in the request log, and every number on this dashboard is aggregated from that log in SQL.')}</li>
          </ul>
          <p className="mt-1.5 text-muted">
            {t('Two dialects share one pool: OpenAI chat completions at')}{' '}
            <span className="font-mono text-subtle">/v1</span> {t('and the Anthropic Messages dialect at')}{' '}
            <span className="font-mono text-subtle">/anthropic/v1</span>{t('. Anthropic requests are translated at the edge to the OpenAI dialect every upstream speaks, and the answer is translated back.')}
          </p>
          <Mermaid chart={REQUEST_PATH} />
        </div>
      </Card>

      <Card
        title={t('Model spoofing — use any model in any client')}
        subtitle={t('The capability this pool exists to enable.')}
      >
        <div className="text-sm">
          <p className="text-muted">
            {t('A spoof exposes a model id of your choosing and points it at a real model in the pool. When a client asks for that name, KeyPool answers as though the client had asked for the target — served by the target\'s entire pool, with every key behind it staying in rotation.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-inset px-3 py-2.5 text-xs">
            <span className="font-mono text-accent">claude-opus-4</span>
            <Icon name="arrowRight" size={13} className="text-muted" />
            <span className="font-mono">your-model-id</span>
            <span className="text-muted">— served by every key behind that model</span>
          </div>
          <p className="mt-3 text-muted">
            {t('This is what lets a client that insists on its own model names — the Claude desktop app and coding agents included — run on any model in the pool. KeyPool speaks the Anthropic Messages dialect, so the client keeps asking for the name it has always asked for; a spoof points that name at whatever model you want behind it. Nothing in the client changes except the base URL and the key.')}
          </p>
          <p className="mt-1.5 text-muted">
            {t('A spoof is not an alias: an alias targets individual keys in a fixed order, while a spoof targets the model — so naming the model directly would behave identically, and only the name differs. Set one up under')}{' '}
            <strong className="font-medium text-subtle">{t('Model spoofing')}</strong>.
          </p>
          <Mermaid chart={SPOOF_PATH} />
        </div>
      </Card>

      <Card
        title={t('Intelligent ranking — what to run for each step')}
        subtitle={t('Advice from the pool\'s own catalogue, not a ranking service.')}
      >
        <div className="text-sm">
          <p className="text-muted">
            {t('The ranking page scores every model in the catalogue — the same one row per model id the Models page shows, never a spoof name — and turns the scores into advice: which model to plan with, which to build with, which to test with, and so on.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-inset px-3 py-2.5 text-xs">
            <span className="font-mono text-accent">{t('Intelligence')} 50%</span>
            <span className="text-muted">+</span>
            <span className="font-mono text-accent">{t('Reliability')} 30%</span>
            <span className="text-muted">+</span>
            <span className="font-mono text-accent">{t('Efficiency')} 20%</span>
            <Icon name="arrowRight" size={13} className="text-muted" />
            <span className="font-mono">{t('Composite')}</span>
          </div>
          <ul className="mt-3 space-y-1.5 text-muted">
            <li>
              <strong className="font-medium text-subtle">{t('Intelligence')}</strong> {t('is a curated prior per model family — public benchmarks and known capability — not a benchmark run here. Unknown families start neutral rather than high.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Reliability')}</strong> {t('is this pool\'s live success rate in the selected window, blended with the health of the keys behind the model. A model with no traffic is scored on health alone and marked untested.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Efficiency')}</strong> {t('blends price per million tokens with observed latency, both on log scales, so free and fast models rise and an unpriced model is marked rather than guessed at.')}</li>
          </ul>
          <p className="mt-3 text-muted">
            {t('The composite sorts the pool into tiers S to C. The role playbook uses its own weights instead: planning leans on intelligence, testing on reliability, long agent runs on efficiency — each with a runner-up named as the fallback.')}
          </p>
          <p className="mt-1.5 text-muted">
            {t('It is advice only: KeyPool routes exactly as before, and nothing on that page changes which key serves a request. The page explains its own maths, so a score can be argued with rather than just trusted.')}
          </p>
        </div>
      </Card>

      <Card
        title={t('What happens when a key fails')}
        subtitle={t('Health is a small state machine per key, and it is visible on the surface, not buried.')}
      >
        <div className="text-sm">
          <p className="text-muted">
            {t('A wrong key is treated as a config problem, not a hiccup: traffic never auto-recovers an auth error, and a failed probe re-opens the breaker with a doubled window. A 404 locks only that key-and-model pair, and a refusal hidden behind a 200 has its own streak — three in a row trips the breaker, and any success clears it.')}
          </p>
          <Mermaid chart={HEALTH_STATES} />
        </div>
      </Card>

      <Card
        title={t('How it is different')}
        subtitle={t('A pool, not a platform.')}
      >
        <div className="text-sm">
          <p className="text-muted">
            {t('Router and gateway tools in this category tend to be platforms: a hosted control plane, an account, a catalogue of providers they maintain, routing decided in someone else\'s cloud. KeyPool is deliberately a pool, not a platform.')}
          </p>
          <ul className="mt-1.5 space-y-1.5 text-muted">
            <li>
              <strong className="font-medium text-subtle">{t('Local, single-operator.')}</strong> {t('One process on your machine for one operator. No login, no tenants, no roles — requests go from this machine straight to the upstream you configured.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Your keys, sealed.')}</strong> {t('Upstream keys are encrypted with AES-256-GCM under a master key file that lives with your data; the dashboard can only ever show the last four characters. The only place a key ever travels is the upstream it belongs to.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('A catalogue you built.')}</strong>{' '}
              <span className="font-mono text-subtle">/v1/models</span> {t('lists exactly what you bound — no provider catalogue maintained on your behalf, no models you did not ask for.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Numbers come from the log.')}</strong> {t('Every dashboard figure is a SQL aggregate over the request log, so the dashboard and the history cannot disagree, and the numbers survive a restart.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('Refusals are counted.')}</strong> {t('An upstream that answers 200 with an error envelope is tracked per key — a refusal streak — instead of vanishing into a success rate, so a silently failing key is visible and eventually retired.')}</li>
            <li>
              <strong className="font-medium text-subtle">{t('One file of storage.')}</strong> {t('SQLite through Node\'s built-in driver — no external database to run, no native module to compile.')}</li>
          </ul>
        </div>
      </Card>

      <Card title={t('The dashboard, section by section')} subtitle={t('What every page is for.')}>
        <ul className="space-y-1.5 text-sm text-muted">
          <li>
            <strong className="font-medium text-subtle">{t('Overview')}</strong> {t('— the wall display: pool health and the day\'s numbers, read at a glance between other work.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Upstreams')}</strong> {t('— the base URLs and every key on them: add and edit upstreams, import keys in bulk, ping, enable or disable, and read breaker states.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Models')}</strong> {t('— the catalogue: bind a model id to keys that already exist, and manage aliases (fallback chains across models).')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Intelligent ranking')}</strong> {t('— the model catalogue ranked on intelligence, reliability and efficiency, with a playbook for plan, build, test, review, docs and long agent runs.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Model spoofing')}</strong> {t('— client-facing names pointed at real pooled models; the highlighted capability above.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Stats')}</strong> {t('— usage for a time range: token flow, latency, errors by kind, and the daily streak.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Costs')}</strong> {t('— what the traffic costs: spend per model, provider and key, priced from a per-million rate table synced from OpenRouter\'s public catalogue. Two outbound fetches carry nothing from your data — the price list and USD exchange rates; every other number on the page is computed from the local request log.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Request log')}</strong> {t('— the record: every request with the model asked for vs the model served, attempts, tokens, error text, and the client it came from. The Console view shows the same record live, one terminal line per request, and its Delete button removes the entries matching the current filters from the log itself.')}
          </li>
          <li>
            <strong className="font-medium text-subtle">{t('Settings')}</strong> {t('— port and binding, security, client identity, retention, the default strategy, and the dashboard language: seven languages, applied instantly and kept in this browser.')}
          </li>
        </ul>
      </Card>

      <Card title={t('Questions')} subtitle={t('The ones that come up on day three.')}>
        <ul className="divide-y divide-line text-sm">
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('Does anything leave my machine?')}</p>
            <p className="mt-1 text-muted">
              {t('Only the requests you send. Each one goes from this machine directly to the upstream you configured. There is no telemetry and no cloud component.')}
            </p>
          </li>
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('Where are my keys stored?')}</p>
            <p className="mt-1 text-muted">
              {t('Upstream keys are sealed with AES-256-GCM under')}{' '}
              <span className="font-mono">data/master.key</span>. {t('The unified client key is stored only as a SHA-256 hash; its plaintext is printed when the server starts. Losing the master key file makes every stored key unrecoverable — by design.')}
            </p>
          </li>
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('What happens when a key fails?')}</p>
            <p className="mt-1 text-muted">
              {t('By failure kind. A 401 or 403 takes the key out of rotation until a ping proves it good again. A 429 starts a cooldown that honours')} <span className="font-mono">{t('Retry-After')}</span>. {t('A 404 locks only that key-and-model pair. A 5xx, timeout or network error increments the fail streak until the breaker opens; a guarded probe tests it before traffic returns.')}
            </p>
          </li>
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('Does failover happen mid-stream?')}</p>
            <p className="mt-1 text-muted">
              {t('No. Failover only happens before the first byte reaches the client. Once a stream has started, the upstream response is the only valid continuation.')}
            </p>
          </li>
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('Do the numbers survive a restart?')}</p>
            <p className="mt-1 text-muted">
              {t('Yes — the dashboard aggregates every figure from the request log in SQL, and health and breaker state are stored per key. Round-robin cursors and latency averages are in-memory only and start fresh.')}
            </p>
          </li>
          <li className="py-2.5">
            <p className="font-medium text-subtle">{t('A client says "no model with that name". What now?')}</p>
            <p className="mt-1 text-muted">
              {t('Almost always the base URL is missing')} <span className="font-mono">/v1</span> {t('(or')}{' '}
              <span className="font-mono">/anthropic/v1</span> {t('for Anthropic clients). Without it the request lands on the dashboard instead of the proxy. Otherwise, the model is not bound to any key — add it under Models.')}</p>
          </li>
        </ul>
      </Card>

      <p className="font-mono text-xs text-faint">{t('KeyPool v2.9')}</p>
    </div>
  );
}
