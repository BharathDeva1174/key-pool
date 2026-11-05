import type { Db } from '../db/index.js';
import { newId } from '../core/ids.js';
import { keyFingerprint, keyHint, normalizeKey, seal, unseal } from '../core/crypto.js';
import { normalizeBaseUrl, type ApiStyle } from '../core/url.js';
import type { BreakerState, CredentialStatus } from '../routing/health.js';
import { STRATEGY_NAMES, type StrategyName } from '../routing/strategies.js';

const now = () => Date.now();

/**
 * An alias's own strategy, or `null` to inherit the global default.
 *
 * `null` is a real setting rather than an absence: it is what makes a strategy
 * chosen in Settings reach aliases that were never given one of their own.
 */
export type AliasStrategy = StrategyName | null;

/** Reads a stored alias strategy, treating anything unrecognised as "inherit". */
function aliasStrategy(raw: unknown): AliasStrategy {
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  return STRATEGY_NAMES.includes(value as StrategyName) ? (value as StrategyName) : null;
}

export type AuthType = 'bearer' | 'none' | 'header' | 'query';
export type EntryStatus = 'unknown' | 'ok' | 'auth_error' | 'not_found' | 'unsupported' | 'disabled';

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiStyle: ApiStyle;
  authType: AuthType;
  authHeader: string | null;
  authPrefix: string | null;
  extraHeaders: Record<string, string>;
  /** Upstream client-emulation profile (`core/compat.ts`); null relays verbatim. */
  compatProfile: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Credential {
  id: string;
  endpointId: string;
  label: string | null;
  keyHint: string;
  keyFingerprint: string;
  status: CredentialStatus;
  lastError: string | null;
  failStreak: number;
  breakerState: BreakerState;
  openedAt: number | null;
  cooldownMs: number;
  cooldownUntil: number | null;
  cooldownAttempts: number;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelEntry {
  id: string;
  credentialId: string;
  modelId: string;
  enabled: boolean;
  status: EntryStatus;
  weight: number;
  priority: number;
  lastPingAt: number | null;
  lastPingOk: number | null;
  lastPingMs: number | null;
  lastError: string | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** An entry joined with everything needed to make one upstream call. */
export interface RoutableEntry {
  entryId: string;
  credentialId: string;
  endpointId: string;
  entry: ModelEntry;
  endpoint: Endpoint;
  credential: Credential;
}

/**
 * A name a client may request that stands in for a real model id.
 *
 * Distinct from an alias, which targets individual model entries: `targetModel`
 * is a model id, so resolution redirects to it and then takes the ordinary
 * model-pool path rather than bypassing it.
 */
export interface Spoof {
  id: string;
  name: string;
  targetModel: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

/**
 * Explicit column aliases for the routing joins.
 *
 * `SELECT c.*, e.*` is unsafe here: both tables have `id`, `created_at` and
 * `updated_at`, and SQLite lets the later column win, which silently hands the
 * endpoint's id to the credential field and breaks every outbound call.
 */
const ENTRY_COLS = /* sql */ `
  me.id             AS entry_id,
  me.credential_id  AS entry_credential_id,
  me.model_id       AS entry_model_id,
  me.enabled        AS entry_enabled,
  me.status         AS entry_status,
  me.weight         AS entry_weight,
  me.priority       AS entry_priority,
  me.last_ping_at   AS entry_last_ping_at,
  me.last_ping_ok   AS entry_last_ping_ok,
  me.last_ping_ms   AS entry_last_ping_ms,
  me.last_error     AS entry_last_error,
  me.last_used_at   AS entry_last_used_at,
  me.created_at     AS entry_created_at,
  me.updated_at     AS entry_updated_at`;

const CRED_COLS = /* sql */ `
  c.id               AS cr_id,
  c.endpoint_id      AS cr_endpoint_id,
  c.label            AS cr_label,
  c.key_hint         AS cr_key_hint,
  c.key_fingerprint  AS cr_key_fingerprint,
  c.status           AS cr_status,
  c.last_error       AS cr_last_error,
  c.fail_streak      AS cr_fail_streak,
  c.breaker_state    AS cr_breaker_state,
  c.opened_at        AS cr_opened_at,
  c.cooldown_ms      AS cr_cooldown_ms,
  c.cooldown_until   AS cr_cooldown_until,
  c.cooldown_attempts AS cr_cooldown_attempts,
  c.disabled         AS cr_disabled,
  c.created_at       AS cr_created_at,
  c.updated_at       AS cr_updated_at`;

const ENDPOINT_COLS = /* sql */ `
  e.id            AS ep_id,
  e.name          AS ep_name,
  e.base_url      AS ep_base_url,
  e.api_style     AS ep_api_style,
  e.auth_type     AS ep_auth_type,
  e.auth_header   AS ep_auth_header,
  e.auth_prefix   AS ep_auth_prefix,
  e.extra_headers AS ep_extra_headers,
  e.compat_profile AS ep_compat_profile,
  e.enabled       AS ep_enabled,
  e.created_at    AS ep_created_at,
  e.updated_at    AS ep_updated_at`;

const ROUTABLE_FROM = /* sql */ `
  FROM model_entries me
  JOIN credentials c ON c.id = me.credential_id
  JOIN endpoints   e ON e.id = c.endpoint_id`;

const str = (v: unknown): string => String(v ?? '');
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => Number(v ?? 0) === 1;

function mapEndpoint(r: Row): Endpoint {
  let extraHeaders: Record<string, string> = {};
  try {
    extraHeaders = JSON.parse(str(r.extra_headers) || '{}') as Record<string, string>;
  } catch {
    extraHeaders = {};
  }
  return {
    id: str(r.id),
    name: str(r.name),
    baseUrl: str(r.base_url),
    apiStyle: str(r.api_style) as ApiStyle,
    authType: str(r.auth_type) as AuthType,
    authHeader: nullableStr(r.auth_header),
    authPrefix: nullableStr(r.auth_prefix),
    extraHeaders,
    compatProfile: nullableStr(r.compat_profile),
    enabled: bool(r.enabled),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapCredential(r: Row): Credential {
  return {
    id: str(r.id),
    endpointId: str(r.endpoint_id),
    label: nullableStr(r.label),
    keyHint: str(r.key_hint),
    keyFingerprint: str(r.key_fingerprint),
    status: str(r.status) as CredentialStatus,
    lastError: nullableStr(r.last_error),
    failStreak: Number(r.fail_streak ?? 0),
    breakerState: str(r.breaker_state) as BreakerState,
    openedAt: nullableNum(r.opened_at),
    cooldownMs: Number(r.cooldown_ms ?? 60_000),
    cooldownUntil: nullableNum(r.cooldown_until),
    cooldownAttempts: Number(r.cooldown_attempts ?? 0),
    disabled: bool(r.disabled),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapEntry(r: Row): ModelEntry {
  return {
    id: str(r.id),
    credentialId: str(r.credential_id),
    modelId: str(r.model_id),
    enabled: bool(r.enabled),
    status: str(r.status) as EntryStatus,
    weight: Number(r.weight ?? 1),
    priority: Number(r.priority ?? 100),
    lastPingAt: nullableNum(r.last_ping_at),
    lastPingOk: nullableNum(r.last_ping_ok),
    lastPingMs: nullableNum(r.last_ping_ms),
    lastError: nullableStr(r.last_error),
    lastUsedAt: nullableNum(r.last_used_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function hydrateSpoof(r: Row): Spoof {
  return {
    id: str(r.id),
    name: str(r.name),
    targetModel: str(r.target_model),
    createdAt: Number(r.created_at),
  };
}

/** Repositories over the pool tables. */
export class UpstreamStore {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

  // ---------------------------------------------------------------- endpoints

  createEndpoint(input: {
    name?: string;
    baseUrl: string;
    apiStyle?: ApiStyle;
    authType?: AuthType;
    authHeader?: string | null;
    authPrefix?: string | null;
    extraHeaders?: Record<string, string>;
    compatProfile?: string | null;
  }): Endpoint {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const id = newId('ep');
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO endpoints
           (id, name, base_url, api_style, auth_type, auth_header, auth_prefix, extra_headers, compat_profile, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        (input.name ?? '').trim() || hostLabel(baseUrl),
        baseUrl,
        input.apiStyle ?? 'auto',
        input.authType ?? 'bearer',
        input.authHeader ?? null,
        input.authPrefix ?? null,
        JSON.stringify(input.extraHeaders ?? {}),
        input.compatProfile ?? null,
        ts,
        ts,
      );
    return this.getEndpoint(id)!;
  }

  listEndpoints(): Endpoint[] {
    const rows = this.db.prepare('SELECT * FROM endpoints ORDER BY created_at ASC').all() as Row[];
    return rows.map(mapEndpoint);
  }

  getEndpoint(id: string): Endpoint | null {
    const row = this.db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as Row | undefined;
    return row ? mapEndpoint(row) : null;
  }

  findEndpointByBaseUrl(baseUrl: string): Endpoint | null {
    const normalized = normalizeBaseUrl(baseUrl);
    const row = this.db.prepare('SELECT * FROM endpoints WHERE base_url = ?').get(normalized) as Row | undefined;
    return row ? mapEndpoint(row) : null;
  }

  updateEndpoint(id: string, patch: Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'apiStyle' | 'authType' | 'authHeader' | 'authPrefix' | 'extraHeaders' | 'compatProfile' | 'enabled'>>): Endpoint | null {
    const existing = this.getEndpoint(id);
    if (!existing) return null;
    const merged = {
      name: patch.name?.trim() || existing.name,
      baseUrl: patch.baseUrl ? normalizeBaseUrl(patch.baseUrl) : existing.baseUrl,
      apiStyle: patch.apiStyle ?? existing.apiStyle,
      authType: patch.authType ?? existing.authType,
      authHeader: patch.authHeader === undefined ? existing.authHeader : patch.authHeader,
      authPrefix: patch.authPrefix === undefined ? existing.authPrefix : patch.authPrefix,
      extraHeaders: patch.extraHeaders ?? existing.extraHeaders,
      compatProfile: patch.compatProfile === undefined ? existing.compatProfile : patch.compatProfile,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.db
      .prepare(
        `UPDATE endpoints SET name = ?, base_url = ?, api_style = ?, auth_type = ?, auth_header = ?,
          auth_prefix = ?, extra_headers = ?, compat_profile = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.baseUrl,
        merged.apiStyle,
        merged.authType,
        merged.authHeader,
        merged.authPrefix,
        JSON.stringify(merged.extraHeaders),
        merged.compatProfile,
        merged.enabled ? 1 : 0,
        now(),
        id,
      );
    return this.getEndpoint(id);
  }

  /** Persists the path style that actually worked, so later calls skip the probe. */
  setApiStyle(id: string, style: ApiStyle): void {
    this.db.prepare('UPDATE endpoints SET api_style = ?, updated_at = ? WHERE id = ?').run(style, now(), id);
  }

  deleteEndpoint(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM endpoints WHERE id = ?').run(id).changes) === 1;
  }

  // ------------------------------------------------------------- credentials

  /**
   * The next automatic label for an endpoint: one past the highest well-formed
   * `KEY<number>` still in use there, so a live key's label is never
   * duplicated. Deleting a middle key leaves a gap and the next key numbers
   * past it; deleting the highest key lets its number come back around. A
   * `KEY` label the operator typed by hand raises the bar the same way.
   * Numbering is per endpoint, so two upstreams each start at KEY1.
   */
  private nextKeyLabel(endpointId: string): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(TRIM(label), 4) AS INTEGER)), 0) AS n
           FROM credentials
          WHERE endpoint_id = ?
            AND TRIM(label) GLOB 'KEY[0-9]*'
            AND TRIM(label) NOT GLOB 'KEY*[^0-9]*'`,
      )
      .get(endpointId) as Row;
    return `KEY${Number(row.n) + 1}`;
  }

  /**
   * Adds a key, sealing it at rest. Re-adding a key that already exists on this
   * endpoint is a no-op that returns the existing row, so bulk imports can be
   * re-run safely.
   *
   * A key added without a label of its own is labelled automatically - KEY1,
   * KEY2, ... per endpoint - so the dashboard's key lists stay addressable
   * without the operator naming dozens of keys by hand.
   */
  addCredential(input: { endpointId: string; apiKey: string; label?: string | null }): { credential: Credential; created: boolean } {
    const key = normalizeKey(input.apiKey);
    if (!key) throw new Error('API key is empty.');
    const fingerprint = keyFingerprint(key);

    const existing = this.db
      .prepare('SELECT * FROM credentials WHERE endpoint_id = ? AND key_fingerprint = ?')
      .get(input.endpointId, fingerprint) as Row | undefined;
    if (existing) return { credential: mapCredential(existing), created: false };

    const label = input.label !== null && input.label !== undefined && input.label.trim() !== '' ? input.label : this.nextKeyLabel(input.endpointId);
    const id = newId('cr');
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO credentials
           (id, endpoint_id, label, key_cipher, key_hint, key_fingerprint, status, fail_streak, breaker_state,
            cooldown_ms, cooldown_attempts, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown', 0, 'closed', 60000, 0, 0, ?, ?)`,
      )
      .run(id, input.endpointId, label, seal(key, this.masterKey), keyHint(key), fingerprint, ts, ts);
    return { credential: this.getCredential(id)!, created: true };
  }

  getCredential(id: string): Credential | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined;
    return row ? mapCredential(row) : null;
  }

  listCredentials(endpointId?: string): Credential[] {
    const rows = endpointId
      ? (this.db.prepare('SELECT * FROM credentials WHERE endpoint_id = ? ORDER BY created_at ASC').all(endpointId) as Row[])
      : (this.db.prepare('SELECT * FROM credentials ORDER BY created_at ASC').all() as Row[]);
    return rows.map(mapCredential);
  }

  /** Decrypts a key for an outbound call. Never exposed over the API. */
  getCredentialSecret(id: string): string {
    const row = this.db.prepare('SELECT key_cipher FROM credentials WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Credential ${id} not found.`);
    return unseal(str(row.key_cipher), this.masterKey);
  }

  updateCredential(
    id: string,
    patch: { label?: string | null; disabled?: boolean; status?: CredentialStatus; lastError?: string | null },
  ): Credential | null {
    const existing = this.getCredential(id);
    if (!existing) return null;
    const merged = {
      label: patch.label === undefined ? existing.label : patch.label,
      disabled: patch.disabled ?? existing.disabled,
      status: patch.status ?? existing.status,
      lastError: patch.lastError === undefined ? existing.lastError : patch.lastError,
    };
    this.db
      .prepare('UPDATE credentials SET label = ?, disabled = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(merged.label, merged.disabled ? 1 : 0, merged.status, merged.lastError, now(), id);
    return this.getCredential(id);
  }

  deleteCredential(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes) === 1;
  }

  // ------------------------------------------------------------ model entries

  createModelEntry(input: { credentialId: string; modelId: string; weight?: number; priority?: number }): { entry: ModelEntry; created: boolean } {
    const modelId = input.modelId.trim();
    if (!modelId) throw new Error('Model ID is required.');

    const existing = this.db
      .prepare('SELECT * FROM model_entries WHERE credential_id = ? AND model_id = ?')
      .get(input.credentialId, modelId) as Row | undefined;
    if (existing) return { entry: mapEntry(existing), created: false };

    const id = newId('me');
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO model_entries
           (id, credential_id, model_id, enabled, status, weight, priority, created_at, updated_at, seq)
         VALUES (?, ?, ?, 1, 'unknown', ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM model_entries))`,
      )
      .run(id, input.credentialId, modelId, input.weight ?? 1, input.priority ?? 100, ts, ts);
    return { entry: this.getModelEntry(id)!, created: true };
  }

  getModelEntry(id: string): ModelEntry | null {
    const row = this.db.prepare('SELECT * FROM model_entries WHERE id = ?').get(id) as Row | undefined;
    return row ? mapEntry(row) : null;
  }

  listModelEntries(): ModelEntry[] {
    return (this.db.prepare('SELECT * FROM model_entries ORDER BY seq ASC, id ASC').all() as Row[]).map(mapEntry);
  }

  updateModelEntry(
    id: string,
    patch: { modelId?: string; enabled?: boolean; status?: EntryStatus; weight?: number; priority?: number; lastError?: string | null },
  ): ModelEntry | null {
    const existing = this.getModelEntry(id);
    if (!existing) return null;
    const merged = {
      modelId: patch.modelId?.trim() || existing.modelId,
      enabled: patch.enabled ?? existing.enabled,
      status: patch.status ?? existing.status,
      weight: patch.weight ?? existing.weight,
      priority: patch.priority ?? existing.priority,
      lastError: patch.lastError === undefined ? existing.lastError : patch.lastError,
    };
    this.db
      .prepare(
        `UPDATE model_entries SET model_id = ?, enabled = ?, status = ?, weight = ?, priority = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(merged.modelId, merged.enabled ? 1 : 0, merged.status, merged.weight, merged.priority, merged.lastError, now(), id);
    return this.getModelEntry(id);
  }

  /** Records the outcome of a ping on an entry. */
  recordPing(id: string, result: { ok: boolean; ms: number | null; status: EntryStatus; error: string | null }): void {
    this.db
      .prepare(
        `UPDATE model_entries SET last_ping_at = ?, last_ping_ok = ?, last_ping_ms = ?, last_error = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now(), result.ok ? 1 : 0, result.ms, result.error, result.status, now(), id);
  }

  markEntryUsed(id: string): void {
    this.db.prepare('UPDATE model_entries SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  deleteModelEntry(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM model_entries WHERE id = ?').run(id).changes) === 1;
  }

  // ----------------------------------------------------------------- routing

  /**
   * One entry joined with its credential and endpoint, ready to be routed to.
   *
   * Deliberately reuses the list query's exact column shape rather than
   * hand-aliasing a second SELECT: `hydrateRow` depends on the joined `c.*` /
   * `e.*` names, and a divergent query would silently hydrate null fields.
   */
  getRoutableEntry(entryId: string): RoutableEntry | null {
    const entry = this.getModelEntry(entryId);
    if (!entry) return null;
    return this.listRoutableForModel(entry.modelId).find((r) => r.entryId === entryId) ?? null;
  }

  /**
   * All enabled entries serving a model id, joined for routing. Health
   * filtering happens in the selector, not here.
   *
   * Ordered by insertion, not by priority: `seq` is the operator's own order of
   * adding keys, which is what `failover` means by "the first healthy key". The
   * `priority` strategy re-ranks on top of this, so leading with the priority
   * number here would only make the two indistinguishable.
   */
  listRoutableForModel(modelId: string): RoutableEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLS}, ${CRED_COLS}, ${ENDPOINT_COLS}
         ${ROUTABLE_FROM}
         WHERE me.model_id = ? AND me.enabled = 1 AND e.enabled = 1
         ORDER BY me.seq ASC, me.id ASC`,
      )
      .all(modelId) as Row[];
    return rows.map((r) => this.hydrateRow(r)).filter((x): x is RoutableEntry => x !== null);
  }

  /** Alias targets in failover order, joined for routing. */
  listRoutableForAlias(aliasId: string): RoutableEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLS}, ${CRED_COLS}, ${ENDPOINT_COLS}
         FROM alias_targets at
         JOIN model_entries me ON me.id = at.model_entry_id
         JOIN credentials   c ON c.id = me.credential_id
         JOIN endpoints     e ON e.id = c.endpoint_id
         WHERE at.alias_id = ? AND me.enabled = 1 AND e.enabled = 1
         ORDER BY at.position ASC`,
      )
      .all(aliasId) as Row[];
    return rows.map((r) => this.hydrateRow(r)).filter((x): x is RoutableEntry => x !== null);
  }

  /** Hydrates one routing row from the aliased column set above. */
  private hydrateRow(r: Row): RoutableEntry | null {
    const entry: ModelEntry = {
      id: str(r.entry_id),
      credentialId: str(r.entry_credential_id),
      modelId: str(r.entry_model_id),
      enabled: bool(r.entry_enabled),
      status: str(r.entry_status) as EntryStatus,
      weight: Number(r.entry_weight ?? 1),
      priority: Number(r.entry_priority ?? 100),
      lastPingAt: nullableNum(r.entry_last_ping_at),
      lastPingOk: nullableNum(r.entry_last_ping_ok),
      lastPingMs: nullableNum(r.entry_last_ping_ms),
      lastError: nullableStr(r.entry_last_error),
      lastUsedAt: nullableNum(r.entry_last_used_at),
      createdAt: Number(r.entry_created_at),
      updatedAt: Number(r.entry_updated_at),
    };
    const credential: Credential = {
      id: str(r.cr_id),
      endpointId: str(r.cr_endpoint_id),
      label: nullableStr(r.cr_label),
      keyHint: str(r.cr_key_hint),
      keyFingerprint: str(r.cr_key_fingerprint),
      status: str(r.cr_status) as CredentialStatus,
      lastError: nullableStr(r.cr_last_error),
      failStreak: Number(r.cr_fail_streak ?? 0),
      breakerState: str(r.cr_breaker_state) as BreakerState,
      openedAt: nullableNum(r.cr_opened_at),
      cooldownMs: Number(r.cr_cooldown_ms ?? 60_000),
      cooldownUntil: nullableNum(r.cr_cooldown_until),
      cooldownAttempts: Number(r.cr_cooldown_attempts ?? 0),
      disabled: bool(r.cr_disabled),
      createdAt: Number(r.cr_created_at),
      updatedAt: Number(r.cr_updated_at),
    };
    const endpoint: Endpoint = {
      id: str(r.ep_id),
      name: str(r.ep_name),
      baseUrl: str(r.ep_base_url),
      apiStyle: str(r.ep_api_style) as ApiStyle,
      authType: str(r.ep_auth_type) as AuthType,
      authHeader: nullableStr(r.ep_auth_header),
      authPrefix: nullableStr(r.ep_auth_prefix),
      extraHeaders: parseJsonObject(r.ep_extra_headers),
      compatProfile: nullableStr(r.ep_compat_profile),
      enabled: bool(r.ep_enabled),
      createdAt: Number(r.ep_created_at),
      updatedAt: Number(r.ep_updated_at),
    };
    if (!entry.id || !credential.id || !endpoint.id || !endpoint.baseUrl) return null;
    return { entryId: entry.id, credentialId: credential.id, endpointId: endpoint.id, entry, endpoint, credential };
  }

  // ----------------------------------------------------------------- aliases

  /**
   * An alias and its targets must land together: a rejected target id used to
   * leave the alias row behind (the FK failure rolled back only the join
   * insert), and an update could half-apply over the old chain.
   */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createAlias(name: string, strategy: AliasStrategy, targetEntryIds: string[]): { id: string } {
    const aliasName = name.trim();
    if (!aliasName) throw new Error('Alias name is required.');
    const id = newId('al');
    const ts = now();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO aliases (id, name, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, aliasName, strategy, ts, ts);
      this.setAliasTargets(id, targetEntryIds);
    });
    return { id };
  }

  setAliasTargets(aliasId: string, entryIds: string[]): void {
    this.db.prepare('DELETE FROM alias_targets WHERE alias_id = ?').run(aliasId);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO alias_targets (id, alias_id, model_entry_id, position, weight) VALUES (?, ?, ?, ?, 1)',
    );
    entryIds.forEach((entryId, index) => {
      insert.run(newId('at'), aliasId, entryId, index + 1);
    });
  }

  getAlias(id: string): { id: string; name: string; strategy: AliasStrategy; createdAt: number } | null {
    const row = this.db.prepare('SELECT * FROM aliases WHERE id = ?').get(id) as Row | undefined;
    return row ? { id: str(row.id), name: str(row.name), strategy: aliasStrategy(row.strategy), createdAt: Number(row.created_at) } : null;
  }

  getAliasByName(name: string): { id: string; name: string; strategy: AliasStrategy; createdAt: number } | null {
    const row = this.db.prepare('SELECT * FROM aliases WHERE name = ?').get(name) as Row | undefined;
    return row ? { id: str(row.id), name: str(row.name), strategy: aliasStrategy(row.strategy), createdAt: Number(row.created_at) } : null;
  }

  listAliases(): Array<{ id: string; name: string; strategy: AliasStrategy; createdAt: number; targets: string[] }> {
    const rows = this.db.prepare('SELECT * FROM aliases ORDER BY created_at ASC').all() as Row[];
    const targetsStmt = this.db.prepare('SELECT model_entry_id FROM alias_targets WHERE alias_id = ? ORDER BY position ASC');
    return rows.map((row) => ({
      id: str(row.id),
      name: str(row.name),
      strategy: aliasStrategy(row.strategy),
      createdAt: Number(row.created_at),
      targets: (targetsStmt.all(str(row.id)) as Row[]).map((t) => str(t.model_entry_id)),
    }));
  }

  updateAlias(id: string, patch: { name?: string; strategy?: AliasStrategy; targets?: string[] }): boolean {
    const existing = this.getAlias(id);
    if (!existing) return false;
    this.tx(() => {
      this.db
        .prepare('UPDATE aliases SET name = ?, strategy = ?, updated_at = ? WHERE id = ?')
        // `undefined` leaves the stored strategy alone; an explicit `null` is the
        // operator handing the alias back to the global default.
        .run(patch.name?.trim() || existing.name, patch.strategy !== undefined ? patch.strategy : existing.strategy, now(), id);
      if (patch.targets) this.setAliasTargets(id, patch.targets);
    });
    return true;
  }

  deleteAlias(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM aliases WHERE id = ?').run(id).changes) === 1;
  }

  // ------------------------------------------------------------- model spoofs

  /**
   * A spoof pointing at another spoof's name is rejected rather than followed.
   * One hop keeps resolution a single lookup with nothing to recurse, so there
   * is no cycle to guard and no half-resolved name to explain in a 503.
   */
  createSpoof(name: string, targetModel: string): { id: string } {
    const spoofName = name.trim();
    if (!spoofName) throw new Error('Spoof name is required.');
    const target = targetModel.trim();
    if (!target) throw new Error('Target model is required.');
    if (this.getSpoofByName(target)) {
      throw new Error(`"${target}" is itself a spoof. Point a spoof at a real model id, not at another spoof.`);
    }
    const id = newId('sp');
    const ts = now();
    this.db
      .prepare('INSERT INTO model_spoofs (id, name, target_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, spoofName, target, ts, ts);
    return { id };
  }

  getSpoof(id: string): Spoof | null {
    const row = this.db.prepare('SELECT * FROM model_spoofs WHERE id = ?').get(id) as Row | undefined;
    return row ? hydrateSpoof(row) : null;
  }

  getSpoofByName(name: string): Spoof | null {
    const row = this.db.prepare('SELECT * FROM model_spoofs WHERE name = ?').get(name) as Row | undefined;
    return row ? hydrateSpoof(row) : null;
  }

  listSpoofs(): Spoof[] {
    const rows = this.db.prepare('SELECT * FROM model_spoofs ORDER BY created_at ASC').all() as Row[];
    return rows.map(hydrateSpoof);
  }

  updateSpoof(id: string, patch: { name?: string; targetModel?: string }): boolean {
    const existing = this.getSpoof(id);
    if (!existing) return false;
    this.db
      .prepare('UPDATE model_spoofs SET name = ?, target_model = ?, updated_at = ? WHERE id = ?')
      .run(patch.name?.trim() || existing.name, patch.targetModel?.trim() || existing.targetModel, now(), id);
    return true;
  }

  deleteSpoof(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM model_spoofs WHERE id = ?').run(id).changes) === 1;
  }

  /** True when any enabled entry serves this model id. */
  hasModel(modelId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM model_entries WHERE model_id = ? LIMIT 1').get(modelId) as Row | undefined;
    return row !== undefined;
  }

  // ------------------------------------------------------- dashboard queries

  /** Every entry with its endpoint/credential context, for the dashboard. */
  listEntriesWithContext(): Array<{ entry: ModelEntry; endpointName: string; baseUrl: string; credentialLabel: string | null; keyHint: string; keyStatus: CredentialStatus; breakerState: BreakerState; failStreak: number; cooldownUntil: number | null; disabled: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT me.id, me.credential_id, me.model_id, me.enabled, me.status, me.weight, me.priority,
                me.last_ping_at, me.last_ping_ok, me.last_ping_ms, me.last_error, me.last_used_at,
                me.created_at, me.updated_at,
                e.name AS e_name, e.base_url AS e_base_url, e.enabled AS e_enabled,
                c.label AS c_label, c.key_hint, c.status AS c_status, c.breaker_state,
                c.fail_streak, c.cooldown_until, c.disabled AS c_disabled
           FROM model_entries me
           JOIN credentials c ON c.id = me.credential_id
           JOIN endpoints   e ON e.id = c.endpoint_id
          ORDER BY e.created_at ASC, me.seq ASC, me.id ASC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      entry: mapEntry(r),
      endpointName: str(r.e_name),
      baseUrl: str(r.e_base_url),
      credentialLabel: nullableStr(r.c_label),
      keyHint: str(r.key_hint),
      keyStatus: str(r.c_status) as CredentialStatus,
      breakerState: str(r.breaker_state) as BreakerState,
      failStreak: Number(r.fail_streak ?? 0),
      cooldownUntil: nullableNum(r.cooldown_until),
      disabled: Number(r.c_disabled ?? 0) === 1,
    }));
  }

  /** Credentials with their endpoint name and key counts, for the dashboard. */
  listCredentialsWithContext(): Array<{ credential: Credential; endpointName: string; baseUrl: string; entryCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT c.*, e.name AS e_name, e.base_url AS e_base_url,
                (SELECT COUNT(*) FROM model_entries me WHERE me.credential_id = c.id) AS entry_count
           FROM credentials c
           JOIN endpoints e ON e.id = c.endpoint_id
          ORDER BY e.created_at ASC, c.created_at ASC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      credential: mapCredential(r),
      endpointName: str(r.e_name),
      baseUrl: str(r.e_base_url),
      entryCount: Number(r.entry_count ?? 0),
    }));
  }

  /** Writes the health state for a credential. */
  persistHealth(credentialId: string, h: {
    status: CredentialStatus;
    failStreak: number;
    breakerState: BreakerState;
    openedAt: number | null;
    cooldownMs: number;
    cooldownUntil: number | null;
    cooldownAttempts: number;
    lastError?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE credentials
            SET status = ?, fail_streak = ?, breaker_state = ?, opened_at = ?,
                cooldown_ms = ?, cooldown_until = ?, cooldown_attempts = ?,
                last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        h.status,
        h.failStreak,
        h.breakerState,
        h.openedAt,
        h.cooldownMs,
        h.cooldownUntil,
        h.cooldownAttempts,
        h.lastError ?? null,
        now(),
        credentialId,
      );
  }

  /**
   * Records one upstream refusal behind a 200 and returns the new streak.
   *
   * Separate from `persistHealth` on purpose. A refusal means the upstream
   * declined the request it had already accepted, which is weak evidence about
   * the credential - a malformed request is refused identically on every key.
   * So it is counted in its own column and only allowed to reach the breaker
   * once the same credential has been refused `threshold` times without a
   * success in between. That threshold is what separates a caller's bad request
   * from a gateway in a bad state; one bad request must not cost a working key,
   * and a gateway refusing everything must not be able to do so forever.
   *
   * The increment and the read are one statement so two concurrent requests
   * cannot both read the same streak and lose an increment between them.
   */
  recordRefusal(credentialId: string, errorMessage: string, threshold: number): number {
    const row = this.db
      .prepare(
        `UPDATE credentials
            SET refusal_streak = refusal_streak + 1,
                last_error = ?,
                updated_at = ?
          WHERE id = ?
      RETURNING refusal_streak`,
      )
      .get(errorMessage, now(), credentialId) as { refusal_streak: number } | undefined;
    const streak = Number(row?.refusal_streak ?? 0);
    // Below the threshold the refusal is noted but the credential is left alone:
    // `persistHealth` is the caller's cue to move the breaker, and it must not
    // be moved on the strength of a single refusal.
    return streak >= threshold ? streak : 0;
  }

  /** Clears the refusal streak after a success, so an old run cannot trip a later one. */
  clearRefusal(credentialId: string): void {
    this.db
      .prepare('UPDATE credentials SET refusal_streak = 0 WHERE id = ? AND refusal_streak != 0')
      .run(credentialId);
  }

  /** The current refusal streak, for tests and diagnostics. */
  refusalStreak(credentialId: string): number {
    const row = this.db.prepare('SELECT refusal_streak FROM credentials WHERE id = ?').get(credentialId) as
      | { refusal_streak: number }
      | undefined;
    return Number(row?.refusal_streak ?? 0);
  }
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'upstream';
  }
}

function parseJsonObject(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
