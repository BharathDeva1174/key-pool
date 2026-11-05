# KeyPool

An OpenAI-compatible pooling proxy with a dashboard, live stats and configurable routing strategies.

You add upstreams as plain **`base_url` + `api_key` + `model_id`** triples. Every OpenAI-compatible client — Claude Code, Cursor, Cline, OpenWebUI, the OpenAI SDKs, `curl` — points at **one unified base URL and one unified API key**, and KeyPool decides which key serves each request.

No provider catalogue. No OAuth. No token-compression tricks. Just a pool, a strategy, and a dashboard.

---

## Quick start

```bash
git clone https://github.com/BharathDeva1174/key-pool.git
cd key-pool
```

**Windows** — the whole thing is one command:

```bat
run.bat
```

On the first run it installs dependencies. Every run then stops any KeyPool already running from this folder, builds the server and dashboard, starts the server and opens the dashboard, printing your unified API key.

**Other OSes, or by hand** — needs Node ≥ 22.5 and pnpm (`corepack enable`, or `npm install -g pnpm`):

```bash
pnpm install
pnpm build
pnpm start        # serves http://127.0.0.1:20121 — dashboard and /v1
```

Same result: the server generates `data/` on first start (an empty SQLite database and a fresh master key) and prints your unified API key.

**It always rebuilds, and it always stops the old one first.** A server loads its code once, at boot — so editing the proxy and re-running the launcher does nothing unless the previous process is actually stopped, and a build that is skipped or stale leaves the old code serving while looking like a fresh start. The build here is unconditional for that reason, and it costs about a second.

The stop step only ever terminates a server started from *this* folder, identified by the exact file it runs. If one refuses to stop, the launcher says so and exits rather than starting a second copy on top of it.

When it prints the key, **save it** — it is also written to `data/unified-key.txt` and shown on the Settings page, so you can always read it back. (You can rotate it there at any time.)

```
Dashboard : http://127.0.0.1:20121/
Base URL  : http://127.0.0.1:20121/v1
API key   : sk-keypool-...        <- printed once
```

Point a client at it:

```bash
curl http://127.0.0.1:20121/v1/chat/completions \
  -H "Authorization: Bearer sk-keypool-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hello"}]}'
```

### Requirements

- Node.js 22.5 or newer (developed and tested on 26)
- pnpm (`corepack enable`, or `npm install -g pnpm`) — the workspace and its `--filter` scripts are pnpm-only; plain `npm install` at the root installs nothing

No Docker, no Go, no native modules. Storage is SQLite via Node's built-in `node:sqlite`.

### Other commands

```bash
pnpm dev         # server + Vite dev server with HMR
pnpm smoke       # end-to-end check against a real booted server
pnpm verify      # build + smoke
pnpm build       # production build
pnpm typecheck   # typecheck both packages
```

---

## Adding an upstream

**Single key** — Upstreams → *Add upstream*. Three fields: base URL, API key, model id. KeyPool pings the model immediately with a one-token request and shows you whether it actually answers.

The base URL field is forgiving. Paste whatever you have:

| You paste | KeyPool stores |
| --- | --- |
| `https://api.example.com` | `https://api.example.com` |
| `https://api.example.com/v1` | `https://api.example.com/v1` |
| `https://api.example.com/v1/` | `https://api.example.com/v1` |
| `https://api.example.com/v1/chat/completions` | `https://api.example.com/v1` |

If the `/v1` prefix is still ambiguous, KeyPool probes `/v1/...` first, retries at the root on a 404, and remembers whichever worked. You can also pin it manually in Settings.

**Bulk keys** — the *Add upstream* dialog has two modes, and you pick one before you type anything:

| Mode | What it does |
| --- | --- |
| **Single key** | One base URL, one API key, one model id. Pings it immediately. |
| **Bulk import** | One base URL, a model id (or several), and a whole list of keys pasted or uploaded. |

In bulk mode the dialog previews exactly what it recognised before you commit, then pings every key with bounded concurrency and shows a pass/fail line per key. It still works on an existing upstream via *Add keys* on that provider's card.

```
sk-key-1
sk-key-2
# comments and blank lines are ignored
Bearer sk-key-3
```

Also accepted:

