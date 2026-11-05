/**
 * Upstream client-emulation profiles.
 *
 * Some upstreams serve certain models only to their own agent client, decided
 * from the shape of the request itself: opencode's Zen gateway, for one, serves
 * its free-tier models only to requests that stream and carry at least two of
 * its own tool names — verified empirically against the live gateway
 * (2026-10-07). A request that satisfies everything but those two signals gets
 * the upstream's own refusal (`OpenCode's free tier can only be used from
 * within OpenCode`) even though the credential is perfectly valid.
 *
 * A profile makes the proxy build the upstream-facing request the way that
 * vendor's own client would, so pooled requests from any coding agent are
 * served. Identity headers (user-agent, vendor session ids) are NOT part of a
 * profile — they belong in the endpoint's `extra_headers`, where the operator
 * controls them like any other header.
 */

export const COMPAT_PROFILES = ['opencode-zen'] as const;
export type CompatProfile = (typeof COMPAT_PROFILES)[number];

/**
 * The tool names whose presence the Zen free-tier gate counts. The gate is
 * satisfied by two; the decoys below carry the two the live gate was verified
 * against. Definitions are irrelevant to the gate, so these are deliberately
 * minimal — and described so a model that sees them prefers the client's own
 * tools, because a call to one of these names reaches the caller as an unknown
 * tool.
 */
const OPENCODE_GATE_TOOL_NAMES = [
  'bash',
  'edit',
  'glob',
  'grep',
  'read',
  'write',
  'task',
  'todowrite',
  'webfetch',
  'websearch',
  'skill',
];

const DECOY_TOOLS: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Compatibility alias for the client\'s native shell tool. Do not call: use the shell tool the client provided instead.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        "Compatibility alias for the client's native file-reading tool. Do not call: use the file-reading tool the client provided instead.",
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

/** True when the name is one the profile's gate counts, compared exactly. */
function isGateToolName(name: unknown): boolean {
  return typeof name === 'string' && OPENCODE_GATE_TOOL_NAMES.includes(name);
}

/**
 * Matches an upstream refusal that is a client-identity gate rather than a
 * credential problem - the Zen gateway's free-tier refusal. A bare 403 sends
 * operators chasing the key; the key is valid, so the message must name the
 * supported route instead.
 */
const GATE_REFUSAL = /only be used from within OpenCode/i;

/** True when this 403 is the gate's verdict on the request shape, not on the key. */
export function isGateRefusal(status: number | null, message: string | null): boolean {
  return status === 403 && typeof message === 'string' && GATE_REFUSAL.test(message);
}

/**
 * Appends the remediation to a gate refusal, or returns the message
 * untouched. Applied once, to the final client-facing error, never per
 * attempt - retrying cannot satisfy a gate the request shape itself fails.
 */
export function withGateRemediation(message: string): string {
  if (!GATE_REFUSAL.test(message)) return message;
  return (
    `${message} This model is served only to the OpenCode client: set the endpoint's ` +
    `compat profile to "opencode-zen" and add a genuine x-opencode-session id to its ` +
    `Extra headers (see README "OpenCode Zen"). Header normalization alone cannot ` +
    `satisfy this gate.`
  );
}

/**
 * A request body the upstream accepts as coming from its own agent client.
 *
 * Anything JSON-serialisable with a `stream` flag qualifies structurally; the
 * profile only needs to read `stream` and `tools` and write both.
 */
export interface CompatBody {
  stream?: unknown;
  stream_options?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

/**
 * Applies a compat profile to one outbound request body, returning the body to
 * send upstream. The input is never mutated.
 *
 * `opencode-zen`:
 *   - forces `stream: true` with `stream_options.include_usage`, whatever the
 *     client asked for. A client that asked not to stream still gets a plain
 *     JSON completion — the proxy reassembles the frames it relays
 *     (`collectCompletionFromSse`), so the coercion is invisible downstream.
 *   - appends the alias tools when the client's own tool set does not already
 *     satisfy the gate, so a request arriving with no tools, or with tools
 *     named in another agent's vocabulary, still counts as agent traffic.
 *
 * An unknown or absent profile returns the body untouched: a profile is an
 * opt-in per endpoint, and a body the proxy never rewrote is the default.
 */
export function applyCompatProfile(profile: string | null, body: CompatBody): CompatBody {
  if (profile !== 'opencode-zen') return body;

  const patched: CompatBody = { ...body, stream: true };
  const existingOptions = (body.stream_options ?? {}) as Record<string, unknown>;
  patched.stream_options = { ...existingOptions, include_usage: true };

  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const gateMatches = tools.filter((t) => isGateToolName((t as { function?: { name?: unknown } } | null)?.function?.name))
    .length;
  if (gateMatches < 2) {
    const present = new Set(
      tools.map((t) => (t as { function?: { name?: unknown } } | null)?.function?.name).filter(isGateToolName),
    );
    patched.tools = [...tools, ...DECOY_TOOLS.filter((d) => !present.has(d.function.name))];
  }
  return patched;
}
