/**
 * Model-name normalisation.
 *
 * Pure and I/O-free, like `core/usage.ts` and `stats/streak.ts`, so the rules
 * here are unit-testable without a database or an HTTP server.
 */

/**
 * A trailing context-window marker: `[1m]`, `[200k]`, `[1M]`.
 *
 * Agents append this to request a larger context variant — Claude Code spells
 * it `model[1m]` — but it selects a variant of a model, it is not part of the
 * model's id. The upstream gateway has never heard of it and will 404 a model
 * literally called `stealth/space-bunny-alpha[1m]`, so it has to come off
 * before the name is resolved.
 *
 * Deliberately narrow: only a number with a magnitude suffix. Stripping any
 * trailing bracket group would mean `some-model[nonsense]` silently resolved to
 * `some-model` and got *served* — answering a request for a model that does
 * not exist with one that does. Callers only fall back to the stripped name
 * when the exact one matched nothing, so a real id that genuinely contains
 * brackets still wins; this pattern is just how narrow that fallback is.
 */
const CONTEXT_SUFFIX = /\[\d+\s*[km]\]$/i;

/**
 * The name without its context-window marker, or `null` when it carries none.
 *
 * `null` rather than the input unchanged so a caller can tell "nothing to
 * strip" from "stripped and it happened to be the same string", and skip a
 * pointless second lookup.
 */
export function stripContextSuffix(model: string): string | null {
  // Trim first, not after: the pattern is anchored to the end of the string, so
  // a name that arrived as `"model[1m]  "` would otherwise not match at all and
  // the marker would survive a remove that appeared to run.
  const trimmed = model.trim();
  const stripped = trimmed.replace(CONTEXT_SUFFIX, '').trim();
  return stripped !== '' && stripped !== trimmed ? stripped : null;
}
