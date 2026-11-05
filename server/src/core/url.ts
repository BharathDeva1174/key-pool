export type ApiStyle = 'auto' | 'v1' | 'root';

// Longest first: stripping `/chat/completions` from
// `https://host/v1/chat/completions` correctly leaves `https://host/v1`,
// which is the OpenAI-style base rather than the bare host.
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/models'];

/**
 * Accepts whatever the operator pasted and returns a clean base URL.
 *
 * Handles the shapes that actually show up: `https://host`,
 * `https://host/v1`, `https://host/v1/`, and a full endpoint URL like
 * `https://host/v1/chat/completions` that was copied from a config screen.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new Error('Base URL is required.');

  let url = trimmed;
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (url.toLowerCase().endsWith(suffix)) {
      url = url.slice(0, url.length - suffix.length);
      break;
    }
  }
  url = url.replace(/\/+$/, '');

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Base URL must start with http:// or https:// (got "${trimmed}").`);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`Base URL is not a valid URL: "${trimmed}".`);
  }
  return url;
}

/** Removes a trailing `/v1`, returning the bare host root. */
export function stripV1(base: string): string {
  return base.replace(/\/v1$/i, '');
}

/** True when the base already carries the `/v1` prefix. */
export function hasV1(base: string): boolean {
  return /\/v1$/i.test(base);
}

/**
 * Builds the ordered list of concrete URLs to try for a given API style.
 *
 * `v1` style appends `/v1` only when the base does not already end in it, so
 * pasting either `https://host` or `https://host/v1` produces the same target.
 * `root` style always strips `/v1` first.
 *
 * With `auto` the `/v1` variant is tried first and the root variant second; the
 * winner is persisted on the endpoint so later requests skip the probe.
 */
export function buildUpstreamUrls(base: string, style: ApiStyle, path: string): string[] {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (style === 'v1') {
    return [hasV1(base) ? `${base}${suffix}` : `${base}/v1${suffix}`];
  }
  if (style === 'root') {
    return [`${stripV1(base)}${suffix}`];
  }
  const withV1 = hasV1(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
  const withoutV1 = `${stripV1(base)}${suffix}`;
  // When the base already carries /v1 both styles resolve to the same URL, so
  // there is nothing to probe and auto collapses to a single candidate.
  return withV1 === withoutV1 ? [withV1] : [withV1, withoutV1];
}

/** The first URL a given style would use - handy for display and for probes. */
export function primaryUpstreamUrl(base: string, style: ApiStyle, path: string): string {
  const urls = buildUpstreamUrls(base, style === 'auto' ? 'v1' : style, path);
  return urls[0] as string;
}

/** Host portion of a URL, used as the display `owned_by` on /v1/models. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'upstream';
  }
}
