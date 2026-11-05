import { buildUpstreamUrls, type ApiStyle } from '../core/url.js';
import {
  classifyStatus,
  classifyThrown,
  extractUpstreamMessage,
  isClientFault,
  isOpenAIErrorShape,
  isRetryableStatus,
  looksLikePathMiss,
  retryAfterMs,
  type UpstreamErrorKind,
} from '../core/errors.js';
import type { Endpoint } from './store.js';

export interface UpstreamCallResult {
  ok: boolean;
  response: Response | null;
  status: number | null;
  kind: UpstreamErrorKind | null;
  retryAfterMs: number | null;
  errorMessage: string | null;
  /** Set when the response is a terminal client fault that must not be retried. */
  terminal: boolean;
  elapsedMs: number;
  /** Which candidate URL actually produced this result. */
  usedUrl: string | null;
}

/** Builds the outbound headers. The client's own credentials are never forwarded. */
export function buildUpstreamHeaders(
  endpoint: Endpoint,
  secret: string,
  requestId?: string | null,
  identityHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', endpoint.apiStyle === 'root' ? 'application/json' : 'application/json, text/event-stream');

  const prefix = endpoint.authPrefix ?? (endpoint.authType === 'bearer' ? 'Bearer ' : '');
  switch (endpoint.authType) {
    case 'bearer':
      headers.set('authorization', `${prefix}${secret}`);
      break;
    case 'header':
      headers.set((endpoint.authHeader ?? 'x-api-key').toLowerCase(), `${prefix}${secret}`);
      break;
    case 'query':
    case 'none':
      // `query` appends to the URL in `applyQueryAuth`; `none` sends nothing.
      break;
  }

  /*
   * Normalized client identity first, operator `extra_headers` after: an
   * explicitly configured value (a pinned user-agent, a genuine session id)
   * wins over the default, while an incoming client's own headers can never
   * reach this point at all - nothing is ever copied from the inbound request.
   */
  for (const [name, value] of Object.entries(identityHeaders ?? {})) {
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(endpoint.extraHeaders)) {
    if (value) headers.set(name, value);
  }
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}

/** Applies `auth_type: 'query'` credentials, using `auth_header` as the param name. */
export function applyQueryAuth(url: string, endpoint: Endpoint, secret: string): string {
  if (endpoint.authType !== 'query' || !secret) return url;
  const param = endpoint.authHeader ?? 'key';
  const parsed = new URL(url);
  parsed.searchParams.set(param, secret);
  return parsed.toString();
}

export interface PerformCallParams {
  urls: string[];
  endpoint: Endpoint;
  secret: string;
  body: unknown;
  timeoutMs: number;
  requestId?: string | null;
  signal?: AbortSignal;
  /** Extra headers to set on the outbound request (e.g. accept: text/event-stream). */
  extraHeaders?: Record<string, string>;
  /**
   * Normalized client-identity headers for this request (see
   * core/clientIdentity.ts). Applied before the endpoint's `extra_headers`,
   * so operator configuration wins and inbound client headers never appear.
   */
  identityHeaders?: Record<string, string>;
  /**
   * How many upstreams this request may still try, so the per-attempt wait can
   * be scaled to what is left of the pool. The caller knows the plan length; the
   * client does not, and a per-attempt constant would quietly divide the budget
   * by a number the caller never chose.
   */
  remainingAttempts?: number;
  /**
   * The instant this whole request runs out of time, as an absolute epoch ms.
   *
   * The caller owns this because only the caller knows the request outlives one
   * call. Recomputing `now + timeoutMs` inside every call is what let three
   * attempts spend three separate budgets: 40s + 60s + 120s against a 120s
   * setting, so a pool whose keys were all down reported a network fault half
   * way through the third one. Passed in, the same request is bounded by the
   * number the operator actually configured.
   */
  deadlineAt?: number;
}

/**
 * Performs one upstream call, walking the candidate URLs only when a 404 looks
 * like a path-shape miss rather than a genuinely missing model. This is what
 * lets a pasted `https://host` find the real `/v1` prefix without any config.
 */
