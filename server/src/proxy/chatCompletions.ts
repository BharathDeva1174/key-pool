import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import type { UpstreamStore, RoutableEntry } from '../upstream/store.js';
import type { SettingsStore } from '../settings.js';
import type { PoolState } from '../routing/poolState.js';
import type { StatsRecorder } from '../stats/recorder.js';
import { performUpstreamCall } from '../upstream/client.js';
import { buildUpstreamUrls } from '../core/url.js';
import { stripContextSuffix } from '../core/modelName.js';
import { applyCompatProfile, isGateRefusal, withGateRemediation, type CompatBody } from '../core/compat.js';
import { isOpenAIErrorShape, openAIError, openAIErrorTypeForStatus, statusForErrorKind, type UpstreamErrorKind } from '../core/errors.js';
import { applyOutcome, claimProbe, eligibility, outcomeForErrorKind } from '../routing/health.js';
import { describeExcluded, healthOf, resolveRequestedModel, type Resolution } from '../routing/selector.js';
import { collectCompletionFromSse, parseUpstreamErrorEnvelope, pipeSseToReply, type StreamOutcome } from './sse.js';
import { estimatePromptTokens, estimateTokensFromChars, readUsage as readUsageObject, type Usage } from '../core/usage.js';
import { InboundError, toOpenAIRequest, type AnthropicMessagesRequest } from './anthropic/inbound.js';
import { anthropicError, anthropicErrorType, toAnthropicMessage } from './anthropic/outbound.js';
import { pipeAnthropicSse } from './anthropic/stream.js';
import { buildNormalizedIdentity, detectClientCategory, hasConflictingIdentity } from '../core/clientIdentity.js';

export interface ProxyDeps {
  db: Db;
  store: UpstreamStore;
  settings: SettingsStore;
  poolState: PoolState;
  recorder: StatsRecorder;
}

/**
 * Fills in a token estimate when the upstream reported no usage at all.
 *
 * The primary source is the upstream's own usage block, requested on every
 * stream via `stream_options.include_usage`. A provider that ignores it would
 * otherwise record no token counts for every request to it. The estimate is
 * deliberately crude (about four characters per token, the same one
 * `count_tokens` uses) and is applied only when *both* counts are missing: a
 * provider that reported a prompt count but not a completion count is trusted
 * on the figure it did send rather than have one real number and one guessed
 * one blended together.
 */
function withUsageEstimate(outcome: StreamOutcome, outbound: ClientBody): Usage {
  if (outcome.promptTokens !== null || outcome.completionTokens !== null) {
    return {
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      totalTokens: outcome.totalTokens,
      cachedTokens: outcome.cachedTokens,
      reasoningTokens: outcome.reasoningTokens,
      completionIncludesReasoning: true,
    };
  }
  const promptTokens = estimatePromptTokens(outbound);
  const completionTokens = estimateTokensFromChars(outcome.outputTextChars);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens: null,
    reasoningTokens: null,
    completionIncludesReasoning: true,
  };
}

interface ClientBody {
  model?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

function parseBody(raw: unknown): ClientBody | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as ClientBody) : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object') return raw as ClientBody;
  return null;
}

/**
 * The upstream usage object, from a non-streaming response body.
 *
 * Delegates to the shared reader in `core/usage.ts` so a stream and a
 * non-streaming body can never be read two different ways.
 */
function readUsage(raw: string): Usage {
  try {
    const parsed = JSON.parse(raw) as { usage?: unknown };
    return readUsageObject(parsed?.usage);
  } catch {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      completionIncludesReasoning: true,
    };
  }
}

/**
 * `POST /v1/chat/completions` - the one endpoint that does the real work.
 *
 * Resolves the requested model to an ordered list of healthy upstreams, tries
 * them in turn, and returns the first success. Failover only ever happens
 * before a single byte has been written downstream; once a stream has started
 * the upstream response is the only valid continuation.
 *
 * The `anthropic` dialect is the same handler with the edges translated. The
 * attempt loop between them - resolution, per-attempt re-read, probe claim,
 * breaker, pool state, the recorder - is shared and deliberately untouched, so
 * both dialects pool, fail over and record identically. Only the request it
 * builds, the bytes it writes back, and the error envelope differ.
 */
