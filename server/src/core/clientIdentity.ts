/**
 * Coding-agent client identity normalization.
 *
 * Every supported coding agent (OpenCode, Claude Code, Codex, any
 * OpenAI/Anthropic-compatible client) reaches the same pool through the same
 * proxy routes. Some upstreams serve certain models only to requests that look
 * like their own agent client, so the proxy normalizes the small set of
 * client-identification headers it controls to OpenCode-compatible values
 * before the request goes upstream.
 *
 * What this module does and does not do:
 * - It classifies the *incoming* client for diagnostics only. The incoming
 *   identity is never forwarded.
 * - It produces the *normalized* identity headers to send upstream. The
 *   operator's per-endpoint `extra_headers` are applied after these, so an
 *   explicitly configured value (e.g. a genuine session id) always wins over
 *   the default, and an incoming client value can never override either.
 * - It never synthesizes secrets. Session ids minted by a real client run
 *   cannot be forged by the proxy; they stay operator-owned via
 *   `extra_headers`. Only non-secret identity fields are normalized here.
 * - Hop-by-hop and untrusted forwarding headers are never copied upstream.
 *   The proxy builds outbound headers from scratch, so the lists below are a
 *   guard for review rather than a runtime filter.
 */

export const CLIENT_IDENTITY_MODES = ['opencode', 'off'] as const;
export type ClientIdentityMode = (typeof CLIENT_IDENTITY_MODES)[number];

/** The client category the incoming request most plausibly came from. */
export type ClientCategory = 'opencode' | 'claude-code' | 'codex' | 'unknown';

/**
 * The User-Agent sent upstream when normalization is on. Mirrors the real
 * opencode CLI shape (`opencode/<ver> ai-sdk/... runtime/bun/...`), which is
 * the shape a client-gated upstream expects beside the body signals.
 */
export const OPENCODE_USER_AGENT = 'opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';

/**
 * Non-secret OpenCode client markers sent upstream when normalization is on.
 * Session ids are deliberately absent: they must be genuine, so they stay in
 * the endpoint's `extra_headers` where the operator controls them.
 */
export const OPENCODE_CLIENT_HEADERS: Record<string, string> = {
  'x-opencode-client': 'cli',
  'x-opencode-project': 'global',
};

/**
 * Connection-specific headers that must never be forwarded by a proxy.
 * Documented here because the outbound builder constructs headers from
 * scratch; if forwarding is ever added, these stay behind.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Client-supplied forwarding metadata that must never reach the upstream, and
 * must never influence routing or identity. The proxy builds outbound headers
 * from scratch, so these are dropped by construction.
 */
export const UNTRUSTED_FORWARDING_HEADERS: readonly string[] = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
];

function header(headers: Record<string, unknown>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}

/**
 * Classifies the incoming client for diagnostics. Best-effort and total: a
 * missing, malformed, or unrecognized User-Agent is `unknown`, never an
 * error, and the result only ever reaches logs — never the upstream request.
 */
export function detectClientCategory(incomingHeaders: Record<string, unknown>): ClientCategory {
  let ua = '';
  try {
    ua = header(incomingHeaders, 'user-agent').slice(0, 512);
  } catch {
    return 'unknown';
  }
  // A known non-OpenCode agent wins over any accompanying OpenCode marker: the
  // marker on a foreign UA is the thing worth noticing, not proof of origin.
  if (/claude[-\s_]?code/i.test(ua)) return 'claude-code';
  if (/codex/i.test(ua)) return 'codex';
  if (/opencode/i.test(ua)) return 'opencode';
  if (header(incomingHeaders, 'x-opencode-client') || header(incomingHeaders, 'x-opencode-session')) return 'opencode';
  return 'unknown';
}

/** True when the incoming request carries OpenCode markers on a foreign UA. */
export function hasConflictingIdentity(incomingHeaders: Record<string, unknown>): boolean {
  const category = detectClientCategory(incomingHeaders);
  if (category === 'opencode' || category === 'unknown') return false;
  try {
    return Boolean(header(incomingHeaders, 'x-opencode-client') || header(incomingHeaders, 'x-opencode-session'));
  } catch {
    return false;
  }
}

export interface NormalizedIdentity {
  /** Headers to set on the upstream request, before `extra_headers` overlay. */
  headers: Record<string, string>;
  /** The client category the upstream will see. */
  normalizedClient: ClientCategory | 'passthrough';
  /** False when mode is `off`: the upstream sees no proxy-supplied identity. */
  applied: boolean;
}

/**
 * Builds the normalized identity for one upstream request. The incoming
 * headers are accepted only so future callers cannot "simplify" this into
 * copying them; they are read for nothing but the documented detection path.
 * Pass the mode, get back headers that contain no secrets and no client data.
 */
export function buildNormalizedIdentity(
  _incomingHeaders: Record<string, unknown>,
  mode: ClientIdentityMode,
): NormalizedIdentity {
  if (mode === 'off') return { headers: {}, normalizedClient: 'passthrough', applied: false };
  return {
    headers: { 'user-agent': OPENCODE_USER_AGENT, ...OPENCODE_CLIENT_HEADERS },
    normalizedClient: 'opencode',
    applied: true,
  };
}
