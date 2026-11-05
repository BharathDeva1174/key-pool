import { safeEqualHash } from '../core/crypto.js';
import type { Settings } from '../settings.js';

/** Pulls the bearer token out of the request headers, if present. */
export function extractPresentedKey(headers: Record<string, unknown>): string | null {
  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return (match[1] as string).trim();
    return auth.trim();
  }
  const apiKey = headers['x-api-key'] ?? headers['x-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

export interface AuthResult {
  authorized: boolean;
  reason: 'ok' | 'disabled' | 'missing' | 'mismatch' | 'unconfigured';
}

/**
 * Verifies the unified client key against the stored SHA-256 hash in constant
 * time. Only the hash is ever persisted.
 */
export function verifyUnifiedKey(settings: Settings, headers: Record<string, unknown>): AuthResult {
  if (!settings.requireApiKey) return { authorized: true, reason: 'disabled' };
  if (!settings.unifiedKeyHash) return { authorized: false, reason: 'unconfigured' };

  const presented = extractPresentedKey(headers);
  if (!presented) return { authorized: false, reason: 'missing' };
  if (!safeEqualHash(presented, settings.unifiedKeyHash)) {
    return { authorized: false, reason: 'mismatch' };
  }
  return { authorized: true, reason: 'ok' };
}