- **CSV** with a header — `api_key`, `base_url`, `model_id`, `label` (and common aliases)
- **JSON** — an array of strings, an array of objects, or `{ "keys": [...] }`
- **A plain array of keys**, if you are calling the API from a script

Keys are normalised (a `Bearer ` prefix and surrounding quotes are stripped), deduplicated, and keys that already exist on that endpoint are skipped, so re-running an import is safe.

### Editing an upstream

Every provider card has **Edit**, which opens the full configuration: name, base URL, path style (`auto` / `v1` / `root`), authentication style (bearer, custom header, query parameter, or none), extra headers, a compatibility profile, and an enabled toggle. The base URL is normalised on save, so pasting a slightly wrong form is fine.

**View keys** opens every key on that upstream with its label, status, breaker state, failure streak, the models bound to it, and its last error. You can relabel a key, bind a new model to it, enable/disable it, or delete it — all without leaving the dialog.

> Keys are stored encrypted, so the dashboard can only ever show the last four characters. It cannot display a stored key in full, by design.

### OpenCode Zen: when an upstream only serves its own client

The Zen gateway (`https://opencode.ai/zen/v1`) serves some of its free models — `fledge-alpha-free`, `longcat-2.5-preview-free` and siblings — only to requests that look like they come from the opencode client itself. Anything else gets a `403` saying the free tier can only be used from within OpenCode, even though the key is perfectly valid and sibling models the gate does not cover serve fine. Two settings together make pooled requests acceptable to that gate:

1. **Compatibility profile** — set to `opencode-zen` in the upstream's Edit dialog. The proxy then sends the request the way the opencode client does: always streaming, and carrying two of opencode's own tool names when the calling agent's tools wouldn't satisfy the gate. A client that asked not to stream still receives an ordinary JSON completion — the proxy reassembles the frames. Health pings are shaped the same way, so gated models can pass a ping and stay in rotation.

2. **Extra headers** — the identity the gate checks on top of the shape. The opencode client sends a `user-agent` like `opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`, plus `x-opencode-client: cli`, `x-opencode-project: global` and an `x-opencode-session` id that the upstream recognises. Paste these into the upstream's **Extra headers (JSON)**:

   ```json
   {
     "user-agent": "opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
     "x-opencode-client": "cli",
     "x-opencode-project": "global",
     "x-opencode-session": "ses_…from a real opencode client session…",
     "x-opencode-session-id": "ses_…same value…"
   }
   ```

   The session id is the part that has to be genuine: it is minted when a real opencode client runs, and the upstream checks it. If the gate starts refusing again, run any command with the opencode CLI and capture a fresh session id (a local listener that logs request headers is enough), then update the two header values.

> Free-tier access through a proxy is against the gateway's stated policy, and the gate is theirs to tighten — a session id can stop being accepted at any time, and a key can be throttled or banned. The models that are *not* client-gated (paid, and the free models the gate does not cover) need none of this: they work with the key alone.

### Client identity normalization

Every coding agent that speaks a supported protocol — OpenCode, Claude Code, Codex, or any other OpenAI/Anthropic-compatible client — can point at the proxy with no per-agent configuration. Before each upstream attempt, the proxy replaces the client-identification headers it controls with OpenCode-compatible values:

