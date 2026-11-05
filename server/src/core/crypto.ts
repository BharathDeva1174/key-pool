import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Writes secret material to disk, owner-only wherever the platform allows it.
 *
 * Every key file goes through here so none of them is treated as more casual
 * than another. The chmod is best effort: it is a no-op on Windows and can be
 * refused on a hardened mount, and refusing to boot over file permissions would
 * be a worse outcome than a file only as private as its directory.
 */
export function writeSecretFile(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: chmod is a no-op or restricted on some Windows setups.
  }
}

/** Reads a secret file, or '' when it is missing or unreadable. */
export function readSecretFile(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Loads the 32-byte master key, generating and persisting it on first run.
 *
 * Losing this file means every stored API key becomes unrecoverable, which is
 * the intended trade-off: key material is never at rest in plaintext in the
 * database.
 */
export function loadOrCreateMasterKey(masterKeyFile: string): Buffer {
  if (existsSync(masterKeyFile)) {
    const raw = readFileSync(masterKeyFile, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `Master key at ${masterKeyFile} is corrupt (expected 32 bytes, got ${buf.length}). ` +
          'Delete it to regenerate, but note that all stored API keys will need to be re-entered.',
      );
    }
    return buf;
  }

  const key = randomBytes(32);
  writeSecretFile(masterKeyFile, key.toString('base64'));
  return key;
}

/** Seals a string with AES-256-GCM. Output is `iv:tag:ciphertext`, base64 each. */
export function seal(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Reverses `seal`. Throws if the payload was tampered with or the key differs. */
export function unseal(payload: string, masterKey: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Sealed payload is malformed.');
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Sealed payload is malformed.');
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Normalises a key before hashing: strips an optional `Bearer ` prefix and
 * surrounding quotes/whitespace, so the same key pasted three different ways
 * produces one fingerprint.
 */
export function normalizeKey(raw: string): string {
  let value = raw.trim();
  if (/^bearer\s+/i.test(value)) value = value.replace(/^bearer\s+/i, '');
  value = value.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/** Stable identity of a key within an endpoint, used to dedupe imports. */
export function keyFingerprint(raw: string): string {
  return sha256Hex(normalizeKey(raw));
}

/** Last 4 characters, for display only. */
export function keyHint(raw: string): string {
  const value = normalizeKey(raw);
  if (value.length <= 4) return value;
  return value.slice(-4);
}

/** Constant-time comparison of two strings of arbitrary length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(sha256Hex(a), 'hex');
  const bufB = Buffer.from(sha256Hex(b), 'hex');
  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time check of `presented` against an already-hashed secret.
 * This is the comparison used for the unified API key, where only the SHA-256
 * digest is stored.
 */
export function safeEqualHash(presented: string, storedHex: string): boolean {
  const bufA = Buffer.from(sha256Hex(presented), 'hex');
  let bufB: Buffer;
  try {
    bufB = Buffer.from(storedHex, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
