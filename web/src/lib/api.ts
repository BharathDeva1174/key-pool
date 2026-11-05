/** Thin typed wrapper over the admin REST API. */

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiStyle: 'auto' | 'v1' | 'root';
  authType: 'bearer' | 'none' | 'header' | 'query';
  authHeader: string | null;
  authPrefix: string | null;
  extraHeaders: Record<string, string>;
  /** Upstream client-emulation profile (e.g. "opencode-zen"); null relays verbatim. */
  compatProfile: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Credential {
  id: string;
  endpointId: string;
  label: string | null;
  keyHint: string;
  keyFingerprint: string;
  status: 'unknown' | 'ok' | 'auth_error';
  lastError: string | null;
  failStreak: number;
  breakerState: 'closed' | 'open' | 'half_open';
  openedAt: number | null;
  cooldownMs: number;
  cooldownUntil: number | null;
  cooldownAttempts: number;
  disabled: boolean;
}

export interface ModelEntry {
  id: string;
  credentialId: string;
  modelId: string;
  enabled: boolean;
  status: 'unknown' | 'ok' | 'auth_error' | 'not_found' | 'unsupported' | 'disabled';
  weight: number;
  priority: number;
  lastPingAt: number | null;
  lastPingOk: number | null;
  lastPingMs: number | null;
  lastError: string | null;
  lastUsedAt: number | null;
}

export interface EntryRow {
  entry: ModelEntry;
  endpointName: string;
  baseUrl: string;
  credentialLabel: string | null;
  keyHint: string;
  keyStatus: Credential['status'];
  breakerState: Credential['breakerState'];
  failStreak: number;
  cooldownUntil: number | null;
  disabled: boolean;
}

export interface CredentialRow {
  credential: Credential;
  endpointName: string;
  baseUrl: string;
  entryCount: number;
}

export interface Alias {
  id: string;
  name: string;
  /** `null` means the alias follows whatever is selected in Settings. */
  strategy: string | null;
  createdAt: number;
  targets: string[];
}

/**
 * A name a client may request that stands in for a real model id.
 *
 * Unlike an alias, which targets individual pooled entries, `targetModel` is a
 * model id: the spoof is served by that model's whole pool, under its own
 * round-robin cursor, exactly as if the client had typed the target directly.
 */
export interface Spoof {
  id: string;
  name: string;
  targetModel: string;
  createdAt: number;
}

export interface PoolSnapshot {
  endpoints: Endpoint[];
  entries: EntryRow[];
  credentials: CredentialRow[];
  aliases: Alias[];
  summary: {
    endpoints: number;
    credentials: number;
    entries: number;
    healthy: number;
    cooling: number;
    authErrors: number;
    breakerOpen: number;
  };
}

export interface PingResult {
  entryId: string;
  ok: boolean;
  status: ModelEntry['status'];
  kind: string;
  ms: number | null;
  error: string | null;
  modelListed: boolean | null;
  resolvedStyle: string | null;
}

export interface Overview {
  requests: number;
  successes: number;
  failures: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  streamingRequests: number;
  since: number;
}

export interface TimeseriesPoint {
  bucket: number;
  requests: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number | null;
}

export interface Breakdown {
  label: string;
  requests: number;
  failures: number;
  totalTokens: number;
  avgLatencyMs: number | null;
}

/** One model as the intelligent-ranking route scores it. */
export interface RankedModel {
  modelId: string;
  family: string;
  requests: number;
  failures: number;
  avgLatencyMs: number | null;
  totalKeys: number;
  healthyKeys: number;
  free: boolean;
  successRate: number | null;
  blendedPricePer1m: number | null;
  intelligence: number;
  reliability: number;
  efficiency: number;
  composite: number;
  tier: 'S' | 'A' | 'B' | 'C';
  measured: 'tested' | 'untested';
  priced: boolean;
}

export type RoleName = 'plan' | 'build' | 'test' | 'review' | 'docs' | 'agent';

export interface RankingRolePick {
  role: RoleName;
  modelId: string;
  runnerUpId: string | null;
  score: number;
}