| Upstream header | Normalized value |
| --- | --- |
| `user-agent` | `opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | `global` |

Rules worth knowing:

- The incoming client's own headers are **never forwarded**. A client that sends a spoofed `x-opencode-session` or `x-forwarded-for` gets normalized like any other — its values stop at the proxy.
- The endpoint's **Extra headers** apply **after** the normalized defaults, so an operator-configured value always wins (that is where a genuine `x-opencode-session` id lives). Normalization never overrides what you configured.
- Session ids are **never synthesized**. A fake session id satisfies no gate and risks the key, so the proxy only sends the non-secret markers above; anything secret stays operator-owned.
- Credentials are untouched: the upstream always sees the pooled key, never the client's unified key.
- Applies to `POST /v1/chat/completions`, `POST /anthropic/v1/messages` (and `/v1/messages`), and health pings. Nothing else — the dashboard and admin API send no client identity.

**Configuration.** `clientIdentityMode` in Settings (via `PUT /api/admin/settings`): `"opencode"` (default) normalizes as above; `"off"` restores verbatim relay with no proxy-supplied identity.

**Verification.** Each proxied response carries `x-keypool-client-identity: opencode` when normalization applied, and the server log records one structured line per request at **debug** level (`originalClient`, `normalizedClient`, `normalizationApplied`, provider, status, duration — never headers, keys, or bodies). Set `KEYPOOL_LOG_LEVEL=debug` to see it; at the default level the terminal stays quiet, because the request log in the database is the record of what happened.

**Limitation, stated plainly.** The normalized headers alone do not satisfy a gate that also checks the request body and a genuine session id. If a gated model refuses, the proxy's error now says so directly — naming the `opencode-zen` profile and the Extra-headers session the gate actually requires — instead of sending you chasing a valid key. A User-Agent change was never sufficient, and the error no longer pretends otherwise.

### Anthropic server-side tools are rejected, not dropped

All KeyPool upstreams speak OpenAI chat completions, which has no equivalent of Anthropic server-side tools (`web_search`, code execution, computer use, …). A request whose tools are all server-side — or a `tool_choice` forcing one — used to reach the upstream silently corrupted: the tools vanished while the forced choice pointed at nothing. It now fails fast with a `400` naming the unsupported tool type, so a broken search surfaces as an error instead of a model answering without its tools. Named custom tools (including one *named* `web_search` with an `input_schema`) still translate to ordinary function tools unchanged.

---

## Adding a model to an upstream you already have

Adding an upstream binds one model id per key as you go. **Add model** on the Models page is the other direction: the base URL and the keys are already in the pool, and what is missing is a name that upstream will actually serve.

This matters because upstreams publish far more models than any single key is configured for. One gateway here lists **401** model ids while three were bound — the rest were one dialog away.

1. **Model id** — spelled exactly as the upstream knows it. A slash is part of the name, not a separator (`minimax/minimax-m3`).
2. **Upstream to bind it to** — a base URL already in the pool, with its key count. It shows what that upstream already serves before you commit.
3. **Keys to bind** — every usable key on that upstream, pre-selected. Untick the ones you don't want; the button counts what is ticked.
4. **Weight and priority** — asked for here rather than left to defaults, because a name bound to fifty keys with the wrong weight is a routing problem you will not notice until traffic looks wrong.

The model appears in `GET /v1/models` as soon as it is bound, and the router treats it like any other. Binding is idempotent: a key that already serves the id counts as *already present*, not as an error.

> **A word on breadth.** Binding across every key on an upstream spreads each request across that many accounts. If the upstream enforces per-account limits — free-tier gateways commonly do — a smaller set keeps the traffic concentrated. The dialog says so above ten keys.

Every model id on the Models page has a **copy button** beside it. The id is what a client puts in its `model` field and it routinely contains a slash, so it is exactly the string you do not want to retype.

---

## How routing works

A **model entry** is one concrete `(base_url, api_key, model_id)` triple — the thing you ping, health-check and route to. When several entries serve the same model id they form a **pool**, and a strategy picks between them.

### Strategies

| Strategy | Behaviour |
| --- | --- |
| `round-robin` | Cycle through every healthy key. Default. |
| `random` | Uniform random among healthy keys. |
| `weighted` | Weighted random, honouring each entry's weight. |
| `least-used` | Fewest requests in flight right now. |
| `least-latency` | Lowest observed average latency. |
| `priority` | Always drain the lowest priority number first. |
| `lkgp` | Stay on the key that last worked until it fails. Maximises prompt-cache hits. |
| `failover` | Always the first healthy key; only moves on error. |

Set a default in Settings, and override it per alias.

### Aliases (fallback chains)

An alias exposes one name that fails over across several models in order. `my-coding-stack` might mean "the expensive model, else the cheap one, else the free one" — and the client only ever asks for `my-coding-stack`.

Aliases appear in `GET /v1/models` alongside real models.

### Model names, and why some contain a slash

A model id is whatever the upstream calls it, and vendor-prefixed ids are the
common case: `vendor/model-id`, `minimax/minimax-m3:free`. The slash
is part of the name, not a path separator — but it is a slash, and that has two
consequences worth knowing.

**In a request body it is just a string.** Send it exactly as the upstream
spells it:

```json
{ "model": "vendor/model-id", "messages": [ ... ] }
```

**In a URL it must survive routing.** `GET /v1/models/{id}` matches across
slashes, so both spellings address the same one entry:

```
GET /v1/models/vendor/model-id
GET /v1/models/vendor%2Fmodel-id
```

If a client percent-encodes the slash, that is fine. What is not fine is a
client that treats the model id as a single URL path segment and rejects or
truncates it at the slash — that is the client mangling the name, and no proxy
setting fixes it. KeyPool advertises the name verbatim so a client that copies
it out of `GET /v1/models` gets something it can actually send.

### The `[1m]` context marker

Some agents append a context-window marker to the model name — Claude Code
sends `vendor/model-id[1m]` to ask for the 1M-token variant. That
bracket is a **variant selector, not part of the model's id**: no upstream
gateway has a model by that name, and it will 404 one.

KeyPool strips a trailing `[1m]`, `[200k]` or similar before resolving, so both
spellings reach the same model:

```
vendor/model-id           → serves that model
vendor/model-id[1m]       → serves that model
```

This is a **fallback, not a rewrite**, which matters in two ways. A model
genuinely registered under a bracketed name is still served by that model rather
than being redirected to the bare one; and the marker is only recognised in the
form `[<number><k|m>]`, so `model[nonsense]` is *not* quietly answered with
`model` — it 404s like any other unknown name.

The catalogue advertises only the canonical name. Fetching
`/v1/models/vendor/model-id[1m]` works and returns the **canonical**
`id`, so an agent that copies what it fetched sends a name the pool advertises.

Your request log records both: the marked name as requested, the bare name as
served — the same pairing used for spoofed names.

### If a client says "no model with that name"

Almost always one of three things, in this order:

1. **The base URL is missing `/v1`.** `http://127.0.0.1:20121` serves the
   dashboard, so a request for `/models` returns HTML with a `200` — which
   fails to parse as a catalogue rather than erroring clearly. The OpenAI base
   URL is `http://127.0.0.1:20121/v1`.
