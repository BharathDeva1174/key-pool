import { buildUpstreamUrls, hasV1, type ApiStyle } from '../core/url.js';
import { classifyThrown, extractUpstreamMessage, looksLikeModelNotFound, type UpstreamErrorKind } from '../core/errors.js';
import { applyCompatProfile, type CompatBody } from '../core/compat.js';
import { buildNormalizedIdentity } from '../core/clientIdentity.js';
import { collectCompletionFromSse, parseSseErrorFrame, parseWholeCompletion } from '../proxy/sse.js';
import { performUpstreamCall, performUpstreamGet } from './client.js';
import type { EntryStatus, UpstreamStore } from './store.js';
import { applyOutcome, healthFromRow, type Outcome } from '../routing/health.js';
import type { Settings } from '../settings.js';

export interface PingResult {
  entryId: string;
  ok: boolean;
  status: EntryStatus;
  kind: UpstreamErrorKind;
  ms: number | null;
  error: string | null;
  /** Whether the upstream's /models listing contained this model id. */
  modelListed: boolean | null;
  resolvedStyle: ApiStyle | null;
}

const PING_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;

/** Maps a failure onto the entry status the dashboard renders. */
function entryStatusFor(kind: UpstreamErrorKind): EntryStatus {
  switch (kind) {
    case 'auth_error':
      return 'auth_error';
    case 'not_found':
      return 'not_found';
    case 'rate_limited':
      return 'unknown';
    case 'timeout':
    case 'dns_error':
    case 'tls_error':
    case 'network_error':
    case 'upstream_error':
    case 'client_error':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Validates one `(base_url, api_key, model_id)` triple.
 *
 * Two calls: `GET /models` to confirm the credential authenticates and to see
 * whether the model is listed, then a real minimal chat completion. The
 * completion is the authoritative check - plenty of upstreams list a model they
 * will not actually invoke.
 */
export async function pingEntry(store: UpstreamStore, entryId: string, settings: Settings): Promise<PingResult> {
  const routable = store.getRoutableEntry(entryId);
  if (!routable) {
    return {
      entryId,
      ok: false,
      status: 'not_found',
      kind: 'not_found',
      ms: null,
      error: 'Entry no longer exists.',
      modelListed: null,
      resolvedStyle: null,
    };
  }

  const { endpoint, credential, entry } = routable;
  let secret: string;
  try {
    secret = store.getCredentialSecret(credential.id);
  } catch (err) {
    const result: PingResult = {
      entryId,
      ok: false,
      status: 'auth_error',
      kind: 'auth_error',
      ms: null,
      error: (err as Error).message,
      modelListed: null,
      resolvedStyle: null,
    };
    store.recordPing(entryId, { ok: false, ms: null, status: 'auth_error', error: result.error });
    return result;
  }

  const modelUrls = buildUpstreamUrls(endpoint.baseUrl, endpoint.apiStyle, '/models');
  let modelListed: boolean | null = null;

  // A ping is pool traffic like any other: it carries the same normalized
  // identity a gated upstream expects, so a healthy entry is not marked
  // down for failing a gate the real traffic would pass.
  const identityHeaders = buildNormalizedIdentity({}, settings.clientIdentityMode).headers;

  const listing = await performUpstreamGet(modelUrls, endpoint, secret, Math.min(LIST_TIMEOUT_MS, settings.connectTimeoutMs * 2), identityHeaders);
  if (listing.status === 401) {
    const result: PingResult = {
      entryId,
      ok: false,
      status: 'auth_error',
      kind: 'auth_error',
      ms: null,
      error: listing.error ?? `Upstream rejected the key (${listing.status}).`,
      modelListed: null,
      resolvedStyle: null,
    };
    finish(store, entryId, result, settings);
    return result;
  }
  // A 403 on the catalogue is not proof that this key cannot serve a model.
  // Let the completion decide; some gateways restrict listing separately.
  if (listing.ok) {
    modelListed = listingListsModel(listing.body, entry.modelId);
  }
  // A missing /models endpoint is not a failure - fall through to the real call.

  const started = Date.now();
  /*
   * A compat profile shapes the ping the same way it shapes proxied traffic
   * (core/compat.ts): an endpoint whose gate reads the request body would
   * refuse the bare ping and mark healthy entries auth_error. With the
   * profile, the ping streams, so the body has to be read as frames before
   * it counts as an answer.
   */
  const compat = endpoint.compatProfile ?? null;
  const call = await performUpstreamCall({
    urls: buildUpstreamUrls(endpoint.baseUrl, endpoint.apiStyle, '/chat/completions'),
    endpoint,
    secret,
    body: applyCompatProfile(compat, {
      model: entry.modelId,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }) as CompatBody,
    timeoutMs: Math.min(PING_TIMEOUT_MS, settings.requestTimeoutMs),
    identityHeaders,
  });

  if (!call.ok) {
    const kind = call.kind ?? 'upstream_error';
    const status = entryStatusFor(kind);
    const error =
      kind === 'not_found' && !looksLikeModelNotFound(call.errorMessage ?? '')
        ? `Upstream has no OpenAI-compatible endpoint at ${endpoint.baseUrl} (404 on both /v1 and root). Set the path style manually in Settings.`
        : call.errorMessage ?? 'Ping failed.';
    const result: PingResult = {
      entryId,
      ok: false,
      status,
      kind,
      ms: Date.now() - started,
      error,
      modelListed,
      resolvedStyle: null,
    };
    // A 403 from this model's completion cannot retire a credential shared
    // with other models. A 401 still establishes a credential-wide failure.
    finish(store, entryId, result, settings, call.status === 403);
    return result;
  }

  const rawText = await call.response!.text().catch(() => '');
  /*
   * A streamed ping is only an answer once its frames say so - the same
   * standard the non-streaming proxy path applies. A stream that ended with a
   * finish reason also counts: the ping allows itself one token, and a
   * reasoning model can spend that budget without emitting a character, so a
   * finished empty turn still certifies a key that authenticates and serves
   * the model - which is exactly what a ping exists to establish. A refusal
   * dressed as a stream is caught first, by the error-frame reader.
   */
  if (compat) {
    const completion = collectCompletionFromSse(rawText) ?? parseWholeCompletion(rawText);
    const finished = /"finish_reason"\s*:\s*"/.test(rawText);
    if (!completion && !finished) {
      const refused = parseSseErrorFrame(rawText);
      const result: PingResult = {
        entryId,
        ok: false,
        status: 'unknown',
        kind: 'upstream_error',
        ms: Date.now() - started,
        error: refused?.message ?? 'Upstream returned a stream with no completion.',
        modelListed,
        resolvedStyle: null,
      };
      finish(store, entryId, result, settings);
      return result;
    }
  }

  const resolvedStyle = call.usedUrl ? styleOfUrl(endpoint.baseUrl, call.usedUrl) : null;
  if (resolvedStyle && endpoint.apiStyle === 'auto' && resolvedStyle !== 'auto') {
    store.setApiStyle(endpoint.id, resolvedStyle);
  }

  const result: PingResult = {
    entryId,
    ok: true,
    status: 'ok',
    kind: 'ok' as UpstreamErrorKind,
    ms: Date.now() - started,
    error: null,
    modelListed,
    resolvedStyle,
  };
  finish(store, entryId, result, settings);
  return result;
}

/** Persists the ping outcome, without retiring a key for one model's 403. */
function finish(store: UpstreamStore, entryId: string, result: PingResult, settings: Settings, modelOnly403 = false): void {
  store.recordPing(entryId, {
    ok: result.ok,
    ms: result.ms,
    status: result.status,
    error: result.error,
  });

  // Preserve credential health exactly, including a genuine earlier auth error.
  // Only this model's availability was tested by the refused completion.
  if (modelOnly403) return;

  const routable = store.getRoutableEntry(entryId);
  if (!routable) return;

  const cfg = {
    breakerThreshold: settings.breakerThreshold,
    breakerCooldownMs: settings.breakerCooldownMs,
    cooldownBaseMs: settings.cooldownBaseMs,
    cooldownMaxMs: settings.cooldownMaxMs,
  };
  const current = healthFromRow(
    {
      status: routable.credential.status,
      disabled: routable.credential.disabled,
      fail_streak: routable.credential.failStreak,
      breaker_state: routable.credential.breakerState,
      opened_at: routable.credential.openedAt,
      cooldown_ms: routable.credential.cooldownMs,
      cooldown_until: routable.credential.cooldownUntil,
      cooldown_attempts: routable.credential.cooldownAttempts,
    },
    cfg,
  );

  const outcome: Outcome = result.ok
    ? { kind: 'ok' }
    : result.kind === 'auth_error'
      ? { kind: 'auth_error' }
      : result.kind === 'rate_limited'
        ? { kind: 'rate_limited', retryAfterMs: null }
        : result.kind === 'not_found'
          ? { kind: 'model_unavailable' }
          : { kind: 'retryable' };

  const next = applyOutcome(current, outcome, cfg, Date.now());
  store.persistHealth(routable.credential.id, {
    status: next.status,
    failStreak: next.failStreak,
    breakerState: next.breakerState,
    openedAt: next.openedAt,
    cooldownMs: next.cooldownMs,
    cooldownUntil: next.cooldownUntil,
    cooldownAttempts: next.cooldownAttempts,
    lastError: result.error,
  });
}

/** Runs pings with a bounded worker pool, preserving input order in results. */
export async function pingEntries(
  store: UpstreamStore,
  entryIds: string[],
  concurrency: number,
  settings: Settings,
): Promise<PingResult[]> {
  const results = new Array<PingResult>(entryIds.length);
  const limit = Math.max(1, Math.min(concurrency, entryIds.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= entryIds.length) return;
      const id = entryIds[index] as string;
      try {
        results[index] = await pingEntry(store, id, settings);
      } catch (err) {
        results[index] = {
          entryId: id,
          ok: false,
          status: 'unknown',
          kind: classifyThrown(err),
          ms: null,
          error: (err as Error).message,
          modelListed: null,
          resolvedStyle: null,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function listingListsModel(body: string, modelId: string): boolean {
  try {
    const parsed = JSON.parse(body) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return false;
    return parsed.data.some((m) => {
      if (typeof m === 'string') return m === modelId;
      if (m && typeof m === 'object') {
        const id = (m as { id?: unknown }).id;
        return typeof id === 'string' && id === modelId;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/** Works out which path style a winning URL used, so it can be persisted. */
function styleOfUrl(baseUrl: string, usedUrl: string): ApiStyle {
  const baseHasV1 = hasV1(baseUrl);
  const usedHasV1 = /\/v1\/(chat\/completions|completions|models)/.test(usedUrl);
  if (baseHasV1) return 'v1';
  return usedHasV1 ? 'v1' : 'root';
}

export { extractUpstreamMessage };