export async function performUpstreamCall(params: PerformCallParams): Promise<UpstreamCallResult> {
  const { urls, endpoint, secret, body, timeoutMs, requestId, remainingAttempts } = params;
  const started = Date.now();
  const serialized = JSON.stringify(body);

  /*
   * The header deadline, shared across the attempts this request still has left.
   *
   * A budget is only a pool if more than one key can draw on it. Spending the
   * whole `requestTimeoutMs` on the first attempt means a slow key takes the
   * entire request with it: the next keys are tried after the client has long
   * stopped waiting, and on a 3-attempt plan the request reports 502 after
   * 3x the configured timeout - having never given the two healthy keys behind
   * it a fair turn. That is the difference between "this key did not answer" and
   * "this request may not take this long", and only the second is a reason to
   * give up.
   *
   * So the budget is shared, and the first attempt draws the largest slice of
   * what remains - which leaves a real, bounded window for the key after it. The
   * last attempt in the plan is given the whole remainder, because by then
   * trying the next key is not an option and a generous wait beats a certain
   * failure.
   *
   * `deadlineAt` is the request's own deadline, passed in by the caller. It is
   * what makes the sharing real rather than per-call: a deadline recomputed here
   * would be a fresh budget for every attempt, so three attempts could still run
   * for 40s + 60s + 120s against a 120s setting and the operator's number would
   * mean nothing. Absent one (the probe, and any caller with a single call), the
   * caller's `timeoutMs` is used exactly as before.
   */
  const deadline = params.deadlineAt ?? Date.now() + timeoutMs;
  const share = Math.max(1, remainingAttempts ?? 1);
  /*
   * Never more than what is actually left. The 1s floor exists so an attempt is
   * never given a zero-length wait and reported as a network fault for having
   * not tried - but a floor above the remaining budget would push the request
   * past the deadline it was given, which is the exact defect this replaced.
   */
  const attemptBudget = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) return 1;
    return Math.max(1_000, Math.ceil(left / share));
  };

  let last: UpstreamCallResult = {
    ok: false,
    response: null,
    status: null,
    kind: 'network_error',
    retryAfterMs: null,
    errorMessage: 'No upstream URL was attempted.',
    terminal: false,
    elapsedMs: 0,
    usedUrl: null,
  };

  for (let i = 0; i < urls.length; i += 1) {
    const raw = urls[i] as string;
    const url = applyQueryAuth(raw, endpoint, secret);
    const headers = buildUpstreamHeaders(endpoint, secret, requestId, params.identityHeaders);
    for (const [name, value] of Object.entries(params.extraHeaders ?? {})) headers.set(name, value);

    try {
      /*
       * The timeout is a time-to-first-byte budget, not a total budget.
       *
       * `AbortSignal.timeout` stays armed for as long as the body is being read,
       * so using it here silently imposed a ceiling on the whole generation: a
       * long streaming answer was cut off mid-sentence at the timeout, and the
       * client saw a stream that simply stopped. An agent turn runs minutes.
       *
       * So the signal is armed to cover the wait for headers and cleared the
       * moment they arrive. An upstream that never answers is still caught; one
       * that answered is then free to take as long as it takes, and the client
       * disconnecting remains the normal way a stream ends.
       */
      const controller = new AbortController();
      const waitMs = attemptBudget();
      // Phrased so `classifyThrown` still reads it as a timeout, exactly as the
      // `AbortSignal.timeout` it replaces did: a slow upstream has to reach the
      // breaker and the cooldown as a timeout, not as a generic network error.
      // The message reports the wait actually allowed, because a request that
      // ended early because its budget was shared says so.
      const headerDeadline = setTimeout(
        () => controller.abort(new Error(`Upstream timed out after ${waitMs}ms without sending headers`)),
        waitMs,
      );
      let response: Response;
      try {
        /*
         * The caller's signal (a client disconnect) joins the header timeout:
         * whichever fires first wins. An abort from the caller reads as an
         * abort, not a timeout - the caller owns that distinction and never
         * charges the key for it (see the clientGone path in
         * proxy/chatCompletions.ts).
         */
        const signal = params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal;
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: serialized,
          signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(headerDeadline);
      }

      const elapsedMs = Date.now() - started;

      if (response.ok) {
        return {
          ok: true,
          response,
          status: response.status,
          kind: null,
          retryAfterMs: null,
          errorMessage: null,
          terminal: false,
          elapsedMs,
          usedUrl: raw,
        };
      }

      const text = await safeText(response);
      const kind = classifyStatus(response.status, text);
      const ra = retryAfterMs(response.headers.get('retry-after'));

      // A 404 that is about the path, not the model, is worth one more try
      // against the other style - this is the auto api_style resolution.
      const pathMiss = kind === 'not_found' && looksLikePathMiss(text) && i < urls.length - 1;
      if (pathMiss) continue;

      return {
        ok: false,
        response: null,
        status: response.status,
        kind,
        retryAfterMs: ra,
        errorMessage: extractUpstreamMessage(text, `Upstream returned ${response.status}.`),
        terminal: isClientFault(response.status),
        elapsedMs,
        usedUrl: raw,
      };
    } catch (err) {
      const elapsedMs = Date.now() - started;
      last = {
        ok: false,
        response: null,
        status: null,
        kind: classifyThrown(err),
        retryAfterMs: null,
        errorMessage: (err as Error)?.message ?? String(err),
        terminal: false,
        elapsedMs,
        usedUrl: raw,
      };
      // A connection-level failure will not be fixed by the other path style.
      break;
    }
  }

  return last;
}

/** Same as `performUpstreamCall` but for GET, used by the ping probe. */
export async function performUpstreamGet(
  urls: string[],
  endpoint: Endpoint,
  secret: string,
  timeoutMs: number,
  identityHeaders?: Record<string, string>,
): Promise<{ status: number; ok: boolean; body: string; error: string | null }> {
  let lastError: string | null = null;
  for (let i = 0; i < urls.length; i += 1) {
    const raw = urls[i] as string;
    const url = applyQueryAuth(raw, endpoint, secret);
    const headers = buildUpstreamHeaders(endpoint, secret, null, identityHeaders);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await safeText(response);
      if (response.ok) return { status: response.status, ok: true, body, error: null };
      // A 404 about the path rather than the key means the other style is
      // worth trying before we conclude this upstream is unusable.
      if (response.status === 404 && i < urls.length - 1 && looksLikePathMiss(body)) continue;
      lastError = extractUpstreamMessage(body, `Upstream returned ${response.status}.`);
      return { status: response.status, ok: false, body, error: lastError };
    } catch (err) {
      lastError = (err as Error)?.message ?? String(err);
    }
  }
  return { status: 0, ok: false, body: '', error: lastError };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export { isOpenAIErrorShape, isRetryableStatus };
export type { ApiStyle };