export async function handleChatCompletions(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  options: { dialect?: 'openai' | 'anthropic' } = {},
): Promise<void> {
  const { store, settings, poolState, recorder, db } = deps;
  const startedAt = Date.now();
  const dialect = options.dialect ?? 'openai';

  /*
   * Client-identity normalization, computed once per request and applied to
   * every upstream attempt below. The incoming category is diagnostics only;
   * the upstream sees the normalized identity, never the client's own
   * headers. Operator `extra_headers` on the endpoint still apply on top.
   */
  const incomingHeaders = request.headers as unknown as Record<string, unknown>;
  const originalClient = detectClientCategory(incomingHeaders);
  const identityConflict = hasConflictingIdentity(incomingHeaders);
  const identity = buildNormalizedIdentity(incomingHeaders, settings.get('clientIdentityMode'));
  const requestId = typeof request.headers['x-request-id'] === 'string' ? (request.headers['x-request-id'] as string) : null;
  if (identity.applied) reply.header('x-keypool-client-identity', identity.normalizedClient);

  /*
   * Client disconnect propagation. A 'close' on the downstream response
   * while it is still writable means the reader left mid-stream - an agent
   * abort, a timeout, a dropped socket. Without this the proxy consumed the
   * upstream to completion for nobody: billed tokens, a held pool slot, and
   * a success row for an unread answer. Aborting stops the upstream fetch
   * and every pipe below; `clientGone` stops the pool from spending sibling
   * keys on the same ghost.
   *
   * Guarded for the inject transport, whose mock response is not a socket:
   * there the listener simply never fires.
   */
  const upstreamAbort = new AbortController();
  let clientGone = false;
  const downstream = reply.raw as unknown as { on?: unknown; writableEnded?: boolean } | null | undefined;
  if (downstream && typeof downstream.on === 'function') {
    (downstream.on as (event: string, listener: () => void) => void)('close', () => {
      if (downstream.writableEnded !== true) {
        clientGone = true;
        upstreamAbort.abort();
      }
    });
  }

  /*
   * One structured diagnostics line per request: safe metadata only (no
   * headers, keys, or bodies), so an operator can verify that every agent is
   * normalized consistently without anything secret reaching the logs.
   *
   * Level is debug, not info, on purpose: the request log in the database is
   * the record of what happened, and stdout is for what the process has to
   * say. A busy pool would otherwise print a JSON line per request to the
   * terminal for as long as the server ran. Set KEYPOOL_LOG_LEVEL=debug to
   * see this line when verifying identity handling.
   */
  let completedStatus: number | null = null;
  let servingProvider: string | null = null;
  const logDiagnostics = () => {
    request.log.debug({
      proxyRequest: true,
      requestId,
      route: request.url,
      protocol: dialect,
      originalClient,
      identityConflict,
      normalizedClient: identity.normalizedClient,
      normalizationApplied: identity.applied,
      provider: servingProvider,
      status: completedStatus,
      durationMs: Date.now() - startedAt,
    });
  };

  /** A failure in the shape the calling client knows how to parse. */
  const fail = (status: number, message: string, type: string, code: string | null) => {
    completedStatus = status;
    logDiagnostics();
    return dialect === 'anthropic'
      ? reply.code(status).send(anthropicError(anthropicErrorType(status), message))
      : reply.code(status).send(openAIError(message, type, code));
  };

  const parsed = parseBody(request.body);

  let body: ClientBody | null;
  let requestedModel: string;
  let wantsStream: boolean;
  try {
    if (dialect === 'anthropic') {
      // Translated before anything else looks at it, so resolution, pooling and
      // the log all see an ordinary OpenAI request naming the model the client
      // asked for - which is what makes aliases and spoofs work here unchanged.
      const translated = toOpenAIRequest((parsed ?? {}) as AnthropicMessagesRequest);
      body = translated as unknown as ClientBody;
      requestedModel = translated.model;
      wantsStream = translated.stream === true;
    } else {
      body = parsed;
      requestedModel = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
      wantsStream = parsed?.stream === true;
    }
  } catch (err) {
    if (err instanceof InboundError) {
      fail(err.status, err.message, 'invalid_request_error', 'invalid_request');
      return;
    }
    throw err;
  }

  if (!body || !requestedModel) {
    fail(400, "Missing or invalid 'model'. Expected a JSON body with a model string.", 'invalid_request_error', 'model_required');
    return;
  }

  const cfg = {
    breakerThreshold: settings.get('breakerThreshold'),
    breakerCooldownMs: settings.get('breakerCooldownMs'),
    cooldownBaseMs: settings.get('cooldownBaseMs'),
    cooldownMaxMs: settings.get('cooldownMaxMs'),
  };
  const requestTimeoutMs = settings.get('requestTimeoutMs');
  const refusalThreshold = settings.get('refusalThreshold');
  const streamStallTimeoutMs = settings.get('streamStallTimeoutMs');

  const resolution: Resolution = resolveRequestedModel(
    store,
    poolState,
    { defaultStrategy: settings.get('defaultStrategy'), breakerCooldownMs: cfg.breakerCooldownMs },
    requestedModel,
  );

  if (resolution.ordered.length === 0) {
    /*
     * A `[1m]`-style marker is stripped before resolution, so reaching here
     * with one still attached means the *base* name is unknown too. Saying so
     * is the difference between a five-second fix and an afternoon: the marker
     * reads like a distinct model, and without this the message sends you to
     * the dashboard to add a model that already exists.
     */
    const bare = stripContextSuffix(requestedModel);
    const message =
      resolution.totalMatches === 0
        ? bare === null
          ? `No upstream is configured for model "${requestedModel}". Add a base URL, API key and model in the dashboard.`
          : `No upstream is configured for model "${requestedModel}", or for "${bare}" without the context marker. Add a base URL, API key and model in the dashboard.`
        : `All ${resolution.totalMatches} upstream(s) for "${requestedModel}" are unavailable (${describeExcluded(resolution.excluded)}).`;
    recorder.record({
      ts: startedAt,
      requestedModel,
      aliasId: resolution.aliasId,
      entryId: null,
      endpointName: null,
      credentialLabel: null,
      upstreamModel: null,
      success: false,
      statusCode: 503,
      errorKind: resolution.totalMatches === 0 ? 'not_found' : 'no_healthy_target',
      errorMessage: message,
      attempts: 0,
      strategy: resolution.strategy,
      streaming: wantsStream,
      latencyMs: Date.now() - startedAt,
      ttfbMs: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      clientCategory: originalClient,
    });
    fail(503, message, 'service_unavailable', 'no_healthy_target');
    return;
  }

  const maxAttempts = Math.max(1, Math.min(settings.get('maxAttempts'), resolution.ordered.length));

  /*
   * One deadline for the whole request, minted once here.
   *
   * This has to live at the request level rather than inside the upstream call,
   * because the call happens once per attempt. A deadline computed per call is a
   * fresh budget per attempt, so a plan of three could spend 40s + 60s + 120s
   * against a 120s setting - the configured number bounds nothing. The proxy is
   * the only layer that knows the request outlives one call, so this is the only
   * place the deadline can honestly be established.
   *
   * It starts after resolution rather than at the top of the handler, so the
   * configured budget means "time spent talking to upstreams", which is what an
   * operator watching a 120s timeout expects it to mean.
   */
  const deadlineAt = Date.now() + requestTimeoutMs;

  let attempts = 0;
  let lastKind: UpstreamErrorKind = 'upstream_error';
  let lastMessage = 'No upstream could serve this request.';
  let lastStatus: number | null = null;
  let lastEntry: RoutableEntry | null = null;

  for (const entry of resolution.ordered) {
    if (attempts >= maxAttempts) break;
    /*
     * The client left while a previous attempt was in flight. Spending
     * another key - billed upstream, for a dead socket - is pure waste, and
     * recording anything but the disconnect would lie about the outcome.
     */
    if (clientGone) {
      recorder.record({
        ts: startedAt,
        requestedModel,
        aliasId: resolution.aliasId,
        entryId: lastEntry?.entryId ?? null,
        endpointName: lastEntry?.endpoint.name ?? null,
        credentialLabel: lastEntry?.credential.label ?? null,
        upstreamModel: lastEntry?.entry.modelId ?? null,
        success: false,
        statusCode: lastStatus,
        errorKind: 'client_disconnected',
        errorMessage: 'Client disconnected before the response completed.',
        attempts,
        strategy: resolution.strategy,
        streaming: wantsStream,
        latencyMs: Date.now() - startedAt,
        ttfbMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        clientCategory: originalClient,
      });
      completedStatus = lastStatus;
      servingProvider = lastEntry?.endpoint.name ?? null;
      logDiagnostics();
      return;
    }
    /*
     * Out of budget. Trying the next key now would spend time the request does
     * not have, and the attempt could only fail the same way - so the request
     * stops here with whatever the last attempt said, rather than reporting a
     * fresh network fault for a call that was never really made.
     */
    if (Date.now() >= deadlineAt) break;
    attempts += 1;

    // Re-read health inside the attempt so a dashboard change is observed.
    const fresh = store.getRoutableEntry(entry.entryId);
    const current = fresh ?? entry;
    const health = healthOf(current.credential, { breakerCooldownMs: cfg.breakerCooldownMs });

    if (eligibility(health, Date.now(), current.entry.status) === 'probe') {
      // Exactly one in-flight request wins the half-open slot; the rest fail fast.
      if (!claimProbe(db, current.credentialId, Date.now())) continue;
    }

    let secret: string;
    try {
      secret = store.getCredentialSecret(current.credentialId);
    } catch {
      lastKind = 'auth_error';
      lastMessage = 'Stored key could not be decrypted.';
      continue;
    }

    const outbound: ClientBody = { ...body, model: current.entry.modelId };
    if (wantsStream) {
      outbound.stream = true;
      /*
        Ask for usage on the final frame.
        *
        * Without this, a streamed response carries no token counts at all and
        * every streamed request would be logged with none. The field is an
        * OpenAI extension that most compatible upstreams implement, and a
        * provider that does not recognise it ignores it and simply sends no
        * usage - the same state we were in before, never a failure.
        */
      const existing = (body?.stream_options ?? {}) as Record<string, unknown>;
      outbound.stream_options = { ...existing, include_usage: true };
    }
    /*
     * A compat profile shapes the upstream request after the client's own
     * wishes: an endpoint behind a client-identity gate (see core/compat.ts)
     * must look like its vendor's agent regardless of what the caller sent.
     * Forcing `stream: true` on a client that asked not to stream is safe
     * here - the non-streaming path below reassembles frames into one
     * completion - and the log keeps recording what the client asked for.
     */
    const patched = applyCompatProfile(
      current.endpoint.compatProfile,
      outbound as unknown as CompatBody,
    );
    Object.assign(outbound, patched);

    poolState.begin(current.entryId);
    try {
      const call = await performUpstreamCall({
        urls: buildUpstreamUrls(current.endpoint.baseUrl, current.endpoint.apiStyle, '/chat/completions'),
        endpoint: current.endpoint,
        secret,
        body: outbound,
        timeoutMs: requestTimeoutMs,
        requestId,
        identityHeaders: identity.headers,
        signal: upstreamAbort.signal,
        // The header wait is drawn from a budget shared with the keys still to
        // be tried, so one unresponsive key cannot consume the whole request.
        // `deadlineAt` is what makes the sharing hold across attempts rather than
        // restarting inside each one.
        deadlineAt,
        remainingAttempts: maxAttempts - attempts + 1,
      });

      if (call.ok) {
        // Persist the path style that actually worked so later calls skip the probe.
        if (current.endpoint.apiStyle === 'auto' && call.usedUrl) {
          const usedV1 = /\/v1\/chat\/completions$/i.test(call.usedUrl);
          const baseHasV1 = /\/v1$/i.test(current.endpoint.baseUrl);
          store.setApiStyle(current.endpoint.id, baseHasV1 || usedV1 ? 'v1' : 'root');
        }

        poolState.recordLatency(current.entryId, call.elapsedMs);
        poolState.markGood(resolution.poolKey, current.entryId);
        store.markEntryUsed(current.entryId);
        clearHealth(store, current, cfg, { refusalStreak: false });
        lastEntry = current;

        if (wantsStream) {
          // The OpenAI path relays frames byte-for-byte; an Anthropic client is
          // waiting for a different event sequence, so it gets a translating
          // pump instead. Same arguments, same outcome shape, same recorder.
          const outcome =
            dialect === 'anthropic'
              ? await pipeAnthropicSse(call.response!, reply, startedAt, requestedModel, streamStallTimeoutMs, upstreamAbort.signal)
              : await pipeSseToReply(call.response!, reply, startedAt, streamStallTimeoutMs, upstreamAbort.signal);

          /*
           * The client disconnected mid-stream. The pipes above already
           * stopped reading and released the upstream socket; what remains
           * is to NOT spend the rest of the pool serving a dead socket, and
           * to record the disconnect honestly instead of a network fault.
           */
          if (clientGone) {
            const delivered = outcome.delivery === 'delivered_to_client';
            const goneUsage = withUsageEstimate(outcome, outbound);
            recorder.record({
              ts: startedAt,
              requestedModel,
              aliasId: resolution.aliasId,
              entryId: current.entryId,
              endpointName: current.endpoint.name,
              credentialLabel: current.credential.label,
              upstreamModel: current.entry.modelId,
              success: false,
              statusCode: call.status,
              errorKind: 'client_disconnected',
              errorMessage: 'Client disconnected before the response completed.',
              attempts,
              strategy: resolution.strategy,
              streaming: true,
              latencyMs: outcome.latencyMs,
              ttfbMs: outcome.ttfbMs,
              promptTokens: delivered ? goneUsage.promptTokens : null,
              completionTokens: delivered ? goneUsage.completionTokens : null,
              totalTokens: delivered ? goneUsage.totalTokens : null,
              cachedTokens: delivered ? goneUsage.cachedTokens : null,
              reasoningTokens: delivered ? goneUsage.reasoningTokens : null,
              clientCategory: originalClient,
            });
            completedStatus = call.status;
            servingProvider = current.endpoint.name;
            logDiagnostics();
            return;
          }

          /*
           * The upstream produced nothing at all, and nothing reached the client
           * - the reply was never even hijacked. The socket is untouched, so the
           * attempt is genuinely abandonable: the key is marked against the
           * breaker and the next one is tried, the same thing it does for a
           * connection that never opened.
           *
           * A gateway in front of several providers drops a fraction of its
           * streams a second in. Without this the client is simply handed an
           * error for a request that a sibling key in the same pool would have
           * served, which is the opposite of what a pool is for.
           *
           * Only `delivered_nothing` qualifies. `dropped_in_translation` means
           * the upstream did respond and the proxy could not map it onto the
           * client's protocol - our failure, not the key's. Failing over there
           * would burn a billed generation on every key to arrive at the same
           * answer, then report it as a network fault, which is precisely the
           * bug this three-state signal exists to prevent. That case falls
           * through to the record below and reaches the client as the error it
           * is.
           */
          if (outcome.delivery === 'delivered_nothing') {
            /*
             * The upstream refused the request behind a 200, rather than dropping
             * the stream. The attempt is still abandonable - a sibling key is
             * worth trying - but the reason is the upstream's own and the status
             * belongs to it, so a rate limit is reported as a rate limit rather
             * than as a 502 describing a network that never failed.
             *
             * `client_error` and `auth_error` are the two kinds another key
             * cannot fix: the request is bad, or this credential is bad. The rest
             * of the pool is still worth trying, so failover continues.
             */
            const refused = outcome.upstreamError ?? null;
            lastKind = refused?.kind ?? 'network_error';
            lastMessage = outcome.errorMessage ?? 'Upstream closed the stream before sending any content.';
            lastStatus = refused?.status ?? null;
            lastEntry = current;

            if (refused) {
              if (lastKind === 'not_found') store.updateModelEntry(current.entryId, { status: 'not_found', lastError: lastMessage });
              if (lastKind === 'auth_error') store.updateModelEntry(current.entryId, { status: 'auth_error', lastError: lastMessage });
              if (lastKind === 'client_error' || lastKind === 'auth_error') break;

              /*
               * A refusal is weak evidence about the key, so it is counted rather
               * than acted on. One is not enough: a bad tool schema or a context
               * overflow is refused identically on every credential, and failing
               * one for the caller's mistake is how a pool loses keys it needed.
               *
               * Repetition is the signal that separates the two. One bad request
               * is refused once; a gateway that has stopped accepting requests is
               * refused every time, on every key - and until this was counted,
               * that second case was invisible. The refusal reached the request
               * log and nothing else, so with more healthy keys than the retry
               * budget - 65 keys against three attempts is ordinary - each request
               * drew fresh unmarked keys, and an upstream refusing everything
               * produced the same 502 indefinitely. The pool could not learn from
               * the one signal it was being handed.
               *
               * So the streak only reaches the breaker at the threshold, and any
               * success clears it (below). `refusalThreshold` is the operator's
               * dial for how patient that is.
               */
              const refusalStreak = store.recordRefusal(current.credentialId, lastMessage, refusalThreshold);
              if (refusalStreak > 0) {
                const refusalHealth = applyOutcome(
                  health,
                  outcomeForErrorKind(lastKind, null),
                  cfg,
                  Date.now(),
                );
                store.persistHealth(current.credentialId, {
                  status: refusalHealth.status,
                  failStreak: refusalHealth.failStreak,
                  breakerState: refusalHealth.breakerState,
                  openedAt: refusalHealth.openedAt,
                  cooldownMs: refusalHealth.cooldownMs,
                  cooldownUntil: refusalHealth.cooldownUntil,
                  cooldownAttempts: refusalHealth.cooldownAttempts,
                  lastError: lastMessage,
                });
              }
              continue;
            }

            const streamOutcome = applyOutcome(health, outcomeForErrorKind(lastKind, null), cfg, Date.now());
            store.persistHealth(current.credentialId, {
              status: streamOutcome.status,
              failStreak: streamOutcome.failStreak,
              breakerState: streamOutcome.breakerState,
              openedAt: streamOutcome.openedAt,
              cooldownMs: streamOutcome.cooldownMs,
              cooldownUntil: streamOutcome.cooldownUntil,
              cooldownAttempts: streamOutcome.cooldownAttempts,
              lastError: lastMessage,
            });
            continue;
          }

          const streamUsage = withUsageEstimate(outcome, outbound);
          /*
           * A success for this credential, established here rather than at the 2xx
           * above: the pipe has now reported that the attempt actually delivered
           * something. This is what ends a refusal run - see the note on
           * `clearHealth`.
           */
          if (!outcome.errored) store.clearRefusal(current.credentialId);
          recorder.record({
            ts: startedAt,
            requestedModel,
            aliasId: resolution.aliasId,
            entryId: current.entryId,
            endpointName: current.endpoint.name,
            credentialLabel: current.credential.label,
            upstreamModel: current.entry.modelId,
            success: !outcome.errored,
            statusCode: outcome.errored ? null : call.status,
            // Named for what actually went wrong. A translation gap reaching
            // the log as `network_error` is what made this undiagnosable: the
            // operator is told to go looking at the network for a bug in the
            // proxy's own protocol translation.
            errorKind: outcome.errored
              ? outcome.delivery === 'dropped_in_translation'
                ? 'translation_gap'
                : 'network_error'
              : null,
            errorMessage: outcome.errorMessage,
            attempts,
            strategy: resolution.strategy,
            streaming: true,
            latencyMs: outcome.latencyMs,
            ttfbMs: outcome.ttfbMs,
            promptTokens: streamUsage.promptTokens,
            completionTokens: streamUsage.completionTokens,
            totalTokens: streamUsage.totalTokens,
            cachedTokens: streamUsage.cachedTokens,
            reasoningTokens: streamUsage.reasoningTokens,
            clientCategory: originalClient,
          });
          completedStatus = call.status;
          servingProvider = current.endpoint.name;
          logDiagnostics();
          return;
        }

        /*
         * The upstream said 2xx, so `ok` is true - but a 2xx with no body is not
         * an answer, and it used to be treated as one.
         *
         * `.catch(() => '')` folded a failed body read into an empty string, so
         * a socket that died mid-body and a gateway that genuinely returned
         * nothing both became a clean 200 with a zero-length payload and a
         * `success: 1` row. The client could not parse it, no attempt was
         * retried, and the log recorded a free request that never happened. The
         * 2xx says the upstream accepted the request; the body is what makes it
         * an answer, so an empty one is a failed attempt and a sibling key may
         * well serve it.
         */
        let rawText: string;
        try {
          rawText = await call.response!.text();
        } catch (err) {
          lastKind = 'network_error';
          lastMessage = `Upstream response body could not be read: ${(err as Error)?.message ?? String(err)}`;
          lastStatus = null;
          lastEntry = current;
          const bodyOutcome = applyOutcome(health, outcomeForErrorKind(lastKind, null), cfg, Date.now());
          store.persistHealth(current.credentialId, {
            status: bodyOutcome.status,
            failStreak: bodyOutcome.failStreak,
            breakerState: bodyOutcome.breakerState,
            openedAt: bodyOutcome.openedAt,
            cooldownMs: bodyOutcome.cooldownMs,
            cooldownUntil: bodyOutcome.cooldownUntil,
            cooldownAttempts: bodyOutcome.cooldownAttempts,
            lastError: lastMessage,
          });
          continue;
        }

        if (rawText.trim().length === 0) {
          lastKind = 'network_error';
          lastMessage = 'Upstream returned an empty response body.';
          lastStatus = null;
          lastEntry = current;
          const emptyOutcome = applyOutcome(health, outcomeForErrorKind(lastKind, null), cfg, Date.now());
          store.persistHealth(current.credentialId, {
            status: emptyOutcome.status,
            failStreak: emptyOutcome.failStreak,
            breakerState: emptyOutcome.breakerState,
            openedAt: emptyOutcome.openedAt,
            cooldownMs: emptyOutcome.cooldownMs,
            cooldownUntil: emptyOutcome.cooldownUntil,
            cooldownAttempts: emptyOutcome.cooldownAttempts,
            lastError: lastMessage,
          });
          continue;
        }
        /*
         * A refusal delivered with a 200, on the non-streaming side.
         *
         * This is the same case the stream pipes recognise, and it was worse
         * here: the body was forwarded verbatim and recorded `success: true`, so
         * a request the upstream had rejected was logged as one that worked -
         * the log and the client disagreeing about the single thing both exist to
         * say. On the Anthropic side it was worse still, because the envelope was
         * then reshaped by `toAnthropicMessage` into an empty assistant message,
         * so a refusal reached the client as a completed turn containing no
         * words.
         *
         * So it is detected before anything is sent, and handled as the failure it
         * is: the upstream's message, the upstream's status, and - for the kinds
         * another key cannot fix - no wasted attempt on the rest of the pool.
         */
        const refused = parseUpstreamErrorEnvelope(rawText);
        if (refused) {
          lastKind = refused.kind;
          lastMessage = refused.message;
          lastStatus = refused.status;
          lastEntry = current;

          if (lastKind === 'not_found') {
            store.updateModelEntry(current.entryId, { status: 'not_found', lastError: lastMessage });
          } else if (lastKind === 'auth_error') {
            store.updateModelEntry(current.entryId, { status: 'auth_error', lastError: lastMessage });
          } else if (lastKind !== 'client_error') {
            // Retryable, so the next key is worth trying - but a rate limit is
            // the gateway's state rather than this credential's, so it is
            // recorded as a cooldown and not as a fault that can open the
            // breaker and evict a perfectly good key.
            const next = applyOutcome(health, outcomeForErrorKind(lastKind, null), cfg, Date.now());
            store.persistHealth(current.credentialId, {
              status: next.status,
              failStreak: next.failStreak,
              breakerState: next.breakerState,
              openedAt: next.openedAt,
              cooldownMs: next.cooldownMs,
              cooldownUntil: next.cooldownUntil,
              cooldownAttempts: next.cooldownAttempts,
              lastError: lastMessage,
            });
          }
          if (lastKind === 'client_error' || lastKind === 'auth_error') break;
          continue;
        }

        /*
         * The body the upstream actually sent, as one completion.
         *
         * A gateway that fronts several providers picks its backend per request,
         * and that choice - not the client's `stream` flag - decides the shape of
         * the reply. So a request that asked for JSON can come back as SSE
         * frames. Forwarding those bytes verbatim answers a client with a 200
         * whose payload it cannot parse, and the log calls it a success because
         * a 2xx did arrive: the client and the log disagree about whether the
         * request worked, which is the one thing this log must never do.
         *
         * The reverse is already recovered further up, by `parseWholeCompletion`,
         * where a stream was asked for and JSON arrived. This is the other half of
         * that pair, on the non-streaming side.
         *
         * Null when the body is not a stream of frames, which is the ordinary
         * case and must pass through untouched - the recovery never rewrites a
         * healthy reply.
         */
        const fromSse = collectCompletionFromSse(rawText);
        const text = fromSse ? JSON.stringify(fromSse) : rawText;
        // Read from whichever body is actually sent back, so the usage recorded
        // below and the usage the client received cannot come apart.
        const usage = fromSse ? readUsageObject(fromSse.usage) : readUsage(text);

        reply.code(call.status ?? 200);
        // The label follows the bytes. Forwarding the upstream's own
        // `text/event-stream` over a reassembled JSON body would tell a client to
        // wait for frames that are not there.
        reply.header('content-type', fromSse ? 'application/json' : call.response!.headers.get('content-type') ?? 'application/json');
        if (dialect === 'anthropic') {
          // Reshaped for the Anthropic client, but read from the same bytes so
          // the usage recorded below and the usage sent back cannot disagree.
          try {
            const upstream = JSON.parse(text) as Record<string, unknown>;
            reply.send(toAnthropicMessage(upstream, requestedModel));
          } catch {
            // An upstream that answered with something unparseable. Forwarding
            // it verbatim is better than an empty message: the client reports
            // what the model actually returned.
            reply.send(text);
          }
        } else {
          reply.send(text);
        }

        // The body parsed as a completion, so this credential has genuinely
        // served - the point at which a refusal run ends. See the note on
        // `clearHealth` for why this is not done at the 2xx.
        store.clearRefusal(current.credentialId);
        if (clientGone) {
          // The answer arrived whole but its reader is gone: billed upstream,
          // delivered to nobody. Recorded as the disconnect it is, with the
          // real usage the body reported - not a success nobody read.
          recorder.record({
            ts: startedAt,
            requestedModel,
            aliasId: resolution.aliasId,
            entryId: current.entryId,
            endpointName: current.endpoint.name,
            credentialLabel: current.credential.label,
            upstreamModel: current.entry.modelId,
            success: false,
            statusCode: call.status,
            errorKind: 'client_disconnected',
            errorMessage: 'Client disconnected before the response completed.',
            attempts,
            strategy: resolution.strategy,
            streaming: false,
            latencyMs: Date.now() - startedAt,
            ttfbMs: call.elapsedMs,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cachedTokens: usage.cachedTokens,
            reasoningTokens: usage.reasoningTokens,
            completionIncludesReasoning: usage.completionIncludesReasoning,
            clientCategory: originalClient,
          });
          completedStatus = call.status ?? 200;
          servingProvider = current.endpoint.name;
          logDiagnostics();
          return;
        }
        recorder.record({
          ts: startedAt,
          requestedModel,
          aliasId: resolution.aliasId,
          entryId: current.entryId,
          endpointName: current.endpoint.name,
          credentialLabel: current.credential.label,
          upstreamModel: current.entry.modelId,
          success: true,
          statusCode: call.status,
          errorKind: null,
          errorMessage: null,
          attempts,
          strategy: resolution.strategy,
        streaming: false,
        latencyMs: Date.now() - startedAt,
        ttfbMs: call.elapsedMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        completionIncludesReasoning: usage.completionIncludesReasoning,
        clientCategory: originalClient,
      });
      completedStatus = call.status ?? 200;
      servingProvider = current.endpoint.name;
      logDiagnostics();
      return;
    }

      // --- failure: record health, then decide whether to try the next entry ---
      lastKind = call.kind ?? 'upstream_error';
      lastMessage = call.errorMessage ?? `Upstream returned ${call.status}.`;
      lastStatus = call.status;
      lastEntry = current;

      const outcome = outcomeForErrorKind(lastKind, call.retryAfterMs);
      /*
       * `auth_error` is the one outcome that must NOT be written to the
       * credential here.
       *
       * The status was 401 or 403, and the documented meaning of that is "this
       * key is out of rotation". But the status is the upstream's answer about
       * *this request against this model*, and providers use 403 for at least two
       * things that need opposite handling:
       *
       *   - a key that is genuinely revoked (xKiro's "account suspended", a
       *     revoked key), which is the credential's fault and should persist;
       *   - a key that is perfectly good but may not use this one model
       *     (OpenCode's "free tier can only be used from within OpenCode"),
       *     which is that model's fault and must stay on the other entries.
       *
       * Nothing in a bare 403 says which one it was. Writing the credential-wide
       * flag on the strength of it retired keys that were still serving a
       * working model: observed here, every key left in `auth_error` also served
       * `space-bunny-free` successfully, and a ping proved the key valid. So the
       * credential is left exactly as it was and only the entry is marked, which
       * is the conservative direction - an over-retired key costs capacity
       * forever, while a key wrongly left in rotation only costs the request that
       * happened to draw it.
       *
       * A genuinely revoked key is still retired, by the one path that can tell
       * the two apart: the ping probe, whose result speaks for the key rather
       * than for one request. `outcomeForErrorKind` maps `auth_error` to a
       * credential-wide flag, so that mapping is undone here and only here, where
       * a single request's status is all the evidence there is.
       */
      if (lastKind !== 'auth_error' && !clientGone) {
        const next = applyOutcome(health, outcome, cfg, Date.now());
        store.persistHealth(current.credentialId, {
          status: next.status,
          failStreak: next.failStreak,
          breakerState: next.breakerState,
          openedAt: next.openedAt,
          cooldownMs: next.cooldownMs,
          cooldownUntil: next.cooldownUntil,
          cooldownAttempts: next.cooldownAttempts,
          lastError: lastMessage,
        });
      }

      if (lastKind === 'not_found') {
        store.updateModelEntry(current.entryId, { status: 'not_found', lastError: lastMessage });
      } else if (lastKind === 'auth_error') {
        store.updateModelEntry(current.entryId, { status: 'auth_error', lastError: lastMessage });
      }

      // A bad request is the caller's fault: another key would fail identically.
      if (call.terminal) break;
      /*
       * A client-identity gate refusal is deterministic across keys: same
       * body shape, same operator session, same verdict on every sibling.
       * Retrying the pool burns billed attempts and latency to arrive at the
       * same 403 - observed live as 8-10 attempts over ~8s per request - and
       * marks every entry down along the way. One attempt establishes it; the
       * actionable error below names the supported route instead. A bare 403
       * with no gate signature keeps failing over: that may be one revoked
       * key among healthy siblings.
       */
      if (isGateRefusal(call.status, lastMessage)) break;
    } finally {
      poolState.end(current.entryId);
    }
  }

  // A pool with no matches at all already returned 503 above, so every request
  // that reaches this point was tried against at least one real upstream.
  //
  // With no upstream status to forward - which is the case for every failure that
  // happened before one could exist, a timeout or a dead socket - the status
  // comes from the kind rather than defaulting to 502. The difference is the
  // whole point: an upstream that answered nothing in time is a 504, and calling
  // it a 502 told the operator their gateway was broken when it was busy.
  const status = lastStatus ?? statusForErrorKind(lastKind);
  // A gate refusal is about the request shape, not the key: say so once, on
  // the final error the client actually receives, so the operator acts on the
  // profile and session instead of rotating a valid key.
  lastMessage = withGateRemediation(lastMessage);

  recorder.record({
    ts: startedAt,
    requestedModel,
    aliasId: resolution.aliasId,
    entryId: lastEntry?.entryId ?? null,
    endpointName: lastEntry?.endpoint.name ?? null,
    credentialLabel: lastEntry?.credential.label ?? null,
    upstreamModel: lastEntry?.entry.modelId ?? null,
    success: false,
    statusCode: status,
    errorKind: lastKind,
    errorMessage: lastMessage,
    attempts,
    strategy: resolution.strategy,
    // What the client asked for, not what this record happened to be reached
    // from. Hardcoding `false` logged every exhausted streaming request as
    // non-streaming, so the failures that cost a whole pool read on the
    // dashboard as though no stream had ever been asked for.
    streaming: wantsStream,
    latencyMs: Date.now() - startedAt,
    ttfbMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    clientCategory: originalClient,
  });

  const suffix = attempts > 1 ? ` (tried ${attempts} upstream${attempts === 1 ? '' : 's'})` : '';
  completedStatus = status;
  servingProvider = lastEntry?.endpoint.name ?? null;
  logDiagnostics();
  if (dialect === 'anthropic') {
    reply.code(status).send(anthropicError(anthropicErrorType(status), `${lastMessage}${suffix}`));
    return;
  }
  reply
    .code(status)
    .send(
      openAIError(
        `${lastMessage}${suffix}`,
        openAIErrorTypeForStatus(status),
        lastKind === 'no_healthy_target' ? 'no_healthy_target' : String(lastKind),
      ),
    );
}