2. **The model genuinely is not in the pool.** `GET /v1/models` is the
   authority — it lists exactly what this proxy can route right now, and omits
   any model with no currently-usable key behind it. So a model that was there
   a moment ago can legitimately be absent: every key serving it may be in
   cooldown, or taken out of rotation after an auth error. Advertising a name
   that can only fail would be worse than omitting it.
3. **The name is a spoof or an alias that was deleted.** Both are advertised in
   the same list, so a name that has gone from the list is no longer routable.
4. **The name carries a context marker the pool does not know.** `model[1m]` is
   handled (see above), but a marker in some other shape — or on a model that is
   not in the pool at all — still 404s. The error names the bare model for you.

### Two dialects, one pool

KeyPool speaks both the OpenAI and the Anthropic wire formats. They are the
same pool, the same key, the same failover — only the surface differs.

| Dialect | Base URL | Endpoint |
| --- | --- | --- |
| OpenAI | `http://127.0.0.1:20121/v1` | `POST /v1/chat/completions` |
| Anthropic | `http://127.0.0.1:20121/anthropic` | `POST /anthropic/v1/messages` |

To point an agent that only speaks Anthropic — Claude Code, for one — at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:20121/anthropic
ANTHROPIC_API_KEY=your-keypool-key
```

> **Do not give an Anthropic client the `/v1` base URL.** It appends its own
> `/v1/messages`, so that setting produces `/v1/v1/messages` and a 404. Either
> value works — `http://127.0.0.1:20121` on its own is also accepted — but
> `.../v1` is the one that breaks.

Both authenticate with the unified key. Anthropic clients send it as
`x-api-key`, which is read alongside `Authorization: Bearer`.

`count_tokens` is answered too — an agent calls it before nearly every turn, and
a 404 there reads as a broken proxy. The figure is an estimate computed locally
from the request's own size: the exact count belongs to whichever upstream
ultimately serves it, which is not knowable before routing.

Both surfaces also serve the model catalogue, and a single model can be fetched
from either: `GET /v1/models` and `GET /anthropic/v1/models` return the same
list, and `GET /v1/models/{id}` and `GET /anthropic/v1/models/{id}` return the
same single entry.

A separate path rather than content-type sniffing on `/v1`, so an existing
OpenAI client is never routed into a translation it did not ask for.

