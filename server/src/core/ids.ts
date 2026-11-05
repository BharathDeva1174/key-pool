import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Crockford-ish base36 of a millisecond timestamp, zero padded to 9 chars. */
function timestampPart(now: number): string {
  return now.toString(36).padStart(9, '0');
}

function randomPart(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

/**
 * Prefixed, roughly time-sortable identifier, e.g. `ep_0m8x1k2ab3`.
 *
 * The timestamp prefix makes ids stable to sort by creation time when scanning
 * a table, which the dashboard does for the log and pool views.
 */
export function newId(prefix: string): string {
  return `${prefix}_${timestampPart(Date.now())}${randomPart(10)}`;
}

/** Generates the unified client-facing API key that clients send to /v1. */
export function generateUnifiedKey(): string {
  return `sk-keypool-${randomBytes(24).toString('base64url')}`;
}
