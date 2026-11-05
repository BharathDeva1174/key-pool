/**
 * End-to-end smoke check against a real running server.
 *
 * Starts a fake OpenAI upstream, boots the built server on a scratch data dir,
 * exercises the dashboard, admin API, bulk import and a real proxied request,
 * then shuts everything down. Run with: node scripts/smoke.mjs
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21999;
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures.push(name);
  }
}

function cleanupDataDir(dir) {
  // The child may still be releasing SQLite/WAL handles; retry briefly and
  // never fail the run over a temp directory.
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch {
      spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1', '>nul']);
    }
  }
  console.log(`  note: could not remove temp dir ${dir}`);
}

const json = { 'content-type': 'application/json' };
const post = (p, body, headers = json) => fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const get = (p, headers = {}) => fetch(`${BASE}${p}`, { headers });

// ---------------------------------------------------------------- fake upstream

const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {}

  const auth = req.headers.authorization ?? '';
  const key = auth.replace(/^Bearer\s+/i, '');
  res.setHeader('x-seen-key', key);

  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model' }] }));
    return;
  }
  if (key === 'sk-bad-key-0001') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    return;
  }
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    // Real OpenAI sends a usage-bearing final frame when include_usage is set.
    res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-smoke',
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }),
  );
});

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

// ---------------------------------------------------------------- boot server

const dataDir = mkdtempSync(join(tmpdir(), 'keypool-smoke-'));
const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.js'), '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: ROOT,
  env: { ...process.env, KEYPOOL_DATA_DIR: dataDir, KEYPOOL_LOG_LEVEL: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let bootOutput = '';
child.stdout.on('data', (d) => (bootOutput += d.toString()));
child.stderr.on('data', (d) => (bootOutput += d.toString()));

// Wait for the server to accept connections.
const deadline = Date.now() + 25_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

console.log('\nKeyPool end-to-end smoke check\n');

if (!up) {
  console.log('  FAIL  server did not start\n');
  console.log(bootOutput);
  child.kill();
  upstream.close();
  cleanupDataDir(dataDir);
  process.exit(1);
}

check('server boots and /api/health responds', true);

// The unified key is printed once on first run.
const keyMatch = bootOutput.match(/sk-keypool-[A-Za-z0-9_-]+/);
const unifiedKey = keyMatch?.[0] ?? '';
check('unified API key printed on first run', Boolean(unifiedKey));

// ---------------------------------------------------------------- dashboard

const dash = await get('/');
const html = await dash.text();
check('dashboard is served at /', dash.status === 200 && html.includes('<div id="root">'));
check('dashboard SPA fallback works on a deep link', (await get('/settings')).status === 200);

// ---------------------------------------------------------------- auth

check('unauthenticated /v1 call is rejected', (await post('/v1/chat/completions', { model: 'smoke-model' })).status === 401);
check('wrong key is rejected', (await post('/v1/chat/completions', { model: 'smoke-model' })).status !== 200);

const authed = { authorization: `Bearer ${unifiedKey}`, ...json };

// ---------------------------------------------------------------- add + ping

const add = await post('/api/admin/quick-add', { baseUrl: upstreamBase, apiKey: 'sk-good-key-0001', modelId: 'smoke-model' });
const addBody = await add.json();
check('quick-add creates and pings an upstream', add.status === 201 && addBody.ping?.ok === true, JSON.stringify(addBody.ping));

// A pasted full endpoint URL should be trimmed to the /v1 base.
const addTrim = await post('/api/admin/quick-add', {
  baseUrl: `${upstreamBase}/v1/chat/completions`,
  apiKey: 'sk-good-key-0002',
  modelId: 'smoke-model',
  autoPing: false,
});
const trimBody = await addTrim.json();
check('pasted full endpoint URL is trimmed', trimBody.endpoint?.baseUrl === `${upstreamBase}/v1`, trimBody.endpoint?.baseUrl);

// ---------------------------------------------------------------- bulk import

const endpoints = await get('/api/admin/endpoints');
const endpointList = await endpoints.json();
const bulk = await post(`/api/admin/endpoints/${endpointList[0].id}/keys`, {
  payload: ['sk-bulk-00000001', 'sk-bulk-00000002', 'sk-bulk-00000003', 'sk-bulk-00000001', 'sk-bad-key-0001'].join('\n'),
  modelIds: ['smoke-model'],
  autoPing: true,
});
const bulkBody = await bulk.json();
check('bulk import adds keys and dedupes', bulk.status === 201 && bulkBody.added === 4, `added=${bulkBody.added} parsed=${JSON.stringify(bulkBody.parsed)}`);
check('bulk import pings each key', Array.isArray(bulkBody.pings) && bulkBody.pings.length === 4, `pings=${bulkBody.pings?.length}`);
check('bad key in the batch is detected', bulkBody.pings?.some((p) => !p.ok && p.status === 'auth_error'));

// ---------------------------------------------------------------- secret hygiene

const credsJson = await (await get('/api/admin/credentials')).text();
check('admin API never returns a plaintext key', !credsJson.includes('sk-good-key-0001') && !credsJson.includes('sk-bulk-00000001'));

// ---------------------------------------------------------------- proxied traffic

const chat = await post('/v1/chat/completions', { model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }, authed);
const chatBodyJson = await chat.json();
check('proxied chat completion returns 200', chat.status === 200, String(chat.status));
check('upstream body passes through intact', chatBodyJson?.choices?.[0]?.message?.content === 'pong');
check('usage is recorded', chatBodyJson?.usage?.total_tokens === 9);

const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: authed,
  body: JSON.stringify({ model: 'smoke-model', messages: [], stream: true }),
});
const streamText = await streamRes.text();
check('streaming returns text/event-stream', streamRes.headers.get('content-type')?.includes('text/event-stream'));
check('SSE frames are relayed verbatim', streamText.includes('"content":"Hel"') && streamText.includes('"content":"lo"') && streamText.includes('[DONE]'));
check('usage is extracted from the SSE frames', streamText.includes('"total_tokens":9'));

// ---------------------------------------------------------------- models list

const models = await (await get('/v1/models', { authorization: `Bearer ${unifiedKey}` })).json();
const ids = models.data.map((m) => m.id);
check('GET /v1/models lists the pooled model', ids.includes('smoke-model'), JSON.stringify(ids));
check('model is listed once despite many keys', ids.filter((i) => i === 'smoke-model').length === 1);

// ---------------------------------------------------------------- stats

await post('/api/admin/logs/flush');
const overview = await (await get('/api/admin/stats/overview?range=24h')).json();
check('stats count the proxied requests', overview.requests >= 3, `requests=${overview.requests}`);
check('stats show token usage', overview.totalTokens >= 18, `tokens=${overview.totalTokens}`);
const logs = await (await get('/api/admin/logs?range=24h')).json();
check('request log records entries', logs.total >= 3, `total=${logs.total}`);

// The console answers "who is sending this" from the log row, so a request
// sent as claude-code must land with its client named.
await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...authed, 'user-agent': 'claude-code/2.0.14 (smoke)' },
  body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
});
await post('/api/admin/logs/flush');
const logsAfterClient = await (await get('/api/admin/logs?range=24h')).json();
check(
  'log records the client a request came from',
  logsAfterClient.rows.some((r) => r.client_category === 'claude-code'),
  `categories=${JSON.stringify([...new Set(logsAfterClient.rows.map((r) => r.client_category))])}`,
);

// ---------------------------------------------------------------- edit + view keys

const edit = await fetch(`${BASE}/api/admin/endpoints/${endpointList[0].id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'renamed upstream', baseUrl: `${upstreamBase}/v1/` }),
});
const editBody = await edit.json();
check('endpoint base URL can be edited', edit.status === 200 && editBody.baseUrl === `${upstreamBase}/v1`, editBody.baseUrl);
check('endpoint name can be edited', editBody.name === 'renamed upstream');

const keysRes = await get(`/api/admin/credentials?endpointId=${endpointList[0].id}`);
const keysJson = await keysRes.json();
check('keys can be listed per endpoint', Array.isArray(keysJson) && keysJson.length > 0, `count=${keysJson?.length}`);
check('key listing exposes detail without the secret', keysJson[0]?.credential?.keyHint?.length === 4);

// ---------------------------------------------------------------- one-call bulk import

const importRes = await post('/api/admin/import-keys', {
  baseUrl: `${upstreamBase}/fresh`,
  name: 'created by bulk import',
  payload: ['sk-fresh-00000001', 'sk-fresh-00000002', 'sk-fresh-00000001'].join('\n'),
  modelIds: ['smoke-model'],
  autoPing: false,
});
const importBody = await importRes.json();
check('import-keys creates the endpoint and imports in one call', importRes.status === 201 && importBody.added === 2, JSON.stringify(importBody.parsed));
check('import-keys dedupes within the payload', importBody.parsed.duplicates === 1);

// ---------------------------------------------------------------- tokens over ranges

await post('/api/admin/logs/flush');
const allTime = await (await get('/api/admin/stats/overview?range=all')).json();
check('all-time range returns in / out / total tokens', allTime.totalTokens > 0 && allTime.promptTokens > 0 && allTime.completionTokens > 0, `in=${allTime.promptTokens} out=${allTime.completionTokens} total=${allTime.totalTokens}`);
const allSeries = await (await get('/api/admin/stats/timeseries?range=all')).json();
check('all-time series uses a coarse bucket', allSeries.bucketMs >= 24 * 60 * 60 * 1000, `bucketMs=${allSeries.bucketMs}`);

// ---------------------------------------------------------------- costs

// The cost is a snapshot taken when a request is logged, so the order here is
// the point: the three successful requests above (chat, stream, and the
// client-identity one) ran before any price existed and must read as unpriced,
// and the request below the price lands priced. One priced row carries
// 7 prompt + 2 completion tokens, so (7*2 + 2*10) / 1e6 USD.
const EXPECT_USD = (7 * 2 + 2 * 10) / 1e6;
const PRE_PRICE_ROWS = 3;
const priced = await post('/api/costs/prices', { modelId: 'smoke-model', inputPer1m: 2, outputPer1m: 10, cachedPer1m: 0.2 });
check('a manual price can be set', priced.status === 200);

const pricedChat = await post('/v1/chat/completions', { model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }, authed);
check('post-price request succeeds', pricedChat.status === 200, String(pricedChat.status));

await post('/api/admin/logs/flush');
const costsSummary = await (await get('/api/costs/summary?range=all')).json();
check(
  'costs summary prices the post-price request and counts the earlier ones as unpriced',
  Math.abs(costsSummary.summary.costUsd - EXPECT_USD) < 1e-12 && costsSummary.summary.unpricedRequests === PRE_PRICE_ROWS,
  JSON.stringify(costsSummary.summary),
);
check('display currency defaults and reads back', typeof costsSummary.currency === 'string' && costsSummary.currency.length === 3, costsSummary.currency);

// The catalogue matcher: the manual row is an exact hit for the id in use.
const match = await (await get('/api/costs/prices/match?model=smoke-model')).json();
check('catalogue match finds the priced row', match.exact?.modelId === 'smoke-model', JSON.stringify(match));

// The two pre-price rows are priced from their recorded combined tokens - and
// only those: rows that already carry a snapshot are never relitigated.
const backfill = await post('/api/costs/prices', { modelId: 'smoke-model', inputPer1m: 2, outputPer1m: 10, cachedPer1m: 0.2, backfill: true });
const backfillBody = await backfill.json();
check('backfill prices the already-logged unpriced rows', backfillBody.backfilled === PRE_PRICE_ROWS, JSON.stringify(backfillBody));
const afterBackfill = await (await get('/api/costs/summary?range=all')).json();
check(
  'totals pick the backfilled rows up',
  Math.abs(afterBackfill.summary.costUsd - (PRE_PRICE_ROWS + 1) * EXPECT_USD) < 1e-12 && afterBackfill.summary.unpricedRequests === 0,
  JSON.stringify(afterBackfill.summary),
);

// Dynamic evaluation: with every used model already priced, the pass must
// come back empty rather than touching anything.
const evaluate = await post('/api/costs/evaluate');
const evaluateBody = await evaluate.json();
check(
  'auto-evaluate of used models runs and leaves priced history alone',
  Array.isArray(evaluateBody.evaluated) && evaluateBody.evaluated.length === 0,
  JSON.stringify(evaluateBody),
);

const costsBreakdown = await (await get('/api/costs/breakdown?range=all')).json();
check(
  'costs break down by model / provider / key',
  costsBreakdown.byModel.some((r) => r.label === 'smoke-model' && r.costUsd > 0) &&
    costsBreakdown.byProvider.length > 0 &&
    costsBreakdown.byKey.length > 0,
);
const costFeed = await (await get('/api/costs/requests?limit=5')).json();
check('the costs feed carries per-request cost and tokens', costFeed.rows.some((r) => r.model === 'smoke-model' && r.costUsd > 0 && r.promptTokens === 7), JSON.stringify(costFeed.rows[0]));

const fx = await (await get('/api/costs/fx')).json();
check('fx offers a currency list with USD at 1', fx.rates.USD === 1 && fx.currencies.length >= 10, `currencies=${fx.currencies.length}`);

const currency = await post('/api/costs/currency', { code: 'EUR' });
check('display currency applies immediately', currency.status === 200 && (await currency.json()).currency === 'EUR');
await post('/api/costs/currency', { code: costsSummary.currency });

// The live feed: opened before the request that feeds it, so the push is
// attributable. The event is a count only - the page refetches.
const sse = await fetch(`${BASE}/api/costs/stream`, { headers: { accept: 'text/event-stream' } });
check('costs SSE stream opens', sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('text/event-stream'));
if (sse.ok) {
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  const readUntil = async (marker, ms) => {
    const until = Date.now() + ms;
    for (;;) {
      if (sseBuf.includes(marker)) return true;
      if (Date.now() > until) return false;
      try {
        const { done, value } = await reader.read();
        if (done) return false;
        sseBuf += decoder.decode(value, { stream: true });
      } catch {
        return false;
      }
    }
  };
  check('SSE preamble arrives immediately', await readUntil(':ok', 5000));
  const liveChat = await post('/v1/chat/completions', { model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }, authed);
  check('request behind the live feed succeeds', liveChat.status === 200);
  check('SSE pushes an event for the logged request', await readUntil('event: requests', 10_000));
  reader.cancel().catch(() => {});
}

// ---------------------------------------------------------------- settings

const settings = await (await get('/api/admin/settings')).json();
check('settings never expose the key hash', settings.settings.unifiedKeyHash === undefined && settings.hasUnifiedKey === true);
check('all 8 strategies are advertised', settings.strategies.length === 8);

const saved = await fetch(`${BASE}/api/admin/settings`, {
  method: 'PUT',
  headers: authed,
  body: JSON.stringify({ defaultStrategy: 'lkgp', breakerThreshold: 3 }),
});
const savedBody = await saved.json();
check('settings changes apply immediately', savedBody.settings.defaultStrategy === 'lkgp' && savedBody.settings.breakerThreshold === 3);

// ---------------------------------------------------------------- shutdown

child.kill();
await new Promise((r) => setTimeout(r, 800));
upstream.close();
cleanupDataDir(dataDir);

console.log('');
if (failures.length === 0) {
  console.log(`All smoke checks passed.\n`);
  process.exit(0);
} else {
  console.log(`${failures.length} smoke check(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