**What the translation covers.** System prompts, multi-turn history, image
blocks, tool definitions, `tool_use` / `tool_result` round-trips, streaming,
stop reasons and usage. The streaming path is genuinely different: the OpenAI
one relays upstream frames byte-for-byte, while the Anthropic one re-emits them
as `message_start` / `content_block_*` / `message_delta` / `message_stop`,
because an Anthropic SDK will not read OpenAI chunks. Requested model names are
echoed back unchanged, so a spoofed or aliased model keeps addressing the same
thing on the next turn.

**What it does not cover.** Anthropic-only features with no OpenAI equivalent —
extended-thinking *request* controls, `effort`, citations, prompt caching
breakpoints — are dropped rather than half-translated. `top_k` is dropped for
the same reason. Server-side tools are the one exception to graceful
degradation: with no upstream capable of running them, a request that depends
on them is rejected with a `400` naming the tool type rather than answered
without them (see above). (Reasoning the upstream *returns* is a different
matter, and is delivered — see below.)

### Reasoning and tool-call streams

A turn does not have to contain prose to be a real answer. A reasoning model
spends its whole turn thinking, and a tool-calling turn's entire output can be a
single call — on the OpenAI endpoint both are relayed and recorded like any
other answer, and neither is mistaken for an upstream that said nothing.

Three details are worth knowing, because each is a way a proxy can quietly
discard a real answer and answer `502` instead:

- **All three reasoning field names are read.** Gateways do not agree on what to
  call thinking: `reasoning_content` is the common one, and `reasoning` and
  `thinking` both appear in the wild. All three are recognised as output.
- **A tool call counts as output even with no arguments.** A call that takes
  none streams a name and an empty argument string; it is still a complete,
  delivered answer.
- **A completed-but-empty turn is delivered, not retried.** A `finish_reason`
  with no content is a real answer. Only a stream that genuinely produced
  nothing — a role preamble and silence, or an empty body — is failed over to
  the next key.

The distinction matters most when failover is on the table: a stream that looks
like it produced nothing is abandoned and re-sent on every key in the pool,
ending at a `502` that names a network fault for a request the upstream had
already answered. The rule is that a turn counts as delivered once it has
produced *anything* — reasoning, a tool call, or a finish reason — not once it
has produced a certain number of characters.

### Model spoofing

A spoof gives a client a model id of your own choosing and points it at a real one. `ai-123:free` might mean "send everything to `minimax:free`", and the client only ever asks for `ai-123:free`.

It is not an alias. An alias targets individual pooled keys in a fixed order — "try these, then these". A spoof points at a **model**, so it is served by every key serving that model, under that model's own round-robin cursor, breaker and health filtering. Naming the model directly would behave identically; only the name differs.

Both names are recorded either way: the request log stores the name the client asked for and the real model it was served by, so a spoof shows up in the log under `ai-123:free` with `minimax:free` beside it. Spoofed names appear in `GET /v1/models`, so a client that enumerates models can find them.

A spoof name may not shadow anything already resolvable — not a real model id, not an alias, not another spoof.

### Failure handling

