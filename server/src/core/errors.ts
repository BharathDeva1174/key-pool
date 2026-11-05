/**
 * The upstream failure taxonomy. Every failure the proxy can encounter maps to
 * exactly one of these kinds, which drives both the health state machine and
 * the shape of the error returned to the client.
 */
export type UpstreamErrorKind =
  | 'auth_error' // 401 / 403 - the key is wrong or revoked
  | 'rate_limited' // 429
  | 'not_found' // 404 or an explicit model_not_found
  | 'upstream_error' // 5xx
  | 'timeout' // request or connect timeout
  | 'dns_error'
  | 'tls_error'
  | 'network_error' // connection refused, socket reset, etc.
  | 'client_error' // 4xx that is the caller's fault - never retried
  | 'no_healthy_target'; // nothing in the pool was eligible

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export function openAIError(message: string, type: string, code: string | null = null): OpenAIErrorBody {
  return { error: { message, type, param: null, code } };
}

const STATUS_TO_ERROR_TYPE: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'server_error',
  503: 'server_error',
  504: 'server_error',
};

export function openAIErrorTypeForStatus(status: number): string {
  return STATUS_TO_ERROR_TYPE[status] ?? 'api_error';
}

/** True when the body already looks like an OpenAI error envelope. */
export function isOpenAIErrorShape(body: unknown): body is OpenAIErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string';
}

/**
 * The status an error of this kind should be reported to the client as.
 *
 * Used when the upstream rejected the request without giving a status of its own
 * - an envelope behind a 200, or a connection that ended before any status
 * existed. Anything the proxy can attribute to a specific cause is reported as
 * that cause, because "the model was rate limited", "nothing answered in time"
 * and "the proxy could not reach anything" call for completely different
 * responses from the operator, and collapsing all three into 502 is what made
 * this undiagnosable.
 *
 * 504 rather than 502 for a timeout is the load-bearing one. A gateway that
 * answered nothing in time is exactly what 504 means, and 502 says something
 * different: that the upstream is broken. An operator reading a wall of 502s has
 * no way to tell a broken gateway from a busy one, and goes looking for a fault
 * that is not there.
 */
export function statusForErrorKind(kind: UpstreamErrorKind): number {
  switch (kind) {
    case 'rate_limited':
      return 429;
    case 'not_found':
      return 404;
    case 'client_error':
      return 400;
    case 'timeout':
      return 504;
    case 'auth_error':
    case 'upstream_error':
    case 'dns_error':
    case 'tls_error':
    case 'network_error':
    case 'no_healthy_target':
      return 502;
    default:
      return 502;
  }
}

/**
 * Classifies an error envelope the upstream sent *inside* a 200.
 *
 * A gateway that fronts several providers reports a rejection in more than one
 * way. The ordinary way is a status code, and that arrives at `classifyStatus`
 * with no trouble. The other way is a `200 OK` whose body is an error envelope -
 * what a provider behind a buffering proxy returns when it rate-limits, refuses
 * a model, or runs out of context.
 *
 * Nothing used to look for it. The stream readers found no frames and no
 * completion, so the request was reported as a dropped connection; the
 * non-streaming path forwarded the bytes and called it a success. Either way the
 * upstream's own explanation was thrown away, the pool spent keys on a request
 * already refused, and the operator was left with a network fault that never
 * happened.
 *
 * So it is recognised here, once, for both dialects. The signal is the envelope's
 * own `code` and `type` first - they are machine-readable - and only then the
 * message text, which is what an unstructured gateway leaves behind. Anything
 * unrecognised is `upstream_error`: genuinely retryable on another key, and far
 * more honest than claiming the network failed.
 */
export function classifyErrorEnvelope(body: OpenAIErrorBody): UpstreamErrorKind {
  const err = body.error ?? ({} as OpenAIErrorBody['error']);
  const haystack = `${err.code ?? ''} ${err.type ?? ''} ${err.message ?? ''}`.toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|quota|overload/.test(haystack)) return 'rate_limited';
  if (/model.?not.?found|no such model|unknown model|model does not exist/.test(haystack)) return 'not_found';
  // The envelope variant of a withdrawn model (mirrors the 410 rule in
  // `classifyStatus`): the model name and a retirement word must both be
  // present, so a deprecated API version cannot retire a live model entry.
  if (/model[^.]{0,60}deprecat|deprecat[^.]{0,60}model/i.test(haystack)) return 'not_found';
  if (/context.?length|too many tokens|maximum context|invalid.?request|bad request|unsupported/.test(haystack)) {
    return 'client_error';
  }
  if (/unauthor|forbidden|invalid.?api.?key|api.?key.*invalid|authentication/.test(haystack)) return 'auth_error';
  return 'upstream_error';
}

export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(header);
  if (!Number.isNaN(at)) {
    return Math.max(0, at - now);
  }
  return null;
}

/** True when a status should be retried against the next candidate. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** True when switching upstreams can never help - the request itself is bad. */
export function isClientFault(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 404 && status !== 408 && status !== 429;
}

/** Maps a thrown fetch/abort error onto the taxonomy. */
export function classifyThrown(err: unknown): UpstreamErrorKind {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e?.cause?.code ?? e?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/i.test(e?.message ?? '')) {
    return 'timeout';
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns_error';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'tls_error';
    default:
      break;
  }
  return 'network_error';
}

/** Maps a non-2xx upstream response onto the taxonomy. */
export function classifyStatus(status: number, bodyText: string): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status === 404) return looksLikeModelNotFound(bodyText) ? 'not_found' : 'not_found';
  // A 410 for a withdrawn model retires the (key, model) entry exactly like a
  // 404: every request would otherwise burn an attempt to learn nothing new.
  // A 410 about anything else (a retired API version, a removed path) stays a
  // terminal client fault - it says nothing about the model entry.
  if (status === 410) return looksLikeModelGone(bodyText) ? 'not_found' : 'client_error';
  if (isClientFault(status)) return 'client_error';
  return 'upstream_error';
}

function looksLikeModelNotFound(bodyText: string): boolean {
  return /model[_\s-]?not[_\s-]?found|no such model|unknown model|does not exist|model_not_found/i.test(bodyText);
}

/** True when the body retires a model rather than reporting a request fault. */
function looksLikeModelGone(bodyText: string): boolean {
  return (
    /model/i.test(bodyText) &&
    /deprecat|discontinued|sunset|no longer (available|supported|served)|has been removed|was removed|end.?of.?life/i.test(
      bodyText,
    )
  );
}

export { looksLikeModelNotFound };

/** True when a 404 body is a path-shape miss rather than a missing model. */
export function looksLikePathMiss(bodyText: string): boolean {
  if (looksLikeModelNotFound(bodyText)) return false;
  return /\bnot found\b|\bno route\b|\bcannot (find|get|post|put|delete|connect)\b|\bpage not found\b/i.test(bodyText);
}

/** Best-effort human message extracted from an arbitrary upstream error body. */
export function extractUpstreamMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) {
    try {
      return extractUpstreamMessage(JSON.parse(body), fallback);
    } catch {
      return body.trim().slice(0, 500);
    }
  }
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') return b.error.slice(0, 500);
    if (typeof b.error === 'object' && b.error !== null) {
      const inner = b.error as Record<string, unknown>;
      if (typeof inner.message === 'string') return inner.message.slice(0, 500);
    }
    if (typeof b.message === 'string') return b.message.slice(0, 500);
    if (typeof b.detail === 'string') return b.detail.slice(0, 500);
  }
  return fallback;
}