export interface RankingResponse {
  range: string;
  generatedAt: number;
  weights: { intelligence: number; reliability: number; efficiency: number };
  models: RankedModel[];
  roles: RankingRolePick[];
  tiers: Record<'S' | 'A' | 'B' | 'C', number>;
}

export interface StreakTier {
  days: number;
  label: string;
  blurb: string;
}

export interface StreakDay {
  day: string;
  requests: number;
  active: boolean;
  isToday: boolean;
}

export interface HeatmapCell {
  day: string;
  requests: number;
  successes: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface Streak {
  /** Consecutive active days ending today, or ending yesterday if today is still open. */
  current: number;
  todayActive: boolean;
  /** The log cannot see further back than this, so `current` may be a floor. */
  truncated: boolean;
  /** The longest run ever recorded. Persisted, so it survives log pruning. */
  best: number;
  totalActiveDays: number;
  totalRequests: number;
  oldestDay: string | null;
  retentionDays: number;
  tier: StreakTier | null;
  earned: StreakTier[];
  days: StreakDay[];
  heatmap: HeatmapCell[];
}

export interface LogRow {
  id: number;
  ts: number;
  requested_model: string;
  alias_id: string | null;
  entry_id: string | null;
  endpoint_name: string | null;
  credential_label: string | null;
  upstream_model: string | null;
  success: number;
  status_code: number | null;
  error_kind: string | null;
  error_message: string | null;
  attempts: number;
  strategy: string | null;
  streaming: number;
  latency_ms: number | null;
  ttfb_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  /** The client the proxy classified the request as (claude-code, codex, opencode, unknown). */
  client_category?: string | null;
}

// -------------------------------------------------------------------- costs

export interface CostSummary {
  costUsd: number | null;
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  avgCostPerRequestUsd: number | null;
}

export interface CostWindow {
  since: number;
  until: number | null;
  bucketMs: number;
}

export interface CostSyncInfo {
  at: number;
  error: string | null;
  auto?: boolean;
}

export interface CostsSummaryResponse {
  window: CostWindow;
  summary: CostSummary;
  currency: string;
  today: CostSummary;
  thisMonth: CostSummary;
  sync: { prices: CostSyncInfo; fx: CostSyncInfo };
}

export interface CostTimeseriesPoint {
  bucket: number;
  requests: number;
  costUsd: number | null;
}

export interface CostBreakdownRow {
  label: string;
  requests: number;
  failures: number;
  costUsd: number | null;
  unpricedRequests: number;
  avgCostPerRequestUsd: number | null;
  /** In + out tokens the label served - what a price is applied to. */
  combinedTokens: number;
}

export interface CostRequestRow {
  id: number;
  ts: number;
  model: string;
  requestedModel: string;
  endpointName: string | null;
  credentialLabel: string | null;
  success: boolean;
  statusCode: number | null;
  errorKind: string | null;
  streaming: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  priceSource: string | null;
}

export interface ModelPrice {
  modelId: string;
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedPer1m: number | null;
  source: 'auto' | 'manual';
  syncedAt: number | null;
  updatedAt: number;
}

export interface FxRateInfo {
  code: string;
  name: string;
}

export interface CostsFxResponse {
  base: string;
  fetchedAt: number;
  error: string | null;
  currencies: FxRateInfo[];
  rates: Record<string, number>;
}

export interface PriceSyncResult {
  ok: boolean;
  updated: number;
  skippedManual: number;
  flagged: Array<{ modelId: string; flag: string; from: number | null; to: number | null }>;
  /** Used models the fresh catalogue priced and backfilled as it landed. */
  evaluated: Array<{ modelId: string; backfilled: number }>;
  fetchedAt: number;
  error?: string;
}

/** The catalogue rows that could price one model id. */
export interface PriceMatch {
  model: string;
  exact: ModelPrice | null;
  candidates: ModelPrice[];
}

export interface Settings {
  port: number;
  bindAddress: string;
  requireApiKey: boolean;
  requireApiKeyForAdmin: boolean;
  defaultStrategy: string;
  maxAttempts: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  refusalThreshold: number;
  streamStallTimeoutMs: number;
  logRetentionDays: number;
  logRequests: boolean;
  autoPingOnAdd: boolean;
  bulkPingConcurrency: number;
  /** The currency costs are *displayed* in; the log stays canonical USD. */
  displayCurrency: string;
  autoSyncPrices: boolean;
}

export interface SettingsResponse {
  settings: Settings;
  hasUnifiedKey: boolean;
  bootstrapUnifiedKey: string | null;
  restartRequired: string[];
  strategies: { name: string; description: string }[];
}

export interface BulkRowResult {
  index: number;
  raw: string;
  key: string;
  label: string | null;
  baseUrl: string | null;
  modelId: string | null;
  status: 'ok' | 'duplicate' | 'invalid';
  reason: string | null;
  fingerprint: string;
}

export interface BulkParseResult {
  format: string;
  rows: BulkRowResult[];
  summary: { total: number; ok: number; duplicates: number; invalid: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const ADMIN_KEY_STORAGE = 'keypool.dashboardKey';

/**
 * The unified key the dashboard presents on admin calls, if the operator has
 * supplied one.
 *
 * Held in `sessionStorage` rather than `localStorage` on purpose: a key that
 * only lives for the tab means closing the browser is enough to forget it, so
 * turning on "require the key on the dashboard API too" does not silently
 * leave a permanent secret sitting on disk. Every read is wrapped because
 * storage throws in private-browsing modes and when cookies are blocked.
 */
export function adminKey(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setAdminKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    /* storage unavailable; the key just is not remembered across requests */
  }
}

/**
 * Pulls a readable sentence out of whatever an error response carried.
 *
 * The two halves of the server disagree on shape and both are correct: the
 * admin API sends `{ error: "..." }`, while `/v1` sends the OpenAI envelope
 * `{ error: { message, type, ... } }`. Reading only the first turned every
 * proxied or unmatched-route failure into a literal "[object Object]" on the
 * page, so both have to be unwrapped here.
 */
function errorMessageOf(parsed: unknown, status: number): string {
  const fallback = `Request failed with ${status}`;
  if (typeof parsed === 'string') return parsed || fallback;
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return fallback;

  const err = (parsed as { error: unknown }).error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      // Present on every admin call so the key is never forgotten on one path
      // and missing on another. A wrong key is rejected exactly as a missing
      // one would be, so sending it speculatively costs nothing.
      ...(adminKey() ? { authorization: `Bearer ${adminKey()}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new ApiError(errorMessageOf(parsed, res.status), res.status);
  return parsed as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });



/** A decrypted key export, plus the filename the server chose for it. */
export interface KeyExport {
  filename: string;
  text: string;
  /** Keys that could not be decrypted, e.g. sealed under a different master key. */
  skipped: number;
}

/**
 * Downloads every key on one provider as a text file.
 *
 * The request goes through the same auth as everything else, so this only
 * works when the operator has locked the admin API. The filename comes from the
 * server so the sanitising rule is not duplicated here.
 */
export async function exportEndpointKeys(endpointId: string): Promise<KeyExport> {
  const res = await fetch(`/api/admin/endpoints/${encodeURIComponent(endpointId)}/export-keys`, {
    headers: {
      'content-type': 'application/json',
      ...(adminKey() ? { authorization: `Bearer ${adminKey()}` } : {}),
    },
  });
  if (!res.ok) {
    let message = `Export failed with ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body; the status line is all we have */
    }
    throw new ApiError(message, res.status);
  }
  return {
    filename: res.headers.get('x-export-filename') ?? `${endpointId}.txt`,
    text: await res.text(),
    skipped: Number(res.headers.get('x-export-skipped') ?? '0'),
  };
}

/** Hands a text export to the browser as a download. */
export function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ImportKeysResult {
  endpointId: string;
  endpointName: string;
  format: string;
  parsed: { total: number; ok: number; duplicates: number; invalid: number };
  added: number;
  duplicatesOnServer: number;
  entriesCreated: number;
  errors: { index: number; reason: string }[];
  pings: PingResult[];
}

export const api = {
  pool: () => request<PoolSnapshot>('/api/admin/pool'),

  quickAdd: (input: { baseUrl: string; apiKey: string; modelId: string; name?: string; autoPing?: boolean }) =>
    post<{ endpoint: Endpoint; entry: ModelEntry; ping: PingResult | null; keyCreated: boolean }>(
      '/api/admin/quick-add',
      input,
    ),

  parseBulk: (payload: string, format?: string) =>
    post<BulkParseResult>('/api/admin/parse-bulk', { payload, format }),

  /** Bulk import that creates the endpoint first if the base URL is new. */
  addKeysByBaseUrl: (input: {
    baseUrl: string;
    name?: string;
    payload: string;
    format?: string;
    modelIds?: string[];
    autoPing?: boolean;
  }) => post<ImportKeysResult>('/api/admin/import-keys', input),

  addKeys: (endpointId: string, input: { payload: string; format?: string; modelIds?: string[]; autoPing?: boolean }) =>
    post<Omit<ImportKeysResult, 'endpointId' | 'endpointName'>>(`/api/admin/endpoints/${endpointId}/keys`, input),

  updateEndpoint: (id: string, body: Partial<Endpoint>) => patch<Endpoint>(`/api/admin/endpoints/${id}`, body),
  deleteEndpoint: (id: string) => del<{ deleted: boolean }>(`/api/admin/endpoints/${id}`),

  credentials: (endpointId?: string) =>
    request<CredentialRow[]>(`/api/admin/credentials${endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : ''}`),

  updateCredential: (id: string, body: { label?: string | null; disabled?: boolean }) =>
    patch<Credential>(`/api/admin/credentials/${id}`, body),
  deleteCredential: (id: string) => del<{ deleted: boolean }>(`/api/admin/credentials/${id}`),

  updateEntry: (id: string, body: Partial<Pick<ModelEntry, 'modelId' | 'enabled' | 'weight' | 'priority' | 'status'>>) =>
    patch<ModelEntry>(`/api/admin/model-entries/${id}`, body),
  deleteEntry: (id: string) => del<{ deleted: boolean }>(`/api/admin/model-entries/${id}`),
  pingEntry: (id: string) => post<PingResult>(`/api/admin/model-entries/${id}/ping`),
  pingAll: (endpointId?: string) => post<{ pinged: number; results: PingResult[] }>('/api/admin/model-entries/ping-all', { endpointId }),

  /*
   * Binds a model id to one key. `weight` and `priority` are optional: the
   * route only requires credentialId and modelId, and the store defaults them
   * to 1 and 100 respectively.
   */
  addEntry: (input: { credentialId: string; modelId: string; weight?: number; priority?: number }) =>
    post<{ entry: ModelEntry; created: boolean; ping: PingResult | null }>('/api/admin/model-entries', input),

  createAlias: (input: { name: string; strategy: string | null; targets: string[] }) =>
    post<Alias>('/api/admin/aliases', input),
  updateAlias: (id: string, input: { name?: string; strategy?: string | null; targets?: string[] }) =>
    patch<Alias>(`/api/admin/aliases/${id}`, input),
  deleteAlias: (id: string) => del<{ deleted: boolean }>(`/api/admin/aliases/${id}`),

  listSpoofs: () => request<Spoof[]>('/api/admin/model-spoofs'),
  createSpoof: (input: { name: string; targetModel: string }) => post<Spoof>('/api/admin/model-spoofs', input),
  updateSpoof: (id: string, input: { name?: string; targetModel?: string }) =>
    patch<Spoof>(`/api/admin/model-spoofs/${id}`, input),
  deleteSpoof: (id: string) => del<{ deleted: boolean }>(`/api/admin/model-spoofs/${id}`),

  strategies: () => request<{ strategies: { name: string; description: string }[] }>('/api/admin/strategies'),

  settings: () => request<SettingsResponse>('/api/admin/settings'),
  saveSettings: (body: Partial<Settings>) =>
    put<{ settings: Settings; changed: string[]; restartRequired: string[] }>('/api/admin/settings', body),
  rotateKey: () => post<{ key: string; note: string }>('/api/admin/settings/rotate-unified-key'),
  unifiedKey: () => request<{ key: string | null }>('/api/admin/settings/unified-key'),
  resetHealth: (entryId?: string) => post<{ reset: number }>('/api/admin/settings/reset-entry-health', { entryId }),

  overview: (range: string) => request<Overview>(`/api/admin/stats/overview?range=${range}`),
  timeseries: (range: string) =>
    request<{ since: number; bucketMs: number; points: TimeseriesPoint[] }>(`/api/admin/stats/timeseries?range=${range}`),
  byModel: (range: string) => request<Breakdown[]>(`/api/admin/stats/by-model?range=${range}`),
  byUpstream: (range: string) => request<Breakdown[]>(`/api/admin/stats/by-upstream?range=${range}`),
  byCredential: (range: string) => request<Breakdown[]>(`/api/admin/stats/by-credential?range=${range}`),
  byError: (range: string) => request<Breakdown[]>(`/api/admin/stats/errors?range=${range}`),
  streak: () => request<Streak>('/api/admin/stats/streak'),

  ranking: (range: string) => request<RankingResponse>(`/api/admin/intelligence?range=${range}`),

  logs: (params: { range?: string; model?: string; success?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params.range) q.set('range', params.range);
    if (params.model) q.set('model', params.model);
    if (params.success !== undefined) q.set('success', String(params.success));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    return request<{ rows: LogRow[]; total: number }>(`/api/admin/logs?${q.toString()}`);
  },

  flushLogs: () => post<{ flushed: boolean }>('/api/admin/logs/flush'),

  deleteLogs: (params: { range?: string; model?: string; success?: string }) => {
    const q = new URLSearchParams();
    if (params.range) q.set('range', params.range);
    if (params.model) q.set('model', params.model);
    if (params.success !== undefined) q.set('success', String(params.success));
    return del<{ deleted: number }>(`/api/admin/logs?${q.toString()}`);
  },

  // ------------------------------------------------------------------ costs

  costsSummary: (range: string) => request<CostsSummaryResponse>(`/api/costs/summary?range=${range}`),
  costsTimeseries: (range: string) =>
    request<{ since: number; until: number | null; bucketMs: number; points: CostTimeseriesPoint[] }>(
      `/api/costs/timeseries?range=${range}`,
    ),
  costsBreakdown: (range: string) =>
    request<{ byModel: CostBreakdownRow[]; byProvider: CostBreakdownRow[]; byKey: CostBreakdownRow[]; window: CostWindow }>(
      `/api/costs/breakdown?range=${range}`,
    ),
  costsRequests: (limit: number, before?: number) =>
    request<{ rows: CostRequestRow[] }>(`/api/costs/requests?limit=${limit}${before ? `&before=${before}` : ''}`),
  costsFx: () => request<CostsFxResponse>('/api/costs/fx'),
  costsFxSync: () => post<{ ok: boolean; count: number; error?: string }>('/api/costs/fx/sync'),
  costsPrices: () => request<{ prices: ModelPrice[] }>('/api/costs/prices'),
  costsMatchPrice: (modelId: string) =>
    request<PriceMatch>(`/api/costs/prices/match?model=${encodeURIComponent(modelId)}`),
  costsPricesSync: () => post<PriceSyncResult>('/api/costs/prices/sync'),
  /** Prices every used model the catalogue can name; ambiguous ones stay for the picker. */
  costsEvaluate: () => post<{ evaluated: Array<{ modelId: string; backfilled: number; source: string }> }>('/api/costs/evaluate'),
  costsSetPrice: (input: {
    modelId: string;
    inputPer1m: number | null;
    outputPer1m: number | null;
    cachedPer1m: number | null;
    /** Also price the logged-but-unpriced rows this model's id covers. */
    backfill?: boolean;
  }) => post<{ price: ModelPrice | null; backfilled: number }>('/api/costs/prices', input),
  costsResetPrice: (modelId: string) => post<{ price: ModelPrice | null }>(`/api/costs/prices/${encodeURIComponent(modelId)}/reset`),
  costsSetCurrency: (code: string) => post<{ currency: string }>('/api/costs/currency', { code }),
  costsSetAutoSync: (enabled: boolean) => post<{ autoSync: boolean }>('/api/costs/autosync', { enabled }),
};