| What happened | What KeyPool does |
| --- | --- |
| `401` / `403` | Marks the entry for that model as an auth error. A bare 403 keeps failing over (it may be one revoked key among healthy siblings) and is not auto-recovered by traffic — re-ping it from the dashboard. A recognizable client-identity gate refusal (e.g. Zen's "only be used from within OpenCode") stops after the first attempt instead: the verdict is deterministic across keys, so retrying the pool only burns latency and marks every entry down. The returned error names the supported route. |
| `429` | Cools that key down. `Retry-After` is honoured when present, otherwise exponential backoff with jitter. Sibling keys keep serving. |
| `404` / model not found | Locks out that one `(key, model)` pair. Other keys serving the same model are unaffected. |
| `5xx`, timeout, network error | Increments a failure streak. At the threshold the key's circuit breaker opens and it leaves the pool; after the cooldown a single probe request is admitted, and success closes it again. |
| `400` (other) | Returned to the client immediately. Retrying a bad request against every key is pure waste. |
| Client disconnects mid-stream | Stops reading the upstream immediately, releases the pool slot, and records `client_disconnected` — never fails over onto a sibling key to serve a dead socket, and never charges the key for the abort. |

**Failover only happens before the first byte reaches the client.** Once a stream has started, the upstream response is the only valid continuation — a second upstream cannot be spliced into a half-delivered stream. If a stream dies mid-flight, KeyPool ends the response and logs the failure rather than returning something corrupt.

One transport boundary worth knowing: the proxy stops *reading* the moment the client leaves and frees everything it owns, but the upstream gateway learns this through TCP backpressure (its send buffers must fill before it stalls), not through an immediate socket kill — the fetch transport cannot destroy a mid-body connection. A disconnect is therefore never billed as a success and never retried, but a gateway generating a short completion may still finish generating it.

---

## Dashboard

| Page | What it gives you |
| --- | --- |
| **Overview** | Headline counters, a requests/failures chart over a selectable window, a live pool-health strip, per-model traffic, and the exact client snippet to copy. Input, output and total tokens are broken out as separate cards. |
| **Upstreams** | One card per base URL with its keys, plus **Edit**, **View keys**, **Add keys**, **Ping all** and **Delete**. |
| **Models** | One row per model id with status, ping time, weight and priority — inline enable/disable, per-row ping — plus a **copy button beside every model id**. **Add model** binds a new model to keys you already have. Alias management sits below. |
| **Intelligent ranking** | Every model the pool serves, scored on three axes the server returns with its weights attached — intelligence (a curated prior per family), reliability (success rate blended with key health) and efficiency (price and latency). Composite score with S/A/B/C tiers, and the best fit per role — plan, build, test, review, docs, agent — with the fallback for when it is down. Spoof names are excluded: they are client aliases, not models. |
| **Model spoofing** | Names a client may request, and the real model each one stands for, with a request count per spoof. |
| **Stats** | Requests, latency and token flow over 1h / 24h / 7d / 30d / **All time**, broken down by model, upstream, key and error kind. In, out and total tokens each get their own card and a dedicated totals panel. Also the **streak**: consecutive active days, personal best, milestones and a twelve-week activity map. |
| **Costs** | Spend over the same ranges, priced per model from a USD-per-million rate table. Prices sync from OpenRouter's public catalogue, with manual overrides that a sync never overwrites; each request's cost is snapshotted onto its log row, so later price edits never rewrite history. Unpriced requests are counted and excluded from totals — never reported as free. Display currency is selectable. |
| **Request log** | Every request with its attempt count, chosen strategy, TTFB, latency, token counts, error text and the **client it came from** (Claude Code, Codex, OpenCode…). Filterable and paginated — or flip to the **Console** view: a live terminal of one line per request naming model, provider, key and client, pausable for reading. |
| **Settings** | Routing strategy, breaker and cooldown tuning, timeouts, retention, port/bind address, and the unified key. |
| **About** | The architecture as diagrams: how a request resolves through alias, spoof or model id, then the health filter, strategy and attempt loop — plus the spoof path end to end. |

The range selector on **Overview** and **Stats** includes **All time**, which reports lifetime token totals across everything still retained in the request log. The chart automatically switches to coarser buckets (a day, then a week) for long windows so a multi-year history stays responsive.

Every number is aggregated from the request log with SQL, so the dashboard and the log can never disagree, and the numbers survive a restart. Prompt and response bodies are never stored.

### The streak

**Stats** carries a streak: how many consecutive days you have sent traffic
through the pool, with a flame that grows as the run lengthens, milestone tiers
at 3 / 7 / 14 / 30 / 60 / 100 / 365 days, your personal best, and a twelve-week
map of daily activity. Earned tiers are shown greyed until you reach them, so the
next one is always visible as a goal.

It is built to be recoverable rather than punishing. **Today does not break the
streak** — a day that has not happened yet cannot have been missed, so opening
the dashboard at 8am costs you nothing. **Badges and your best are never
revoked** when a run ends, and the panel always shows the next milestone to
reach, so a broken streak is a number to beat rather than a reason to stop
opening the app.

The streak is **not affected by the window selector** above it — it measures days,
not the selected range, and the panel says so rather than leaving you to
discover it by switching to "Last hour" and watching the number not move.

Two honest limits, both from the same source as everything else on the page:

- The streak is computed from the request log, so it can only reach as far back
  as **Log retention** on the Settings page (30 days by default). Past that the
  figure reads **"at least N"** rather than claiming a precision the log no
  longer supports. Raise retention for a longer record.
- The **personal best is the one number here that is not a live aggregate.** It
  is kept separately, because pruning would otherwise delete the days that
  produced it. It is raised when you beat it and never lowered.
- Turn **Log requests** off and there is nothing to count — the streak goes to
  zero, correctly, because nothing was recorded.

---

## Security

- **Upstream keys are encrypted at rest** with AES-256-GCM under a master key generated on first run (`data/master.key`). No route, log line or error message ever returns a key in plaintext — the dashboard shows the last four characters only.
- **The unified key is stored in the database only as a SHA-256 hash** and compared in constant time. The plaintext lives in `data/unified-key.txt` (owner-only, gitignored) so it survives a restart; it is printed to the console on every start and displayed on the Settings page. An earlier version showed it once and lost it, which locked out anyone who missed the banner.
- **The server binds to `127.0.0.1` by default**, so nothing on your network can reach it.
- **The dashboard has no login** (by design — it is a local tool). That means any local process can reach the admin API. If you ever expose KeyPool beyond localhost, turn on *Require the key on the dashboard API too* in Settings, and change the bind address deliberately.

> Losing `data/master.key` makes every stored API key unrecoverable. Back it up alongside the database, or accept re-entering keys.

---

## Configuration

Everything is editable in the dashboard. Environment variables are only first-run defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `20121` | Port for the single process serving both the dashboard and `/v1` |
| `KEYPOOL_HOST` | `127.0.0.1` | Interface to bind |
| `KEYPOOL_DATA_DIR` | `./data` | Where `data.sqlite` and `master.key` live |
| `KEYPOOL_LOG_LEVEL` | `info` | `fatal`…`trace`, or `silent` |

Precedence is CLI flag > environment variable > Settings > built-in default. So `PORT=3000 run.bat` wins for that launch, while a port changed in Settings persists for normal starts.

---

## Layout

```
testprj1/
├─ run.bat                  one-command start
├─ server/                  Fastify + node:sqlite, TypeScript
│  └─ src/
│     ├─ proxy/             chat/completions, SSE relay, /v1/models
│     │  └─ anthropic/      the Anthropic dialect: request, response, stream
│     ├─ routing/           strategies, health state machine, selector
│     ├─ upstream/          store, HTTP client, ping probe
│     ├─ stats/             request log and aggregations
│     ├─ db/                schema and versioned migrations
│     ├─ routes/            the admin API
│     ├─ core/              crypto, errors, URL normalisation, bulk keys
│     └─ auth/              unified-key verification
├─ web/                     React + Vite + Tailwind dashboard
│  └─ src/{pages,components,lib}
├─ scripts/                 smoke check, stop-keypool
└─ data/                    SQLite database and master key (gitignored)
```

---

## Testing

```bash
pnpm smoke   # boots the built server and exercises the full flow
```

`scripts/smoke.mjs` starts a fake OpenAI upstream, boots the **built** server on a scratch data dir and port 21999, then exercises the dashboard, the admin API, bulk import and a real proxied request before shutting everything down. It is the end-to-end gate: `pnpm verify` runs the build and this check.

---

## Scope

**In:** chat completions with streaming, the synthesised model catalogue (`GET /v1/models`, `/v1/models/{id}`) on both dialects, key pooling, 8 strategies, aliases, model spoofing, intelligent model ranking, binding a new model to existing upstream keys, bulk import, ping/probe, health and failover, stats, request log, settings, dashboard.

**Out:** OAuth, provider catalogues, token compression, semantic cache, MCP/A2A, embeddings, images, audio, the Responses API, per-account billing, budgets, chargeback and invoices, and multi-user accounts. Deliberately. KeyPool is a pooling proxy, not a gateway platform — [9router](https://github.com/decolua/9router) and [OmniRoute](https://github.com/diegosouzapw/OmniRoute) cover that ground if you need it.

One non-goal from that list has since been **withdrawn**, and narrowly: cross-vendor format translation. The reason is worth stating so it doesn't become a slippery slope: every upstream was always OpenAI-compatible and the pool is unchanged, so `/anthropic/v1` is a second front door to the same machine rather than a second kind of machine. See [Two dialects, one pool](#two-dialects-one-pool).

---

## License

MIT