/** Resets a credential's health after a successful request. */
function clearHealth(
  store: UpstreamStore,
  entry: RoutableEntry,
  cfg: { breakerThreshold: number; breakerCooldownMs: number; cooldownBaseMs: number; cooldownMaxMs: number },
  /*
   * `refusalStreak` defaults to being cleared, and the one caller that opts out
   * is the streaming path - which is where the subtlety lives.
   *
   * On a 2xx the health reset runs *before* the body is read, because at that
   * point all the proxy knows is that the upstream accepted the request. It does
   * not yet know whether the body is an answer. So clearing the refusal streak
   * here would wipe the run on every request that got as far as a 2xx - including
   * the ones whose 200 turned out to carry a refusal, which are recorded a few
   * lines later. The counter would sit permanently at 1 and could never reach the
   * threshold, which is the exact blindness this was added to remove.
   *
   * The streak is therefore cleared where a success is actually established: on
   * the non-streaming path once the body parses as a completion, and on the
   * streaming path once the pipe reports it delivered something.
   */
  opts: { refusalStreak?: boolean } = {},
): void {
  store.persistHealth(entry.credentialId, {
    status: 'ok',
    failStreak: 0,
    breakerState: 'closed',
    openedAt: null,
    cooldownMs: cfg.breakerCooldownMs,
    cooldownUntil: null,
    cooldownAttempts: 0,
    lastError: null,
  });
  store.updateModelEntry(entry.entryId, { status: 'ok', lastError: null });
  /*
   * The refusal streak is consecutive by definition, so a success ends the run.
   * Without this a key refused twice during one bad patch would trip the breaker
   * on the first refusal of the next unrelated one, having never actually failed
   * three times in a row.
   */
  if (opts.refusalStreak !== false) store.clearRefusal(entry.credentialId);
}

export { isOpenAIErrorShape };
